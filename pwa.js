(function () {
  "use strict";

  const isLocalFile = location.protocol === "file:";

  if ("serviceWorker" in navigator && !isLocalFile) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(error => {
        console.info("No se pudo registrar la PWA:", error.message);
      });
    });
  }
})();
