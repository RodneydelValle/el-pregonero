/* Service worker: permite instalar IMP TRAVEL como app y verlo sin conexión. */
const V = 6;   // el mismo número ?v= con que index.html pide styles.css y app.js: se suben juntos
const VERSION = `imp-travel-v${V}`;
// La página y sus dos archivos con versión se guardan juntos y de una vez: sin conexión siempre se usa este trío,
// nunca la página de una versión con el código de otra
const NUCLEO = ["./", `styles.css?v=${V}`, `app.js?v=${V}`];
const RESTO = ["cuenta.js", "manifest.webmanifest", "config/gustos.json", "config/firebase.js",
  "data/eventos.json", "data/restaurantes.json", "data/lugares.json", "icons/icono-192.png", "icons/icono-512.png"];
// cache: "reload" va directo al servidor: la caché del navegador podría tener aún los archivos de la versión anterior
const delServidor = (u) => new Request(u, { cache: "reload" });

self.addEventListener("install", (ev) => {
  // Si falla algo del núcleo, la instalación falla y sigue la versión anterior, completa (el navegador reintenta
  // en la próxima visita). El resto va archivo por archivo: si alguno falla, la app igual se instala.
  ev.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(NUCLEO.map(delServidor))
      .then(() => Promise.allSettled(RESTO.map((u) => c.add(delServidor(u))))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const RAIZ = new URL("./", self.location.href).pathname;   // /el-pregonero/

/** La página: siempre la del servidor ("no-cache": si no cambió, responde un 304 liviano) y no se guarda.
 *  Sin red, la que se instaló junto con su app.js y su styles.css (sirve también para ./?ver=… y ./#…). */
async function pagina(req) {
  try {
    return await fetch(req, { cache: "no-cache" });
  } catch {
    const cache = await caches.open(VERSION);
    const ruta = new URL(req.url).pathname;
    const g = ruta === RAIZ || ruta === `${RAIZ}index.html` ? await cache.match("./") : await cache.match(req);
    if (g) return g;
    throw new Error("sin conexión");
  }
}

/** app.js?v=N y styles.css?v=N: de la red y sin guardarlos. Sin red, solo los que instaló esta versión.
 *  (GitHub Pages ignora el ?v=: guardarlos al vuelo podría dejar en la caché el código de otra versión.) */
async function conVersion(req) {
  try {
    return await fetch(req);
  } catch {
    const g = await (await caches.open(VERSION)).match(req);
    if (g) return g;
    throw new Error("sin conexión");
  }
}

/** Datos, íconos y demás: lo más nuevo de la red, y se guarda para verlo sin conexión. */
async function redPrimero(req) {
  const cache = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    const g = await cache.match(req);
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
    if (req.mode === "navigate") ev.respondWith(pagina(req));
    else if (url.searchParams.has("v")) ev.respondWith(conVersion(req));
    else ev.respondWith(redPrimero(req));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    ev.respondWith(cachePrimero(req));          // tipografías
  }
});
