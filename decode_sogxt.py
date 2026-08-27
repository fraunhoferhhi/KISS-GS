#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "pillow",
#     "pyyaml",
# ]
# ///

"""Decode a SOG-XT container directory into a 3DGS-INRIA `.ply`."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import yaml
from PIL import Image


# ============================================================================
# Imports and Helpers
# ============================================================================

def read_image_uint8(path: Path) -> np.ndarray:
    image = np.array(Image.open(path))
    if image.ndim == 2:
        image = image[..., None]
    return image.astype(np.uint8, copy=False)


def normalize_to_01(values: np.ndarray) -> np.ndarray:
    values_f32 = values.astype(np.float32, copy=False)
    return (values_f32 - values_f32.min()) / (values_f32.max() - values_f32.min() + 1e-8)


def dequantize(
    quantized: np.ndarray,
    min_values: np.ndarray | float,
    max_values: np.ndarray | float,
) -> np.ndarray:
    return normalize_to_01(quantized) * (max_values - min_values) + min_values


def extract_ranges(container_meta: dict) -> dict[str, tuple[object, object]]:
    ranges: dict[str, tuple[object, object]] = {}
    for op in container_meta["ops"]:
        fields = op.get("input_fields") or []
        if len(fields) != 1:
            continue
        for transform in op.get("transforms", []):
            quant = transform.get("simple_quantize")
            if quant and "min_values" in quant:
                ranges[fields[0]] = (quant["min_values"], quant["max_values"])
    return ranges


def untile_feature_grid_3x5(tiled_hw3: np.ndarray) -> np.ndarray:
    tile_rows, tile_cols = 3, 5
    total_height, total_width, channels = tiled_hw3.shape
    height = total_height // tile_rows
    width = total_width // tile_cols
    tiles = tiled_hw3.reshape(tile_rows, height, tile_cols, width, channels)
    return tiles.transpose(1, 3, 4, 0, 2).reshape(height, width, channels * tile_rows * tile_cols)


# ============================================================================
# Main Decoding Path
# ============================================================================

def decode_container_to_columns(container_dir: Path) -> list[tuple[str, np.ndarray]]:
    container_meta = yaml.safe_load((container_dir / "container_meta.yaml").read_text())
    grid_side = int(container_meta["meta"]["grid_side"])
    centroid_grid_side = int(container_meta["meta"]["f_rest_centroids_side"])
    image_codec = str(container_meta["meta"]["image_codec"])
    ranges = extract_ranges(container_meta)

    def p(field: str) -> Path:
        return container_dir / f"{field}.{image_codec}"

    active_mask = read_image_uint8(p("active_mask"))[..., 0].reshape(-1) > 0

    opacities = dequantize(
        read_image_uint8(p("opacities"))[..., 0],
        float(ranges["opacities"][0]),
        float(ranges["opacities"][1]),
    )
    opacities = (1.0 / (1.0 + np.exp(-opacities))).reshape(grid_side * grid_side, 1)

    scales_min = np.asarray(ranges["scales"][0], dtype=np.float32).reshape(1, 1, 3)
    scales_max = np.asarray(ranges["scales"][1], dtype=np.float32).reshape(1, 1, 3)
    scales = np.exp(dequantize(read_image_uint8(p("scales")), scales_min, scales_max)).reshape(grid_side * grid_side, 3)

    means_low = read_image_uint8(p("means_bytes_0")).astype(np.float32)
    means_high = read_image_uint8(p("means_bytes_1")).astype(np.float32)
    means_signed_log = dequantize(
        means_low + 256.0 * means_high,
        float(ranges["means"][0]),
        float(ranges["means"][1]),
    )
    means = (np.sign(means_signed_log) * np.expm1(np.abs(means_signed_log))).reshape(grid_side * grid_side, 3)

    quaternions_min = np.asarray(ranges["quaternions"][0], dtype=np.float32).reshape(1, 1, 4)
    quaternions_max = np.asarray(ranges["quaternions"][1], dtype=np.float32).reshape(1, 1, 4)
    quaternions = dequantize(
        read_image_uint8(p("quaternions")),
        quaternions_min,
        quaternions_max,
    ).reshape(grid_side * grid_side, 4)

    f_dc_min = np.asarray(ranges["f_dc"][0], dtype=np.float32).reshape(1, 1, 3)
    f_dc_max = np.asarray(ranges["f_dc"][1], dtype=np.float32).reshape(1, 1, 3)
    f_dc = dequantize(read_image_uint8(p("f_dc")), f_dc_min, f_dc_max).reshape(grid_side * grid_side, 3)

    labels_uv = read_image_uint8(p("f_rest_labels")).astype(np.int64, copy=False)
    centroid_indices = (labels_uv[..., 1] * centroid_grid_side + labels_uv[..., 0]).reshape(-1)

    centroid_min = np.asarray(ranges["f_rest_centroids"][0], dtype=np.float32)
    centroid_max = np.asarray(ranges["f_rest_centroids"][1], dtype=np.float32)
    if centroid_min.size != 45:
        raise ValueError("Expected 45-channel centroids (SOG-XT).")

    centroid_grid = untile_feature_grid_3x5(normalize_to_01(read_image_uint8(p("f_rest_centroids"))))
    centroids = dequantize(
        centroid_grid.reshape(centroid_grid_side, centroid_grid_side, 45),
        centroid_min.reshape(1, 1, 45),
        centroid_max.reshape(1, 1, 45),
    ).reshape(centroid_grid_side * centroid_grid_side, 45)

    f_rest = centroids[centroid_indices].reshape(grid_side * grid_side, 3, 15).transpose(0, 2, 1)
    sh = np.concatenate([f_dc[:, None, :], f_rest], axis=1)

    means = means[active_mask]
    scales = scales[active_mask]
    opacities = opacities[active_mask]
    quaternions = quaternions[active_mask]
    sh = sh[active_mask]

    normals = np.zeros_like(means, dtype=np.float32)
    scales_log = np.log(scales)
    opacities_logit = np.log(opacities) - np.log1p(-opacities)
    f_rest_flat = sh[:, 1:, :].transpose(0, 2, 1).reshape(sh.shape[0], 45)

    return [
        ("x", means[:, 0]),
        ("y", means[:, 1]),
        ("z", means[:, 2]),
        ("nx", normals[:, 0]),
        ("ny", normals[:, 1]),
        ("nz", normals[:, 2]),
        ("f_dc_0", sh[:, 0, 0]),
        ("f_dc_1", sh[:, 0, 1]),
        ("f_dc_2", sh[:, 0, 2]),
        *[(f"f_rest_{i}", f_rest_flat[:, i]) for i in range(45)],
        ("opacity", opacities_logit[:, 0]),
        ("scale_0", scales_log[:, 0]),
        ("scale_1", scales_log[:, 1]),
        ("scale_2", scales_log[:, 2]),
        ("rot_0", quaternions[:, 0]),
        ("rot_1", quaternions[:, 1]),
        ("rot_2", quaternions[:, 2]),
        ("rot_3", quaternions[:, 3]),
    ]


# ============================================================================
# PLY Writer and CLI Entry Point
# ============================================================================

def write_ply(path: Path, *, columns: list[tuple[str, np.ndarray]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    num_vertices = int(columns[0][1].shape[0])
    matrix = np.empty((num_vertices, len(columns)), dtype="<f4")
    for column_index, (_name, values) in enumerate(columns):
        matrix[:, column_index] = values.astype(np.float32, copy=False).reshape(num_vertices)

    header = "\n".join([
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {num_vertices}",
        *[f"property float {name}" for name, _ in columns],
        "end_header",
        "",
    ]).encode("ascii")

    with path.open("wb") as f:
        f.write(header)
        f.write(matrix.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Input container directory.")
    parser.add_argument("--output", type=Path, required=True, help="Output INRIA `.ply` path.")
    args = parser.parse_args()
    write_ply(args.output, columns=decode_container_to_columns(args.input))


if __name__ == "__main__":
    main()
