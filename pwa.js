(function () {
  "use strict";

  const isLocalFile = location.protocol === "file:";
  let refreshing = false;

  if ("serviceWorker" in navigator && !isLocalFile) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js?v=online-v82", { updateViaCache: "none" })
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

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }
})();



























