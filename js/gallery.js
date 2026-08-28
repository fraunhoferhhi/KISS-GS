// @ts-check
/**
 * The single-frame qualitative comparison. The generated manifest supplies all
 * images and paper metrics; this module owns only selection and presentation.
 *
 * @typedef {{path: string, width: number, height: number}} GalleryImage
 * @typedef {object} GalleryRow
 * @property {string} key
 * @property {string} label
 * @property {string} kind
 * @property {string | null} psnr
 * @property {string | null} lpips
 * @property {string | null} size_mb
 * @property {Record<string, GalleryImage>} images
 * @typedef {{view: string, rows: GalleryRow[]}} GalleryData
 */

/** @param {GalleryRow} row */
const metricsSentence = (row) => row.psnr
  ? `${row.label} · ${row.size_mb} MB · ${row.psnr} dB PSNR · ${row.lpips} LPIPS`
  : `${row.label} · the captured photograph, the reference image`;

/**
 * Describe our file against the selected reference without implying that
 * ground truth has a meaningful file size.
 * @param {GalleryRow} ours
 * @param {GalleryRow} reference
 */
const relativeSize = (ours, reference) => {
  const oursSize = Number(ours.size_mb);
  const referenceSize = Number(reference.size_mb);
  if (!Number.isFinite(oursSize) || !Number.isFinite(referenceSize) || referenceSize <= 0) return null;
  const ratio = referenceSize / oursSize;
  if (ratio >= 1) return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× smaller`;
  return `${(1 / ratio).toFixed(1)}× larger`;
};

/** @param {HTMLImageElement} image */
const imageReady = (image) => {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  });
};

const GALLERY_NUDGE_KEY = "kissgs:gallery-nudge";
const GALLERY_NUDGE_MS = 8_000;

const nudgeSeen = () => {
  try {
    return window.sessionStorage.getItem(GALLERY_NUDGE_KEY) === "shown";
  } catch {
    return false;
  }
};

const rememberNudge = () => {
  try {
    window.sessionStorage.setItem(GALLERY_NUDGE_KEY, "shown");
  } catch {
    // Blocked storage costs at most one extra nudge on the next page load.
  }
};

/** @param {HTMLElement} host @param {GalleryRow} shown @param {GalleryRow} ours @param {GalleryRow} reference */
const renderMetrics = (host, shown, ours, reference) => {
  /** @param {string} label @param {string} value */
  const item = (label, value) => {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    group.append(term, description);
    return group;
  };
  const next = [];
  if (shown.psnr) {
    next.push(item("Size", `${shown.size_mb} MB`));
    next.push(item("PSNR", `${shown.psnr} dB`));
    next.push(item("LPIPS", String(shown.lpips)));
    const relative = relativeSize(ours, reference);
    if (relative) next.push(item("Relative size", shown === reference ? "Reference" : relative));
  } else {
    const note = item("Reference image", "Captured photograph · no reconstruction metrics");
    note.classList.add("gal-metric-note");
    next.push(note);
  }
  host.replaceChildren(...next);
  host.toggleAttribute("data-ground-truth", !shown.psnr);
};

/** @param {HTMLElement} host @param {GalleryData} data */
export const initGallery = async (host, data) => {
  const rows = new Map(data.rows.map((row) => [row.key, row]));
  const referenceSelect = /** @type {HTMLSelectElement | null} */ (
    host.querySelector('[data-gallery-choice="reference"]')
  );
  const oursSelect = /** @type {HTMLSelectElement | null} */ (
    host.querySelector('[data-gallery-choice="ours"]')
  );
  const budgetButtons = /** @type {HTMLButtonElement[]} */ (
    [...host.querySelectorAll("[data-gallery-budget]")]
  );
  const zoomButtons = /** @type {HTMLButtonElement[]} */ (
    [...host.querySelectorAll("[data-gallery-zoom]")]
  );
  const sourcePanels = /** @type {HTMLElement[]} */ (
    [...host.querySelectorAll("[data-gallery-source]")]
  );
  const showButtons = /** @type {HTMLButtonElement[]} */ (
    [...host.querySelectorAll("[data-gallery-show]")]
  );
  const frame = /** @type {HTMLElement | null} */ (host.querySelector("[data-gallery-frame]"));
  const metricsHost = /** @type {HTMLElement | null} */ (host.querySelector("[data-gallery-metrics]"));
  const readout = /** @type {HTMLElement | null} */ (host.querySelector("[data-gallery-readout]"));
  if (!referenceSelect || !oursSelect || !frame || !metricsHost
      || sourcePanels.length !== 2 || showButtons.length !== 2) return;

  let referenceKey = referenceSelect.value;
  let oursKey = oursSelect.value;
  let zoom = String(
    zoomButtons.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.zoom
      || zoomButtons[0]?.dataset.zoom || "full",
  );
  /** @type {"reference" | "ours"} */
  let persistentSource = "ours";
  let hovered = false;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  /** @type {HTMLElement | null} */
  let nudge = null;
  let nudgeTimer = 0;

  const dismissNudge = () => {
    if (nudgeTimer) window.clearTimeout(nudgeTimer);
    nudgeTimer = 0;
    nudge?.remove();
    nudge = null;
  };

  const render = () => {
    const reference = rows.get(referenceKey);
    const ours = rows.get(oursKey);
    if (!reference || !ours) return;
    const showingReference = hovered ? persistentSource === "ours" : persistentSource === "reference";
    const shown = showingReference ? reference : ours;
    const entry = shown.images[zoom];
    if (!entry) return;
    frame.style.setProperty("--gal-aspect", `${entry.width} / ${entry.height}`);

    for (const image of frame.querySelectorAll("img")) {
      const role = image.dataset.galleryImage;
      const source = role === "reference" ? reference : ours;
      const sourceEntry = source.images[zoom];
      if (!sourceEntry) continue;
      if (!image.src.endsWith(sourceEntry.path)) image.src = sourceEntry.path;
      image.width = sourceEntry.width;
      image.height = sourceEntry.height;
      image.toggleAttribute("data-visible", source === shown);
    }

    frame.dataset.showing = showingReference ? "reference" : "ours";
    host.dataset.showing = frame.dataset.showing;
    const identity = showingReference ? `Reference · ${reference.label}` : `Ours · ${ours.label}`;
    frame.setAttribute(
      "aria-label",
      `Showing ${identity}. ${metricsSentence(shown)}.`,
    );
    renderMetrics(metricsHost, shown, ours, reference);

    for (const panel of sourcePanels) {
      panel.toggleAttribute("data-showing", panel.dataset.gallerySource === frame.dataset.showing);
    }
    for (const button of showButtons) {
      const role = button.dataset.galleryShow;
      const showing = role === frame.dataset.showing;
      button.setAttribute("aria-pressed", String(showing));
      button.textContent = showing ? "Showing" : "Show";
      button.setAttribute(
        "aria-label",
        showing
          ? `${role === "reference" ? "Reference" : "KISS-GS"} image showing`
          : `Show ${role === "reference" ? "reference" : "KISS-GS"} image`,
      );
    }

    referenceSelect.value = referenceKey;
    oursSelect.value = oursKey;
    for (const button of budgetButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.galleryBudget === oursKey));
    }
    for (const button of zoomButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.zoom === zoom));
    }
  };

  /** @param {string} message */
  const announce = (message) => { if (readout) readout.textContent = message; };

  referenceSelect.addEventListener("change", () => {
    referenceKey = referenceSelect.value;
    render();
    const row = rows.get(referenceKey);
    if (row) announce(`Reference: ${metricsSentence(row)}.`);
  });
  oursSelect.addEventListener("change", () => {
    oursKey = oursSelect.value;
    render();
    const row = rows.get(oursKey);
    if (row) announce(`Ours: ${metricsSentence(row)}.`);
  });
  for (const button of budgetButtons) {
    button.addEventListener("click", () => {
      oursKey = String(button.dataset.galleryBudget);
      render();
      const row = rows.get(oursKey);
      if (row) announce(`Ours: ${metricsSentence(row)}.`);
    });
  }
  for (const button of zoomButtons) {
    button.addEventListener("click", () => {
      zoom = String(button.dataset.zoom);
      render();
      announce(`Magnification: ${button.textContent?.trim()}.`);
    });
  }
  for (const button of showButtons) {
    button.addEventListener("click", () => {
      persistentSource = button.dataset.galleryShow === "reference" ? "reference" : "ours";
      hovered = false;
      dismissNudge();
      render();
      const shown = rows.get(persistentSource === "reference" ? referenceKey : oursKey);
      if (shown) announce(`Showing ${metricsSentence(shown)}.`);
    });
  }

  frame.addEventListener("pointerenter", (event) => {
    if (!finePointer || /** @type {PointerEvent} */ (event).pointerType === "touch") return;
    hovered = true;
    dismissNudge();
    render();
  });
  frame.addEventListener("pointerleave", () => {
    if (!finePointer) return;
    hovered = false;
    render();
  });

  render();
  // Opacity is now an atomic visibility switch. Do not enable the reveal until
  // both selected images have loaded, or the first hover can expose the dark
  // frame while the hidden reference finishes decoding. This module itself is
  // loaded only as the gallery approaches the viewport, so promoting this pair
  // from lazy to eager does not affect the page's cold-load image budget.
  const images = /** @type {HTMLImageElement[]} */ ([...frame.querySelectorAll("img")]);
  for (const image of images) image.loading = "eager";
  await Promise.all(images.map(imageReady));
  referenceSelect.disabled = false;
  oursSelect.disabled = false;
  for (const button of [...budgetButtons, ...zoomButtons, ...showButtons]) button.disabled = false;
  if (finePointer && !nudgeSeen()) {
    rememberNudge();
    nudge = document.createElement("span");
    nudge.className = "gal-nudge";
    nudge.setAttribute("data-gallery-nudge", "");
    nudge.setAttribute("role", "status");
    nudge.textContent = "Hover to switch images";
    frame.append(nudge);
    nudgeTimer = window.setTimeout(dismissNudge, GALLERY_NUDGE_MS);
  }
  host.setAttribute("data-ready", "");
};
