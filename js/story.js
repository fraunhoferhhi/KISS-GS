// @ts-check
/**
 * The story panel: which section the visitor is in, and the breadcrumb.
 *
 * Under V3-A this module has exactly two outputs, and the renderer is not one of
 * them. Reading position moves the breadcrumb and cumulatively unlocks controls.
 * It never selects a scene or a tier, never touches the camera, and never
 * toggles an attribute — so there is no `apply` call anywhere in this file, and
 * `SectionSpec` has no axis through which one could arrive.
 *
 * What remains:
 *
 *   1. Unlocks are monotonic for the session, forwards and backwards.
 *   2. Nothing the viewer emits can move the page: the page-to-viewer direction
 *      no longer exists, and this file neither scrolls nor navigates on any
 *      viewer event.
 *
 * The one authored renderer state left on the page is the boot payload
 * `main.js` applies once (V3-B); returning to the opening restores nothing.
 */

/**
 * One entry of the story payload the build embeds.
 * @typedef {object} SectionSpec
 * @property {string} id
 * @property {string | null} nav
 * @property {string[]} unlocks
 */

/**
 * @typedef {object} StoryState
 * @property {string | null} active
 * @property {string[]} unlocked
 */

/* -------------------------------------------------------------------------- *
 * pure — covered by `node --test` in milliseconds, no browser involved
 * -------------------------------------------------------------------------- */

/**
 * The transition rule: which section is being read, and what is unlocked.
 *
 * There is nothing else to return. A transition — in either direction, into a
 * section or back out of it — produces no renderer operation, which is what
 * makes a scroll physically unable to fight the visitor's own input.
 *
 * @param {StoryState} current
 * @param {SectionSpec} section
 * @returns {{state: StoryState, unlocked: string[]}}
 */
export const nextState = (current, section) => {
  const unlocked = [...new Set([...current.unlocked, ...section.unlocks])];
  const active = current.active === section.id ? current.active : section.id;
  return { state: { active, unlocked }, unlocked };
};

/**
 * Give every section the unlocks of every section up to and including it.
 *
 * The observer coalesces through `requestAnimationFrame`, and a breadcrumb jump
 * moves several sections at once, so the sections in between are never entered.
 * With per-section unlocks the controls they introduce would stay locked for the
 * rest of the session — a visitor who flicked past the size section would never
 * see the size slider. Accumulating by position makes the control surface a
 * function of how far the visitor has come rather than of how they got there,
 * and keeps unlocking monotonic either way.
 *
 * @param {SectionSpec[]} sections  in page order
 * @returns {SectionSpec[]}
 */
export const withCumulativeUnlocks = (sections) => {
  /** @type {string[]} */
  const seen = [];
  return sections.map((section) => {
    for (const name of section.unlocks) if (!seen.includes(name)) seen.push(name);
    return { ...section, unlocks: [...seen] };
  });
};

/**
 * Which breadcrumb entry is current while `activeId` is being read.
 *
 * A section without a `nav` label is not an entry of its own: it belongs to the
 * last entry before it. That is what lets one entry — "How it works" — cover the
 * pipeline, the sorting and the symmetry sections without the breadcrumb going
 * dark for two of the three.
 *
 * @param {SectionSpec[]} sections  in page order
 * @param {string | null} activeId
 * @returns {string | null}
 */
export const breadcrumbFor = (sections, activeId) => {
  if (!activeId) return null;
  let current = null;
  for (const section of sections) {
    if (section.nav) current = section.id;
    if (section.id === activeId) return current;
  }
  return null;
};

/**
 * Pick the section the visitor is reading from a set of intersection records.
 *
 * The rule is "the topmost section that has crossed the reading line", which is
 * stable in both scroll directions — picking the largest intersection ratio is
 * not, because a short section can never win against a tall neighbour.
 *
 * @param {{id: string, top: number, bottom: number}[]} boxes
 * @param {number} line  the reading line, in the scroll container's coordinates
 * @returns {string | null}
 */
export const activeSection = (boxes, line) => {
  let best = null;
  for (const box of boxes) {
    if (box.top <= line && box.bottom > line) return box.id;
    if (box.top > line && (best === null || box.top < best.top)) best = box;
  }
  return best ? best.id : (boxes.length ? boxes[boxes.length - 1].id : null);
};

/**
 * Where a target belongs in the story panel's own scroll coordinates.
 * `Element.scrollIntoView` walks every scrollable ancestor; once an early
 * section became tall enough at M5, Chrome also moved the root document by the
 * masthead's height. The desktop composition has exactly one vertical scroller
 * here, so address that scroller directly.
 *
 * @param {number} scrollTop
 * @param {number} panelTop
 * @param {number} targetTop
 * @param {number} scrollMarginTop
 */
export const panelScrollTarget = (scrollTop, panelTop, targetTop, scrollMarginTop) =>
  Math.max(0, scrollTop + targetTop - panelTop - scrollMarginTop);

/* -------------------------------------------------------------------------- *
 * DOM wiring — thin, on purpose
 * -------------------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {HTMLElement} options.story
 * @param {HTMLElement | null} options.breadcrumb
 * @param {SectionSpec[]} options.sections
 * @param {{unlock: (names: string[]) => void}} options.bridge
 */
export const initStory = ({ story, breadcrumb, sections, bridge }) => {
  const ordered = withCumulativeUnlocks(sections);
  /** @type {Map<string, SectionSpec>} */
  const specs = new Map(ordered.map((section) => [section.id, section]));
  const elements = /** @type {HTMLElement[]} */ ([
    ...story.querySelectorAll(":scope > section[id]"),
  ]);
  /** @type {StoryState} */
  let state = { active: null, unlocked: [] };

  /** @param {HTMLElement} target @param {ScrollBehavior} behavior */
  const scrollToSection = (target, behavior) => {
    const overflow = getComputedStyle(story).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      const panel = story.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      story.scrollTo({
        top: panelScrollTarget(story.scrollTop, panel.top, box.top, margin),
        behavior,
      });
      return;
    }
    target.scrollIntoView({ behavior, block: "start" });
  };

  // The bar pins (its `top` is where the visible story begins); the entry list
  // inside it scrolls and fades (P2.3 gave the bar a second child, the toggle).
  const crumbs = /** @type {HTMLElement | null} */ (breadcrumb?.querySelector("[data-crumb-list]") ?? breadcrumb);

  const links = new Map(
    [...(breadcrumb?.querySelectorAll("a[data-nav]") || [])].map((link) => [
      /** @type {HTMLAnchorElement} */ (link).dataset.nav || "",
      /** @type {HTMLAnchorElement} */ (link),
    ]),
  );

  /**
   * Keep the current entry visible in the breadcrumb's own horizontal scroller.
   * Written as `scrollLeft` rather than `scrollIntoView` on purpose: the latter
   * scrolls every ancestor that can scroll, and the nearest one here is the
   * story panel — the page moving itself because the breadcrumb caught up is
   * precisely the loop this module must not create.
   *
   * @param {HTMLAnchorElement} link
   */
  const revealCrumb = (link) => {
    if (!crumbs) return;
    const strip = crumbs.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    const pad = 16;
    if (box.left < strip.left + pad) {
      crumbs.scrollLeft -= strip.left + pad - box.left;
    } else if (box.right > strip.right - pad) {
      crumbs.scrollLeft += box.right - (strip.right - pad);
    }
    markCrumbEdges();
  };

  /**
   * Say which way the breadcrumb still has entries, so the stylesheet can fade
   * that edge. The scrollbar is hidden — a strip that is quietly cut off with no
   * affordance is a strip whose last entries do not exist as far as a visitor is
   * concerned, and on a narrow panel that is most of them.
   */
  const markCrumbEdges = () => {
    if (!crumbs) return;
    const slack = 2;
    const edges = [];
    if (crumbs.scrollLeft > slack) edges.push("start");
    if (crumbs.scrollLeft + crumbs.clientWidth < crumbs.scrollWidth - slack) {
      edges.push("end");
    }
    const value = edges.join(" ");
    if (crumbs.dataset.edge !== value) crumbs.dataset.edge = value;
  };

  /** @param {string} id */
  const enter = (id) => {
    const spec = specs.get(id);
    if (!spec) return;
    const result = nextState(state, spec);
    state = result.state;
    bridge.unlock(result.unlocked);
    story.dataset.section = id;
    const crumb = breadcrumbFor(ordered, id);
    for (const [key, link] of links) {
      if (key === crumb) {
        link.setAttribute("aria-current", "true");
        revealCrumb(link);
      } else link.removeAttribute("aria-current");
    }
  };

  // The reading line sits a third of the way down the panel: a section becomes
  // "the one being read" when its heading has comfortably arrived, not when its
  // first pixel appears.
  const measure = () => {
    // On desktop the story panel is its own scroll context; on a phone the whole
    // document scrolls and the panel just sits in it. Either way the reading
    // line is expressed in viewport coordinates, which is what
    // getBoundingClientRect already gives us.
    const panel = story.getBoundingClientRect();
    // The visible story begins where its sticky breadcrumb pins: 0 on the
    // desktop, the pinned renderer panel's height on a phone (P2.2, V3-BN),
    // where the panel covers the top of the document and a section scrolled
    // to its scroll margin arrives below it, not at the viewport's top.
    const pinned = breadcrumb ? Number.parseFloat(getComputedStyle(breadcrumb).top) || 0 : 0;
    const top = Math.max(panel.top, pinned, 0);
    const bottom = Math.min(panel.bottom, document.documentElement.clientHeight);
    return {
      line: top + Math.max(bottom - top, 0) / 3,
      boxes: elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { id: element.id, top: box.top, bottom: box.bottom };
      }),
    };
  };

  let scheduled = 0;
  const update = () => {
    if (scheduled) return;
    scheduled = window.requestAnimationFrame(() => {
      scheduled = 0;
      const { boxes, line } = measure();
      const id = activeSection(boxes, line);
      if (id && id !== state.active) enter(id);
    });
  };

  crumbs?.addEventListener("scroll", markCrumbEdges, { passive: true });
  window.addEventListener("resize", markCrumbEdges, { passive: true });
  markCrumbEdges();

  story.addEventListener("scroll", update, { passive: true });
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });

  breadcrumb?.addEventListener("click", (event) => {
    const link = /** @type {HTMLElement} */ (event.target).closest("a[data-nav]");
    if (!link) return;
    const target = document.getElementById(
      /** @type {HTMLAnchorElement} */ (link).dataset.nav || "",
    );
    if (!target) return;
    event.preventDefault();
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollToSection(target, smooth ? "smooth" : "auto");
    // Move focus with the view. A keyboard visitor who activates a breadcrumb
    // entry and is left parked at the old position has been moved without being
    // told, and their next Tab continues from where they no longer are. Focus
    // does not scroll: the smooth scroll above owns that.
    target.focus({ preventScroll: true });
  });

  // Same-page resource links target this nested scroller too. Native fragment
  // navigation may move both the panel and the root document, hiding the title
  // above the viewport; route section targets through the same geometry as the
  // breadcrumb and move focus without asking a second scroller to intervene.
  document.addEventListener("click", (event) => {
    const link = /** @type {HTMLElement} */ (event.target).closest('a[href^="#"]');
    if (!link || breadcrumb?.contains(link)) return;
    const href = /** @type {HTMLAnchorElement} */ (link).getAttribute("href") || "";
    const target = href.length > 1 ? document.getElementById(href.slice(1)) : null;
    if (!target || !elements.includes(target)) return;
    event.preventDefault();
    // Resource links can cross the entire paper. Native smooth scrolling over
    // that distance spends seconds sweeping through unrelated sections and
    // makes the composition look as though it has fallen apart. Land directly;
    // breadcrumb hops remain smooth because they are the reading navigation.
    scrollToSection(target, "auto");
    target.focus({ preventScroll: true });
  });

  // The first section is entered explicitly rather than waiting for a scroll,
  // so the breadcrumb and the opening's unlocks are right before the first
  // scroll event rather than after it.
  if (elements.length) enter(elements[0].id);
  update();

  return { get active() { return state.active; } };
};
