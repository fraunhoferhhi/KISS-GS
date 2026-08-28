// @ts-check

/**
 * P2.3 (T11, V3-BN): the phone's scene toggle.
 *
 * Below 900 px the renderer panel is pinned at the top of the viewport (P2.2),
 * and this button in the sticky breadcrumb bar collapses it. Collapsed is one
 * attribute on `#split`: the stylesheet takes the panel's height to zero and
 * hides it, the breadcrumb pins at 0, and the iframe is never touched — no
 * `display: none`, no `src` change — so collapsing never re-decodes the scene.
 * The choice persists for the session, like the nudge; a landscape phone starts
 * collapsed because the pinned renderer would otherwise take most of it.
 *
 * The template's inline script writes the first value before the panel's first
 * paint from the same key and query, so a remembered collapse never flashes the
 * open panel; this module keeps it current. `test/rules.test.mjs` holds the
 * constants to the template.
 */

export const SCENE_STORAGE_KEY = "kissgs:scene";
export const LANDSCAPE_PHONE = "(max-width: 899px) and (max-height: 499px)";

/**
 * A stored choice wins; without one, only a landscape phone starts collapsed.
 * @param {string | null} stored
 * @param {boolean} landscape
 * @returns {"hidden" | "shown"}
 */
export const initialSceneState = (stored, landscape) =>
  stored === "hidden" || stored === "shown" ? stored : landscape ? "hidden" : "shown";

/**
 * @param {{
 *   split: HTMLElement,
 *   button: HTMLButtonElement,
 *   bridge: {setSceneHidden: (hidden: boolean) => void},
 * }} options
 */
export const sceneToggle = ({ split, button, bridge }) => {
  const read = () => {
    try {
      return window.sessionStorage.getItem(SCENE_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const write = (/** @type {string} */ value) => {
    try {
      window.sessionStorage.setItem(SCENE_STORAGE_KEY, value);
    } catch {
      // Blocked storage costs the choice one reload, nothing more.
    }
  };
  if (split.dataset.scene !== "hidden" && split.dataset.scene !== "shown") {
    split.dataset.scene = initialSceneState(read(), window.matchMedia(LANDSCAPE_PHONE).matches);
  }
  const render = () => {
    const shown = split.dataset.scene !== "hidden";
    button.setAttribute("aria-pressed", String(shown));
    const label = shown ? "Hide scene" : "Show scene";
    button.setAttribute("aria-label", label);
    button.title = label;
    const text = button.querySelector("[data-scene-toggle-text]");
    if (text) text.textContent = label;
  };
  button.addEventListener("click", () => {
    const hidden = split.dataset.scene !== "hidden";
    split.dataset.scene = hidden ? "hidden" : "shown";
    write(split.dataset.scene);
    render();
    // A hidden scene should not spend battery on a path nobody sees.
    bridge.setSceneHidden(hidden);
  });
  // Shipped `disabled`: the static document never offers a control that cannot act.
  button.disabled = false;
  render();
};
