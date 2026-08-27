// @ts-check
/** M7's byte-accounting figure and the band controls that manipulate it.
 *
 * @typedef {import("./viewer-bridge.js").PageState} PageState
 * @typedef {import("./controls.js").SizeManifest} SizeManifest
 * @typedef {import("@viewer/viewer-contracts").AttributeKey} AttributeKey
 */

import { formatBytes } from "./viewer-bridge.js";

const DECOMPOSE_ORDER = /** @type {const} */ ([
  "shAc", "rotations", "scales", "opacity", "shDc", "positionDetail",
]);

/** The explicit animation's mutations, kept pure so timing never enters its gate. */
export const decompositionSteps = () => [
  ...DECOMPOSE_ORDER.map((key) => ({ [key]: false })),
  ...[...DECOMPOSE_ORDER].reverse().map((key) => ({ [key]: true })),
  {
    positionDetail: true,
    shDc: true,
    shAc: true,
    scales: true,
    rotations: true,
    opacity: true,
  },
];

/**
 * Attributes whose visitor toggle snaps instead of taking ffsplat's 2.25 s
 * fade (R2, V3-BC). View-dependent colour is a subtle effect: faded, the eye
 * cannot tell the two states apart, so the switch appears to do nothing.
 * Every other attribute keeps the fade, which is what makes a plane's absence
 * legible. Section intents (`apply()`) are untouched by this rule.
 */
const SNAP_TOGGLES = new Set(["shAc"]);

/**
 * The `attributes.set` options for one visitor toggle; pure so it is testable.
 * @param {string} key
 */
export const toggleOptions = (key) => (SNAP_TOGGLES.has(key) ? { immediate: true } : undefined);

/** The stack's segments, in the order the switches are in. `overhead` follows. */
export const STACK_ORDER = /** @type {const} */ ([
  "positionCoarse", "positionDetail", "shDc", "opacity", "scales", "rotations", "shAc",
]);

/**
 * V3-N's byte composition, as data.
 *
 * The figure's promise is that its segments *are* the file: the seven attributes
 * plus the container's own metadata and active mask, summing to the total the
 * stat card prints. So the remainder is computed rather than measured, and if
 * the parts do not fit inside the whole — a missing plane, a stale total, a
 * viewer reporting one attribute twice — this returns `null` and the figure
 * keeps the last honest state instead of drawing an accounting that is wrong.
 *
 * @param {Record<string, number> | null | undefined} sizes
 * @param {number | null | undefined} total
 * @returns {{key: string, bytes: number, share: number, label: string, exact: string, percent: string}[] | null}
 */
export const byteStack = (sizes, total) => {
  const whole = Number(total);
  if (!sizes || !Number.isFinite(whole) || whole <= 0) return null;
  const parts = STACK_ORDER.map((key) => Number(sizes[key]));
  if (parts.some((bytes) => !Number.isFinite(bytes) || bytes < 0)) return null;
  const remainder = whole - parts.reduce((sum, bytes) => sum + bytes, 0);
  if (remainder < 0) return null;
  return [
    ...STACK_ORDER.map((key, index) => ({ key, bytes: parts[index] })),
    { key: "overhead", bytes: remainder },
  ]
    .map(({ key, bytes }) => ({
      key,
      bytes,
      share: bytes / whole,
      // Decimal units on screen; the exact count for a screen reader (V3-N).
      label: formatBytes(bytes),
      exact: `${bytes.toLocaleString("en-US")} bytes`,
      percent: `${((bytes / whole) * 100).toFixed(1)}%`,
    }));
};

/**
 * The ribbon joining each segment of the bar to its row in the legend.
 *
 * The author's complaint was structural: the bar is proportional and the legend
 * cannot be, because a 0.1% row would be unreadable — so the two orders drift
 * apart and the reader has to guess which label belongs to which band. A ribbon
 * per segment removes the guess.
 *
 * Both ends are arithmetic in the SVG's own normalized units — the bar side from
 * the cumulative bytes, the legend side from the row index over equal rows — so
 * this measures no layout, needs no observer, and produces the same path the
 * build already wrote into the markup.
 *
 * @param {{key: string, bytes: number}[] | null} stack
 * @returns {{key: string, d: string}[] | null}
 */
export const stackLinks = (stack) => {
  if (!stack || !stack.length) return null;
  const total = stack.reduce((sum, segment) => sum + segment.bytes, 0);
  if (!(total > 0)) return null;
  const rows = stack.length;
  const round = (/** @type {number} */ value) => String(Number(value.toFixed(3)));
  let consumed = 0;
  return stack.map((segment, index) => {
    const top = (consumed * 1000) / total;
    consumed += segment.bytes;
    const bottom = (consumed * 1000) / total;
    const rowTop = (index * 1000) / rows;
    const rowBottom = ((index + 1) * 1000) / rows;
    return {
      key: segment.key,
      d: `M0,${round(top)} L100,${round(rowTop)} L100,${round(rowBottom)} L0,${round(bottom)} Z`,
    };
  });
};

/**
 * The byte stack and its compact band legend are one widget: both render from
 * the bridge's attribute snapshot, and neither keeps a competing model.
 * Build-derived values remain in the stack until the viewer publishes, which is
 * also the complete renderer-off and no-JavaScript state.
 *
 * @param {HTMLElement} slot
 * @param {HTMLElement} figure
 * @param {{setAttributes: (next: Record<string, boolean>, options?: {immediate?: boolean}) => Promise<void>}} bridge
 * @param {SizeManifest | null} manifest
 * @param {HTMLElement | null} inspector
 */
export const attributeBreakdown = (slot, figure, bridge, manifest, inspector = null) => {
  const group = /** @type {HTMLElement | null} */ (slot.querySelector('[data-control="attributes"]'));
  // Both instances of the mirrored switch (V3-AF): the renderer's attribute row
  // and the byte figure's legend, where the author asked for an attribute to be
  // toggled beside the bytes it costs. One widget, one bridge, so neither
  // instance can hold a state the other does not.
  const toggles = /** @type {HTMLButtonElement[]} */ ([
    ...slot.querySelectorAll("[data-attribute-toggle]"),
    ...figure.querySelectorAll("[data-attribute-toggle]"),
    ...(inspector?.querySelectorAll("[data-attribute-toggle]") ?? []),
  ]);
  const stack = /** @type {HTMLElement | null} */ (figure.querySelector("[data-byte-stack]"));
  const segments = /** @type {HTMLElement[]} */ (
    [...figure.querySelectorAll("[data-stack-segment]")]
  );
  const fills = /** @type {HTMLElement[]} */ (
    [...figure.querySelectorAll("[data-stack-fill]")]
  );
  const links = /** @type {SVGPathElement[]} */ (
    [...figure.querySelectorAll("[data-stack-link]")]
  );
  const action = /** @type {HTMLButtonElement | null} */ (
    figure.querySelector('[data-action="decompose-attributes"]')
  );
  let sequence = 0;
  let selection = "";
  let running = false;

  /** @param {PageState} state */
  const pointFor = (state) => {
    const scene = state.scene ?? manifest?.boot?.scene;
    const tier = state.size ?? manifest?.boot?.tier;
    return scene && tier
      ? manifest?.scenes?.[scene]?.points.find((point) => point.tier === tier) ?? null
      : null;
  };

  const stopSequence = () => {
    sequence += 1;
    running = false;
    if (action) action.setAttribute("aria-busy", "false");
  };

  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      const key = toggle.dataset.attributeToggle;
      if (!key || key === "positionCoarse") return;
      stopSequence();
      void bridge.setAttributes({ [key]: toggle.getAttribute("aria-checked") !== "true" }, toggleOptions(key));
    });
  }

  action?.addEventListener("click", async () => {
    stopSequence();
    const token = sequence;
    running = true;
    action.setAttribute("aria-busy", "true");
    const stepMs = Math.max(0, Number(action.dataset.stepMs) || 500);
    for (const step of decompositionSteps()) {
      if (token !== sequence) return;
      await bridge.setAttributes(step);
      if (token !== sequence) return;
      await new Promise((resolve) => window.setTimeout(resolve, stepMs));
    }
    if (token === sequence) {
      running = false;
      action.setAttribute("aria-busy", "false");
    }
  });

  return (/** @type {PageState} */ state) => {
    if (group) group.hidden = !state.unlocked.includes("attributes");
    const usable = state.renderer === "ready";
    const active = state.attributes;
    const readiness = state.attributeReadiness;
    for (const toggle of toggles) {
      const rawKey = toggle.dataset.attributeToggle;
      const foundational = rawKey === "positionCoarse";
      const key = foundational || !rawKey ? null : /** @type {AttributeKey} */ (rawKey);
      const enabled = foundational || (key && active ? active[key] !== false : true);
      toggle.setAttribute("aria-checked", String(enabled));
      toggle.disabled = foundational || !usable || Boolean(key && readiness && readiness[key] === false);
    }

    const nextSelection = `${state.scene ?? ""}/${state.size ?? ""}`;
    if (selection && nextSelection !== selection && running) {
      stopSequence();
      const complete = decompositionSteps().at(-1);
      if (complete) void bridge.setAttributes(complete, { immediate: true });
    }
    selection = nextSelection;

    const point = pointFor(state);
    const sizes = state.attributeSizes ?? point?.attributes ?? null;
    const total = state.sceneBytes ?? point?.bytes ?? null;
    const composition = byteStack(sizes, total);
    if (stack && composition) {
      // One transaction: the total and every segment move together, so the
      // figure is never a new attribute against an old denominator.
      stack.dataset.stackTotal = String(total);
      const bytesFor = new Map(composition.map((segment) => [segment.key, segment]));
      for (const fill of fills) {
        const segment = bytesFor.get(fill.dataset.stackFill ?? "");
        if (segment) fill.style.setProperty("--stack-share", String(segment.share));
      }
      const ribbons = new Map((stackLinks(composition) ?? []).map((link) => [link.key, link.d]));
      for (const link of links) {
        const d = ribbons.get(link.dataset.stackLink ?? "");
        if (d) link.setAttribute("d", d);
      }
      for (const row of segments) {
        const segment = bytesFor.get(row.dataset.stackSegment ?? "");
        if (!segment) continue;
        row.dataset.stackBytes = String(segment.bytes);
        row.dataset.stackExact = segment.exact;
        const label = row.querySelector("[data-stack-label]");
        const percent = row.querySelector("[data-stack-percent]");
        if (label) {
          label.textContent = segment.label;
          label.setAttribute("aria-label", segment.exact);
        }
        if (percent) percent.textContent = segment.percent;
      }
      figure.dataset.breakdownSource = state.attributeSizes ? "viewer" : "build";
    }
    if (action) action.disabled = !usable;
  };
};

/**
 * V3-O's raw-plane disclosure: the actual encoded images of the landed point.
 *
 * The markup arrives complete from the build, so a visitor with no JavaScript
 * opens the boot point's real files. This widget only moves it: when a different
 * scene or tier lands, every `src` and every byte count is rewritten from the
 * size manifest. Nothing is fetched while the disclosure is closed — a
 * `loading="lazy"` image inside a closed `<details>` is display:none — and the
 * URLs are the ones the renderer beside it already requested, so opening it is
 * mostly cache hits.
 *
 * The derivation `<assetsBase>/<tier>/<scene>/<file>` is the export's own
 * directory shape, which `load_size_matrix` asserts at build time rather than
 * this widget assuming.
 *
 * @param {HTMLElement} details
 * @param {SizeManifest | null} manifest
 */
export const planeDisclosure = (details, manifest) => {
  const images = /** @type {HTMLImageElement[]} */ (
    [...details.querySelectorAll("[data-plane-image]")]
  );
  const counts = /** @type {HTMLElement[]} */ (
    [...details.querySelectorAll("[data-plane-bytes]")]
  );
  const dimensions = new Map(
    [...details.querySelectorAll("[data-plane-dims]")].map((node) => [
      /** @type {HTMLElement} */ (node).dataset.planeDims ?? "",
      /** @type {HTMLElement} */ (node),
    ]),
  );
  /**
   * Every attribute plane is one cell per Gaussian, so the first one's width is
   * the scene's grid side and the unit every other plane is scaled against.
   *
   * That unit is only knowable once the base plane of the *current* point has
   * decoded, and the planes do not arrive in order: Garden's grid is 512 wide at
   * M and 720 at L, so a codebook that decodes first would otherwise be scaled
   * against the tier the visitor has left — or, while the base image is pending
   * and its `naturalWidth` is zero, against the width the build wrote into the
   * markup. Both are wrong and neither was ever recomputed. So the geometry is
   * derived in one place, does nothing until the unit is real, and runs again on
   * every load until it is.
   */
  const refreshPlaneGeometry = () => {
    const unit = images[0]?.naturalWidth;
    if (!unit) return;
    const spans = images
      .filter((image) => image.complete && image.naturalWidth)
      .map((image) => image.naturalWidth / unit);
    const largest = Math.max(1, ...spans);
    const drawnUnit = images[0]?.clientWidth || 0;
    for (const image of images) {
      if (!image.complete || !image.naturalWidth) continue;
      const dims = dimensions.get(image.dataset.planeImage ?? "");
      if (dims) {
        const channels = dims.dataset.planeChannels;
        dims.textContent = `${image.naturalWidth} × ${image.naturalHeight}${channels ? ` × ${channels}` : ""}`;
      }
      const span = image.naturalWidth / unit;
      const item = image.closest("li");
      if (!item) continue;
      item.style.setProperty("--plane-span", String(span));
      item.style.setProperty("--plane-relative-span", String(span / largest));
      if (item.dataset.planeGroup !== "attribute" && drawnUnit) {
        item.style.setProperty("--plane-drawn-width", `${drawnUnit * span}px`);
      }
    }
  };
  // Registered once, not per render: a tier change replaces every `src`, so a
  // one-shot listener would cover the first point and no other.
  for (const image of images) image.addEventListener("load", refreshPlaneGeometry);
  if ("ResizeObserver" in window) new ResizeObserver(refreshPlaneGeometry).observe(details);
  const files = new Map(
    (manifest?.planeFiles ?? []).map((plane) => [plane.name, plane.file]),
  );
  const base = manifest?.assetsBase ?? "";

  return (/** @type {PageState} */ state) => {
    const scene = state.scene;
    const tier = state.size;
    if (!scene || !tier || !base || !files.size) return;
    if (details.dataset.planeScene === scene && details.dataset.planeTier === tier) return;
    const point = manifest?.scenes?.[scene]?.points.find((entry) => entry.tier === tier);
    if (!point?.planes) return;
    for (const image of images) {
      const file = files.get(image.dataset.planeImage ?? "");
      if (file) image.src = `${base}/${tier}/${scene}/${file}`;
    }
    for (const count of counts) {
      const bytes = point.planes[count.dataset.planeBytes ?? ""];
      if (Number.isFinite(bytes)) count.textContent = formatBytes(bytes);
    }
    // The pixel size comes from the file itself once it has decoded: the grid
    // side is a property of the scene, and reading it off the image is exact
    // where a second copy in the manifest would be one more thing to keep true.
    for (const image of images) {
      const dims = dimensions.get(image.dataset.planeImage ?? "");
      if (dims && !(image.complete && image.naturalWidth)) dims.textContent = "…";
    }
    refreshPlaneGeometry();
    details.dataset.planeScene = scene;
    details.dataset.planeTier = tier;
  };
};
