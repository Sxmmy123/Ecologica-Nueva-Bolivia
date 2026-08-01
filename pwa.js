(function () {
  "use strict";

  const APP_VERSION = "v2.21";
  const CACHE_PREFIX = "nueva-bolivia-pwa-";
  const CURRENT_CACHE = "nueva-bolivia-pwa-v2.21";
  const CLEANUP_KEY = "__pwaCacheCleanupVersion";
  const isLocalFile = location.protocol === "file:";

  async function cleanOldCachesOnce() {
    if (isLocalFile || !("caches" in window)) return;
    if (localStorage.getItem(CLEANUP_KEY) === APP_VERSION) return;

    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CURRENT_CACHE)
        .map(key => caches.delete(key)));
      localStorage.setItem(CLEANUP_KEY, APP_VERSION);
    } catch (error) {
      console.info("No se pudo limpiar el cache anterior:", error.message);
    }
  }

  if ("serviceWorker" in navigator && !isLocalFile) {
    window.addEventListener("load", async () => {
      await cleanOldCachesOnce();

      navigator.serviceWorker.register("./service-worker.js?v=v2.21", { updateViaCache: "none" })
        .then(registration => {
          if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                worker.postMessage({ type: "SKIP_WAITING" });
              }
            });
          });
          registration.update().catch(() => {});
        })
        .catch(error => {
          console.info("No se pudo registrar la PWA:", error.message);
        });
    });
  }
})();






























