// @ts-check
/** Wire the three modules together. Everything interesting is in them. */

import { createBridge } from "./viewer-bridge.js";
import { initStory } from "./story.js";
import { datasetPlot, rateDistortionPlot } from "./rd-plot.js";
import { attributeBreakdown, planeDisclosure } from "./attribute-breakdown.js";
import { planeProbe } from "./plane-probe.js";
import { exploreNudge } from "./nudge.js";
import { bandForm } from "./band-form.js";
import {
  bandSurface,
  cameraGroup,
  frameRate,
  rendererFallback,
  scenePicker,
  scenePreviews,
  sceneFigures,
  sceneArrival,
  sizeSlider,
  splitDivider,
  stageStatus,
  stageTip,
  statFigures,
  viewportActions,
  printPreparation,
} from "./controls.js";

/** @param {string} id */
const need = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the shell is missing #${id}`);
  return element;
};

const panel = need("viewer-panel");
// First, and synchronously: the band's form is layout the rest builds on. The
// template's inline script wrote the first value; this keeps it current.
bandForm(panel);
const frame = /** @type {HTMLIFrameElement} */ (need("viewer"));
const statCard = need("stat-card");

// The build already rendered the exported scene's figures into the card, and the
// bridge must start from the same values rather than from a placeholder: the two
// agree to the character, so nothing flickers when the viewer becomes ready.
/** @param {string} key */
const initial = (key) => {
  const node = statCard.querySelector(`[data-stat="${key}"]`);
  return node?.getAttribute("aria-label") || node?.textContent?.trim() || "unavailable";
};

/**
 * The build's size manifest: every exported operating point of every scene, with
 * its bytes and the quality measured for it. Absent only when the page was built
 * without a viewer export, in which case the slider has nothing to offer and
 * stays empty rather than guessing a scale.
 * @type {import("./controls.js").SizeManifest | null}
 */
let sizes = null;
try {
  const payload = document.getElementById("size-data")?.textContent;
  if (payload) sizes = JSON.parse(payload);
} catch (error) {
  console.error("the size manifest is invalid", error);
}

const bridge = createBridge({
  panel,
  frame,
  initialStats: { bytes: initial("bytes"), count: initial("count"), bits: initial("bits") },
});

/**
 * Optional hosts: a widget mirrored into the prose exists only where its section
 * does. A missing one is not a broken shell.
 * @param {string} id
 */
const optional = (id) => document.getElementById(id);

const planes = optional("plane-disclosure");
const widgets = [
  statFigures(document),
  sceneFigures(document, sizes),
  sceneArrival(statCard, bridge),
  frameRate(statCard),
  rendererFallback(need("stage-fallback"), bridge),
  stageStatus(need("stage-status")),
  stageTip(need("stage-tip")),
  bandSurface(need("control-band")),
  cameraGroup(need("control-band"), bridge),
  sizeSlider(need("control-band"), bridge, sizes),
  scenePicker(need("stage-cards"), bridge, sizes),
  attributeBreakdown(need("control-band"), need("attribute-breakdown"), bridge, sizes, planes),
  rateDistortionPlot(need("size-rd-plot"), bridge, sizes),
  viewportActions(need("viewport-actions"), panel, bridge),
];

// The prose mirrors of V3-C. Same widget, same bridge, same requested state —
// the only difference is that a mirror is not unlock-gated, because it lives
// inside the section that introduces it.
// V3-O's raw-plane disclosure. Not in the list above because it is absent from
// a page built with no viewer export, exactly like the figure it sits under.
if (planes) {
  widgets.push(planeDisclosure(planes, sizes));
  // The pixel probe (V3-AL): page-owned, and the one thing worth keeping from
  // the explorer V3-O removed.
  widgets.push(planeProbe(planes, sizes, bridge));
}

// The Results chapter's dataset-scope plot. Not part of the bridge's widget
// list: it draws the paper's per-dataset means, which no renderer state moves.
const datasetFigure = optional("results-rd");
if (datasetFigure) datasetPlot(datasetFigure, sizes);

const sizeMirror = optional("size-mirror");
if (sizeMirror) widgets.push(sizeSlider(sizeMirror, bridge, sizes, { gate: false }));
const sceneMirror = optional("scene-mirror");
if (sceneMirror) widgets.push(scenePicker(sceneMirror, bridge, sizes, { gate: false }));
const scenePreviewCards = optional("scene-previews");
if (scenePreviewCards) widgets.push(scenePreviews(scenePreviewCards, bridge));

bridge.subscribe((state) => {
  for (const render of widgets) render(state);
});

splitDivider(need("divider"), need("split"));
printPreparation(optional("stage-fallback"));

/** @type {import("./story.js").SectionSpec[]} */
let sections = [];
try {
  sections = JSON.parse(document.getElementById("story-data")?.textContent || "[]");
} catch (error) {
  console.error("the story payload is invalid", error);
}

initStory({ story: need("story"), breadcrumb: document.getElementById("breadcrumb"), sections, bridge });
// F3.3: the one hint the page volunteers about the camera, and only to a visitor
// who has read on without ever touching it.
exploreNudge({ stage: need("stage"), story: need("story"), panel, sections, bridge });

/**
 * The one and only renderer state this page authors (V3-A, V3-B).
 *
 * It is applied once, from the build's validated boot entry — the export's first
 * scene at its default tier, which is also where the slider's track already
 * stands — plus the complete attribute set and the slow idle orbit. Nothing
 * re-applies it: a visitor who changes the scene and scrolls back to the opening
 * keeps their scene, and `apply` waits for the viewer handle itself, so this is
 * the same single selection the page has always issued at boot.
 */
const boot = () => {
  /** @type {import("./viewer-bridge.js").ViewerIntent} */
  const intent = { attributes: "all", camera: "orbit" };
  if (sizes?.boot) {
    intent.scene = sizes.boot.scene;
    intent.size = sizes.boot.tier;
  }
  return bridge.apply(intent);
};

void boot();
void bridge.start();
