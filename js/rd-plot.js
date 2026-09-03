// @ts-check
/**
 * M5's rate–distortion plot.
 *
 * The expensive pieces — 194 kB of paper data and the plotting library — are
 * fetched only when the figure approaches the viewport. The bridge still calls
 * this widget's render function from first paint, so the latest scene and size
 * are waiting when that lazy load finishes; there is no second state store.
 * `vendor/observable-plot.js` is @observablehq/plot 0.6.17 bundled as one ESM
 * file with esbuild 0.25.9; its license sits beside it.
 *
 * @typedef {import("./viewer-bridge.js").PageState} PageState
 * @typedef {import("./controls.js").SizeManifest} SizeManifest
 * @typedef {object} RdSeries
 * @property {string} compression
 * @property {string} method
 * @property {string} label
 * @property {{color?: string, variant?: string, sourceOrigin?: string}} [style]
 * @typedef {object} RdRecord
 * @property {string} compression
 * @property {string} method
 * @property {string} dataset
 * @property {string} scene
 * @property {string} sizeTier
 * @property {number} rate
 * @property {number} psnr
 * @typedef {object} RdMetric
 * @property {string} label
 * @property {string} shortLabel
 * @property {boolean} maximize
 * @typedef {{schema: number, series: RdSeries[], records: RdRecord[],
 *   datasetRecords?: RdRecord[], metrics?: Record<string, RdMetric>}} RdPayload
 * @typedef {RdRecord & {rateMb: number, label: string, color: string}} PlotPoint
 */

import { retryable, retryWhenTouched, whenApproached } from "./lazy.js";

/** The 194 kB of paper data and the plotting library, fetched at most once.
 *
 * Two figures draw from them now — the opening scene plot and the Results
 * chapter's dataset plot — and the second one must not pay for the first's
 * bytes again. Memoising the promise rather than the result also means a
 * visitor who reaches both figures in the same second gets one request.
 * @type {Promise<{payload: RdPayload, Plot: any}> | null}
 */
let runtime = null;
/** How many times the shared runtime has failed, so a retry is a real one. */
let runtimeFailures = 0;

/** @param {string} source */
const loadRuntime = (source) => {
  if (!runtime) {
    runtime = Promise.all([
      fetch(source),
      // A module whose fetch failed stays in the module map as a failure, so
      // after one the specifier has to differ or the retry never leaves the
      // browser. `retryable` is a no-op until then.
      import(retryable("../vendor/observable-plot.js", runtimeFailures)),
    ]).then(async ([response, module]) => {
      if (!response.ok) throw new Error(`rate–distortion data returned ${response.status}`);
      const loaded = /** @type {RdPayload} */ (await response.json());
      if (loaded.schema !== 1) {
        throw new Error(`unsupported rate–distortion schema ${loaded.schema}`);
      }
      return { payload: loaded, Plot: module };
    }).catch((error) => {
      // A failed load must not be cached as a failure for the other figure.
      runtime = null;
      runtimeFailures += 1;
      throw error;
    });
  }
  return runtime;
};

const MOBILE_QUERY = "(max-width: 899px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** @param {{compression: string, method: string}} record */
const seriesKey = (record) => `${record.compression}\u0000${record.method}`;

/** @param {string} value */
const sceneLabel = (value) => {
  const name = value.includes("-") ? value.slice(value.indexOf("-") + 1) : value;
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
};

/**
 * Build the scene view from the paper payload. This model deliberately retains
 * HAC++ and dataset context for the later Results scope; the opening Size scope
 * renders only SOG-XT-FT and INRIA-Q. Duplicate reference rows collapse here.
 *
 * @param {RdPayload} payload
 * @param {SizeManifest} manifest
 * @param {string} sceneName
 */
export const scenePlotModel = (payload, manifest, sceneName) => {
  const scene = manifest.scenes[sceneName];
  if (!scene) return null;
  const identities = new Map(
    payload.series.map((series) => [
      `${series.compression}\u0000${series.method}`,
      series,
    ]),
  );
  const wanted = manifest.series;
  const seen = new Set();
  /** @type {PlotPoint[]} */
  const ours = [];
  /** @type {PlotPoint[]} */
  const hacpp = [];
  /** @type {PlotPoint[]} */
  const comparisons = [];
  /** @type {PlotPoint | null} */
  let inria = null;

  for (const record of payload.records) {
    if (record.dataset !== scene.dataset || !Number.isFinite(record.rate) || !Number.isFinite(record.psnr)) {
      continue;
    }
    const isScene = record.scene === scene.scene;
    const isDatasetContext = record.scene === "";
    if (!isScene && !isDatasetContext) continue;
    const identity = identities.get(seriesKey(record));
    const label = identity?.label || record.compression;
    const point = {
      ...record,
      rateMb: record.rate / 1_000_000,
      label,
      color: identity?.style?.color || "currentColor",
    };
    const duplicate = `${seriesKey(record)}\u0000${record.scene}\u0000${record.rate}\u0000${record.psnr}`;
    if (seen.has(duplicate)) continue;
    seen.add(duplicate);

    if (record.compression === wanted.compression && record.method === wanted.method && isScene) {
      ours.push(point);
    } else if (record.compression === "chen2025hac-plus:44k" && isScene) {
      hacpp.push(point);
    } else if (record.compression === "uncompressed" && record.method === "inria" && isScene) {
      inria = point;
    } else if (isDatasetContext) {
      comparisons.push(point);
    }
  }
  ours.sort((a, b) => a.rate - b.rate);
  hacpp.sort((a, b) => a.rate - b.rate);
  comparisons.sort((a, b) => seriesKey(a).localeCompare(seriesKey(b)) || a.rate - b.rate);
  return { scene, ours, hacpp, inria, comparisons };
};

/**
 * The metrics the Results chapter offers, in the paper's own order. Only the
 * order is here: every label comes from the payload's own `metrics` block, which
 * the paper's plotting script wrote.
 */
export const DATASET_METRICS = [{ key: "psnr" }, { key: "ssim" }, { key: "lpips" }];

/** How a series was measured. The one thing V3-M asks the plot to be explicit
 * about, and it is data rather than typography: reading the dagger out of a
 * label would break the moment the paper restyled its tables. */
/** @type {Record<string, string>} */
const PROVENANCE = {
  ffsplat: "recomputed",
  hacpp_root: "recomputed",
  external_3dgs_zip: "self-reported",
};

/** The uncompressed reference every reduction factor is measured against. */
const REFERENCE = { compression: "uncompressed", method: "inria" };

/**
 * Build the dataset view: our curve, the recomputed HAC++ curve, the
 * self-reported literature, and the INRIA-Q reference.
 *
 * The rows are the paper's own per-dataset means, reduced into `datasetRecords`
 * by `build/rd_data.py` — not averaged here. Our series is measured per scene
 * and the literature publishes dataset means only, so an average taken in the
 * browser would be a second answer to a question the paper already answered.
 *
 * Returns `null` rather than an empty chart when the dataset or the metric has
 * no data at all: a plot with axes and nothing on them reads as a result.
 *
 * @param {RdPayload & {datasetRecords?: RdRecord[]}} payload
 * @param {SizeManifest} manifest
 * @param {string} dataset
 * @param {string} metricKey
 */
export const datasetPlotModel = (payload, manifest, dataset, metricKey) => {
  const metricInfo = payload.metrics?.[metricKey];
  if (!metricInfo) return null;
  const rows = (payload.datasetRecords || []).filter((row) => row.dataset === dataset);
  if (!rows.length) return null;
  const identities = new Map(payload.series.map((entry) => [seriesKey(entry), entry]));

  /** @type {Map<string, any>} */
  const built = new Map();
  for (const row of rows) {
    const value = /** @type {any} */ (row)[metricKey];
    if (!Number.isFinite(value) || !Number.isFinite(row.rate) || row.rate <= 0) continue;
    const key = seriesKey(row);
    const identity = identities.get(key);
    if (!identity) continue;
    if (!built.has(key)) {
      built.set(key, {
        key,
        compression: row.compression,
        method: row.method,
        label: identity.label,
        color: identity.style?.color || "currentColor",
        provenance: PROVENANCE[identity.style?.sourceOrigin || ""] || "unstated",
        points: [],
      });
    }
    built.get(key).points.push({
      sizeTier: row.sizeTier,
      rate: row.rate,
      rateMb: row.rate / 1_000_000,
      value,
    });
  }
  for (const series of built.values()) {
    series.points.sort((/** @type {any} */ a, /** @type {any} */ b) => a.rate - b.rate);
  }

  const oursKey = seriesKey(manifest.series);
  const referenceKey = seriesKey(REFERENCE);
  const hacppKey = [...built.keys()].find(
    (key) => identities.get(key)?.style?.sourceOrigin === "hacpp_root",
  );
  const ours = built.get(oursKey);
  if (!ours) return null;
  const literature = [...built.values()]
    .filter((series) => identities.get(series.key)?.style?.sourceOrigin === "external_3dgs_zip")
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    dataset,
    metric: {
      key: metricKey,
      label: metricInfo.label,
      shortLabel: metricInfo.shortLabel,
      maximize: Boolean(metricInfo.maximize),
    },
    ours,
    hacpp: (hacppKey && built.get(hacppKey)) || null,
    literature,
    reference: built.get(referenceKey) || null,
    // Every series the dataset has, for consumers that draw more of the paper's
    // Fig. 1 than the page does (the poster: compaction alone, the encoding
    // before fine-tuning, the .sog/.spz formats, SOG-XT on the INRIA .ply).
    allSeries: [...built.values()],
  };
};

/**
 * Which of the scene's operating points the plot marks: the requested tier, or
 * nothing at all when this scene has no encoding at that tier. A ragged scene
 * marks nothing rather than marking the wrong point.
 * @param {{sizeTier: string}[]} points
 * @param {string | null | undefined} tier
 */
export const markedIndex = (points, tier) =>
  tier ? points.findIndex((point) => point.sizeTier === tier) : -1;

/** V3-AX: chart text inherits the SVG's rem size. Plot writes a px `font-size`
 * attribute on every text mark, which no reader's root setting can reach. */
const inheritTextSize = (/** @type {SVGSVGElement} */ svg) => {
  for (const text of svg.querySelectorAll("text[font-size]")) text.removeAttribute("font-size");
};

/** @param {PlotPoint} point */
const pointLabel = (point) =>
  `${(point.rate / 1_000_000).toFixed(2)} MB, ${point.psnr.toFixed(2)} dB PSNR`;

/** @param {PlotPoint[]} points */
const grouped = (points) => {
  /** @type {Map<string, PlotPoint[]>} */
  const groups = new Map();
  for (const point of points) {
    const key = seriesKey(point);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(point);
  }
  return [...groups.values()];
};

/**
 * @param {HTMLElement} host
 * @param {{apply: (intent: {size?: string}) => unknown}} bridge
 * @param {SizeManifest | null} manifest
 */
export const rateDistortionPlot = (host, bridge, manifest) => {
  const chart = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-chart]"));
  const status = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-status]"));
  const description = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-description]"));
  const sceneOut = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-scene]"));
  if (!chart || !manifest) return () => undefined;

  /** @type {PageState | null} */
  let state = null;
  /** @type {RdPayload | null} */
  let payload = null;
  /** @type {any} */
  let Plot = null;
  let loading = false;
  let width = 0;
  let resizeObserver = null;

  const isStatic = () => window.matchMedia(MOBILE_QUERY).matches;
  const reducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;
  const styles = getComputedStyle(host);
  const theme = {
    green: styles.getPropertyValue("--green-600").trim(),
    greenDark: styles.getPropertyValue("--green-900").trim(),
    orange: styles.getPropertyValue("--orange").trim(),
    blue: styles.getPropertyValue("--blue").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    line: styles.getPropertyValue("--gray-200").trim(),
    paper: styles.getPropertyValue("--paper").trim(),
  };

  /** @param {PlotPoint[]} points */
  const comparisonMarks = (points) => grouped(points).flatMap((series) => [
    Plot.line(series, {
      x: "rateMb", y: "psnr", stroke: series[0]?.color || theme.muted,
      strokeWidth: 1.1, opacity: 0.32,
    }),
    Plot.dot(series, {
      x: "rateMb", y: "psnr", fill: series[0]?.color || theme.muted,
      r: 2.1, opacity: 0.42, title: (/** @type {PlotPoint} */ point) => `${point.label}\n${pointLabel(point)}`,
    }),
  ]);

  const render = () => {
    // The plot is a control as much as a figure: it draws the scene the visitor
    // asked for and marks the tier they asked for, without waiting for either to
    // land (V3-C).
    const requested = state?.requested;
    if (!Plot || !payload || !requested?.scene) return;
    const model = scenePlotModel(payload, manifest, requested.scene);
    if (!model || !model.ours.length) return;
    const pointIndex = markedIndex(model.ours, requested.size);
    const selected = pointIndex >= 0 ? [model.ours[pointIndex]] : [];
    const focusedIndex = Number(
      document.activeElement?.closest?.("[data-rd-point]")?.getAttribute("data-point-index") ?? -1,
    );
    if (sceneOut) sceneOut.textContent = `${sceneLabel(requested.scene)} · PSNR`;
    if (description) {
      description.textContent = [
        `SOG-XT-FT operating points for ${sceneLabel(requested.scene)}.`,
        model.inria ? `The dashed rule and point are its INRIA-Q reference: ${pointLabel(model.inria)}.` : "",
        "Up and to the left is better.",
      ].filter(Boolean).join(" ");
    }
    const interactive = !isStatic();
    host.toggleAttribute("data-static", !interactive);
    host.setAttribute("data-motion", reducedMotion() ? "reduced" : "full");
    const measuredWidth = Math.max(320, Math.floor(chart.getBoundingClientRect().width));
    width = measuredWidth;
    const height = Math.max(330, Math.min(500, Math.round(measuredWidth * 0.62)));
    const visibleRates = [...model.ours, ...(model.inria ? [model.inria] : [])].map((point) => point.rateMb);
    const guideLabel = model.inria ? [model.inria] : [];
    const marks = [
      Plot.frame({ stroke: theme.line }),
      Plot.gridY({ stroke: theme.line, strokeOpacity: 0.6 }),
      ...(model.inria ? [
        Plot.ruleY([model.inria.psnr], { stroke: theme.blue, strokeDasharray: "5,4", strokeWidth: 1.4 }),
        Plot.dot([model.inria], {
          x: "rateMb", y: "psnr", fill: theme.paper, stroke: theme.blue, strokeWidth: 2, r: 5,
          title: (/** @type {PlotPoint} */ point) => `INRIA-Q\n${pointLabel(point)}`,
        }),
        Plot.text(guideLabel, {
          x: "rateMb", y: "psnr", text: () => "INRIA-Q", fill: theme.blue,
          dx: -8, dy: -9, textAnchor: "end",
        }),
      ] : []),
      Plot.line(model.ours, { x: "rateMb", y: "psnr", stroke: theme.greenDark, strokeWidth: 2.6 }),
      Plot.dot(model.ours, {
        x: "rateMb", y: "psnr", fill: theme.green, stroke: theme.paper, strokeWidth: 1.2, r: 5,
        title: pointLabel,
      }),
      Plot.dot(selected, {
        x: "rateMb", y: "psnr", fill: theme.paper, stroke: theme.greenDark, strokeWidth: 2.8, r: 9,
      }),
      Plot.dot(selected, { x: "rateMb", y: "psnr", fill: theme.green, r: 4.5 }),
    ];
    const svg = Plot.plot({
      width: measuredWidth,
      height,
      marginTop: 34,
      marginRight: 24,
      marginBottom: 52,
      marginLeft: 64,
      style: { background: "transparent", color: theme.muted, fontFamily: "Inter, sans-serif", fontSize: "0.875rem" },
      x: {
        type: "log",
        label: "Encoded size (MB)",
        nice: true,
        ticks: 6,
        tickFormat: (/** @type {number} */ value) => value < 1 ? value.toFixed(1) : String(value),
      },
      y: { label: "PSNR (dB)", nice: true, ticks: 6 },
      marks,
    });
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-labelledby", "size-rd-title size-rd-description");
    inheritTextSize(svg);
    chart.replaceChildren(svg);
    chart.setAttribute("aria-busy", "false");

    const group = [...svg.querySelectorAll('g[aria-label="dot"]')].find((candidate) => {
      const candidates = [...candidate.querySelectorAll("circle")];
      return candidates.length === model.ours.length && candidates.every((circle, index) =>
        circle.querySelector("title")?.textContent === pointLabel(model.ours[index]));
    });
    const circles = [...(group?.querySelectorAll("circle") || [])];
    for (const [index, circle] of circles.entries()) {
      const point = model.ours[index];
      if (!point) continue;
      circle.setAttribute("data-rd-point", "");
      circle.setAttribute("data-point-index", String(index));
      circle.setAttribute("aria-label", pointLabel(point));
      circle.setAttribute("aria-current", index === pointIndex ? "true" : "false");
      circle.setAttribute("tabindex", interactive ? "0" : "-1");
      if (!interactive) continue;
      circle.setAttribute("role", "button");
      circle.addEventListener("click", () => void bridge.apply({ size: point.sizeTier }));
      circle.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void bridge.apply({ size: point.sizeTier });
      });
    }
    if (focusedIndex >= 0) {
      circles[focusedIndex]?.focus({ preventScroll: true });
    }
    host.setAttribute("data-ready", "");
  };

  const load = async () => {
    if (loading || payload) return;
    loading = true;
    if (status) status.textContent = "Drawing the paper's measurements…";
    try {
      const source = host.dataset.rdSource;
      if (!source) throw new Error("the plot has no data source");
      const loaded = await loadRuntime(source);
      payload = loaded.payload;
      Plot = loaded.Plot;
      status?.remove();
      resizeObserver = new ResizeObserver(() => {
        const next = Math.floor(chart.getBoundingClientRect().width);
        if (Math.abs(next - width) > 3) render();
      });
      resizeObserver.observe(chart);
      render();
    } catch (error) {
      console.error("the rate–distortion plot could not load", error);
      chart.setAttribute("aria-busy", "false");
      // Not a verdict on the data: one fetch failed. Releasing the guard and
      // arming a deliberate approach is the whole retry — the observer and its
      // one-shot listeners have already been consumed, so without this the
      // sentence below would stand for the rest of the session.
      loading = false;
      retryWhenTouched(host, load);
      if (status) {
        status.textContent =
          "The plot could not load. Point at it or focus it to try again; the measurements are in the paper.";
      }
    }
  };

  whenApproached(host, load, 500);

  return (/** @type {PageState} */ nextState) => {
    const changed = nextState.requested.scene !== state?.requested.scene
      || nextState.requested.size !== state?.requested.size;
    state = nextState;
    if (Plot && payload && changed) render();
  };
};

/**
 * M14's dataset-scope plot: the Results chapter's evidence, drawn by the same
 * component and from the same file as the opening figure.
 *
 * What replaced what is the point. This section used to carry the paper's own
 * plots twice — a 1.37 MB iframe of the interactive export and four
 * PDF-converted SVGs — which is 3 MB of pictures of a chart the page can draw
 * from 233 kB of data it already fetches. DESIGN_V2 §13's amendment asks for one
 * component at three scopes, and this is the third.
 *
 * The colours are the page's, not the data's. `rd.json` carries the paper's own
 * series colours, in which our curve is blue and HAC++ is green — correct in a
 * paper whose figures are read on their own, wrong on a page where green means
 * *this is the thing being shown*. So the four roles here are painted from the
 * page's palette and the literature stays a quiet gray.
 *
 * @param {HTMLElement} host
 * @param {SizeManifest | null} manifest
 */
export const datasetPlot = (host, manifest) => {
  const chart = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-chart]"));
  const status = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-status]"));
  const description = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-description]"));
  const caption = /** @type {HTMLElement | null} */ (host.querySelector("[data-rd-caption]"));
  const scopeButtons = [...host.querySelectorAll("[data-rd-scope]")];
  const metricButtons = [...host.querySelectorAll("[data-rd-metric]")];
  if (!chart || !manifest || !scopeButtons.length) return;

  /** @type {RdPayload | null} */
  let payload = null;
  /** @type {any} */
  let Plot = null;
  let loading = false;
  let width = 0;
  let dataset = String(scopeButtons[0].getAttribute("data-rd-scope"));
  let metric = String(metricButtons[0]?.getAttribute("data-rd-metric") || "psnr");

  const styles = getComputedStyle(host);
  const theme = {
    green: styles.getPropertyValue("--green-600").trim(),
    greenDark: styles.getPropertyValue("--green-900").trim(),
    orange: styles.getPropertyValue("--orange").trim(),
    blue: styles.getPropertyValue("--blue").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    line: styles.getPropertyValue("--gray-200").trim(),
    paper: styles.getPropertyValue("--paper").trim(),
    page: styles.getPropertyValue("--page").trim(),
    ink: styles.getPropertyValue("--ink").trim(),
  };

  /** @param {{rateMb: number, value: number}} point @param {string} unit */
  const readout = (point, unit) =>
    `${point.rateMb.toFixed(2)} MB, ${point.value.toFixed(unit === "psnr" ? 2 : 4)}`;

  const label = (/** @type {string} */ name) =>
    scopeButtons.find((button) => button.getAttribute("data-rd-scope") === name)?.textContent?.trim()
    || name;

  const press = () => {
    for (const button of scopeButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.getAttribute("data-rd-scope") === dataset),
      );
    }
    for (const button of metricButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.getAttribute("data-rd-metric") === metric),
      );
    }
  };

  const render = () => {
    if (!Plot || !payload) return;
    const model = datasetPlotModel(payload, manifest, dataset, metric);
    press();
    if (!model) {
      // No data is a sentence, not an empty pair of axes (V3-M).
      chart.replaceChildren();
      chart.setAttribute("aria-busy", "false");
      const note = document.createElement("p");
      note.className = "rd-chart-status";
      note.textContent = `The paper reports no ${metric.toUpperCase()} for ${label(dataset)}.`;
      chart.append(note);
      if (description) description.textContent = note.textContent;
      host.setAttribute("data-ready", "");
      return;
    }
    const measuredWidth = Math.max(320, Math.floor(chart.getBoundingClientRect().width));
    width = measuredWidth;
    const height = Math.max(320, Math.min(520, Math.round(measuredWidth * 0.66)));
    /** One series as a line plus its points. `dot` overrides the point marks
     * only, and is kept out of the line's options rather than passed through as
     * a channel Plot would have to ignore. Both marks carry the series' name as
     * their accessible label: it is how the tip layer below finds the curve to
     * lift, and how a spec identifies a series without a native `<title>`
     * (P1.6, V3-BP — the hover tip replaced the title tooltips on this plot). */
    const series = (/** @type {any} */ entry, /** @type {any} */ options) => {
      const { dot, ...line } = options;
      return [
        Plot.line(entry.points, { x: "rateMb", y: "value", ariaLabel: () => entry.label, ...line }),
        Plot.dot(entry.points, {
          x: "rateMb", y: "value",
          fill: line.stroke, r: 3.2,
          ariaLabel: () => entry.label,
          ...(dot || {}),
        }),
      ];
    };
    /** Every drawn point with its series' name, for the one tip layer. */
    const named = (/** @type {any} */ entry) =>
      entry.points.map((/** @type {any} */ point) => ({ ...point, series: entry.label }));
    const everyPoint = [
      ...model.literature.flatMap(named),
      ...(model.reference ? named(model.reference) : []),
      ...(model.hacpp ? named(model.hacpp) : []),
      ...named(model.ours),
    ];
    const marks = [
      Plot.frame({ stroke: theme.line }),
      Plot.gridY({ stroke: theme.line, strokeOpacity: 0.6 }),
      ...model.literature.flatMap((entry) => series(entry, {
        stroke: theme.muted, strokeWidth: 1, opacity: 0.45,
      })),
      ...(model.reference ? [
        Plot.ruleY([model.reference.points[0].value], {
          stroke: theme.blue, strokeDasharray: "5,4", strokeWidth: 1.4,
        }),
        Plot.text([model.reference.points[0]], {
          x: "rateMb", y: "value", text: () => "INRIA-Q", fill: theme.blue,
          dx: -8, dy: -9, textAnchor: "end",
        }),
        Plot.dot(model.reference.points, {
          x: "rateMb", y: "value", fill: theme.paper, stroke: theme.blue, strokeWidth: 2, r: 5,
          ariaLabel: () => model.reference.label,
        }),
      ] : []),
      ...(model.hacpp ? series(model.hacpp, {
        stroke: theme.orange, strokeWidth: 1.8, dot: { r: 4 },
      }) : []),
      ...series(model.ours, {
        stroke: theme.greenDark, strokeWidth: 2.6, dot: { r: 4.6, fill: theme.green },
      }),
      // The tip (V3-BP): the method's name and readout at the point nearest the
      // pointer — over a line as much as over a dot, and on a tap — in the
      // page's own tokens. Plot's pointer publishes the hovered datum as the
      // SVG's `value` and fires `input`; the listener after `plot()` turns that
      // into the lifted curve, because the pointer transform itself renders one
      // point, never the series the point belongs to.
      Plot.tip(everyPoint, Plot.pointer({
        x: "rateMb", y: "value", maxRadius: 40,
        title: (/** @type {any} */ point) =>
          `${point.series}\n${point.rateMb.toFixed(2)} MB · ${point.value.toFixed(metric === "psnr" ? 2 : 4)}`
          + `${metric === "psnr" ? " dB" : ""} ${metric.toUpperCase()}`,
        fill: theme.page, stroke: theme.line, textPadding: 8, lineHeight: 1.3,
        fontFamily: "Inter, sans-serif", fontSize: 14,
      })),
    ];
    const svg = Plot.plot({
      width: measuredWidth,
      height,
      marginTop: 34,
      marginRight: 24,
      marginBottom: 52,
      marginLeft: 66,
      style: {
        background: "transparent", color: theme.muted,
        fontFamily: "Inter, sans-serif", fontSize: "0.875rem",
      },
      x: {
        type: "log",
        label: "Encoded size (MB)",
        nice: true,
        ticks: 6,
        tickFormat: (/** @type {number} */ value) =>
          value < 1 ? value.toFixed(1) : String(value),
      },
      // A metric the reader wants *small* is drawn with small at the top, so
      // "up and to the left is better" stays true for every metric.
      y: { label: model.metric.label, nice: true, ticks: 6, reverse: !model.metric.maximize },
      marks,
    });
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-labelledby", `${host.id}-title ${host.id}-description`);
    inheritTextSize(svg);
    const lines = [...svg.querySelectorAll('[aria-label="line"] path')];
    svg.addEventListener("input", () => {
      const hot = /** @type {{series?: string} | null} */ (/** @type {any} */ (svg).value)?.series ?? null;
      for (const path of lines) {
        path.parentElement?.toggleAttribute("data-hot", hot !== null && path.getAttribute("aria-label") === hot);
      }
    });
    chart.replaceChildren(svg);
    chart.setAttribute("aria-busy", "false");
    if (caption) {
      caption.textContent =
        `${label(dataset)} · ${model.metric.shortLabel} · dataset mean`;
    }
    if (description) {
      const literature = model.literature.map((entry) => entry.label).join(", ");
      description.textContent = [
        `${label(dataset)}, ${model.metric.label}, one point per operating point of each method.`,
        `Our own curve is ${model.ours.points.length} encoded sizes, recomputed here.`,
        model.hacpp
          ? `HAC++ is ${model.hacpp.points.length} operating points, also recomputed under our protocol.`
          : "HAC++ reports nothing for this scope.",
        model.reference
          ? `The dashed rule is the uncompressed INRIA-Q reference at ${readout(model.reference.points[0], metric)}.`
          : "",
        literature ? `The faint series are self-reported literature values: ${literature}.` : "",
        // Smaller-is-better metrics reverse the y axis above, so the useful
        // direction remains visually and accessibly consistent.
        "Up and to the left is better.",
      ].filter(Boolean).join(" ");
    }
    host.setAttribute("data-ready", "");
  };

  const load = async () => {
    if (loading || payload) return;
    loading = true;
    if (status) status.textContent = "Drawing the paper's measurements…";
    try {
      const source = host.dataset.rdSource;
      if (!source) throw new Error("the plot has no data source");
      const loaded = await loadRuntime(source);
      payload = loaded.payload;
      Plot = loaded.Plot;
      status?.remove();
      new ResizeObserver(() => {
        const next = Math.floor(chart.getBoundingClientRect().width);
        if (Math.abs(next - width) > 3) render();
      }).observe(chart);
      render();
    } catch (error) {
      console.error("the dataset plot could not load", error);
      chart.setAttribute("aria-busy", "false");
      // The scope and metric buttons are already a retry trigger — they call
      // `load()` when there is no payload — but only once the guard is released.
      loading = false;
      retryWhenTouched(host, load);
      if (status) {
        status.textContent =
          "The plot could not load. Point at it or choose a scope to try again; the measurements are in the paper.";
      }
    }
  };

  for (const button of [...scopeButtons, ...metricButtons]) {
    button.addEventListener("click", () => {
      const scope = button.getAttribute("data-rd-scope");
      const chosen = button.getAttribute("data-rd-metric");
      if (scope) dataset = scope;
      if (chosen) metric = chosen;
      press();
      if (payload) render();
      else void load();
    });
  }
  press();
  whenApproached(host, load, 500);
};
