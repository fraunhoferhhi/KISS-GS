/* Page-local widgets only. Everything 3D lives inside the ffsplat viewer
   iframes, which own their own runtime. */

import { retryable, retryWhenTouched, whenApproached } from "./lazy.js";

// The page has no binary favicon asset. An explicit empty icon keeps browsers
// from probing /favicon.ico and turning a perfectly healthy page load into a
// noisy 404 in diagnostics.
if (!document.querySelector('link[rel="icon"]')) {
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = "data:,";
  document.head.append(icon);
}

/* ---- V3-Q's qualitative comparison ------------------------------------- */
/* Lazy for the same reason the plot is: it is the ninth section down, and a
   visitor who never reaches it pays nothing for its module. */
for (const gallery of document.querySelectorAll("[data-gallery]")) {
  let loading = null;
  let failures = 0;
  const load = () => {
    if (!loading) {
      loading = import(retryable("./gallery.js", failures)).then(({ initGallery }) => {
        const payload = document.getElementById("gallery-data")?.textContent;
        if (!payload) throw new Error("the gallery has no data");
        initGallery(gallery, JSON.parse(payload));
      }).catch((error) => {
        console.error("the comparison gallery could not load", error);
        // The frames ship inert and only `initGallery` enables them, so a failed
        // import already leaves an honest static comparison. Releasing the guard
        // is what keeps it from being a permanent one.
        loading = null;
        failures += 1;
        retryWhenTouched(gallery, load);
      });
    }
    return loading;
  };
  whenApproached(gallery, load);
}
