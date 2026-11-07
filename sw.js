/* Service worker: permite instalar IMP TRAVEL como app y verlo sin conexión. */
const VERSION = "imp-travel-v5";
const BASE = ["./", "index.html", "styles.css", "app.js", "cuenta.js", "manifest.webmanifest", "config/gustos.json",
  "config/firebase.js", "data/eventos.json", "data/restaurantes.json", "data/lugares.json", "icons/icono-192.png", "icons/icono-512.png"];

self.addEventListener("install", (ev) => {
  // Archivo por archivo: si alguno falla, la app igual se instala con el resto
  ev.waitUntil(caches.open(VERSION)
    .then((c) => Promise.allSettled(BASE.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function redPrimero(req) {
  const cache = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    const g = await cache.match(req, { ignoreSearch: true });
    if (g) return g;
    throw new Error("sin conexión");
  }
}

async function cachePrimero(req) {
  const cache = await caches.open(VERSION);
  const g = await cache.match(req);
  if (g) return g;
  const r = await fetch(req);
  if (r.ok || r.type === "opaque") cache.put(req, r.clone());
  return r;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    ev.respondWith(redPrimero(req));            // siempre lo más nuevo; sin red, lo guardado
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    ev.respondWith(cachePrimero(req));          // tipografías
  }
});
