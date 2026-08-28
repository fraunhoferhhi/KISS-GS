// @ts-check
/**
 * The band's form — wide or compact — as one attribute on the viewer panel.
 *
 * P1.8 (T5, V3-BO). The compact form (no headings, no ruler, the camera on one
 * row) used to be keyed on `@container band style(--band-form: compact)`, with
 * the flag set by two CSS triggers: the short-viewport media query and a 600 px
 * panel-width container query. Safari 17 — the 2017 iPad Pro on iPadOS 17 —
 * resolves neither `style()` queries nor the flag, so it drew the tip folded
 * into a band that was still wide. The two triggers now feed one decision made
 * here, written to `data-band-form` on `#viewer-panel`, and every compact rule
 * in the stylesheet keys on that attribute; `test/rules.test.mjs` holds the
 * stylesheet to zero `style(`.
 *
 * The first value is written by an inline script in the template, before the
 * panel's first paint, from the same two facts (`data-short-viewport`,
 * `data-narrow-panel`) — a module runs after the parser finishes, and a band
 * that paints wide and then snaps short on every phone load would be a
 * regression on the container query it replaces. This module keeps the value
 * current: the media query's `change` event and a `ResizeObserver` on the
 * panel, whose content box is what the container query measured.
 */

/** The panel width, in CSS px, at and under which the band is compact. */
export const DEFAULT_NARROW_PANEL_PX = 600;

/**
 * The rule, on its own so `node --test` can hold it.
 * @param {boolean} shortViewport
 * @param {number} panelWidth content-box width of `#viewer-panel`
 * @param {number} [narrowPanelPx]
 * @returns {"wide" | "compact"}
 */
export const bandFormFor = (shortViewport, panelWidth, narrowPanelPx = DEFAULT_NARROW_PANEL_PX) =>
  shortViewport || panelWidth <= narrowPanelPx ? "compact" : "wide";

/**
 * Keep `data-band-form` current on the panel. Applies once synchronously.
 * @param {HTMLElement} panel `#viewer-panel`, carrying `data-short-viewport`
 *   (a media query) and `data-narrow-panel` (a px number)
 */
export const bandForm = (panel) => {
  const query = panel.dataset.shortViewport || "";
  const narrow = Number(panel.dataset.narrowPanel) || DEFAULT_NARROW_PANEL_PX;
  // `not all` is a media query that never matches: a panel that states no query
  // simply never has a short viewport.
  const short = window.matchMedia(query || "not all");
  /** @param {number} width */
  const apply = (width) => {
    const form = bandFormFor(short.matches, width, narrow);
    if (panel.dataset.bandForm !== form) panel.dataset.bandForm = form;
  };
  const contentWidth = () => {
    const style = getComputedStyle(panel);
    return panel.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  };
  short.addEventListener("change", () => apply(contentWidth()));
  // Every engine that can run the viewer has ResizeObserver; its callback runs
  // after layout and before paint, so a split drag never shows a stale form.
  new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentBoxSize?.[0];
    apply(box ? box.inlineSize : contentWidth());
  }).observe(panel);
  apply(contentWidth());
};
