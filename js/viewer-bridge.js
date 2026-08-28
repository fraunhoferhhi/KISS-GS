// @ts-check
/**
 * The only code on this page that touches the viewer iframe.
 *
 * Three things here were earned the hard way in v1 and are ported deliberately
 * rather than re-derived: the late-handle polling (the iframe's `load` event is
 * not the moment `ffsplatViewers` exists), the generous and injectable timeout
 * budgets (`viewer.ready` resolves on the FIRST RENDERED FRAME, which on a cold
 * phone is several seconds of adapter, shaders, fetch, decode, upload and sort),
 * and the latest-intent reconciliation that stops a fast scroll or a rapid
 * slider drag from landing a stale scene.
 *
 * Everything else is new and much smaller, because of one rule: the bridge owns
 * a single state object and a `subscribe`, every widget is a pure
 * `render(state)`, and no widget ever calls another. That is the fix for v1's
 * tangle of sync functions calling each other.
 *
 * @typedef {import("@viewer/viewer-contracts").Viewer} Viewer
 * @typedef {import("@viewer/viewer-contracts").ViewerStateSnapshot} ViewerStateSnapshot
 * @typedef {import("@viewer/viewer-contracts").AttributeState} AttributeState
 * @typedef {import("@viewer/viewer-contracts").ViewerOptions} ViewerOptions
 * @typedef {import("@viewer/scene-input").SceneTransform} SceneTransform
 * @typedef {import("@viewer/viewer-contracts").AttributeKey} AttributeKey
 * @typedef {import("@viewer/viewer-contracts").AttributePanelKey} AttributePanelKey
 * @typedef {import("@viewer/viewer-contracts").AttributeReadiness} AttributeReadiness
 * @typedef {import("@viewer/viewer-contracts").SceneSelectOutcome} SceneSelectOutcome
 */

/**
 * A sparse renderer intent: only the axes a section actually names.
 * @typedef {object} ViewerIntent
 * @property {string} [scene]
 * @property {string} [size]
 * @property {"orbit" | "hold" | "keep" | {position: number[], target: number[], fov?: number}} [camera]
 * @property {"all" | "none" | Partial<Record<AttributeKey, boolean>>} [attributes]
 * @property {null | {plane?: string, pixel?: number[]}} [explorer]
 */

/**
 * What every widget renders from. One object, one subscribe, no derived state
 * held anywhere else.
 * @typedef {object} PageState
 * @property {"booting" | "ready" | "off" | "failed"} renderer
 * @property {string} reason
 * @property {string | null} scene   the LANDED scene: what the live figures describe
 * @property {string | null} size    the LANDED tier
 * @property {{scene: string | null, size: string | null}} requested
 *   the newest intent over the landed pair, and the only thing a control renders
 *   from (V3-C)
 * @property {{bytes: string, count: string, bits: string}} stats
 * @property {string[]} unlocked
 * @property {boolean} paused      the RENDERER is paused, not the camera path
 * @property {boolean} playing     the camera path is running
 * @property {boolean} motionSuspended  the path is paused by the page while a scene or
 *   tier the visitor asked for loads (V3-BA); the visitor's wanted state is kept
 * @property {boolean} inputSeen   the visitor has driven the camera at least once this
 *   page session (a drag, a wheel step, a fly key — never a hover); never unset
 * @property {number | null} fps
 * @property {"webgpu" | "webgl2" | null} backend
 * @property {boolean} arriving   a scene or size the page asked for has not landed
 * @property {number | null} progress  how far that arrival has got, 0..1, or null
 * @property {AttributeState | null} attributes
 * @property {Record<AttributePanelKey, number> | null} attributeSizes
 * @property {AttributeReadiness | null} attributeReadiness
 * @property {number | null} sceneBytes  complete container bytes, including metadata and mask
 * @property {{status: "unavailable" | "failed", scene: string | null, size: string | null} | null}
 *   selectionError  the viewer could not reach the requested point; the controls
 *   keep it, the live figures refuse to describe it, and a retry is offered
 */

export const ATTRIBUTE_KEYS = /** @type {const} */ ([
  "positionDetail",
  "shDc",
  "shAc",
  "scales",
  "rotations",
  "opacity",
]);

const RENDERER_STORAGE_KEY = "kissgs:renderer";

/* -------------------------------------------------------------------------- *
 * pure pieces — no DOM, so `node --test` covers them in milliseconds
 * -------------------------------------------------------------------------- */

/**
 * Format a byte count exactly as the build does. The two must agree to the
 * character: a value that Python rounds one way and the browser the other
 * visibly flickers the moment the viewer becomes ready.
 * @param {number} value
 */
export const formatBytes = (value) => {
  const bytes = Number(value);
  if (Math.abs(bytes) >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (Math.abs(bytes) >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes.toFixed(0)} B`;
};

/** What the three live figures read when there is no honest value for them. */
export const UNAVAILABLE_STATS = { bytes: "unavailable", count: "unavailable", bits: "unavailable" };

/**
 * The three live figures, from the viewer's own scene statistics.
 * @param {{containerBytes: number, splatCount: number} | null | undefined} stats
 * @returns {{bytes: string, count: string, bits: string}}
 */
export const formatStats = (stats) => {
  const unavailable = { ...UNAVAILABLE_STATS };
  if (!stats) return unavailable;
  const { containerBytes, splatCount } = stats;
  if (!Number.isFinite(containerBytes) || !Number.isFinite(splatCount)) return unavailable;
  // A scene with no splats would otherwise read "Infinity bits / Gaussian".
  const bits = splatCount > 0
    ? `${Math.round((containerBytes * 8) / splatCount)} bits / Gaussian`
    : "unavailable";
  return {
    bytes: formatBytes(containerBytes),
    count: `${Number(splatCount).toLocaleString("en-US")} Gaussians`,
    bits,
  };
};

/**
 * The viewer advances tour time at `TOUR_SPEED_REFERENCE` (0.35) of wall clock
 * at speed 1. It is not on the public handle, so it is written down here: a
 * tour is authored in tour-seconds, and this is what turns a wall-clock
 * revolution into one.
 */
export const TOUR_TIME_PER_SECOND = 0.35;

/** One slow revolution, in seconds of wall clock. */
export const ORBIT_REVOLUTION_SECONDS = 75;

/** How long pressing play takes to glide back onto the path. */
export const ORBIT_ENTER_MS = 900;
/** V3-BB: page-authored motion eases; the viewer owns the envelope, the page the durations. */
export const MOTION_RAMP_OUT_MS = 500;
export const MOTION_RAMP_IN_MS = 700;

/**
 * The page's authored idle orbit: a slow turn around the pose the viewer fitted
 * to this scene, at that pose's own radius and elevation.
 *
 * Sample zero IS the given pose, so starting the orbit on load cannot lurch the
 * scene, and the arithmetic matches the viewer's own `eye()` so the pose the
 * page computes and the pose the camera lands on are the same one.
 *
 * @param {{position: readonly number[], target: readonly number[], fov?: number}} pose
 * @param {{revolutionSeconds?: number}} [options]
 * @returns {import("@viewer/camera-tour").CameraTour}
 */
export const createOrbitTour = (pose, options = {}) => {
  const target = [pose.target[0], pose.target[1], pose.target[2]];
  const dx = pose.position[0] - target[0];
  const dy = pose.position[1] - target[1];
  const dz = pose.position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz) || 1;
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.asin(Math.min(1, Math.max(-1, dy / radius)));
  const duration =
    (options.revolutionSeconds ?? ORBIT_REVOLUTION_SECONDS) * TOUR_TIME_PER_SECOND;
  const horizontal = Math.cos(pitch);
  const height = target[1] + radius * Math.sin(pitch);
  return {
    duration,
    loop: true,
    sample(seconds) {
      const angle = yaw + (seconds / duration) * Math.PI * 2;
      return {
        position: [
          target[0] + radius * horizontal * Math.sin(angle),
          height,
          target[2] + radius * horizontal * Math.cos(angle),
        ],
        target: [...target],
        ...(pose.fov === undefined ? {} : { fov: pose.fov }),
      };
    },
  };
};

/**
 * Latest-intent reconciliation, as a plain object.
 *
 * Every asynchronous viewer operation is issued against a generation token. A
 * newer request bumps the generation, so a slow one that finally settles can
 * see it is no longer wanted and drop its result instead of overwriting a newer
 * scene. `pending` accumulates the sparse axes requested since the last landing,
 * so the operation that does run carries the newest value on every axis rather
 * than the newest value on one.
 */
export const createIntentTracker = () => {
  let generation = 0;
  /** @type {ViewerIntent} */
  let pending = {};
  /** @type {ViewerIntent} */
  let landed = {};
  return {
    /**
     * Record a sparse intent and return the token to guard the work with.
     * @param {ViewerIntent} intent
     */
    request(intent) {
      generation += 1;
      pending = { ...pending, ...intent };
      return generation;
    },
    /** @param {number} token */
    isCurrent(token) {
      return token === generation;
    },
    /** Everything requested and not yet landed, newest value per axis. */
    get pending() {
      return { ...pending };
    },
    /** What the viewer is known to be showing. */
    get landed() {
      return { ...landed };
    },
    /**
     * Mark a request as landed. A stale token lands nothing: the newer request
     * is still in flight and owns the axes.
     * @param {number} token
     */
    land(token) {
      if (token !== generation) return false;
      landed = { ...landed, ...pending };
      pending = {};
      return true;
    },
  };
};

/**
 * Which viewer call satisfies a scene/size intent, given what already landed.
 *
 * The two calls are not interchangeable. `selectSize` keeps the camera exactly
 * where the visitor left it — the viewer passes `preserveCamera` for it — which
 * is what §7 means by comparing several encoded sizes "from the same camera
 * position". `selectByRef` is a scene change and glides to the new scene's own
 * pose.
 *
 * So the choice must follow the *difference* between the intent and what is on
 * screen, not merely which keys the intent happens to carry. A slider move
 * arriving while an earlier scene intent is still pending coalesces with it, and
 * deciding on "does the intent mention a scene" would then reach for
 * `selectByRef` and throw away the visitor's viewpoint — for a change that was
 * only ever about size.
 *
 * @param {ViewerIntent} wanted   every axis requested and not yet landed
 * @param {ViewerIntent} landed   what the viewer is known to be showing
 * @returns {{kind: "ref", query: {name: string, tier?: string}} | {kind: "size", size: string} | null}
 */
export const selectionFor = (wanted, landed) => {
  if (wanted.scene !== undefined && wanted.scene !== landed.scene) {
    return {
      kind: "ref",
      query: {
        name: wanted.scene,
        ...(wanted.size !== undefined ? { tier: wanted.size } : {}),
      },
    };
  }
  // Deliberately not conditional on the size having changed: re-selecting the
  // size that is already on screen is what the viewer answers "unchanged" to,
  // and that answer is a publish every widget uses to reconcile.
  if (wanted.size !== undefined) return { kind: "size", size: wanted.size };
  return null;
};

/**
 * Is a scene or size the page asked for still on its way?
 *
 * The viewer's own `sizeKey` and `sceneStats` do not move until a scene has been
 * *applied* — `currentSize` derives from the applied scene index — so between a
 * request and its landing the snapshot describes the scene the visitor has
 * already left. Those are the megabytes that read as a wrong answer stated
 * confidently: drag to 25 MB and the card still says 3.94.
 *
 * So this compares what the page asked for against what the viewer is showing,
 * which is the only pair that can answer it. `pending` clears on landing and the
 * viewer publishes the new key as it applies it, so the flag falls the moment
 * either half of that happens — whichever arrives first.
 *
 * @param {ViewerIntent} pending  axes requested and not yet landed
 * @param {{scene: string | null, size: string | null}} showing
 */
export const isArriving = (pending, showing) =>
  (pending.scene !== undefined && pending.scene !== showing.scene) ||
  (pending.size !== undefined && pending.size !== showing.size);

/**
 * The requested scene and tier: the newest intent, falling back to what the
 * viewer is showing.
 *
 * This is the pair every *control* renders from, and it is why two instances of
 * the same control can exist at all. A widget that positioned itself from the
 * landed tier would snap back for as long as a selection was in flight, and a
 * widget that kept its own pending value could not be mirrored — the second
 * instance has no way to read the first one's private field. Live figures keep
 * reading the landed pair, because those describe what is on screen.
 *
 * @param {ViewerIntent} pending  axes requested and not yet landed
 * @param {{scene: string | null, size: string | null}} showing
 * @returns {{scene: string | null, size: string | null}}
 */
export const mergeRequested = (pending, showing) => ({
  scene: pending.scene ?? showing.scene ?? null,
  size: pending.size ?? showing.size ?? null,
});

/**
 * Expand `all` / `none` / a partial map into the full attribute state.
 * @param {"all" | "none" | Partial<Record<AttributeKey, boolean>>} intent
 * @param {AttributeState} current
 * @returns {AttributeState}
 */
export const resolveAttributes = (intent, current) => {
  const next = /** @type {AttributeState} */ ({ ...current });
  for (const key of ATTRIBUTE_KEYS) {
    if (intent === "all") next[key] = true;
    else if (intent === "none") next[key] = false;
    else if (typeof intent === "object" && intent[key] !== undefined) {
      next[key] = Boolean(intent[key]);
    }
  }
  return next;
};

/* -------------------------------------------------------------------------- *
 * the bridge itself
 * -------------------------------------------------------------------------- */

/** @param {string} code @param {string} message @param {unknown} [cause] */
const bridgeError = (code, message, cause) => {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
};

/**
 * A duration budget read off the panel's `data-*-ms` attributes, so a spec can
 * shorten it without waiting out the production value (AGENTS: never wait on a
 * real timeout).
 * @param {HTMLElement} host @param {string} name @param {number} fallback
 */
export const readTimeout = (host, name, fallback) => {
  const raw = Number(host.dataset[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * @param {object} options
 * @param {HTMLElement} options.panel   the element carrying the timeout budgets
 * @param {HTMLIFrameElement} options.frame
 * @param {{bytes: string, count: string, bits: string}} options.initialStats
 */
export const createBridge = ({ panel, frame, initialStats }) => {
  const budgets = {
    iframe: readTimeout(panel, "iframeTimeoutMs", 15_000),
    handle: readTimeout(panel, "handleTimeoutMs", 15_000),
    ready: readTimeout(panel, "readyTimeoutMs", 30_000),
    operation: readTimeout(panel, "operationTimeoutMs", 20_000),
  };

  /** @type {Set<(state: PageState) => void>} */
  const subscribers = new Set();
  /** @type {PageState} */
  let state = {
    renderer: "booting",
    reason: "",
    scene: null,
    size: null,
    requested: { scene: null, size: null },
    stats: initialStats,
    unlocked: [],
    paused: false,
    playing: false,
    motionSuspended: false,
    inputSeen: false,
    fps: null,
    backend: null,
    arriving: false,
    progress: null,
    attributes: null,
    attributeSizes: null,
    attributeReadiness: null,
    sceneBytes: null,
    selectionError: null,
  };
  /** @type {Viewer | null} */
  let viewer = null;
  /** @type {(() => void) | null} */
  let unsubscribeViewer = null;
  /** @type {Promise<Viewer | null> | null} */
  let booting = null;
  let bootAttempt = 0;
  const intents = createIntentTracker();
  /** The authored idle orbit for the scene currently on screen. */
  /** @type {import("@viewer/camera-tour").CameraTour | null} */
  let orbitTour = null;
  let motionGeneration = 0;
  /**
   * V3-BA: the page stopped the path for a scene or tier change and owes the
   * visitor a restart once the outcome lands. Carried across superseded
   * requests, so a burst of changes is one stop and one start.
   */
  let motionSuspended = false;
  /**
   * A ramped stop is in flight: the viewer still reports `tourPlaying` while the
   * camera slows, but the switch must already show the state the visitor chose.
   * Cleared by the viewer's own report that the path has stopped.
   */
  let stoppingMotion = false;
  /**
   * The high-water mark of the arrival in progress. The viewer reports the
   * download of a scene as one fraction, but it reports it from several
   * concurrent requests, and a cached asset can land whole between two samples —
   * so a raw reading can still step back by a hair. The page draws a bar, and a
   * bar that retreats reads as a fault rather than as arithmetic. Reset on every
   * arrival edge, in `refreshDerived`.
   */
  let progressFloor = 0;
  let hasMeasuredProgress = false;
  /**
   * The last selection the viewer answered `unavailable` or `failed` for, still
   * unresolved. It is deliberately bridge-local rather than read back out of
   * `state`: every publication of the live figures has to consult it, including
   * the viewer snapshots that keep arriving afterwards and would otherwise put
   * the scene the visitor has left back under a control naming the one they
   * asked for.
   * @type {PageState["selectionError"]}
   */
  let selectionFailure = null;
  let fpsTimer = 0;
  let lastFrames = 0;
  let lastFrameSampleMs = 0;

  /** Motion the page authors is motion the visitor is allowed to decline. */
  const prefersReducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const readPreferenceOff = () => {
    try {
      return window.localStorage.getItem(RENDERER_STORAGE_KEY) === "off";
    } catch {
      return false;
    }
  };
  let preferenceOff = readPreferenceOff();

  /** @param {Partial<PageState>} patch */
  const publish = (patch) => {
    state = { ...state, ...patch };
    for (const subscriber of subscribers) subscriber(state);
  };

  /**
   * Recompute the two derived facts: whether something the page asked for is
   * still on its way, and what the controls should be showing.
   *
   * Called from the four places that can change either answer: a new request, a
   * viewer snapshot, a landing, and the end of boot. Cheap, and it publishes
   * only on a change, so calling it more often than strictly necessary costs
   * nothing.
   */
  const refreshDerived = () => {
    /** @type {Partial<PageState>} */
    const patch = {};
    // A failed selection has nothing more coming: the request is still pending —
    // that is the point, the controls keep it — but the indicator must stop.
    const arriving = !selectionFailure
      && isArriving(intents.pending, { scene: state.scene, size: state.size });
    if (arriving !== state.arriving) {
      // Either edge starts a new measurement, so neither may inherit the last
      // one's high-water mark.
      progressFloor = 0;
      hasMeasuredProgress = false;
      patch.arriving = arriving;
      // A finished arrival has no progress to report, and leaving the last
      // fraction behind would make the next one start from wherever this one
      // stopped.
      if (!arriving) patch.progress = null;
    }
    const requested = mergeRequested(intents.pending, {
      scene: state.scene,
      size: state.size,
    });
    if (requested.scene !== state.requested.scene || requested.size !== state.requested.size) {
      patch.requested = requested;
    }
    if (Object.keys(patch).length) publish(patch);
  };

  /**
   * Resolve `promise`, or reject with a typed error once the budget is spent.
   * Selection outcomes are typed and never reject, but a request that neither
   * lands nor aborts would settle nothing at all, and one abandoned operation
   * must not hold the current intent open forever.
   * @template T
   * @param {PromiseLike<T>} promise
   * @param {string} code
   * @param {string} message
   * @param {number} timeoutMs
   */
  const withDeadline = (promise, code, message, timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(bridgeError(code, message)), timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });

  /** @param {string} expectedSrc */
  const waitForFrameLoad = (expectedSrc) =>
    new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        frame.removeEventListener("load", onLoad);
        reject(bridgeError("iframe-timeout", "the viewer document did not load"));
      }, budgets.iframe);
      const onLoad = () => {
        window.clearTimeout(timer);
        frame.removeEventListener("load", onLoad);
        resolve(undefined);
      };
      frame.addEventListener("load", onLoad);
      if (frame.src === expectedSrc && frame.contentDocument?.readyState === "complete") {
        onLoad();
      }
    });

  /**
   * The iframe's `load` event is not the moment the handle exists: ffsplat's
   * runtime assigns `window.ffsplatViewers` only after awaiting its config and
   * settings, so the assignment lands in a later microtask than the load that
   * woke us. Reading once lost the race against every real viewer and dropped
   * the page into renderer-off. Poll, bounded by its own injectable budget.
   */
  const waitForHandle = () =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (/** @type {() => void} */ action) => {
        if (settled) return;
        settled = true;
        window.clearInterval(poll);
        window.clearTimeout(timer);
        action();
      };
      const attempt = () => {
        /** @type {Viewer | null} */
        let candidate = null;
        try {
          candidate =
            /** @type {any} */ (frame.contentWindow)?.ffsplatViewers?.[0] ?? null;
        } catch (error) {
          // A cross-origin or torn-down frame throws on access. That is
          // terminal, not something more polling can fix.
          finish(() =>
            reject(bridgeError("handle-unavailable", "the viewer is not same-origin", error)),
          );
          return;
        }
        if (candidate) finish(() => resolve(candidate));
      };
      const poll = window.setInterval(attempt, 25);
      const timer = window.setTimeout(
        () => finish(() => reject(bridgeError("handle-unavailable", "the viewer handle is missing"))),
        budgets.handle,
      );
      attempt();
    });

  /**
   * The three live figures, unless the point the controls name never landed.
   * PLAN 2.2: a load failure never lies by displaying one operating point's
   * bytes as another's.
   * @param {ViewerStateSnapshot["sceneStats"]} sceneStats
   */
  const liveStats = (sceneStats) =>
    selectionFailure ? { ...UNAVAILABLE_STATS } : formatStats(sceneStats);

  /** @param {ViewerStateSnapshot} snapshot */
  const onViewerChange = (snapshot) => {
    const fraction = snapshot.loading?.fraction;
    const measured =
      typeof fraction === "number" && Number.isFinite(fraction)
        ? Math.min(1, Math.max(0, fraction))
        : null;
    if (measured !== null) {
      progressFloor = Math.max(progressFloor, measured);
      hasMeasuredProgress = true;
    }
    const nextScene = snapshot.sceneRef?.name ?? snapshot.sceneName;
    const nextSize = snapshot.sizeKey;
    const stillArriving = isArriving(intents.pending, { scene: nextScene, size: nextSize });
    if (!snapshot.tourPlaying) stoppingMotion = false;
    publish({
      scene: nextScene,
      size: nextSize,
      stats: liveStats(snapshot.sceneStats),
      sceneBytes: snapshot.sceneStats?.containerBytes ?? null,
      attributes: snapshot.attributes,
      attributeSizes: viewer?.attributes?.sizes() ?? null,
      attributeReadiness: viewer?.attributes?.readiness() ?? null,
      paused: snapshot.paused,
      // The viewer, not the page, is the authority on whether the path is
      // running: it stops the tour itself the moment the visitor takes the
      // camera, and the play button has to follow that rather than argue. The
      // one exception is a ramp-out the page itself asked for, which the viewer
      // reports as still playing until the envelope reaches zero.
      playing: stoppingMotion ? false : snapshot.tourPlaying,
      // `loading: null` can be a handoff between stages of the same semantic
      // request. Preserve the last determinate reading while that request is
      // pending; only an actual arrival edge resets the measurement.
      progress: measured !== null || (stillArriving && hasMeasuredProgress)
        ? progressFloor
        : null,
    });
    refreshDerived();
  };

  /**
   * Frame rate, sampled rather than counted: the viewer publishes a frame
   * counter, and one reading a second is enough for telemetry that must not
   * compete with the compressed size for attention.
   */
  const sampleFrameRate = () => {
    if (!viewer || state.renderer !== "ready") return;
    const frames = viewer.getFrameCount();
    const now = performance.now();
    const elapsed = (now - lastFrameSampleMs) / 1000;
    if (lastFrameSampleMs && elapsed > 0) {
      const fps = Math.round((frames - lastFrames) / elapsed);
      if (fps !== state.fps) publish({ fps: Number.isFinite(fps) ? fps : null });
    }
    lastFrames = frames;
    lastFrameSampleMs = now;
  };

  const stopFrameRate = () => {
    if (fpsTimer) window.clearInterval(fpsTimer);
    fpsTimer = 0;
    lastFrameSampleMs = 0;
    if (state.fps !== null) publish({ fps: null });
  };

  const startFrameRate = () => {
    if (fpsTimer) return;
    lastFrames = viewer?.getFrameCount() ?? 0;
    lastFrameSampleMs = performance.now();
    fpsTimer = window.setInterval(sampleFrameRate, 1000);
  };

  /** @param {Viewer} active */
  const currentPose = (active) => {
    const camera = active.camera.getState();
    return {
      position: [...camera.position],
      target: [...camera.target],
      fov: camera.fov,
    };
  };

  /**
   * Start the authored orbit. `enterMs` glides onto the path instead of cutting
   * to it, which is what a visitor who has moved the camera and then pressed
   * play expects; the opening orbit needs no glide, because it is built around
   * the pose already on screen.
   * @param {{enterMs?: number, rampMs?: number}} [options]
   */
  const startOrbit = ({ enterMs = 0, rampMs = 0 } = {}) => {
    const active = viewer;
    if (!active) return;
    if (!orbitTour) orbitTour = createOrbitTour(currentPose(active));
    stoppingMotion = false;
    active.tour.start(orbitTour, {
      // Attract-mode semantics: the path yields to the first interaction and
      // the visitor gets the camera, rather than the two fighting over it.
      cancelOnInteraction: true,
      ...(enterMs > 0 ? { enterMs } : {}),
      ...(rampMs > 0 ? { rampMs } : {}),
    });
  };

  /** Ask ffsplat for the selected scene's finalized dataset path. The analytic
   * orbit remains a zero-data fallback for exports without one.
   * @param {{enterMs?: number, rampMs?: number}} [options]
   */
  const startAuthoredMotion = async ({ enterMs = 0, rampMs = 0 } = {}) => {
    const active = viewer;
    if (!active) return;
    const generation = ++motionGeneration;
    stoppingMotion = false;
    const playback = {
      cancelOnInteraction: true,
      ...(enterMs > 0 ? { enterMs } : {}),
      ...(rampMs > 0 ? { rampMs } : {}),
    };
    const authored = await active.tour.playAuthored(playback);
    if (generation !== motionGeneration || active !== viewer) return;
    if (authored) {
      orbitTour = null;
      return;
    }
    startOrbit({ enterMs, rampMs });
  };

  /**
   * Stop the path, easing its speed down first (V3-BB). The switch shows the
   * visitor's choice at once; the viewer reports the actual stop when the
   * envelope reaches zero.
   * @param {Viewer} active
   * @param {{rampMs?: number}} [options]
   */
  const stopMotion = (active, { rampMs = 0 } = {}) => {
    motionGeneration += 1;
    if (rampMs > 0) {
      stoppingMotion = true;
      active.tour.stop({ rampMs });
      publish({ playing: false });
    } else active.tour.stop();
  };

  /**
   * V3-BA: an operating-point change while the visitor wants motion. The path
   * ramps to a stop before the load, the switch shows off and is disabled, and
   * the wanted state is remembered for `resumeMotion`.
   * @param {Viewer} active
   */
  const suspendMotion = (active) => {
    if (motionSuspended || !state.playing) return;
    motionSuspended = true;
    stopMotion(active, { rampMs: MOTION_RAMP_OUT_MS });
    publish({ motionSuspended: true });
  };

  /**
   * The suspension ends: the request landed, or failed with the previous scene
   * still on screen. Either way the visitor wanted motion, so it ramps back —
   * unless the same request asked the camera to hold.
   * @param {Viewer} active
   * @param {{hold?: boolean}} [options]
   */
  const resumeMotion = (active, { hold = false } = {}) => {
    if (!motionSuspended) return;
    motionSuspended = false;
    publish({ motionSuspended: false });
    if (hold || active !== viewer || prefersReducedMotion()) return;
    if (!state.playing) void startAuthoredMotion({ rampMs: MOTION_RAMP_IN_MS });
  };

  /**
   * Apply the camera axis of a section's intent.
   * @param {Viewer} active
   * @param {NonNullable<ViewerIntent["camera"]>} camera
   */
  const applyCamera = async (active, camera) => {
    if (camera === "keep") return;
    // `hold` stops the idle path and keeps the pose. A section asks for it when
    // its argument needs two renders to be comparable, and it deliberately does
    // NOT re-pose: the view the visitor chose is the view they compare from.
    if (camera === "hold") {
      stopMotion(active, { rampMs: MOTION_RAMP_OUT_MS });
      return;
    }
    if (camera === "orbit") {
      orbitTour = null;
      if (!prefersReducedMotion()) await startAuthoredMotion({ rampMs: MOTION_RAMP_IN_MS });
      return;
    }
    active.camera.setPose({
      position: camera.position,
      target: camera.target,
      ...(camera.fov === undefined ? {} : { fov: camera.fov }),
    });
  };

  const boot = async () => {
    const attempt = (bootAttempt += 1);
    const isCurrent = () => attempt === bootAttempt && !preferenceOff;
    /** @type {Viewer | null} */
    let handle = null;
    try {
      const source = frame.dataset.src;
      if (!source) throw bridgeError("unavailable", "the viewer source is missing");
      const expected = new URL(source, document.baseURI).href;
      const loaded = waitForFrameLoad(expected);
      if (frame.src !== expected) frame.setAttribute("src", source);
      await loaded;
      if (!isCurrent()) return null;

      handle = /** @type {Viewer} */ (await waitForHandle());
      if (!isCurrent()) {
        handle.destroy?.();
        return null;
      }
      const ready = /** @type {Viewer} */ (
        await withDeadline(handle.ready, "ready-timeout", "the viewer never rendered", budgets.ready)
      );
      if (!isCurrent()) {
        handle.destroy?.();
        return null;
      }
      viewer = ready || handle;
      if (typeof viewer.state !== "function" || typeof viewer.subscribe !== "function") {
        throw bridgeError("unavailable", "the viewer does not implement the page API");
      }
      const unsubscribeChanges = viewer.subscribe(onViewerChange);
      // Camera input activity (F3.1's signal). The page keeps only the fact
      // that there has been some: the nudge wants "never touched", not a feed.
      const noteInput = () => {
        if (!state.inputSeen) publish({ inputSeen: true });
      };
      const unsubscribeInput = viewer.input?.subscribe(noteInput) ?? null;
      if (viewer.input?.lastActivity) noteInput();
      unsubscribeViewer = () => {
        unsubscribeChanges();
        unsubscribeInput?.();
      };
      // Decision A, applied to the last piece of chrome still coming from the
      // viewer. The export carries `--brand KISS-GS --ui-mode tour-step`, which
      // resolves to the single `identity` region, and that region is the pill
      // the page's own stat card sat on top of. The page draws the wordmark, so
      // the viewer stops drawing it — and the export does not have to change,
      // which is what makes this a page decision rather than a 796 MB one.
      try {
        viewer.ui?.setVisibleRegions([]);
      } catch (error) {
        console.error("could not hide the viewer's own chrome", error);
      }
      const snapshot = viewer.state();
      publish({
        renderer: snapshot.enabled === false ? "off" : "ready",
        reason: snapshot.enabled === false ? "unavailable" : "",
        backend: viewer.backendKind ?? null,
        scene: snapshot.sceneRef?.name ?? snapshot.sceneName,
        size: snapshot.sizeKey,
        stats: liveStats(snapshot.sceneStats),
        sceneBytes: snapshot.sceneStats?.containerBytes ?? null,
        attributes: snapshot.attributes,
        attributeSizes: viewer.attributes?.sizes() ?? null,
        attributeReadiness: viewer.attributes?.readiness() ?? null,
        paused: snapshot.paused,
        playing: snapshot.tourPlaying,
      });
      // The page's opening intent was recorded before the viewer existed, so it
      // compared against a null scene and read as arriving. Now there is a
      // snapshot to compare against, and for the boot scene the answer is no.
      refreshDerived();
      startFrameRate();
      return viewer;
    } catch (error) {
      stopFrameRate();
      unsubscribeViewer?.();
      unsubscribeViewer = null;
      try {
        handle?.destroy?.();
      } catch (cleanupError) {
        console.error("could not clean up a failed viewer boot", cleanupError);
      }
      viewer = null;
      frame.removeAttribute("src");
      console.error("the viewer is unavailable", error);
      const code = /** @type {{code?: string}} */ (error)?.code || "unavailable";
      publish({ renderer: "failed", reason: code });
      return null;
    }
  };

  const ensureViewer = () => {
    if (viewer) return Promise.resolve(viewer);
    if (preferenceOff) return Promise.resolve(null);
    if (!booting) {
      const attempt = boot();
      booting = attempt.then((result) => {
        if (!result) booting = null;
        return result;
      });
    }
    return booting;
  };

  /**
   * Drop a resolved failure. Called by every new attempt, so the live figures
   * come back from the viewer's own snapshot rather than from a remembered one.
   */
  const clearSelectionFailure = () => {
    if (!selectionFailure) return;
    selectionFailure = null;
    publish({ selectionError: null, stats: formatStats(viewer?.state()?.sceneStats) });
  };

  /**
   * The viewer could not reach the requested point.
   *
   * The token is deliberately NOT landed: the requested scene and tier stay
   * pending, so both mirrored controls and the plot marker keep naming what the
   * visitor asked for and a retry is one dispatch away (PLAN 2.2). What must not
   * survive is the impression that the figures beside those controls describe
   * that point — they describe the scene the viewer never left — so they are
   * withdrawn until the next attempt.
   * @param {number} token
   * @param {"unavailable" | "failed"} status
   * @param {unknown} detail
   */
  const failSelection = (token, status, detail) => {
    if (!intents.isCurrent(token)) return;
    console.error("the viewer could not select the scene", detail);
    const wanted = intents.pending;
    selectionFailure = {
      status,
      scene: wanted.scene ?? state.scene,
      size: wanted.size ?? state.size,
    };
    publish({
      selectionError: selectionFailure,
      stats: { ...UNAVAILABLE_STATS },
      arriving: false,
      progress: null,
    });
    refreshDerived();
    // The previous scene is still on screen, so the motion the visitor wanted
    // comes back (V3-BA).
    if (viewer) resumeMotion(viewer);
  };

  /**
   * Apply a sparse intent: the one-time boot payload, or an explicit visitor
   * action. Every axis the intent does not name is left exactly as the visitor
   * left it.
   * @param {ViewerIntent} intent
   */
  const apply = async (intent) => {
    const token = intents.request(intent);
    // A new attempt supersedes the last failure, whether it is the retry for the
    // same point or a move to another one. Clearing it before the work starts is
    // what puts the arrival indicator back over the figures.
    clearSelectionFailure();
    refreshDerived();
    const active = await ensureViewer();
    if (!active || !intents.isCurrent(token)) return;
    const wanted = intents.pending;
    try {
      const selection = selectionFor(wanted, intents.landed);
      if (selection) {
        const scenes = active.scenes;
        if (scenes) {
          // A scene decoding under a running tour stutters (V3-BA): stop first,
          // load, and give the motion back once the outcome lands.
          suspendMotion(active);
          /** @type {SceneSelectOutcome} */
          let outcome;
          // The selection gets its own try. The one around the rest of this
          // function lands the token, which is right for a camera or attribute
          // call that threw after the scene arrived — and exactly wrong here.
          try {
            outcome = selection.kind === "ref"
              ? await withDeadline(
                  scenes.selectByRef(selection.query),
                  "select-timeout",
                  "the viewer did not finish selecting the scene",
                  budgets.operation,
                )
              : await withDeadline(
                  scenes.selectSize(selection.size),
                  "select-timeout",
                  "the viewer did not finish selecting the size",
                  budgets.operation,
                );
          } catch (error) {
            failSelection(token, "failed", error);
            return;
          }
          if (!intents.isCurrent(token)) return;
          // Exhaustive on purpose: the union has five members and only two of
          // them mean the scene on screen is now the one the page asked for.
          switch (outcome.status) {
            case "applied":
            case "unchanged":
              break;
            case "superseded":
              // Not a failure and not a landing: a newer selection owns the axes
              // and will publish for itself.
              return;
            case "unavailable":
            case "failed":
              failSelection(token, outcome.status, outcome);
              return;
            default:
              // A member ffsplat added and this page has not been taught. Refuse
              // to call it a landing rather than guess.
              failSelection(token, "failed", outcome);
              return;
          }
        }
      }
      if (wanted.attributes !== undefined && active.attributes) {
        active.attributes.set(resolveAttributes(wanted.attributes, active.attributes.get()));
      }
      if (!intents.isCurrent(token)) return;
      // Last, and only once the scene has landed: authored motion belongs to
      // THIS scene, and its analytic fallback is built around that scene's
      // fitted pose.
      if (wanted.camera !== undefined) await applyCamera(active, wanted.camera);
      if (!intents.isCurrent(token)) return;
      resumeMotion(active, { hold: wanted.camera === "hold" });
      intents.land(token);
      refreshDerived();
    } catch (error) {
      // A superseded operation is not a failure: a newer intent owns the axes.
      if (intents.isCurrent(token)) console.error("a viewer operation failed", error);
      // A failure that IS current has nothing more coming, so the indicator must
      // not be left spinning over the figures it is hiding. The figures are the
      // previous scene's and now describe what is actually on screen again.
      if (intents.isCurrent(token)) {
        intents.land(token);
        publish({ arriving: false, progress: null });
        refreshDerived();
        resumeMotion(active);
      }
    }
  };

  return {
    /** @param {(state: PageState) => void} subscriber */
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },
    get state() {
      return state;
    },
    /** Start the viewer unless the visitor has turned rendering off. */
    start() {
      if (preferenceOff) {
        publish({ renderer: "off", reason: "user" });
        return Promise.resolve(null);
      }
      return ensureViewer();
    },
    apply,
    /**
     * Apply a visitor-authored attribute choice without inventing a second
     * state store. The viewer publishes the resulting snapshot and every page
     * widget follows that one event.
     * @param {Partial<AttributeState>} next
     * @param {{immediate?: boolean}} [options]
     */
    async setAttributes(next, options) {
      const active = await ensureViewer();
      active?.attributes?.set(next, options);
    },
    /**
     * Turn rendering on or off, and remember the choice. This is the one piece
     * of session state the page persists, because a visitor who turned the
     * renderer off did so for a reason that outlives one page load.
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
      preferenceOff = !enabled;
      try {
        if (enabled) window.localStorage.removeItem(RENDERER_STORAGE_KEY);
        else window.localStorage.setItem(RENDERER_STORAGE_KEY, "off");
      } catch {
        // Private browsing and blocked storage must not make the page unusable.
      }
      if (!enabled) {
        motionGeneration += 1;
        motionSuspended = false;
        stoppingMotion = false;
        bootAttempt += 1;
        stopFrameRate();
        orbitTour = null;
        unsubscribeViewer?.();
        unsubscribeViewer = null;
        try {
          viewer?.destroy?.();
        } catch (error) {
          console.error("could not destroy the viewer", error);
        }
        viewer = null;
        booting = null;
        frame.removeAttribute("src");
        publish({ renderer: "off", reason: "user" });
        return Promise.resolve(null);
      }
      publish({ renderer: "booting", reason: "" });
      return ensureViewer();
    },
    /** Retry after a failed boot, from the same intent the page last wanted. */
    /**
     * P2.3 (V3-BN): the phone's collapsed panel. Nothing can see a hidden scene,
     * so its camera path ramps out the way it does for a scene change (V3-BA),
     * and expanding rides the same ramp back. That is all this does: the iframe
     * stays alive and nothing is re-decoded.
     * @param {boolean} hidden
     */
    setSceneHidden(hidden) {
      if (!viewer) return;
      if (hidden) suspendMotion(viewer);
      else resumeMotion(viewer);
    },
    retry() {
      if (state.renderer === "off" && state.reason === "user") return this.setEnabled(true);
      booting = null;
      publish({ renderer: "booting", reason: "" });
      return ensureViewer().then((active) => {
        const pending = intents.landed;
        if (active && Object.keys(pending).length) void apply(pending);
        return active;
      });
    },
    /**
     * Play or pause the authored camera path. Pausing the path is not pausing
     * the renderer: the scene stays live and the visitor keeps the camera.
     * @param {boolean} playing
     */
    setPlaying(playing) {
      const active = viewer;
      if (!active) return;
      if (playing) {
        void startAuthoredMotion({ enterMs: ORBIT_ENTER_MS, rampMs: MOTION_RAMP_IN_MS });
      } else stopMotion(active, { rampMs: MOTION_RAMP_OUT_MS });
    },
    /** The viewer owns path timing; the page only renders its normalized cursor. */
    tourState() {
      return viewer?.tour.state() ?? { playing: false, progress: 0, duration: 0, ramp: 1 };
    },
    /** @param {number} progress normalized position through the complete path */
    seekTour(progress) {
      viewer?.tour.seekProgress(Math.min(1, Math.max(0, progress)));
    },
    /**
     * Highlight one primitive, or nothing. The index is the *compacted* splat
     * index — the cell's rank among the mask's active cells — which is the same
     * index the viewer's own selection uses.
     * @param {number | null} index
     */
    selectSplat(index) {
      if (index === null) viewer?.selection?.clear();
      else viewer?.selection?.set(index);
    },
    /**
     * Move the camera towards a point in the scene's world coordinates. The
     * viewer stops its camera path first, so this is a user action winning over
     * an authored one rather than two motions fighting.
     * @param {readonly number[]} position
     * @param {number} scale
     */
    steerToPoint(position, scale) {
      viewer?.selection?.steerTo(position, scale);
    },
    stopSteering() {
      viewer?.selection?.stopSteering();
    },
    /**
     * The placement the export derived for one scene: the rotation that stands
     * it upright and the translation that centres it.
     *
     * This reads the viewer document's own bootstrap config, which is typed
     * (`ViewerOptions`) and same-origin, exactly like the `ffsplatViewers`
     * handle beside it. The page needs it because the container's positions are
     * in the scene's own coordinates and the camera works in world ones.
     *
     * @param {string} tier
     * @param {string} scene
     * @returns {SceneTransform | null}
     */
    sceneTransform(tier, scene) {
      const config = /** @type {{sse?: {config?: ViewerOptions}}} */ (
        /** @type {unknown} */ (frame.contentWindow)
      )?.sse?.config;
      const wanted = `/${tier}/${scene}/`;
      for (const option of config?.scenes ?? []) {
        const source = option.source;
        if (source?.kind !== "plane") continue;
        if (source.manifestUrl.includes(wanted)) return source.scene ?? null;
      }
      return null;
    },
    /** Return the camera to the scene's fitted pose. */
    resetCamera() {
      motionGeneration += 1;
      return viewer?.camera.reset() ?? Promise.resolve();
    },
    /** @param {string[]} names */
    unlock(names) {
      const merged = [...new Set([...state.unlocked, ...names])];
      if (merged.length !== state.unlocked.length) publish({ unlocked: merged });
    },
    get viewer() {
      return viewer;
    },
  };
};
