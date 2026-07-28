const CACHE_NAME = "nueva-bolivia-pwa-v82";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./admin.html",
  "./horario.html",
  "./dia.html",
  "./mes.html",
  "./calificar.html",
  "./notas.html",
  "./alumno.html",
  "./reportes.html",
  "./firebase-config.js",
  "./firebase-sync.js?v=online-v82",
  "./pwa.js?v=online-v82",
  "./manifest.json",
  "./images/login-fondo.png",
  "./images/logo-nueva-bolivia.png",
  "./images/icon-72.png",
  "./images/icon-96.png",
  "./images/icon-128.png",
  "./images/icon-144.png",
  "./images/icon-152.png",
  "./images/icon-180.png",
  "./images/icon-192.png",
  "./images/icon-384.png",
  "./images/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: true }).then(cached => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});



























