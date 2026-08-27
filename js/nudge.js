// @ts-check
/**
 * The explore-the-scene nudge (F3.3, R13).
 *
 * One small pill over the stage's lower edge — "Drag to look around · scroll to
 * zoom" with the cube mark — shown to a visitor who has read past the first
 * section without ever touching the camera, while no scene is arriving. It is
 * dismissed by any camera input, by its own close button, or after a while, and
 * it is shown once per session. It never takes focus and it is absent from the
 * static document: this module creates it, and removes it.
 *
 * The condition is read from three places the page already owns: the story's
 * current section (`#story[data-section]`, written by `initStory`), the bridge's
 * `inputSeen` (the viewer's input-activity signal, F3.1) and its `arriving`.
 */

import { readTimeout } from "./viewer-bridge.js";

const STORAGE_KEY = "kissgs:nudge";
const DEFAULT_DISMISS_MS = 8_000;

/**
 * Touch has no wheel, so the second clause is dropped rather than made wrong.
 * @param {boolean} coarse
 */
export const nudgeText = (coarse) =>
  coarse ? "Drag to look around" : "Drag to look around · scroll to zoom";

const alreadyShown = () => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "shown";
  } catch {
    return false;
  }
};

const rememberShown = () => {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, "shown");
  } catch {
    // Blocked storage costs at most one extra nudge per page load.
  }
};

/**
 * @param {object} options
 * @param {HTMLElement} options.stage   the pill's host; it is positioned inside it
 * @param {HTMLElement} options.story   carries `data-section`
 * @param {HTMLElement} options.panel   carries the `data-nudge-dismiss-ms` budget
 * @param {import("./story.js").SectionSpec[]} options.sections  in page order
 * @param {{subscribe: (listener: (state: import("./viewer-bridge.js").PageState) => void) => () => void}} options.bridge
 */
export const exploreNudge = ({ stage, story, panel, sections, bridge }) => {
  const firstId = sections[0]?.id ?? null;
  const dismissMs = readTimeout(panel, "nudgeDismissMs", DEFAULT_DISMISS_MS);
  /** @type {HTMLElement | null} */
  let pill = null;
  let timer = 0;
  let done = alreadyShown();
  /** @type {import("./viewer-bridge.js").PageState | null} */
  let latest = null;

  const dismiss = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (!pill) return;
    pill.remove();
    pill = null;
  };

  const passedFirst = () => {
    const current = story.dataset.section;
    return Boolean(current) && current !== firstId;
  };

  const build = () => {
    const coarse = window.matchMedia("(hover: none), (pointer: coarse)").matches;
    const node = document.createElement("div");
    node.className = "stage-nudge";
    node.setAttribute("role", "status");
    node.setAttribute("data-nudge", "");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "stat-cube");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of ["m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z", "m4 7.5 8 4.5 8-4.5M12 12v9"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    const text = document.createElement("span");
    text.textContent = nudgeText(coarse);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "stage-nudge-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", dismiss);
    node.append(svg, text, close);
    return node;
  };

  const show = () => {
    done = true;
    rememberShown();
    pill = build();
    stage.append(pill);
    timer = window.setTimeout(dismiss, dismissMs);
  };

  const evaluate = () => {
    if (!latest) return;
    if (latest.inputSeen) {
      done = true;
      dismiss();
      return;
    }
    if (done || pill) return;
    if (latest.renderer !== "ready" || latest.arriving) return;
    if (!passedFirst()) return;
    show();
  };

  bridge.subscribe((state) => {
    latest = state;
    evaluate();
  });
  new MutationObserver(evaluate).observe(story, {
    attributes: true,
    attributeFilter: ["data-section"],
  });
};
