// @ts-check
/**
 * A point the visitor asked for that is still on its way. A point that never
 * landed is not still arriving: the indicator stops, and the figures stay
 * covered because they are the scene the viewer never left, under controls that
 * now name a different one. Shared by the card and the phone strip (P2.1).
 * @param {PageState} state
 */
export const arriving = (state) => Boolean(state.arriving) && state.renderer === "ready" && !state.selectionError;

/**
 * The page-drawn widgets. Under decision A the iframe renders the canvas and
 * nothing else, so every control on this page is here.
 *
 * Each widget is one function returning a `render(state)`. A widget reads the
 * bridge's single state object and writes its own DOM; it never calls another
 * widget and never holds derived state. That constraint is small enough to look
 * arbitrary and it is the whole reason this file will not turn into v1's mesh of
 * `syncControlLabels` / `syncFallback` / `syncTourSurfaceLabels`.
 *
 * @typedef {import("./viewer-bridge.js").PageState} PageState
 */

import { formatBytes } from "./viewer-bridge.js";

/**
 * One exported operating point of one scene: the bytes the export contains and
 * the quality the paper measured for it, joined at build time.
 * @typedef {object} SizePoint
 * @property {string} tier   internal identifier — never shown to the visitor
 * @property {number} bytes
 * @property {number | null} psnr
 * @property {Record<string, number>} attributes
 * @property {number} attributeOverhead
 * @property {Record<string, number>} planes  per-plane bytes, for V3-O's disclosure
 */

/**
 * The build's size manifest, as embedded in `#size-data`.
 * @typedef {object} SizeManifest
 * @property {{scene: string, tier: string}} boot
 * @property {string} assetsBase
 * @property {{name: string, label: string, file: string}[]} planeFiles
 * @property {string} metaFile
 * @property {{label: string, compression: string, method: string}} series
 * @property {{label: string, short: string}} metric
 * @property {{dataset: string, label: string, scenes: {name: string, label: string}[]}[]} groups
 * @property {Record<string, {dataset: string, scene: string, points: SizePoint[]}>} scenes
 */

const SPLIT_STORAGE_KEY = "kissgs:split";
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

/**
 * How long the slider waits before selecting the point it is showing.
 *
 * Every stop on the track is a separate encoded scene, so a pointer sweep that
 * issued a selection per frame would issue sixty downloads. Long enough that a
 * sweep costs one, short enough that a deliberate step feels immediate.
 */
const SIZE_SETTLE_MS = 90;

/* -------------------------------------------------------------------------- *
 * pure
 * -------------------------------------------------------------------------- */

/**
 * Clamp a divider position, in percent of the window.
 *
 * The CSS does the real containment work — the grid track is a `clamp()` around
 * two hard pixel minimums, so neither panel can be squeezed to nothing whatever
 * this returns. This is only about not persisting an absurd number.
 * @param {number} value
 */
export const clampSplit = (value) =>
  Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value * 10) / 10));

/**
 * Read the persisted divider position, or null when there is nothing usable
 * stored. Blocked storage must never break the layout.
 */
export const readSplit = () => {
  try {
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampSplit(value) : null;
  } catch {
    return null;
  }
};

/**
 * A tick label: the scale under the track, not the value on it.
 *
 * Megabytes throughout, so seven labels read as one ruler — `formatBytes` would
 * switch the smallest stops to kilobytes and the eye would have to convert. The
 * precision falls away as the numbers grow, which is what makes a row of seven
 * legible: `0.12 MB`, `0.5 MB`, `3.9 MB`, `25 MB`. The exact figure remains in
 * the slider's accessible value and in the stat card, both from `formatBytes`.
 * @param {number} bytes
 */
export const formatMegabytes = (bytes) => {
  const megabytes = Number(bytes) / 1_000_000;
  if (!Number.isFinite(megabytes)) return "";
  const digits = megabytes >= 10 ? 0 : megabytes >= 1 ? 1 : 2;
  const text = megabytes.toFixed(digits);
  const trimmed = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  return `${trimmed} MB`;
};

/**
 * Where a stop sits along the track, as a fraction of the travel.
 *
 * Not a percentage of the track's width: a native range thumb travels between
 * its own half-widths, so a mark at 50% of the box and the thumb at value 3 of 6
 * are several pixels apart — visible, and wrong, once the track carries drawn
 * stops the thumb is supposed to land on. The CSS therefore interpolates this
 * fraction across `100% - <mark size>` and offsets by half a mark, which is the
 * thumb's own geometry, and the ruler above uses the same anchor so a label
 * names the stop it stands over.
 * @param {number} index
 * @param {number} count
 */
export const sizeStopFraction = (index, count) =>
  count > 1 ? Math.round((index / (count - 1)) * 10000) / 10000 : 0;

/**
 * The quality half of the read-out, or nothing when the point has no measured
 * quality. A tier the paper's data does not cover shows its megabytes and stays
 * silent about dB rather than inventing one.
 * @param {SizePoint | null} point
 * @param {string} metric
 */
export const formatQuality = (point, metric) =>
  point && typeof point.psnr === "number" && Number.isFinite(point.psnr)
    ? `${point.psnr.toFixed(1)} dB${metric ? ` ${metric}` : ""}`
    : "";

/**
 * What a screen reader hears for the slider's current position: the operating
 * point, in the page's own vocabulary.
 * @param {SizePoint | null} point
 * @param {string} metric
 */
export const describePoint = (point, metric) => {
  if (!point) return "";
  const quality = formatQuality(point, metric);
  return quality ? `${formatBytes(point.bytes)}, ${quality}` : formatBytes(point.bytes);
};

/* -------------------------------------------------------------------------- *
 * widgets
 * -------------------------------------------------------------------------- */

/**
 * Every `[data-stat]` on the page — in the stat card, in the fallback copy, and
 * inside the prose, where `[[bytes]]` tokens rendered into one at build time.
 * They are all the same widget because they are all the same fact.
 * @param {ParentNode} root
 */
export const statFigures = (root) => {
  const nodes = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("[data-stat]")]);
  /** The compact instrument panel uses short labels; prose keeps full terms. */
  const compact = (/** @type {string} */ key, /** @type {string} */ value) => {
    if (key === "count") {
      const count = Number(value.replace(/[^\d]/g, ""));
      if (!Number.isFinite(count)) return value;
      const [scale, suffix] = count >= 1_000_000
        ? [1_000_000, "M"]
        : count >= 1_000 ? [1_000, "k"] : [1, ""];
      return `${(count / scale).toFixed(1).replace(/\.0$/, "")}${suffix} splats`;
    }
    if (key === "bits") return value.replace(/ bits \/ Gaussian$/, " b/splat");
    return value;
  };
  return (/** @type {PageState} */ state) => {
    for (const node of nodes) {
      const key = /** @type {"bytes" | "count" | "bits"} */ (node.dataset.stat);
      const value = state.stats[key];
      if (value && value !== "unavailable") {
        const visible = node.hasAttribute("data-compact-stat") ? compact(key, value) : value;
        if (node.textContent !== visible) node.textContent = visible;
        if (node.hasAttribute("data-compact-stat")) node.setAttribute("aria-label", value);
      }
    }
  };
};

/**
 * Resolve the visitor-facing dataset and scene labels for an exported scene.
 * Internal keys such as `MipNeRF360-Garden` are identifiers, not copy: the
 * authored manifest supplies punctuation, spacing, and display names.
 * @param {SizeManifest | null} manifest
 * @param {string | null} sceneName
 */
export const labelsForScene = (manifest, sceneName) => {
  if (!manifest || !sceneName) return null;
  for (const group of manifest.groups || []) {
    const scene = group.scenes.find((entry) => entry.name === sceneName);
    if (scene) return { dataset: group.label, scene: scene.label };
  }
  return null;
};

/**
 * Keep `[[dataset]]` and `[[scene]]` prose tokens aligned with the landed scene.
 * @param {ParentNode} root
 * @param {SizeManifest | null} manifest
 */
export const sceneFigures = (root, manifest) => {
  const nodes = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("[data-scene-label]")]);
  return (/** @type {PageState} */ state) => {
    const labels = labelsForScene(manifest, state.scene);
    if (!labels) return;
    for (const node of nodes) {
      const key = /** @type {"dataset" | "scene"} */ (node.dataset.sceneLabel);
      if (node.textContent !== labels[key]) node.textContent = labels[key];
    }
  };
};

/**
 * The stat card's arrival state.
 *
 * While a scene the visitor asked for is still on its way, the card's figures
 * belong to the scene they left behind — a drag to 25 MB with `3.94 MB` still
 * under it. So the figures are covered rather than corrected: they stay in flow
 * and hold the card's box open, and the indicator sits in the same grid cell, so
 * nothing about this changes the card's size in either direction.
 *
 * `renderer === "ready"` is part of the test on purpose. Before the viewer has
 * published anything the figures come from the build, and the build's figures are
 * the boot scene's — correct, not stale, and the opening's central claim.
 * @param {HTMLElement} card
 * @param {{state: PageState, apply: (intent: {scene?: string, size?: string}) => unknown}} bridge
 */
export const sceneArrival = (card, bridge) => {
  const indicator = /** @type {HTMLElement | null} */ (card.querySelector(".stat-loading"));
  const bar = /** @type {HTMLElement | null} */ (card.querySelector("[data-load-bar]"));
  const figures = /** @type {HTMLElement | null} */ (card.querySelector(".stat-figures"));
  const readout = /** @type {HTMLElement | null} */ (card.querySelector(".stat-readout"));

  /**
   * The failure notice is built here rather than in the template because it can
   * only ever act with this module running: a static document that shipped a
   * Retry button would be shipping a control that cannot retry.
   */
  let failure = /** @type {HTMLElement | null} */ (null);
  let message = /** @type {HTMLElement | null} */ (null);
  const ensureFailure = () => {
    if (failure || !readout) return failure;
    failure = document.createElement("div");
    failure.className = "stat-failed";
    failure.setAttribute("role", "status");
    failure.setAttribute("aria-hidden", "true");
    message = document.createElement("span");
    message.setAttribute("data-selection-error-message", "");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "stat-retry";
    retry.setAttribute("data-selection-retry", "");
    retry.textContent = "Retry";
    // The requested pair is still the pending intent, so re-dispatching it is the
    // whole of a retry: the bridge decides again which viewer call satisfies it.
    retry.addEventListener("click", () => {
      const { scene, size } = bridge.state.requested;
      void bridge.apply({
        ...(scene ? { scene } : {}),
        ...(size ? { size } : {}),
      });
    });
    failure.append(message, retry);
    readout.append(failure);
    return failure;
  };

  return (/** @type {PageState} */ state) => {
    const error = state.selectionError;
    const onWay = arriving(state);
    if (onWay) card.dataset.loading = "";
    else delete card.dataset.loading;
    if (error) card.dataset.selectionError = error.status;
    else delete card.dataset.selectionError;
    const notice = error ? ensureFailure() : failure;
    if (notice) {
      notice.setAttribute("aria-hidden", String(!error));
      if (error && message) {
        message.textContent = error.status === "unavailable"
          ? "This version of the scene is not available."
          : "This scene could not be loaded.";
      }
    }
    // The figures are hidden from the eye by the stylesheet; this hides them from
    // a screen reader too, which would otherwise read out the old megabytes.
    if (figures) figures.setAttribute("aria-hidden", String(onWay || Boolean(error)));
    if (indicator) indicator.setAttribute("aria-hidden", String(!onWay));
    if (!indicator || !bar) return;
    const fraction = onWay ? state.progress : null;
    if (fraction === null) indicator.setAttribute("data-indeterminate", "");
    else indicator.removeAttribute("data-indeterminate");
    bar.style.setProperty("--load", `${Math.round(Math.min(1, Math.max(0, fraction ?? 0)) * 100)}%`);
  };
};

/**
 * The frame-rate read-out in the stat card. Deliberately the quietest thing on
 * the card: §4 wants the compressed size to win, and a renderer benchmark is
 * not what this page is about.
 *
 * The line is always there and only the number changes. A scene nobody is moving
 * through renders no frames — the viewer schedules them on demand — so there is
 * genuinely nothing to measure, and the read-out says so with an en dash rather
 * than with a zero, which would claim the renderer had stalled. The same dash
 * covers a renderer that is off, paused or still booting: in all four cases the
 * honest answer is "no rate", and the stylesheet holds the slot at three digits
 * so the unit beside it does not move between any of them.
 * @param {HTMLElement} card
 */
export const frameRate = (card) => {
  const output = card.querySelector("[data-fps]");
  return (/** @type {PageState} */ state) => {
    if (!output) return;
    const measuring = state.renderer === "ready" && !state.paused && !!state.fps;
    const text = measuring ? String(state.fps) : "\u2013";
    if (output.textContent !== text) output.textContent = text;
  };
};

/**
 * What the pointer can do, and — only when the viewer had to fall back — what
 * to do about that. Both live on the same reserved row, so the pointer costs no
 * height when it appears (§6, and invariant 2).
 * @param {HTMLElement} tip
 */
export const stageTip = (tip) => {
  const line = tip.querySelector("[data-tip]");
  const hint = /** @type {HTMLElement | null} */ (tip.querySelector("#backend-hint"));
  const coarse = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  if (line) {
    line.textContent = coarse
      ? "Drag to orbit · Pinch to zoom · Two fingers to pan"
      : "Drag to orbit · Scroll to zoom · WASD to move · Right-drag to pan";
  }
  return (/** @type {PageState} */ state) => {
    if (!hint) return;
    const webgl2 = state.renderer === "ready" && state.backend === "webgl2";
    hint.hidden = !webgl2;
    // The row is one line and the pointer tip is the expendable half of it: on a
    // narrow panel the stylesheet drops the tip rather than letting the two
    // squeeze each other into ellipses.
    if (webgl2) tip.dataset.hint = "webgl2";
    else delete tip.dataset.hint;
    if (webgl2 && !hint.textContent) {
      hint.textContent = "Running on WebGL2. A WebGPU browser renders this faster.";
    }
  };
};

/**
 * Reflect the unlocked control surface onto the band.
 *
 * The band is the one place the growing control surface is visible as a whole,
 * so it is also the honest place to state it: `data-unlocked="camera size"`.
 * Each widget still decides for itself whether it is mounted; this only says
 * what the page has introduced so far, which is what a stylesheet and a gate
 * can both read without either of them reaching into JavaScript state.
 *
 * @param {HTMLElement} band
 */
export const bandSurface = (band) => (/** @type {PageState} */ state) => {
  const names = state.unlocked.join(" ");
  if (band.dataset.unlocked !== names) band.dataset.unlocked = names;
};

/**
 * The camera group: play/pause for the authored path, and a way back to the
 * pose the scene was fitted to.
 *
 * Pausing the path is not pausing the renderer. The scene stays live and the
 * visitor keeps the camera — §5's "the renderer must remain navigable".
 * @param {HTMLElement} slot
 * @param {{setPlaying: (playing: boolean) => void, resetCamera: () => unknown,
 *   tourState: () => {playing: boolean, progress: number, duration: number},
 *   seekTour: (progress: number) => void}} bridge
 */
export const cameraGroup = (slot, bridge) => {
  const group = /** @type {HTMLElement | null} */ (slot.querySelector('[data-control="camera"]'));
  const toggle = /** @type {HTMLButtonElement | null} */ (
    slot.querySelector('[data-action="toggle-tour"]')
  );
  const suspendedTip = /** @type {HTMLElement | null} */ (
    toggle?.querySelector("[data-motion-suspended-tip]") ?? null
  );
  const reset = /** @type {HTMLButtonElement | null} */ (
    slot.querySelector('[data-action="reset-camera"]')
  );
  const progressTrack = /** @type {HTMLElement | null} */ (
    slot.querySelector("[data-tour-progress-track]")
  );
  const progress = /** @type {HTMLInputElement | null} */ (
    slot.querySelector("[data-tour-progress]")
  );
  let progressFrame = 0;

  const stopProgress = () => {
    if (progressFrame) cancelAnimationFrame(progressFrame);
    progressFrame = 0;
  };
  const updateProgress = () => {
    progressFrame = 0;
    if (!progress || progress.disabled) return;
    const value = bridge.tourState().progress;
    if (Number.isFinite(value)) {
      const normalized = Math.min(1, Math.max(0, value));
      progress.value = String(normalized);
      progressTrack?.style.setProperty("--tour-progress", `${normalized * 100}%`);
    }
    progressFrame = requestAnimationFrame(updateProgress);
  };

  toggle?.addEventListener("click", () => {
    bridge.setPlaying(toggle.getAttribute("aria-checked") !== "true");
  });
  reset?.addEventListener("click", () => void bridge.resetCamera());
  progress?.addEventListener("input", () => {
    const value = Number(progress.value);
    progressTrack?.style.setProperty("--tour-progress", `${value * 100}%`);
    bridge.seekTour(value);
  });

  return (/** @type {PageState} */ state) => {
    if (group) group.hidden = !state.unlocked.includes("camera");
    const usable = state.renderer === "ready";
    if (toggle) {
      // A switch, not a Play/Pause button (V3-E). Its name and its label are
      // the same in both states — `aria-checked` and the thumb carry the
      // state — because a control that renames itself is announced as two
      // different controls to anyone who is listening rather than looking.
      toggle.setAttribute("aria-checked", String(state.playing && !state.motionSuspended));
      // V3-BA: while a scene or tier the visitor asked for loads, the page holds
      // the path and the switch is locked off; the tooltip and the description
      // say why, and both exist only for the duration.
      toggle.disabled = !usable || state.motionSuspended;
      toggle.toggleAttribute("data-suspended", state.motionSuspended);
      if (suspendedTip) {
        suspendedTip.hidden = !state.motionSuspended;
        if (state.motionSuspended) toggle.setAttribute("aria-describedby", suspendedTip.id);
        else toggle.removeAttribute("aria-describedby");
      }
    }
    if (reset) reset.disabled = !usable;
    const active = usable && state.playing;
    if (progress) progress.disabled = !active;
    if (progressTrack) {
      progressTrack.toggleAttribute("data-active", active);
      progressTrack.setAttribute("aria-hidden", String(!active));
    }
    stopProgress();
    if (active) progressFrame = requestAnimationFrame(updateProgress);
  };
};

/**
 * The size slider: one stop per exported operating point of the current scene.
 *
 * Everything the visitor reads here is a megabyte value. The tier keys the
 * viewer selects by are internal identifiers and appear in no label, tick,
 * tooltip or accessible name (§4, standing rule 7); they travel in the manifest
 * and in `bridge.apply`, and stop there.
 *
 * Two behaviours are worth stating because they are the difference between a
 * slider that helps and one that fights:
 *
 * The thumb belongs to the visitor while they are moving it. A viewer event
 * arriving mid-drag must not snap it back, so the widget remembers the point it
 * is showing and only re-syncs from viewer state once that point has landed —
 * or immediately, when the change came from somewhere else, which is how the
 * plot will move it at M5.
 *
 * A drag issues one selection, not sixty. Each stop is a different encoding of
 * the scene, so every intermediate value the pointer sweeps through would be a
 * download; the paired rulers follow the thumb immediately and the scene follows a
 * short pause or the release of the button.
 *
 * @param {HTMLElement} slot
 * @param {{apply: (intent: {size?: string}) => unknown}} bridge
 * @param {SizeManifest | null} manifest
 * @param {{settleMs?: number, gate?: boolean}} [options]
 */
export const sizeSlider = (slot, bridge, manifest, options = {}) => {
  const settleMs = options.settleMs ?? SIZE_SETTLE_MS;
  // The renderer's instrument is unlock-gated; a prose mirror is not, because it
  // sits inside the very section that introduces it and gating it would only
  // reflow the paragraph as the reading line crossed it.
  const gate = options.gate ?? true;
  const group = /** @type {HTMLElement | null} */ (slot.querySelector('[data-control="size"]'));
  const input = /** @type {HTMLInputElement | null} */ (slot.querySelector("[data-size-input]"));
  const ticks = /** @type {HTMLElement | null} */ (slot.querySelector("[data-size-ticks]"));
  const stops = /** @type {HTMLElement | null} */ (slot.querySelector("[data-size-stops]"));
  const metric = manifest?.metric?.short || "";

  /** @type {string | null} */
  let mounted = null;
  /** @type {SizePoint[]} */
  let points = [];
  /** The point the slider is showing but the viewer has not landed yet. */
  /** @type {SizePoint | null} */
  let pending = null;
  let timer = 0;

  /** @param {SizePoint | null} point */
  const show = (point) => {
    if (input) input.setAttribute("aria-valuetext", describePoint(point, metric));
    for (const layer of [ticks, stops]) {
      if (!layer) continue;
      for (const mark of layer.children) {
        const active = point !== null
          && mark.getAttribute("data-at-index") === String(points.indexOf(point));
        if (active) mark.setAttribute("data-active", "");
        else mark.removeAttribute("data-active");
      }
    }
  };

  /** @param {string} scene @param {string} [tier] */
  const mount = (scene, tier) => {
    mounted = scene;
    points = manifest?.scenes?.[scene]?.points ?? [];
    pending = null;
    if (input) {
      input.max = String(Math.max(points.length - 1, 0));
      input.disabled = points.length < 2;
    }
    if (ticks) {
      ticks.replaceChildren(
        ...points.map((point, index) => {
          const tick = document.createElement("span");
          tick.className = "size-tick";
          tick.dataset.sizeTick = "";
          tick.textContent = formatMegabytes(point.bytes);
          tick.setAttribute("data-at-index", String(index));
          // A tick at either end of the track is aligned to that end rather
          // than centred on it, so the scale never overhangs the panel.
          tick.style.setProperty("--at", String(sizeStopFraction(index, points.length)));
          return tick;
        }),
      );
    }
    // The stops the thumb can land on, drawn on the rail. They are the same
    // points as the ruler above and share its anchor, so a mark, its label and
    // the thumb are one position rather than three that nearly agree.
    if (stops) {
      stops.replaceChildren(
        ...points.map((point, index) => {
          const mark = document.createElement("i");
          mark.className = "size-stop";
          mark.dataset.sizeStop = "";
          mark.setAttribute("data-at-index", String(index));
          mark.style.setProperty("--at", String(sizeStopFraction(index, points.length)));
          return mark;
        }),
      );
    }
    // Where the track stands before the viewer has reported anything: the point
    // the page authored for this scene. Complete and correct from the moment the
    // control is unlocked, rather than an empty track until a scene lands.
    const index = tier === undefined ? -1 : points.findIndex((point) => point.tier === tier);
    if (index >= 0) {
      if (input) input.value = String(index);
      show(points[index]);
    }
  };

  const commit = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (pending) void bridge.apply({ size: pending.tier });
  };

  input?.addEventListener("input", () => {
    const point = points[Number(input.value)];
    if (!point) return;
    pending = point;
    show(point);
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(commit, settleMs);
  });
  // Release of the pointer, or an arrow key: the visitor has stopped choosing.
  input?.addEventListener("change", commit);

  if (manifest?.boot) mount(manifest.boot.scene, manifest.boot.tier);

  return (/** @type {PageState} */ state) => {
    // Requested, not landed (V3-C): the track shows the operating point the
    // visitor asked for from the moment they ask for it, from either instance,
    // while the stat card keeps describing the scene that is actually on screen.
    const { scene, size } = state.requested;
    if (group && gate) group.hidden = !state.unlocked.includes("size");
    if (scene && scene !== mounted) mount(scene, size ?? undefined);
    if (input) input.disabled = state.renderer !== "ready" || points.length < 2;
    // `pending` covers only the settle window before this instance has issued
    // its request. Once it has, the requested tier carries it and every other
    // view of the same state agrees.
    if (pending && size === pending.tier) pending = null;
    if (pending || !size) return;
    const index = points.findIndex((point) => point.tier === size);
    if (index < 0) {
      show(null);
      return;
    }
    if (input) input.value = String(index);
    show(points[index]);
  };
};

/**
 * The page-owned scene picker. Dataset and scene presentation comes from
 * `content/site.yaml`; the viewer sees only the internal scene name.
 *
 * Options are relabelled for the tier that actually landed. That distinction
 * matters for a ragged export: asking for Train while M is selected may land
 * Train at S, and the control must describe Train/S rather than the request.
 *
 * `plain` names the scene only (the phone strip, P2.1): the size is the byte
 * figure beside it, and a 320 px line has no room to say it twice.
 *
 * @param {HTMLElement} host
 * @param {{apply: (intent: {scene?: string}) => unknown}} bridge
 * @param {SizeManifest | null} manifest
 * @param {{gate?: boolean, plain?: boolean}} [options]
 */
export const scenePicker = (host, bridge, manifest, options = {}) => {
  const gate = options.gate ?? true;
  const plain = options.plain ?? false;
  const group = /** @type {HTMLElement | null} */ (host.querySelector('[data-control="scenes"]'));
  const select = /** @type {HTMLSelectElement | null} */ (host.querySelector("[data-scene-input]"));
  /** @type {string | null} */
  let mountedTier = null;

  /** @param {string} tier */
  const mount = (tier) => {
    mountedTier = tier;
    if (!select) return;
    const selected = select.value;
    select.replaceChildren(
      ...(manifest?.groups ?? []).map((entry) => {
        const options = entry.scenes.map((scene) => {
          const option = document.createElement("option");
          const point = manifest?.scenes?.[scene.name]?.points.find((item) => item.tier === tier);
          option.value = scene.name;
          option.textContent = plain
            ? scene.label
            : point ? `${scene.label} · ${formatBytes(point.bytes)}` : `${scene.label} · unavailable`;
          return option;
        });
        const optgroup = document.createElement("optgroup");
        optgroup.label = entry.label;
        optgroup.replaceChildren(...options);
        return optgroup;
      }),
    );
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  };

  select?.addEventListener("change", () => {
    if (select.value) void bridge.apply({ scene: select.value });
  });

  if (manifest?.boot) mount(manifest.boot.tier);

  return (/** @type {PageState} */ state) => {
    if (group && gate) group.hidden = !state.unlocked.includes("scenes");
    // The option LABELS describe the tier that landed — a ragged scene must be
    // named at the size it actually has. The SELECTION is the requested scene,
    // so both instances name the visitor's choice while it is still arriving.
    if (state.size && state.size !== mountedTier) mount(state.size);
    if (select) {
      select.disabled = state.renderer !== "ready";
      const scene = state.requested.scene;
      if (scene && select.value !== scene) select.value = scene;
    }
  };
};

/**
 * F1.9 (R3, V3-AY): the Scenes chapter's preview cards. Three buttons, each a
 * shortcut to one scene, shipped inert and enabled here. A card is a *view* of
 * the requested scene (V3-C): it requests through the bridge exactly like the
 * select does and never touches the select, and `aria-pressed` follows
 * `state.requested.scene` — so a scene chosen anywhere else presses no card.
 * @param {HTMLElement} host
 * @param {{apply: (intent: {scene?: string}) => unknown}} bridge
 */
export const scenePreviews = (host, bridge) => {
  const cards = /** @type {HTMLButtonElement[]} */ ([...host.querySelectorAll("[data-scene-preview]")]);
  for (const card of cards) {
    card.addEventListener("click", () => {
      const scene = card.dataset.scenePreview;
      if (scene) void bridge.apply({ scene });
    });
  }
  return (/** @type {PageState} */ state) => {
    for (const card of cards) {
      card.disabled = state.renderer !== "ready";
      card.setAttribute("aria-pressed", String(state.requested.scene === card.dataset.scenePreview));
    }
  };
};

/**
 * The floating viewport actions: clean view, fullscreen, and rendering on/off.
 *
 * This cluster is the one thing clean view keeps, because hiding the way back
 * out of a mode is how a visitor gets stuck in it.
 * @param {HTMLElement} actions
 * @param {HTMLElement} panel
 * @param {{setEnabled: (enabled: boolean) => unknown}} bridge
 */
export const viewportActions = (actions, panel, bridge) => {
  /** @param {string} name */
  const button = (name) =>
    /** @type {HTMLButtonElement | null} */ (actions.querySelector(`[data-action="${name}"]`));
  const chrome = button("toggle-chrome");
  const fullscreen = button("fullscreen");
  const renderer = button("toggle-renderer");
  // All three act only through this module, so the markup ships them inert and
  // mounting is what turns them on.
  for (const action of [chrome, fullscreen, renderer]) if (action) action.disabled = false;

  /** @param {HTMLButtonElement | null} target @param {string} text */
  const label = (target, text) => {
    const slot = target?.querySelector("[data-label]");
    if (slot && slot.textContent !== text) slot.textContent = text;
  };

  /** @param {boolean} hidden */
  const setChrome = (hidden) => {
    panel.dataset.chrome = hidden ? "hidden" : "shown";
    chrome?.setAttribute("aria-pressed", String(hidden));
    label(chrome, hidden ? "Show interface" : "Clean view");
  };
  setChrome(false);

  chrome?.addEventListener("click", () => setChrome(panel.dataset.chrome !== "hidden"));
  // Escape is what a visitor already tries in a stripped-down view, and it is
  // the only way out when the pointer is nowhere near the button.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.dataset.chrome === "hidden") setChrome(false);
  });

  fullscreen?.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panel.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === panel;
    fullscreen?.setAttribute("aria-pressed", String(active));
    label(fullscreen, active ? "Exit fullscreen" : "Fullscreen");
  });

  renderer?.addEventListener("click", () => {
    void bridge.setEnabled(renderer.getAttribute("aria-pressed") !== "true");
  });

  return (/** @type {PageState} */ state) => {
    const on = state.renderer !== "off";
    renderer?.setAttribute("aria-pressed", String(on));
    label(renderer, on ? "Rendering on" : "Rendering off");
    if (fullscreen) fullscreen.disabled = false;
  };
};

/**
 * The renderer-off / boot-failure screen.
 *
 * The still image is attached at the moment the screen is shown rather than in
 * the markup: a healthy first visit must not spend a single byte of its opening
 * bandwidth on a picture of the scene it is already rendering.
 * @param {HTMLElement} fallback
 * @param {{retry: () => unknown}} bridge
 */
export const rendererFallback = (fallback, bridge) => {
  const image = /** @type {HTMLImageElement | null} */ (
    fallback.querySelector("[data-fallback-image]")
  );
  const heading = fallback.querySelector("[data-fallback-heading]");
  const text = fallback.querySelector("[data-fallback-text]");
  const retry = /** @type {HTMLButtonElement | null} */ (
    fallback.querySelector('[data-action="retry-renderer"]')
  );
  const originalText = text?.innerHTML || "";

  retry?.addEventListener("click", () => {
    void bridge.retry();
  });

  return (/** @type {PageState} */ state) => {
    const shown = state.renderer === "off" || state.renderer === "failed";
    fallback.hidden = !shown;
    if (!shown) return;
    if (image && !image.src) {
      const source = image.dataset.fallbackImage;
      if (source) {
        image.src = source;
        image.hidden = false;
      }
    }
    if (heading) {
      heading.textContent =
        state.renderer === "failed" ? "The renderer could not start" : "Rendering is off";
    }
    if (text && state.renderer === "failed") {
      text.innerHTML = originalText;
    }
    if (retry) retry.hidden = false;
  };
};

/**
 * Boot and error read-out. Deliberately quiet: it says something only while the
 * viewer is still working, and never competes with the compressed size.
 * @param {HTMLElement} status
 */
export const stageStatus = (status) => (/** @type {PageState} */ state) => {
  const booting = state.renderer === "booting";
  status.hidden = !booting;
  if (booting) status.textContent = "Decoding the scene…";
};

/**
 * The draggable divider.
 *
 * It writes one custom property, `--split`, which the grid template clamps. The
 * position is persisted because resizing the panels is a preference about how
 * someone wants to read, not a transient gesture.
 * @param {HTMLElement} divider
 * @param {HTMLElement} split
 */
export const splitDivider = (divider, split) => {
  // The separator is only a separator once something can move it: dragging and
  // the arrow keys are this module, so this module is what makes it focusable.
  divider.tabIndex = 0;

  /** @param {number} percent @param {boolean} persist */
  const setSplit = (percent, persist) => {
    const clamped = clampSplit(percent);
    split.style.setProperty("--split", `${clamped}%`);
    divider.setAttribute("aria-valuenow", String(Math.round(clamped)));
    if (!persist) return;
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(clamped));
    } catch {
      // Nothing to do: the layout is correct, only the memory of it is lost.
    }
  };

  const stored = readSplit();
  if (stored !== null) setSplit(stored, false);

  let dragging = false;
  /** @param {PointerEvent} event */
  const move = (event) => {
    if (!dragging) return;
    const box = split.getBoundingClientRect();
    if (box.width <= 0) return;
    setSplit(((event.clientX - box.left) / box.width) * 100, false);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    const current = Number.parseFloat(split.style.getPropertyValue("--split"));
    if (Number.isFinite(current)) setSplit(current, true);
  };

  divider.addEventListener("pointerdown", (event) => {
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  });
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);

  // The divider is a real separator, so it answers the arrow keys a separator is
  // expected to answer rather than being mouse-only.
  divider.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0;
    if (!step) return;
    event.preventDefault();
    const current = Number.parseFloat(split.style.getPropertyValue("--split")) || 56;
    setSplit(current + step, true);
  });
};

/**
 * F2.4 (V3-BK): what the page does for paper. Before printing, every closed
 * disclosure opens and the renderer-off still gets its source — a print
 * stylesheet can hide the iframe but cannot set a src. Showing the fallback is
 * the stylesheet's job (a print rule beside `[hidden]` in the base layer), not
 * this hook's: a renderer state arriving between beforeprint and the print
 * rendering would put `hidden` straight back. After printing, the reader's
 * disclosures come back as they were.
 * @param {HTMLElement | null} fallback
 */
export const printPreparation = (fallback) => {
  /** @type {HTMLDetailsElement[]} */
  let opened = [];
  window.addEventListener("beforeprint", () => {
    opened = [...document.querySelectorAll("details")].filter((details) => !details.open);
    for (const details of opened) details.open = true;
    const image = /** @type {HTMLImageElement | null} */ (fallback?.querySelector("[data-fallback-image]") ?? null);
    if (image && !image.getAttribute("src") && image.dataset.fallbackImage) {
      image.src = image.dataset.fallbackImage;
    }
  });
  window.addEventListener("afterprint", () => {
    for (const details of opened) details.open = false;
    opened = [];
  });
};
