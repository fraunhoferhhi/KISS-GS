/** Lazy activation that does not depend on one engine's observer timing.
 *
 * The figures on this page that are heavy enough to load only when they are
 * about to be seen — the rate–distortion plot and the comparison gallery (and,
 * until F1.5, the sorting scrubber) — each used an `IntersectionObserver` plus
 * `pointerenter` and `focusin`, written out once per figure.
 *
 * The observer alone is not enough. In WebKit, a *programmatic* scroll of the
 * story pane — a fragment navigation, or anything that calls `scrollIntoView` —
 * can bring a figure fully into view without the observer's callback ever
 * running, so the figure stays blank until something else disturbs the page.
 * Chromium and Firefox deliver it. Rather than trust the difference, the
 * geometry is also checked on the scroll and resize events every engine does
 * deliver — capture phase, so a nested scroller counts — and once at
 * registration, for a figure that is already on screen.
 *
 * Whichever signal arrives first wins, and the load runs once.
 */

/** @type {Set<{host: Element, margin: number, fire: () => void}>} */
const waiting = new Set();
let listening = false;

const check = () => {
  for (const entry of [...waiting]) {
    const box = entry.host.getBoundingClientRect();
    const height = window.innerHeight || 0;
    const width = window.innerWidth || 0;
    const near = box.bottom >= -entry.margin && box.top <= height + entry.margin
      && box.right >= -entry.margin && box.left <= width + entry.margin;
    if (!near) continue;
    waiting.delete(entry);
    entry.fire();
  }
  if (waiting.size || !listening) return;
  document.removeEventListener("scroll", check, true);
  window.removeEventListener("resize", check);
  listening = false;
};

/**
 * Run `load` once, when `host` comes within `margin` pixels of the viewport, or
 * when it is pointed at or focused — whichever happens first.
 *
 * @param {Element} host
 * @param {() => unknown} load
 * @param {number} [margin]
 */
export const whenApproached = (host, load, margin = 400) => {
  let started = false;
  const fire = () => {
    if (started) return;
    started = true;
    void load();
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      fire();
    }, { rootMargin: `${margin}px` });
    observer.observe(host);
    waiting.add({ host, margin, fire });
    if (!listening) {
      listening = true;
      document.addEventListener("scroll", check, { passive: true, capture: true });
      window.addEventListener("resize", check, { passive: true });
    }
    check();
  } else {
    fire();
  }
  host.addEventListener("pointerenter", fire, { once: true });
  host.addEventListener("focusin", fire, { once: true });
};

/**
 * Ask again, after a failed load.
 *
 * Deliberately pointer and focus only. The viewport check in `whenApproached`
 * would fire again the moment it is re-registered for a figure that is already
 * on screen, turning one failed fetch into a retry loop; a deliberate approach
 * cannot. Both listeners are one-shot, so a second failure simply arms them
 * again through the same call.
 *
 * @param {Element} host
 * @param {() => unknown} load
 */
export const retryWhenTouched = (host, load) => {
  const again = () => {
    host.removeEventListener("pointerenter", again);
    host.removeEventListener("focusin", again);
    void load();
  };
  host.addEventListener("pointerenter", again, { once: true });
  host.addEventListener("focusin", again, { once: true });
};

/**
 * The specifier to import on attempt number `failures`.
 *
 * A module whose fetch failed stays in the browser's module map *as a failure*,
 * so re-importing the same specifier returns the same error without ever
 * reaching the network — which would make every retry here a no-op. A query
 * makes the second attempt a genuinely new module, and it is paid only after a
 * failure.
 *
 * @param {string} specifier
 * @param {number} failures
 */
export const retryable = (specifier, failures) =>
  (failures ? `${specifier}?retry=${failures}` : specifier);
