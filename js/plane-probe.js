// @ts-check
/**
 * The pixel probe: hover a pixel of a real encoded plane, and the renderer moves
 * to that Gaussian.
 *
 * V3-O removed ffsplat's container explorer, and V3-AL restores the *one* thing
 * that was worth keeping from it — the correspondence between a pixel and a
 * primitive — as page-owned interaction rather than viewer chrome. Nothing here
 * asks ffsplat for a panel. It uses two things the viewer already offers to any
 * embedder: `selection.set` / `steerTo`, and the typed bootstrap config that
 * carries each scene's placement.
 *
 * The decode is the page's own, and that is the point rather than a workaround.
 * This page's whole claim is that a scene is ordinary images plus a few
 * deterministic operations; performing those operations on one pixel, live, is
 * the claim demonstrated. Every rule is the viewer's own — `sog-xt-splats.ts`
 * for the arithmetic and `container-explorer.ts` for the pixel-to-splat mapping —
 * because a formula that drifts sends the camera to a plausible wrong place.
 *
 * @typedef {import("./viewer-bridge.js").PageState} PageState
 * @typedef {import("./controls.js").SizeManifest} SizeManifest
 * @typedef {import("@viewer/scene-input").SceneTransform} SceneTransform
 *
 * @typedef {object} SogXtRangeLike
 * @property {number | readonly number[]} mins
 * @property {number | readonly number[]} maxs
 *
 * @typedef {object} ShMosaic
 * @property {number} centroidSide
 * @property {number} tileRows
 * @property {number} tileCols
 */

/** The viewer's `EPSILON`: it keeps a single-valued plane from dividing by zero. */
const EPSILON = 1e-8;

/** @param {number | readonly number[]} range @param {number} channel */
const channelOf = (range, channel) =>
  typeof range === "number" ? range : Number(range[channel]);

/** @param {number} a @param {number} b @param {number} t */
const lerp = (a, b, t) => a * (1 - t) + b * t;

/** The inverse of the signed-log mapping positions are quantised through. */
const signedExpm1 = (/** @type {number} */ value) => Math.sign(value) * (Math.exp(Math.abs(value)) - 1);

/**
 * The range a plane actually uses, over its first `channels` channels.
 *
 * The container quantises to the full byte or word, but the decoder rescales
 * from the range the data *occupies* — so this is not cosmetic: use 0..65535
 * instead and every position is wrong by a scale factor.
 *
 * @param {ArrayLike<number>} data RGBA samples — bytes for a byte plane, and the
 *   combined 16-bit words for the two position planes, which is why this is not
 *   typed as a byte array: clamping those to 255 makes every position wrong by a
 *   factor, and the camera lands somewhere plausible.
 * @param {number} channels
 */
export const observedRange = (data, channels) => {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = data[index + channel];
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  return { lo, hi };
};

/**
 * The 16-bit position word, from the coarse plane and the detail plane.
 * @param {readonly number[]} high `means_bytes_1`, the coarse byte
 * @param {readonly number[]} low `means_bytes_0`, the detail byte
 */
export const combinedMean = (high, low) =>
  [0, 1, 2].map((channel) => low[channel] + 256 * high[channel]);

/**
 * One primitive's position in the container's own coordinates.
 * @param {readonly number[]} combined
 * @param {SogXtRangeLike} means
 * @param {{lo: number, hi: number}} observed
 */
export const localMean = (combined, means, observed) =>
  combined.map((value, channel) =>
    signedExpm1(
      lerp(
        channelOf(means.mins, channel),
        channelOf(means.maxs, channel),
        (value - observed.lo) / (observed.hi - observed.lo + EPSILON),
      ),
    ),
  );

/**
 * The same point where the renderer draws it.
 *
 * `steerTo` takes world coordinates, and the export gives each scene a rotation
 * that stands it upright and a translation that centres it. Skipping this is the
 * one mistake that looks like it works: the camera moves, just to the wrong
 * place, and only in scenes whose placement is not the identity.
 *
 * @param {readonly number[]} local
 * @param {SceneTransform | null | undefined} transform
 */
export const worldPoint = (local, transform) => {
  if (!transform) return [...local];
  const [qx, qy, qz, qw] = transform.rotation;
  const length = Math.hypot(qx, qy, qz, qw) || 1;
  const [x, y, z, w] = [qx / length, qy / length, qz / length, qw / length];
  const [vx, vy, vz] = local;
  const dot = x * vx + y * vy + z * vz;
  const cross = [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
  const scale = w * w - (x * x + y * y + z * z);
  return [
    2 * dot * x + scale * vx + 2 * w * cross[0] + transform.position[0],
    2 * dot * y + scale * vy + 2 * w * cross[1] + transform.position[1],
    2 * dot * z + scale * vz + 2 * w * cross[2] + transform.position[2],
  ];
};

/**
 * How big the primitive is, which is how close the camera should come to it.
 * @param {readonly number[]} pixel
 * @param {SogXtRangeLike} scales
 * @param {{lo: number, hi: number}} observed
 */
export const maxScaleOf = (pixel, scales, observed) =>
  Math.max(
    ...[0, 1, 2].map((channel) =>
      Math.exp(
        lerp(
          channelOf(scales.mins, channel),
          channelOf(scales.maxs, channel),
          (pixel[channel] - observed.lo) / (observed.hi - observed.lo + EPSILON),
        ),
      ),
    ),
  );

/**
 * How many active cells precede each row of the grid.
 *
 * The compacted splat index is a cell's rank among the active cells, so the
 * whole mask has to be counted once. Counting it *per row* is what keeps a hover
 * to one 512-pixel read instead of a megabyte, and keeps a 262,144-entry lookup
 * table off the heap.
 *
 * @param {Uint8ClampedArray | Uint8Array} mask RGBA bytes for the whole grid
 * @param {number} side
 */
export const maskRowStarts = (mask, side) => {
  const starts = new Int32Array(side);
  let seen = 0;
  for (let row = 0; row < side; row += 1) {
    starts[row] = seen;
    const base = row * side * 4;
    for (let column = 0; column < side; column += 1) {
      if (mask[base + column * 4] > 0) seen += 1;
    }
  }
  return starts;
};

/**
 * The splat at a grid coordinate, or `null` where the mask pruned the cell.
 * @param {number} rowStart active cells before this row, from `maskRowStarts`
 * @param {Uint8ClampedArray | Uint8Array} maskRow RGBA bytes for one row
 * @param {number} u
 */
export const compactedIndexAt = (rowStart, maskRow, u) => {
  if (!maskRow[u * 4]) return null;
  let index = rowStart;
  for (let column = 0; column < u; column += 1) {
    if (maskRow[column * 4] > 0) index += 1;
  }
  return index;
};

/**
 * The centroid a label pixel points at, and where it is drawn.
 *
 * `clusterAt` reads the label from R and the slice from G, addressing a
 * `centroidSide` grid. The codebook image repeats that grid once per
 * spherical-harmonic coefficient in a mosaic, so one centroid appears
 * `tileRows * tileCols` times — every one of them is the same centroid, which is
 * why the connector draws a line to all of them rather than picking one.
 *
 * @param {readonly number[]} pixel
 * @param {ShMosaic | null | undefined} shN
 */
export const codebookLookup = (pixel, shN) => {
  if (!shN?.centroidSide) return null;
  const label = pixel[0];
  const slice = pixel[1];
  const cells = [];
  for (let row = 0; row < shN.tileRows; row += 1) {
    for (let column = 0; column < shN.tileCols; column += 1) {
      cells.push([column * shN.centroidSide + label, row * shN.centroidSide + slice]);
    }
  }
  return { label, slice, cluster: slice * shN.centroidSide + label, cells };
};

const SH_C0 = 0.28209479177387814;
const logistic = (/** @type {number} */ value) => 1 / (1 + Math.exp(-value));
const clamp01 = (/** @type {number} */ value) => Math.max(0, Math.min(1, value));

/**
 * Keep changing values optically still: source bytes own three columns, while
 * reconstructed values reserve a sign plus three integer and three fractional
 * columns. `white-space: pre` on the rendered number preserves the leading pad.
 *
 * @param {number} value
 * @param {boolean} [byte]
 */
export const formatInspectorNumber = (value, byte = false) => (
  byte ? String(value).padStart(3, " ") : Number(value).toFixed(3).padStart(8, " ")
);

/** @param {readonly number[]} pixel @param {SogXtRangeLike} range @param {{lo:number,hi:number}} observed @param {number} channels */
const decodeRange = (pixel, range, observed, channels) =>
  Array.from({ length: channels }, (_unused, channel) =>
    lerp(
      channelOf(range.mins, channel),
      channelOf(range.maxs, channel),
      (pixel[channel] - observed.lo) / (observed.hi - observed.lo + EPSILON),
    ));

/**
 * The compact semantic value shown below one plane. This is deliberately a
 * small vocabulary rather than a generic field inspector: one reconstructed
 * attribute, one centroid identity, or one directly inspected SH triplet.
 *
 * @param {string} name
 * @param {readonly number[]} pixel
 * @param {any} context
 * @returns {{labels?: string[], values?: number[], channels?: string[], text?: string}}
 */
export const inspectorValue = (name, pixel, context) => {
  const { meta, observed } = context;
  if (name === "positionCoarse" || name === "positionDetail") {
    const coarseWords = context.high.slice(0, 3).map(
      (/** @type {number} */ value) => 128 + 256 * value,
    );
    const coarse = localMean(coarseWords, meta.means, observed.coarse);
    if (name === "positionCoarse") {
      return { labels: ["x", "y", "z"], values: coarse, channels: ["r", "g", "b"] };
    }
    const final = localMean(combinedMean(context.high, context.low), meta.means, observed.combined);
    return {
      labels: ["δx", "δy", "δz"],
      values: final.map((value, channel) => value - coarse[channel]),
      channels: ["r", "g", "b"],
    };
  }
  if (name === "baseColor") {
    if (!meta.sh0) return { text: "not described by this container" };
    const sh0 = decodeRange(pixel, meta.sh0, observed.sh0, 3);
    return {
      labels: ["r", "g", "b"],
      values: sh0.map((value) => clamp01(0.5 + value * SH_C0)),
      channels: ["r", "g", "b"],
    };
  }
  if (name === "opacity") {
    if (!meta.opacities) return { text: "not described by this container" };
    const [logit] = decodeRange(pixel, meta.opacities, observed.opacity, 1);
    return { labels: ["α"], values: [logistic(logit)], channels: ["r"] };
  }
  if (name === "scales") {
    if (!meta.scales) return { text: "not described by this container" };
    return {
      labels: ["s_x", "s_y", "s_z"],
      values: decodeRange(pixel, meta.scales, observed.scales, 3).map(Math.exp),
      channels: ["r", "g", "b"],
    };
  }
  if (name === "rotations") {
    if (!meta.quats) return { text: "not described by this container" };
    const [w, x, y, z] = decodeRange(pixel, meta.quats, observed.rotations, 4);
    const length = Math.hypot(x, y, z, w) || 1;
    return {
      labels: ["q_x", "q_y", "q_z", "q_w"],
      values: [x / length, y / length, z / length, w / length],
      channels: ["g", "b", "a", "r"],
    };
  }
  if (name === "mask") return { text: context.active ? "active" : "pruned" };
  if (name === "shLabels") {
    const found = codebookLookup(pixel, meta.shN);
    return { text: found ? `centroid ${found.cluster} (${found.label}, ${found.slice})` : "—" };
  }
  if (name === "shCentroids") {
    if (!meta.shN?.centroidsMins || !meta.shN?.centroidsMaxs) {
      return { text: "not described by this container" };
    }
    const coefficient = Number(context.coefficient) || 0;
    const stride = meta.shN.tileRows * meta.shN.tileCols;
    const mins = [0, 1, 2].map((channel) => channelOf(meta.shN.centroidsMins, channel * stride + coefficient));
    const maxs = [0, 1, 2].map((channel) => channelOf(meta.shN.centroidsMaxs, channel * stride + coefficient));
    return {
      labels: ["R", "G", "B"],
      values: pixel.slice(0, 3).map((value, channel) =>
        lerp(mins[channel], maxs[channel],
          (value - observed.codebook.lo) / (observed.codebook.hi - observed.codebook.lo + EPSILON))),
      channels: ["r", "g", "b"],
    };
  }
  return { text: "—" };
};

/* -------------------------------------------------------------------------- *
 * the widget
 * -------------------------------------------------------------------------- */

/** Wait for one plane's pixels to exist.
 *
 * The planes are `loading="lazy"` inside a closed disclosure, so on the first
 * open they have not started loading at all -- and `decode()` on an image in
 * that state never settles in Firefox, which left the whole probe permanently
 * unprepared there while Chromium happened to resolve it. Ask for the load
 * explicitly, then wait for the event rather than for a decode that may never
 * come. An error resolves too: one missing plane must not hang the rest.
 *
 * @param {HTMLImageElement} image
 */
const planePixels = (image) => {
  image.loading = "eager";
  if (image.complete) return image.decode().catch(() => undefined);
  return new Promise((done) => {
    const settle = () => {
      image.removeEventListener("load", settle);
      image.removeEventListener("error", settle);
      done(undefined);
    };
    image.addEventListener("load", settle);
    image.addEventListener("error", settle);
  });
};

/** Planes that are one grid cell per Gaussian, so a pixel addresses a splat. */
const SYNCHRONIZED = new Set([
  "positionCoarse", "positionDetail", "baseColor", "opacity",
  "scales", "rotations", "mask", "shLabels",
]);

/** One canvas per plane, read a pixel at a time rather than kept as an array.
 *
 * Canvas 2D storage is premultiplied by specification, so `drawImage` followed by
 * `getImageData` is a lossy round trip for any pixel whose alpha is not 255 —
 * measured at up to 2/255 per channel in all three engines (Q3, BROWSERS.md).
 * Every plane read here is opaque, where premultiplying by 255 is the identity:
 * mask, coarse and detail positions, scales and the SH labels. The one plane in a
 * bundle whose alpha carries data is `rotations` — the quaternion is stored
 * scalar-first — and reading it through this reader would be silently wrong.
 */
const readerFrom = (/** @type {Uint8ClampedArray} */ data, /** @type {number} */ width, /** @type {number} */ height) => ({
  width,
  height,
  /** @param {number} x @param {number} y */
  at: (x, y) => [...data.slice((y * width + x) * 4, (y * width + x + 1) * 4)],
  /** @param {number} y */
  row: (y) => data.slice(y * width * 4, (y + 1) * width * 4),
  all: () => data,
});

const canvasPixelReader = (/** @type {HTMLImageElement} */ image) => {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  return readerFrom(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height,
  );
};

const bitmapPixelReader = (/** @type {ImageBitmap} */ bitmap) => {
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) return null;
    return readerFrom(new Uint8ClampedArray(pixels.buffer), width, height);
  } catch {
    return null;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
};

const bitmapReaderFrom = async (/** @type {string} */ source) => {
  if (typeof createImageBitmap !== "function") return null;
  const response = await fetch(source).catch(() => null);
  if (!response?.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  }).catch(() => null);
  if (!bitmap) return null;
  try {
    return bitmapPixelReader(bitmap);
  } finally {
    bitmap.close();
  }
};

const ALPHA_PROBE = [
  255, 128, 3, 1, 7, 200, 255, 2, 250, 5, 120, 128, 33, 66, 99, 255,
];
const ALPHA_PROBE_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAHElEQVR4AQERAO7/AP+AAwEHyP8C+gV4gCFCY/86/gcQIyG3IQAAAABJRU5ErkJggg==";
/** @type {Promise<boolean> | null} */
let bitmapPathExact = null;

/** Exact RGBA readback for the alpha-carrying quaternion plane.
 *
 * Firefox's WebCodecs surface premultiplies this plane, but a Firefox capable
 * of running the renderer has the viewer's fallback available: encoded bytes
 * -> explicitly unpremultiplied ImageBitmap -> WebGL2 RGBA8 readback. As in the
 * viewer, exactness is measured with a low-alpha probe before trusting the path;
 * WebKit's almost-right 63/95/127 result is therefore rejected, not displayed.
 */
const exactPixelReader = async (/** @type {HTMLImageElement} */ image) => {
  bitmapPathExact ??= (async () => {
    const probe = await bitmapReaderFrom(ALPHA_PROBE_URL);
    const pixels = probe?.all();
    return Boolean(pixels && pixels.length === ALPHA_PROBE.length
      && ALPHA_PROBE.every((value, index) => pixels[index] === value));
  })();
  if (!await bitmapPathExact) return null;
  return bitmapReaderFrom(image.currentSrc || image.src);
};

/**
 * @param {HTMLElement} details
 * @param {SizeManifest | null} manifest
 * @param {{
 *   selectSplat: (index: number | null) => void,
 *   steerToPoint: (position: readonly number[], scale: number) => void,
 *   stopSteering: () => void,
 *   sceneTransform: (tier: string, scene: string) => SceneTransform | null,
 * }} bridge
 */
export const planeProbe = (details, manifest, bridge) => {
  const images = /** @type {HTMLImageElement[]} */ (
    [...details.querySelectorAll("[data-plane-image]")]
  );
  const cursors = new Map(
    [...details.querySelectorAll("[data-plane-cursor]")].map((node) => [
      /** @type {HTMLElement} */ (node).dataset.planeCursor ?? "",
      /** @type {HTMLElement} */ (node),
    ]),
  );
  const readout = /** @type {HTMLElement | null} */ (
    details.querySelector("[data-plane-readout]")
  );
  const positionReadout = /** @type {HTMLOutputElement | null} */ (
    details.querySelector("[data-plane-position]")
  );
  const rawOutputs = new Map(
    [...details.querySelectorAll("[data-plane-raw]")].map((node) => [
      /** @type {HTMLElement} */ (node).dataset.planeRaw ?? "",
      /** @type {HTMLOutputElement} */ (node),
    ]),
  );
  const decodedOutputs = new Map(
    [...details.querySelectorAll("[data-plane-decoded]")].map((node) => [
      /** @type {HTMLElement} */ (node).dataset.planeDecoded ?? "",
      /** @type {HTMLOutputElement} */ (node),
    ]),
  );
  const links = /** @type {SVGSVGElement | null} */ (
    details.querySelector("[data-plane-links]")
  );
  const linkPath = /** @type {SVGPathElement | null} */ (
    details.querySelector("[data-plane-link-path]")
  );
  const byName = new Map(images.map((image) => [image.dataset.planeImage ?? "", image]));

  // Progressive enhancement (V3-AL). The static document ships each plane as a
  // named picture; pointing at a pixel is this module, so this module is what
  // makes the image focusable and what promises the renderer will move.
  for (const image of images) {
    if (!image.hasAttribute("data-plane-probeable")) continue;
    image.tabIndex = 0;
    image.setAttribute(
      "aria-label",
      `${image.getAttribute("alt") || "This"}: point at a pixel to move the renderer to that Gaussian`,
    );
  }

  /** @type {{point: string, side: number, readers: Map<string, ReturnType<typeof canvasPixelReader>>, meta: any, observed: Record<string, {lo:number,hi:number}>, rowStarts: Int32Array, transform: SceneTransform | null} | null} */
  let decoded = null;
  /** @type {string} */
  let decodingPoint = "";
  let pinned = false;
  /**
   * What the overlay is currently showing: the probed pixel and the codebook
   * cells its label names. Both the cursors and the leader lines are placed from
   * `getBoundingClientRect()` at the moment of the probe, so a divider drag or a
   * window resize moves every box out from under them. Keeping the *selection*
   * rather than the geometry is what lets them be redrawn from the new boxes.
   * @type {{u: number, v: number, found: ReturnType<typeof codebookLookup>} | null}
   */
  let overlay = null;
  /** @type {{u:number,v:number} | null} */
  let codebookSelection = null;
  let landed = { scene: "", tier: "" };
  /** A hover that arrived before the planes had been decoded. @type {[number, number, boolean] | null} */
  let pending = null;

  /**
   * Why the last preparation gave up, if it did. It survives `clear()`, because
   * the pointer leaving a plane does not make the failure untrue, and it is the
   * only thing that tells a visitor the wall is not simply unresponsive.
   * @type {string}
   */
  let failure = "";

  const clear = () => {
    pending = null;
    overlay = null;
    codebookSelection = null;
    for (const cursor of cursors.values()) cursor.hidden = true;
    linkPath?.setAttribute("d", "");
    if (readout) readout.textContent = failure;
    if (positionReadout) positionReadout.textContent = "—";
    for (const output of [...rawOutputs.values(), ...decodedOutputs.values()]) {
      output.textContent = "—";
    }
    bridge.stopSteering();
    bridge.selectSplat(null);
  };

  /**
   * Decode what one probe needs: the mask's ranks and two observed ranges.
   *
   * Preparation latches its operating point so that two hovers cannot decode the
   * same planes twice — and the latch is the hazard. Held through a failure it
   * makes the point permanently unpreparable: every later `prepare()` returns as
   * "already decoding", and the only recovery is to land a different scene and
   * come back. So the whole body runs inside `try`/`finally`, the `finally`
   * releases the latch whenever it still owns the key and nothing was decoded,
   * and the failure is stated in the readout instead of being swallowed. The
   * retry is the next pointer or focus action, because `probe()` asks for
   * preparation again when it finds nothing decoded.
   */
  const prepare = async () => {
    const key = `${landed.tier}/${landed.scene}`;
    if (decoded?.point === key || decodingPoint === key) return;
    const base = manifest?.assetsBase;
    const metaFile = manifest?.metaFile;
    if (!base || !metaFile || !landed.scene || !landed.tier) return;
    decodingPoint = key;
    /** A way out that is nobody's fault: a newer point took the latch. */
    const superseded = () => decodingPoint !== key;
    try {
      await Promise.all(images.map(planePixels));
      if (superseded()) return;
      const response = await fetch(`${base}/${landed.tier}/${landed.scene}/${metaFile}`)
        .catch(() => null);
      if (superseded()) return;
      if (!response || !response.ok) throw new Error(`meta.json: ${response?.status ?? "no response"}`);
      const meta = await response.json().catch(() => null);
      if (superseded()) return;
      if (!meta) throw new Error("meta.json is not JSON");
      const readers = new Map();
      for (const [name, image] of byName) {
        readers.set(
          name,
          name === "rotations" ? await exactPixelReader(image) : canvasPixelReader(image),
        );
      }
      const mask = readers.get("mask");
      const high = readers.get("positionCoarse");
      const low = readers.get("positionDetail");
      const scales = readers.get("scales");
      if (superseded()) return;
      if (!mask || !high || !low || !scales) throw new Error("a plane the probe needs is missing");
      // A plane whose image never arrived still yields a reader — over a 0x0
      // canvas, whose `getImageData` throws. Saying so here is a great deal
      // clearer than an IndexSizeError from inside `observedRange`.
      for (const [name, reader] of readers) {
        if (name === "rotations" && !reader) continue;
        if (!reader?.width || !reader.height) throw new Error(`the ${name} plane decoded to nothing`);
      }
      const side = Number(meta.gridSide) || mask.width;
      if (!Number.isFinite(side) || side <= 0) throw new Error("the grid has no side length");
      if (mask.width < side) throw new Error("the mask is narrower than the grid it indexes");
      const combined = combinedRangeSource(high.all(), low.all());
      const coarse = coarseRangeSource(high.all());
      /** @param {string} name @param {number} channels */
      const rangeOf = (name, channels) => {
        const reader = readers.get(name);
        return reader ? observedRange(reader.all(), channels) : { lo: 0, hi: 0 };
      };
      decoded = {
        point: key,
        side,
        readers,
        meta,
        // Every observed range is a whole-plane fact, so it is computed once
        // per operating point rather than once per hover.
        observed: {
          combined: observedRange(combined, 3),
          coarse: observedRange(coarse, 3),
          sh0: rangeOf("baseColor", 3),
          opacity: rangeOf("opacity", 1),
          scales: rangeOf("scales", 3),
          rotations: rangeOf("rotations", 4),
          codebook: rangeOf("shCentroids", 3),
        },
        rowStarts: maskRowStarts(mask.all(), side),
        transform: bridge.sceneTransform(landed.tier, landed.scene),
      };
      failure = "";
      details.dataset.probeReady = "";
      if (pending) {
        const [u, v, steer] = pending;
        pending = null;
        probe(u, v, steer);
      }
    } catch (error) {
      if (superseded()) return;
      console.error("the plane probe could not prepare this operating point", error);
      failure = "These planes could not be read. Point at one again to try once more.";
      pending = null;
      if (readout) readout.textContent = failure;
    } finally {
      // Whatever happened, the latch is only worth keeping if it is guarding a
      // decode that actually produced something.
      if (decodingPoint === key && decoded?.point !== key) decodingPoint = "";
    }
  };

  /**
   * The combined 16-bit words, packed back into a byte-strided buffer so one
   * `observedRange` serves both planes. Values exceed 255, so this is a plain
   * array rather than clamped bytes.
   * @param {Uint8ClampedArray} high
   * @param {Uint8ClampedArray} low
   */
  function combinedRangeSource(high, low) {
    const combined = new Float64Array(high.length);
    for (let index = 0; index < high.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        combined[index + channel] = low[index + channel] + 256 * high[index + channel];
      }
    }
    return combined;
  }

  /** @param {Uint8ClampedArray} high */
  function coarseRangeSource(high) {
    const coarse = new Float64Array(high.length);
    for (let index = 0; index < high.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        coarse[index + channel] = 128 + 256 * high[index + channel];
      }
    }
    return coarse;
  }

  /** @param {HTMLImageElement} image @param {number} u @param {number} v */
  const showCursor = (image, u, v) => {
    const name = image.dataset.planeImage ?? "";
    const cursor = cursors.get(name);
    if (!cursor) return;
    const scale = image.clientWidth / (image.naturalWidth || 1);
    cursor.hidden = false;
    cursor.style.left = `${(u + 0.5) * scale}px`;
    cursor.style.top = `${(v + 0.5) * scale}px`;
  };

  /** The leader lines from the hovered index pixel into the codebook mosaic. */
  const drawLinks = (
    /** @type {ReturnType<typeof codebookLookup>} */ found,
    /** @type {number} */ u,
    /** @type {number} */ v,
  ) => {
    const labels = byName.get("shLabels");
    const codebook = byName.get("shCentroids");
    if (!links || !linkPath || !labels || !codebook || !found) return;
    const frame = links.getBoundingClientRect();
    links.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
    /** @param {HTMLImageElement} image @param {number} x @param {number} y */
    const point = (image, x, y) => {
      const bounds = image.getBoundingClientRect();
      return [
        bounds.left - frame.left + ((x + 0.5) / image.naturalWidth) * bounds.width,
        bounds.top - frame.top + ((y + 0.5) / image.naturalHeight) * bounds.height,
      ];
    };
    const from = point(labels, u, v);
    linkPath.setAttribute(
      "d",
      found.cells
        .map((cell) => {
          const to = point(codebook, cell[0], cell[1]);
          return `M${from[0].toFixed(1)},${from[1].toFixed(1)} L${to[0].toFixed(1)},${to[1].toFixed(1)}`;
        })
        .join(" "),
    );
  };

  const rawChannels = /** @type {Record<string, string[]>} */ ({
    mask: ["R"],
    positionCoarse: ["R", "G", "B"],
    positionDetail: ["R", "G", "B"],
    baseColor: ["R", "G", "B"],
    opacity: ["R"],
    scales: ["R", "G", "B"],
    rotations: ["R", "G", "B", "A"],
    shLabels: ["R", "G"],
    shCentroids: ["R", "G", "B"],
  });

  /** @param {HTMLElement | undefined} output @param {{labels?:string[],values?:number[],channels?:string[],text?:string}} value @param {boolean} [byte] */
  const renderValue = (output, value, byte = false) => {
    if (!output) return;
    output.replaceChildren();
    if (value.text !== undefined) {
      output.textContent = value.text;
      return;
    }
    (value.values ?? []).forEach((number, index) => {
      const item = document.createElement("span");
      item.className = "plane-value";
      const symbol = document.createElement("span");
      const channel = value.channels?.[index] ?? "";
      symbol.className = `plane-value-symbol plane-channel-${channel}`;
      const label = value.labels?.[index] ?? "";
      const [base, subscript] = label.split("_");
      symbol.append(base);
      if (subscript) {
        const sub = document.createElement("sub");
        sub.textContent = subscript;
        symbol.append(sub);
      }
      const renderedNumber = document.createElement("span");
      renderedNumber.className = "plane-value-number";
      renderedNumber.textContent = formatInspectorNumber(number, byte);
      item.append(symbol, renderedNumber);
      output.append(item);
    });
    if (!output.childNodes.length) output.textContent = "—";
  };

  /** @param {string} name @param {readonly number[]} pixel */
  const renderRaw = (name, pixel) => {
    const labels = rawChannels[name] ?? [];
    renderValue(rawOutputs.get(name), {
      labels,
      values: pixel.slice(0, labels.length),
      channels: labels.map((label) => label.toLowerCase()),
    }, true);
  };

  /** Update every compact card from the one synchronized grid coordinate. */
  /** @param {number} u @param {number} v @param {number | null} index @param {ReturnType<typeof codebookLookup>} found */
  const updateInspector = (u, v, index, found) => {
    if (!decoded) return;
    const high = decoded.readers.get("positionCoarse");
    const low = decoded.readers.get("positionDetail");
    const labels = decoded.readers.get("shLabels");
    if (!high || !low) return;
    const context = {
      meta: decoded.meta,
      observed: decoded.observed,
      high: high.at(u, v),
      low: low.at(u, v),
      label: labels?.at(u, v) ?? [0, 0, 0, 255],
      active: index !== null,
    };
    if (positionReadout) positionReadout.textContent = `(${u}, ${v})`;
    for (const image of images) {
      const name = image.dataset.planeImage ?? "";
      if (name === "shCentroids") {
        rawOutputs.get(name)?.replaceChildren(
          document.createTextNode(found ? `${found.cells.length} linked texels` : "—"),
        );
        decodedOutputs.get(name)?.replaceChildren(
          document.createTextNode(found ? `centroid ${found.cluster}` : "—"),
        );
        continue;
      }
      const reader = decoded.readers.get(name);
      if (!reader) {
        const raw = rawOutputs.get(name);
        const reconstructed = decodedOutputs.get(name);
        if (raw) raw.textContent = "unavailable in this browser";
        if (reconstructed) reconstructed.textContent = "unavailable in this browser";
        continue;
      }
      const pixel = reader.at(u, v);
      renderRaw(name, pixel);
      renderValue(decodedOutputs.get(name), inspectorValue(name, pixel, context));
    }
  };

  /** @param {number} u @param {number} v @param {boolean} steer */
  const probe = (u, v, steer) => {
    // A pointer can reach a plane before its pixels have been decoded -- one
    // slow fetch is enough, and Firefox loses this race where Chromium wins it.
    // Dropping that hover left the interaction dead until the pointer moved
    // again, which for a visitor who has already stopped moving is never.
    if (!decoded) {
      pending = [u, v, steer];
      // Also the retry after a failed preparation: `prepare()` latches its own
      // operating point, so asking again while one is in flight costs nothing,
      // and a visitor never has to know a fetch failed.
      void prepare();
      return;
    }
    const { side, readers, meta } = decoded;
    if (u < 0 || v < 0 || u >= side || v >= side) return;
    const mask = readers.get("mask");
    const high = readers.get("positionCoarse");
    const low = readers.get("positionDetail");
    const scales = readers.get("scales");
    const labels = readers.get("shLabels");
    if (!mask || !high || !low || !scales) return;
    const index = compactedIndexAt(decoded.rowStarts[v], mask.row(v), u);
    for (const image of images) {
      if (SYNCHRONIZED.has(image.dataset.planeImage ?? "")) showCursor(image, u, v);
    }
    const found = labels ? codebookLookup(labels.at(u, v), meta.shN) : null;
    if (found) drawLinks(found, u, v);
    overlay = { u, v, found };
    updateInspector(u, v, index, found);
    if (index === null) {
      bridge.selectSplat(null);
      bridge.stopSteering();
      if (readout) {
        readout.textContent =
          `Pixel ${u}, ${v} — pruned by the active mask, so there is no Gaussian here.`;
      }
      return;
    }
    const local = localMean(
      combinedMean(high.at(u, v), low.at(u, v)),
      meta.means,
      decoded.observed.combined,
    );
    const world = worldPoint(local, decoded.transform);
    const radius = maxScaleOf(scales.at(u, v), meta.scales, decoded.observed.scales);
    bridge.selectSplat(index);
    if (steer) bridge.steerToPoint(world, radius);
    if (readout) {
      const place = world.map((value) => value.toFixed(2)).join(", ");
      readout.textContent =
        `Pixel ${u}, ${v} is Gaussian ${index.toLocaleString("en-US")} at (${place})`
        + (found ? `, using codebook centroid ${found.label}, ${found.slice}.` : ".");
    }
  };

  /** @param {HTMLImageElement} image @param {PointerEvent} event */
  const pixelAt = (image, event) => {
    const bounds = image.getBoundingClientRect();
    const scale = image.naturalWidth / (bounds.width || 1);
    return [
      Math.floor((event.clientX - bounds.left) * scale),
      Math.floor((event.clientY - bounds.top) * scale),
    ];
  };

  let cursor = [0, 0];
  for (const image of images) {
    if (!SYNCHRONIZED.has(image.dataset.planeImage ?? "")) continue;
    image.addEventListener("pointermove", (event) => {
      if (pinned) return;
      cursor = pixelAt(image, /** @type {PointerEvent} */ (event));
      probe(cursor[0], cursor[1], true);
    });
    image.addEventListener("pointerleave", () => {
      if (!pinned) clear();
    });
    // A tap has no hover, so it pins: the readout and the camera stay on that
    // Gaussian until the next tap. This is also what makes the interaction
    // reachable without a pointing device at all.
    image.addEventListener("click", (event) => {
      cursor = pixelAt(image, /** @type {PointerEvent} */ (event));
      pinned = true;
      probe(cursor[0], cursor[1], true);
    });
    image.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 16 : 1;
      const moves = /** @type {Record<string, number[]>} */ ({
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      });
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        pinned = true;
        cursor = [
          Math.min(Math.max(cursor[0] + move[0], 0), (decoded?.side ?? 1) - 1),
          Math.min(Math.max(cursor[1] + move[1], 0), (decoded?.side ?? 1) - 1),
        ];
        probe(cursor[0], cursor[1], true);
      } else if (event.key === "Escape") {
        pinned = false;
        clear();
      }
    });
    image.addEventListener("blur", () => {
      if (!pinned) clear();
    });
    image.addEventListener("focus", () => {
      if (!overlay) {
        const side = decoded?.side ?? image.naturalWidth ?? 1;
        cursor = [Math.floor(side / 2), Math.floor(side / 2)];
      }
      probe(cursor[0], cursor[1], true);
    });
  }

  const codebook = byName.get("shCentroids");
  /** @param {number} u @param {number} v */
  const inspectCodebook = (u, v) => {
    if (!decoded || !codebook) return;
    const reader = decoded.readers.get("shCentroids");
    if (!reader || u < 0 || v < 0 || u >= reader.width || v >= reader.height) return;
    const side = Number(decoded.meta.shN?.centroidSide) || 1;
    const tileColumn = Math.floor(u / side);
    const tileRow = Math.floor(v / side);
    const coefficient = tileRow * Number(decoded.meta.shN?.tileCols || 1) + tileColumn;
    const pixel = reader.at(u, v);
    renderRaw("shCentroids", pixel);
    renderValue(decodedOutputs.get("shCentroids"), inspectorValue("shCentroids", pixel, {
      meta: decoded.meta,
      observed: decoded.observed,
      coefficient,
    }));
    if (positionReadout) positionReadout.textContent = `(${u}, ${v}), coefficient ${coefficient + 1}`;
    if (readout) readout.textContent = `Codebook coefficient ${coefficient + 1}, RGB triplet at texel ${u}, ${v}.`;
    for (const cursorNode of cursors.values()) cursorNode.hidden = true;
    linkPath?.setAttribute("d", "");
    showCursor(codebook, u, v);
    codebookSelection = { u, v };
    overlay = null;
  };
  if (codebook) {
    codebook.tabIndex = 0;
    codebook.setAttribute("aria-label", "Colour codebook: inspect one coefficient texel");
    codebook.addEventListener("pointermove", (event) => {
      if (pinned) return;
      const [u, v] = pixelAt(codebook, /** @type {PointerEvent} */ (event));
      inspectCodebook(u, v);
    });
    codebook.addEventListener("pointerleave", () => { if (!pinned) clear(); });
    codebook.addEventListener("click", (event) => {
      const [u, v] = pixelAt(codebook, /** @type {PointerEvent} */ (event));
      pinned = true;
      inspectCodebook(u, v);
    });
    codebook.addEventListener("focus", () => {
      const side = Number(decoded?.meta.shN?.centroidSide) || codebook.naturalWidth || 1;
      inspectCodebook(Math.floor(side / 2), Math.floor(side / 2));
    });
    codebook.addEventListener("keydown", (event) => {
      if (!codebookSelection) return;
      const moves = /** @type {Record<string, number[]>} */ ({
        ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        ArrowUp: [0, -1], ArrowDown: [0, 1],
      });
      const move = moves[event.key];
      if (move) {
        event.preventDefault();
        pinned = true;
        inspectCodebook(codebookSelection.u + move[0], codebookSelection.v + move[1]);
      } else if (event.key === "Escape") {
        pinned = false;
        clear();
      }
    });
    codebook.addEventListener("blur", () => { if (!pinned) clear(); });
  }

  /**
   * Redraw the overlay where the wall is *now*. Placement only: no pixel is read
   * again, the renderer is not touched, and nothing is announced — this is the
   * same selection, drawn against boxes that have moved.
   */
  const refreshOverlay = () => {
    if (codebookSelection && codebook) {
      showCursor(codebook, codebookSelection.u, codebookSelection.v);
      return;
    }
    if (!overlay || !decoded) return;
    for (const image of images) {
      if (SYNCHRONIZED.has(image.dataset.planeImage ?? "")) showCursor(image, overlay.u, overlay.v);
    }
    if (overlay.found) drawLinks(overlay.found, overlay.u, overlay.v);
  };

  // The divider is draggable and the window is resizable, and both move every
  // box the overlay was placed from. A pinned selection is the case that makes
  // this visible, because it is the one that outlives the pointer.
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => refreshOverlay()).observe(details);
  }

  details.addEventListener("toggle", () => {
    if (/** @type {HTMLDetailsElement} */ (details).open) void prepare();
    else {
      pinned = false;
      clear();
    }
  });

  return (/** @type {PageState} */ state) => {
    const next = { scene: state.scene ?? "", tier: state.size ?? "" };
    if (next.scene === landed.scene && next.tier === landed.tier) return;
    landed = next;
    // A new operating point is a different file: the old ranks and ranges
    // describe a scene that is no longer on screen.
    decoded = null;
    decodingPoint = "";
    failure = "";
    pinned = false;
    delete details.dataset.probeReady;
    clear();
    if (/** @type {HTMLDetailsElement} */ (details).open) void prepare();
  };
};
