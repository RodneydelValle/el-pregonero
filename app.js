/* IMP TRAVEL (antes El Pregonero) — agenda de eventos, restaurantes temáticos, Mapa del Aventurero y favoritos.
 * Datos: data/eventos.json (lo actualiza el robot), data/restaurantes.json y data/tiendas.json (listas revisadas a mano)
 * y data/lugares.json (fotos de teatros, museos y salas: se muestran en cada evento que ocurre ahí).
 * El mapa usa Leaflet (vendor/), que se carga solo al abrir esa sección.
 * Favoritos: en el navegador; con sesión de Google (cuenta.js + Firebase) quedan en la cuenta de cada persona. */
"use strict";

const REPO = "RodneydelValle/el-pregonero";
const URL_BUSCAR = `https://github.com/${REPO}/actions/workflows/buscar-eventos.yml`;
const URL_GUSTOS = `https://github.com/${REPO}/edit/main/config/gustos.json`;
const CLAVE_GUARDADOS = "pregonero:guardados";
const CLAVE_REST = "pregonero:restaurantes";
const CLAVE_TIENDAS = "pregonero:tiendas";
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const COMUNAS_RM = /santiago|metropolitana|providencia|[ñn]u[ñn]oa|las condes|vitacura|lo barnechea|la reina|pe[ñn]alol[ée]n|macul|la florida|puente alto|maip[úu]|estaci[óo]n central|quinta normal|recoleta|independencia|conchal[íi]|huechuraba|quilicura|renca|cerro navia|lo prado|pudahuel|cerrillos|pedro aguirre cerda|san miguel|san joaqu[íi]n|la cisterna|el bosque|la granja|la pintana|san ram[óo]n|lo espejo|san bernardo|buin|colina|lampa|talagante|pe[ñn]aflor|melipilla|pirque|san jos[ée] de maipo|movistar arena|caupolic[áa]n|teatro coliseo|blondie|santander arena|espacio riesco|matucana|gam\b|parque o.?higgins/i;
const HASH_SECCION = { agenda: "eventos", restaurantes: "restaurantes", mapa: "mapa", favoritos: "favoritos" };
const SECCIONES = ["agenda", "restaurantes", "mapa", "favoritos"];
// Banners de la cabecera: cada uno es una sección (en ese orden se deslizan, el mismo de los botones de temas).
// Todos menos Agenda y Restaurantes son la agenda con su tema (id de config/gustos.json); Yokai no tiene banner.
// Restaurantes no tiene pestaña: se llega por su banner. "nombre" es lo que oye un lector de pantalla.
const BANNERS = [
  { id: "agenda", hash: "eventos", seccion: "agenda", cat: "todas", nombre: "Agenda" },
  { id: "medieval", hash: "medieval", seccion: "agenda", cat: "medieval", nombre: "Medieval, fantasía y rol" },
  { id: "anime", hash: "anime", seccion: "agenda", cat: "anime", nombre: "Anime, manga y cosplay" },
  { id: "ilustracion", hash: "ilustracion", seccion: "agenda", cat: "ilustracion", nombre: "Ilustración y cómic" },
  { id: "conciertos", hash: "conciertos", seccion: "agenda", cat: "conciertos", nombre: "Conciertos" },
  { id: "juegos", hash: "juegos", seccion: "agenda", cat: "juegos", nombre: "Juegos de mesa" },
  { id: "museos", hash: "museos", seccion: "agenda", cat: "museos", nombre: "Museos, arte y cultura" },
  { id: "teatro", hash: "teatro", seccion: "agenda", cat: "teatro", nombre: "Teatro" },
  { id: "standup", hash: "standup", seccion: "agenda", cat: "standup", nombre: "Stand-up" },
  { id: "restaurantes", hash: "restaurantes", seccion: "restaurantes", cat: null, nombre: "Restaurantes temáticos" },
];
// Un banner también puede mostrar varios temas juntos: cat "grupo:x" y aquí { "grupo:x": ["tema1", "tema2"] }.
// Hoy ninguno lo usa (el 8-11-2026 las exposiciones de arte pasaron a ser parte de Museos).
const GRUPOS = {};

const estado = { seccion: "agenda", cat: "todas", texto: "", soloRM: false, soloNuevos: false, tema: "todos", verTemporadas: false };
let EVENTOS = [];
let EVENTOS_CARGADOS = false;
let AGENDA_FALLO = false;
let ESTADO_RESTAURANTES = "cargando";   // "cargando" | "listo" | "fallo"
const FOTOS_ROTAS = new Set();   // fotos que no cargaron: no se vuelven a pintar
let LUGARES = [];         // teatros, museos, salas... con sus fotos (data/lugares.json)
let REFERENCIALES = {};   // categoría -> foto referencial, para eventos en un lugar que aún no tiene foto
let ULTIMA = {};          // datos de la última búsqueda
let NUEVOS = new Set();   // id de los eventos que agregó la última búsqueda
let CATS = {};
let ORDEN_CATS = [];
let RESTAURANTES = [];
let TIENDAS = [];          // tiendas del Mapa del Aventurero (data/tiendas.json)
let TIENDAS_FALLO = false;
let TEMAS = {};
let ORDEN_TEMAS = [];
let REVISADO = null;
let favEventos = leerSet(CLAVE_GUARDADOS);
let favRest = leerSet(CLAVE_REST);
let favTiendas = leerSet(CLAVE_TIENDAS);
let CUENTA = { disponible: false, usuario: null };

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
// Íconos: están en el <svg class="sprite"> de index.html. Cada tema de la agenda tiene el suyo
// (un tema nuevo sin ícono muestra su emoji de config/gustos.json).
const ICONO_CAT = { todas: "i-cuadricula", medieval: "i-espadas", yokai: "i-torii", anime: "i-mando", ilustracion: "i-pincel",
  conciertos: "i-guitarra", juegos: "i-dado6", museos: "i-museo", teatro: "i-teatro", standup: "i-standup" };
function ico(id, clase = "") {
  return `<svg class="ico${clase ? " " + clase : ""}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
}
function icoCat(id, emoji) {
  return ICONO_CAT[id] ? ico(ICONO_CAT[id], "ico-cat") : `<span class="emoji" aria-hidden="true">${esc(emoji || "•")}</span>`;
}
function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function urlSegura(u) { return typeof u === "string" && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null; }
function sinTildes(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function fecha(iso) { const [a, m, d] = iso.split("-").map(Number); return new Date(a, m - 1, d); }
function hoy() { const h = new Date(); return new Date(h.getFullYear(), h.getMonth(), h.getDate()); }
function dias(a, b) { return Math.round((b - a) / 86400000); }
function vigente(e) { return fecha(e.fecha_fin || e.fecha_inicio) >= hoy(); }
function leerSet(clave) {
  try { return new Set(JSON.parse(localStorage.getItem(clave) || "[]")); } catch { return new Set(); }
}
function guardarLocal() {
  try {
    localStorage.setItem(CLAVE_GUARDADOS, JSON.stringify([...favEventos]));
    localStorage.setItem(CLAVE_REST, JSON.stringify([...favRest]));
    localStorage.setItem(CLAVE_TIENDAS, JSON.stringify([...favTiendas]));
  } catch { /* sin almacenamiento */ }
}
function avisar(texto) {
  const a = $("#aviso");
  a.textContent = texto; a.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => { a.hidden = true; }, 2800);
}
/** Une partes de una dirección sin repetir ("Ñuñoa" ya incluido en "Casa de la Cultura de Ñuñoa").
 *  Si una parte nueva contiene a otras anteriores, queda la más completa ("Blondie" → "Blondie, Alameda 2879"). */
function unirPartes(partes) {
  const unico = [];
  partes.filter(Boolean).forEach((p) => {
    const q = sinTildes(p);
    if (unico.some((u) => sinTildes(u).includes(q))) return;
    const dentro = unico.filter((u) => q.includes(sinTildes(u)));
    if (!dentro.length) { unico.push(p); return; }
    unico.splice(unico.indexOf(dentro[0]), 1, p);
    for (const u of dentro.slice(1)) unico.splice(unico.indexOf(u), 1);
  });
  return unico;
}
/** "Cómo llegar": abre Google Maps (en el celular, su app) con la ruta desde donde está la persona hasta el lugar.
 *  La página no muestra mapas: solo manda el lugar a Google Maps. */
function urlComoLlegar(q) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`; }

function rangoTexto(e) {
  const i = fecha(e.fecha_inicio);
  if (!e.fecha_fin) return `${DIAS_LARGOS[i.getDay()]} ${i.getDate()} de ${MESES[i.getMonth()]}`;
  const f = fecha(e.fecha_fin);
  if (i.getMonth() === f.getMonth()) return `${i.getDate()} al ${f.getDate()} de ${MESES[f.getMonth()]}`;
  return `${i.getDate()} de ${MESES[i.getMonth()]} al ${f.getDate()} de ${MESES[f.getMonth()]}`;
}
function cuandoRelativo(e) {
  const h = hoy(), i = fecha(e.fecha_inicio), f = e.fecha_fin ? fecha(e.fecha_fin) : i;
  if (i <= h && f >= h) return i < h ? `En curso · hasta el ${f.getDate()} de ${MESES[f.getMonth()]}` : "Hoy";
  const n = dias(h, i);
  if (n === 1) return "Mañana";
  if (n < 7) return `Este ${DIAS_LARGOS[i.getDay()]}`;
  if (n < 14) return `En ${n} días`;
  return rangoTexto(e);
}
function lugarTexto(e) { return unirPartes([e.lugar, e.comuna || e.ciudad]).join(", "); }

// ---------- favoritos y cuenta ----------
// Los favoritos de eventos que ya pasaron no se borran de la cuenta (otra pestaña podría tener una agenda
// más nueva o más vieja): simplemente no se muestran. El tope de la cuenta guarda los más recientes.
// Las tiendas del mapa viajan a la cuenta dentro de la lista de restaurantes, con "t-" delante: así no hay que
// cambiar las reglas de Firestore (que solo aceptan las listas "eventos" y "restaurantes").
const PREFIJO_TIENDA = "t-";
function favoritosActuales() {
  return { eventos: [...favEventos], restaurantes: [...favRest, ...[...favTiendas].map((id) => PREFIJO_TIENDA + id)] };
}
function separarFavoritos(lista) {
  const r = (lista || []).filter((x) => typeof x === "string");
  return { rest: r.filter((x) => !x.startsWith(PREFIJO_TIENDA)), tiendas: r.filter((x) => x.startsWith(PREFIJO_TIENDA)).map((x) => x.slice(PREFIJO_TIENDA.length)) };
}
function conjuntoFav(tipo) { return tipo === "r" ? favRest : tipo === "t" ? favTiendas : favEventos; }
/** Lee los favoritos del navegador. Una pestaña con la versión anterior de la página guarda la lista de la cuenta
 *  tal cual (con las tiendas "t-…" mezcladas en restaurantes): aquí se separan siempre. */
function leerFavoritosLocales() {
  const s = separarFavoritos([...leerSet(CLAVE_REST)]);
  favEventos = leerSet(CLAVE_GUARDADOS);
  favRest = new Set(s.rest);
  favTiendas = new Set([...leerSet(CLAVE_TIENDAS), ...s.tiendas]);
}
leerFavoritosLocales();

/** Actualiza en su lugar los botones ☆/★ y el contador, sin redibujar la página (no se pierde el foco ni la posición). */
function refrescarFavoritos(desde) {
  document.querySelectorAll('[data-accion="favorito"]').forEach((b) => {
    const en = conjuntoFav(b.dataset.tipo).has(b.dataset.id);
    b.classList.toggle("guardado", en);
    b.setAttribute("aria-pressed", String(en));
    pintarBotonFavorito(b, en);
  });
  const n = contarFavoritos();
  $("#cuenta-favoritos").textContent = n ? String(n) : "";
  if (estado.seccion === "favoritos") {
    pintarFavoritos();
    // La lista se redibujó: el foco vuelve al mismo botón, o al título si ese favorito ya no está
    if (desde && !document.contains(desde)) {
      const igual = document.querySelector(`#sec-favoritos [data-accion="favorito"][data-tipo="${desde.dataset.tipo}"][data-id="${CSS.escape(desde.dataset.id)}"]`);
      (igual || $("#t-favoritos")).focus({ preventScroll: true });
    }
  }
}

function alternarFavorito(tipo, id, boton) {
  const conjunto = conjuntoFav(tipo);
  const quitar = conjunto.has(id);
  if (quitar) conjunto.delete(id); else conjunto.add(id);
  guardarLocal();
  if (CUENTA.usuario) window.pregoneroCuenta.guardar(favoritosActuales());
  if (quitar) avisar("Quitado de tus favoritos");
  else if (CUENTA.disponible && !CUENTA.usuario) avisar("★ En favoritos (en este navegador). Inicia sesión para tenerlos en todos lados");
  else avisar("★ Guardado en tus favoritos");
  refrescarFavoritos(boton);
}

window.pregoneroCuenta = {
  entrar: null, salir: null, guardar: () => {},
  estado(info) { CUENTA = { ...CUENTA, ...info }; pintarCuenta(); if (estado.seccion === "favoritos") pintarFavoritos(); },
  favoritos(fav) {
    const { rest, tiendas } = separarFavoritos(fav.restaurantes);
    favEventos = new Set(fav.eventos || []); favRest = new Set(rest); favTiendas = new Set(tiendas);
    guardarLocal(); refrescarFavoritos();
  },
  locales() { return favoritosActuales(); },
  limpiarLocales() { favEventos = new Set(); favRest = new Set(); favTiendas = new Set(); guardarLocal(); refrescarFavoritos(); },
  error(msg, e) { console.error(e); avisar(msg); },
};

// Otra pestaña cambió los favoritos (o cerró la sesión y los borró): esta se pone al día
window.addEventListener("storage", (ev) => {
  if (ev.key === null || ev.key === CLAVE_GUARDADOS || ev.key === CLAVE_REST || ev.key === CLAVE_TIENDAS) {
    leerFavoritosLocales();
    refrescarFavoritos();
  }
});

function pintarCuenta() {
  $("#zona-cuenta").hidden = !CUENTA.disponible;
  const u = CUENTA.usuario;
  $("#btn-entrar").hidden = !!u;
  $("#usuario").hidden = !u;
  if (u) {
    $("#nombre-usuario").textContent = (u.nombre || "").split(" ")[0] || "Tu cuenta";
    const img = $("#avatar");
    if (urlSegura(u.foto)) { img.src = u.foto; img.hidden = false; } else img.hidden = true;
  }
}
async function entrar() {
  const c = window.pregoneroCuenta;
  if (!c.entrar) { avisar("El inicio de sesión aún se está cargando"); return; }
  await c.entrar();
}
async function salir() {
  const c = window.pregoneroCuenta;
  if (c.salir) await c.salir();
  avisar("Sesión cerrada");
}

// ---------- secciones (pestañas) ----------
/** El hash sin "#", decodificado si se puede (un "%" suelto en un enlace mal copiado no debe romper la página). */
function hashActual() {
  const h = location.hash.slice(1);
  try { return decodeURIComponent(h); } catch { return h; }
}
function seccionDeHash() {
  const h = hashActual();
  if (h === "restaurantes" || h.startsWith("r-")) return "restaurantes";
  if (h === "mapa" || h.startsWith("m-")) return "mapa";
  if (h === "favoritos") return "favoritos";
  return "agenda";
}
/** Las categorías que deja ver el tema elegido (null: todas). */
function catsFiltro(cat = estado.cat) {
  return cat === "todas" ? null : GRUPOS[cat] || [cat];
}
/** El banner de la agenda que corresponde a un tema: el suyo, si tiene (Yokai no tiene); si no, Agenda. */
function bannerDeCat(cat = estado.cat) {
  const cats = catsFiltro(cat);
  if (!cats) return 0;
  const k = BANNERS.findIndex((b) => b.seccion === "agenda" && b.cat !== "todas" && cats.every((c) => catsFiltro(b.cat).includes(c)));
  return k >= 0 ? k : 0;
}
/** El banner de lo que se está mostrando; null en el mapa y en Mis favoritos (ahí el banner se queda donde estaba). */
function bannerActual() {
  if (estado.seccion === "agenda") return bannerDeCat();
  const k = BANNERS.findIndex((b) => b.seccion === estado.seccion);
  return k >= 0 ? k : null;
}
/** Sección y tema según la dirección: #eventos, la de cada banner (#medieval, #anime, #conciertos…), #restaurantes,
 *  #favoritos, #e-…, #r-… */
function aplicarHash() {
  estado.seccion = seccionDeHash();
  if (estado.seccion !== "agenda") return;
  const b = BANNERS.find((x) => x.hash === hashActual());
  if (b && b.cat !== "todas") estado.cat = b.cat;
  else if (bannerDeCat() !== 0) estado.cat = "todas";   // #eventos, sin dirección o #e-… con el tema de un banner: toda la agenda
}
function irA(seccion) {
  // La pestaña Agenda muestra la agenda completa: si se venía del banner de un tema, vuelve a "Todo"
  // (un tema sin banner elegido con su botón, como Yokai, se mantiene)
  if (seccion === "agenda" && bannerDeCat() !== 0) { estado.cat = "todas"; pintarChips(); pintar(); }
  const hash = seccion === "mapa" && MAPA.sel ? `#m-${MAPA.sel}` : `#${HASH_SECCION[seccion]}`;
  if (estado.seccion !== seccion) history.pushState(null, "", hash);
  else if (location.hash !== hash) history.replaceState(null, "", hash);
  estado.seccion = seccion;
  pintarSecciones(true);
  const nav = $(".secciones");
  if (window.scrollY > nav.offsetTop) window.scrollTo({ top: nav.offsetTop, behavior: "smooth" });
  // Para lectores de pantalla y teclado: el foco pasa al título de la sección que se abrió
  $(`#t-${seccion}`)?.focus({ preventScroll: true });
}
function contarFavoritos() {
  return EVENTOS.filter((e) => favEventos.has(e.id) && vigente(e)).length
    + RESTAURANTES.filter((r) => favRest.has(r.id)).length
    + TIENDAS.filter((x) => favTiendas.has(x.id)).length;
}
/** suave: el banner pasa al de la sección deslizándose (al tocar una pestaña, un punto o una flecha). */
function pintarSecciones(suave = false) {
  for (const s of SECCIONES) {
    const sec = $(`#sec-${s}`);   // un index.html anterior en caché no tiene #sec-mapa
    if (sec) sec.hidden = estado.seccion !== s;
    const p = $(`.pestana[data-seccion="${s}"]`);   // Restaurantes no tiene pestaña (sí en un index.html viejo en caché)
    if (!p) continue;
    if (estado.seccion === s) p.setAttribute("aria-current", "page"); else p.removeAttribute("aria-current");
  }
  const n = contarFavoritos();
  $("#cuenta-favoritos").textContent = n ? String(n) : "";
  if (estado.seccion === "restaurantes") pintarRestaurantes();
  if (estado.seccion === "favoritos") pintarFavoritos();
  if (estado.seccion === "mapa") abrirMapa();
  // Las fotos de la pestaña que se muestra quedan donde estaban (mientras estuvo escondida no se podían mover)
  const visible = $(`#sec-${estado.seccion}`);
  if (visible) reubicarCarruseles(visible);
  if (estado.seccion === "agenda") mostrarTemaMarcado();   // escondida, la fila de temas no se podía mover
  sincronizarBanners(suave);
}
function pintarTodo() {
  pintarChips();
  pintar();
  pintarSecciones();
}

// ---------- agenda: filtros ----------
function filtrar() {
  const q = sinTildes(estado.texto.trim());
  const cats = catsFiltro();
  return EVENTOS.filter((e) => {
    if (!vigente(e)) return false;
    if (estado.soloNuevos) return NUEVOS.has(e.id);   // "Nuevos" muestra todo lo nuevo, sin otros filtros
    if (cats && !cats.includes(e.categoria)) return false;
    if (estado.soloRM && !COMUNAS_RM.test([e.lugar, e.comuna, e.ciudad, e.region, e.direccion].join(" "))) return false;
    if (q) {
      const t = sinTildes([e.titulo, e.lugar, e.comuna, e.ciudad, e.descripcion, CATS[e.categoria]?.nombre].join(" "));
      if (!q.split(/\s+/).every((p) => t.includes(p))) return false;
    }
    return true;
  });
}

// ---------- agenda: pintar ----------
/** El detalle de la última búsqueda va al pie (la línea con la fecha y la última búsqueda arriba se quitó;
 *  un index.html viejo en caché aún la tiene: se sigue llenando si está). */
function pintarCabecera(datos) {
  const h = new Date();
  const hoyEl = $("#fecha-hoy");
  if (hoyEl) hoyEl.textContent = `${DIAS_LARGOS[h.getDay()]} ${h.getDate()} de ${MESES[h.getMonth()]} de ${h.getFullYear()} · Santiago de Chile`;
  const u = datos.ultima_busqueda || {};
  let txt = "Aún sin búsquedas";
  if (u.fecha) {
    const f = new Date(u.fecha);
    const horas = Math.round((Date.now() - f) / 3600000);
    const cuando = horas < 1 ? "hace un rato" : horas < 24 ? `hace ${horas} h` : `hace ${Math.round(horas / 24)} días`;
    const nNuevos = EVENTOS.filter((e) => NUEVOS.has(e.id)).length;   // mismo número que el botón "Nuevos"
    txt = `Última búsqueda ${cuando}${nNuevos ? ` · ${nNuevos} nuevo${nNuevos === 1 ? "" : "s"}` : " · sin novedades"}`;
    const det = [];
    if (u.paginas_revisadas) det.push(`${u.paginas_revisadas} páginas leídas`);
    if (u.busquedas) det.push(`${u.busquedas} búsquedas`);
    if (u.llamadas_ia) det.push(`${u.llamadas_ia} lecturas con IA`);
    if (u.ia_sin_cupo) det.push("la IA gratuita llegó a su límite del día");
    const detalle = $("#detalle-busqueda");   // el texto de la última búsqueda se quitó del pie (9-11-2026); un index.html viejo aún lo tiene
    if (detalle) detalle.textContent = `Última búsqueda: ${f.toLocaleString("es-CL", { dateStyle: "long", timeStyle: "short" })}${det.length ? " · " + det.join(" · ") : ""}. Total en agenda: ${datos.total ?? EVENTOS.length}.`;
  }
  const est = $("#estado-busqueda");
  if (est) est.textContent = txt;
}

function pintarChips() {
  const vigentes = EVENTOS.filter(vigente);
  const cuenta = (id) => vigentes.filter((e) => e.categoria === id).length;
  const chips = [
    { id: "todas", nombre: "Todo", emoji: "📰", n: vigentes.length },
    ...ORDEN_CATS.map((c) => ({ id: c.id, nombre: c.nombre, emoji: c.emoji, n: cuenta(c.id) })),
  ];
  const cats = catsFiltro();   // los temas que muestra el banner o el botón elegido
  $("#chips").innerHTML = chips.map((c) =>
    `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${c.id === "todas" ? !cats : !!cats?.includes(c.id)}">` +
    `${icoCat(c.id, c.emoji)}${esc(c.nombre)} <span class="cuenta">${c.n}</span></button>`
  ).join("") +
    `<button type="button" class="chip" data-rm="1" aria-pressed="${estado.soloRM}">${ico("i-pin-rm", "ico-pin")}Solo Región Metropolitana</button>`;
  if (estado.cat !== temaMostrado) { temaMostrado = estado.cat; mostrarTemaMarcado(); }
}
/** La fila de temas se desliza (en el celular no caben): que se vea el tema marcado, por ejemplo al pasar al banner
 *  de un tema que está al final de la fila, como Juegos o Museos. */
let temaMostrado = null;
function mostrarTemaMarcado() {
  const fila = $("#chips");
  const marcados = [...fila.querySelectorAll('.chip[data-cat][aria-pressed="true"]')];
  if (!marcados.length || !fila.clientWidth) return;
  const f = fila.getBoundingClientRect();
  const a = marcados[0].getBoundingClientRect(), z = marcados[marcados.length - 1].getBoundingClientRect();
  let d = 0;
  if (a.left < f.left) d = a.left - f.left - 12;
  else if (z.right > f.right) d = Math.min(z.right - f.right + 12, a.left - f.left - 12);
  if (d) fila.scrollBy({ left: d, behavior: MOVIMIENTO_REDUCIDO.matches ? "auto" : "smooth" });
}

function antetitulo(e) {
  const c = CATS[e.categoria] || { nombre: e.categoria, emoji: "•" };
  const nuevo = e.agregado && dias(fecha(e.agregado), hoy()) <= 2 ? '<span class="etiqueta nuevo">NUEVO</span>' : "";
  return `<p class="antetitulo">${icoCat(e.categoria, c.emoji)}${esc(c.nombre)}${nuevo}</p>`;
}

function datosLinea(e) {
  const partes = [];
  const l = lugarTexto(e);
  if (l) partes.push(`<span class="dato">${ico("i-pin", "ico-pin")}${esc(l)}</span>`);
  if (e.hora) partes.push(`<span class="dato">${ico("i-reloj")}${esc(e.hora)} h</span>`);
  else if (e.horario) partes.push(`<span class="dato">${ico("i-reloj")}${esc(e.horario)}</span>`);   // exposiciones: horario de visita
  if (e.precio) partes.push(`<span class="dato">${ico("i-ticket")}${esc(e.precio)}</span>`);
  return partes.length ? `<p class="datos">${partes.join("")}</p>` : "";
}

function fuenteLinea(e) {
  const fuentes = (e.fuentes || []).filter((f) => urlSegura(f.url)).slice(0, 3)
    .map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nombre || "fuente")}</a>`).join(", ");
  const marcas = [];
  if (e.desde_imagen) marcas.push(`<span class="marca" title="La fecha o el lugar se leyeron de un afiche">${ico("i-camara")}leído del afiche</span>`);
  if (e.confianza === "baja") marcas.push(`<span class="marca aviso-baja" title="Conviene confirmar en la fuente">${ico("i-aviso")}por confirmar</span>`);
  return `<p class="fuente">${fuentes ? "Fuente: " + fuentes : ""}${marcas.join("")}</p>`;
}

function consultaEvento(e) { return unirPartes([e.lugar, e.direccion, e.comuna || e.ciudad]).concat("Chile").join(", "); }
function consultaLocal(r) {
  // "mapa" es una búsqueda limpia para direcciones confusas (pisos, galerías, accesos por otra calle)
  const dir = r.mapa ? [r.mapa] : [String(r.direccion || "").replace(/\s*\([^)]*\)/g, ""), r.comuna];
  return unirPartes([r.nombre, ...dir]).concat("Chile").join(", ");
}

/** Contenido del botón de favorito: estrella y texto, o solo la estrella (en las tarjetas de la portada). */
function contenidoFavorito(en, soloEstrella) {
  const estrella = ico(en ? "i-estrella-llena" : "i-estrella", "ico-estrella");
  return soloEstrella ? estrella : `${estrella}${en ? "En favoritos" : "Favorito"}`;
}
function pintarBotonFavorito(b, en) {
  const solo = b.classList.contains("estrella-fav");
  b.innerHTML = contenidoFavorito(en, solo);
  if (solo) b.setAttribute("aria-label", en ? "Quitar de mis favoritos" : "Agregar a mis favoritos");
}
function botonFavorito(tipo, id, enFavoritos, soloEstrella = false) {
  const datos = `data-accion="favorito" data-tipo="${tipo}" data-id="${esc(id)}" aria-pressed="${enFavoritos}"`;
  if (soloEstrella) {
    return `<button type="button" class="estrella-fav${enFavoritos ? " guardado" : ""}" ${datos} ` +
      `aria-label="${enFavoritos ? "Quitar de mis favoritos" : "Agregar a mis favoritos"}">${contenidoFavorito(enFavoritos, true)}</button>`;
  }
  return `<button type="button" class="accion${enFavoritos ? " guardado" : ""}" ${datos}>${contenidoFavorito(enFavoritos, false)}</button>`;
}

function acciones(e) {
  const tieneLugar = lugarTexto(e) || e.direccion;
  return `<div class="acciones">
    ${botonFavorito("e", e.id, favEventos.has(e.id))}
    <button type="button" class="accion" data-accion="calendario" data-id="${esc(e.id)}">${ico("i-calendario-mas")}Calendario</button>
    ${tieneLugar ? `<a class="accion" href="${esc(urlComoLlegar(consultaEvento(e)))}" target="_blank" rel="noopener">${ico("i-ruta")}Cómo llegar</a>` : ""}
    <button type="button" class="accion" data-accion="compartir" data-id="${esc(e.id)}">${ico("i-compartir")}Compartir</button>
  </div>`;
}

// ---------- fotos: afiches, fotos de los lugares y de los restaurantes ----------
/** "Teatro Caupolicán - Santiago Centro" → " teatro caupolican santiago centro " (para buscar alias como palabras enteras). */
function claveTexto(t) { return ` ${sinTildes(t).replace(/[^a-z0-9]+/g, " ").trim()} `; }

function prepararLugares(datos) {
  const claves = (lista) => (lista || []).map(claveTexto).filter((c) => c.trim().length >= 3);
  LUGARES = (datos.lugares || []).map((l) => ({ ...l, _claves: claves([l.nombre, ...(l.alias || [])]), _excluir: claves(l.excluir) }));
  REFERENCIALES = datos.referenciales || {};
}

/** Lugares conocidos que aparecen en el lugar o la dirección del evento, en el orden en que se nombran.
 *  Si un alias está dentro de otro más específico ("museo de arte contemporaneo" y "... quinta normal"), gana el específico;
 *  "excluir" descarta un lugar cuando el texto nombra otra sede ("quinta normal" no es el MAC del Parque Forestal). */
function lugaresDe(e) {
  const t = claveTexto([e.lugar, e.direccion].filter(Boolean).join(" "));
  if (!t.trim()) return [];
  const todo = claveTexto([e.lugar, e.direccion, e.comuna, e.ciudad, e.region].filter(Boolean).join(" "));
  const hallados = [];
  for (const l of LUGARES) {
    if (l._excluir.some((x) => todo.includes(x))) continue;
    const alias = l._claves.filter((a) => t.includes(a)).sort((a, b) => b.length - a.length)[0];
    if (alias) hallados.push({ l, alias, pos: t.indexOf(alias) });
  }
  // Se descarta un lugar si otro que también calzó tiene un alias más largo que contiene el suyo:
  // "Museo de Arte Contemporáneo (MAC), Av. Matucana 464" es la sede Quinta Normal, no la del Parque Forestal.
  return hallados
    .filter((x) => !hallados.some((y) => y !== x && y.l._claves.some((c) => c.length > x.alias.length && c.includes(x.alias))))
    .sort((a, b) => a.pos - b.pos)
    .map((x) => x.l);
}

/** Sin repetidas ni rotas (las que ya fallaron en esta visita). */
function unicas(fotos) {
  const vistas = new Set();
  return fotos.filter((f) => {
    const u = urlSegura(f.url);
    if (!u || FOTOS_ROTAS.has(u) || vistas.has(u)) return false;
    vistas.add(u);
    return true;
  });
}

/** El afiche y las fotos del evento primero; después, las del lugar (de varios lugares, una de cada uno).
 *  Si no hay ninguna, una imagen referencial de la categoría (se avisa que lo es). */
function dominioDe(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function fotosEvento(e) {
  // El crédito del afiche es la fuente del sitio al que lleva su enlace (o, si no está entre las fuentes, ese sitio)
  const fuentes = (e.fuentes || []).filter((f) => urlSegura(f.url));
  const sitio = dominioDe(urlSegura(e.url) || "");
  const fuente = fuentes.find((f) => sitio && dominioDe(f.url) === sitio)
    || fuentes.find((f) => dominioDe(f.url) === dominioDe(urlSegura(e.imagen) || "")) || (sitio ? null : fuentes[0]);
  const deEvento = {
    credito: fuente?.nombre ? `Fuente: ${fuente.nombre}` : sitio ? `Fuente: ${sitio}` : "",
    pagina: urlSegura(e.url) || fuente?.url || null,
  };
  const fotos = [];
  if (urlSegura(e.imagen)) fotos.push({ url: e.imagen, tipo: "afiche", ...deEvento });
  for (const u of Array.isArray(e.fotos) ? e.fotos : []) fotos.push({ url: u, tipo: "evento", ...deEvento });
  const lugares = lugaresDe(e).slice(0, 3);
  for (const l of lugares) {
    // primero se quitan las que no cargaron, para que un lugar con más fotos no desaparezca de la galería
    const buenas = (l.fotos || []).filter((f) => urlSegura(f.url) && !FOTOS_ROTAS.has(f.url));
    for (const f of buenas.slice(0, lugares.length === 1 ? 4 : 1)) fotos.push({ ...f, tipo: "lugar", lugar: l.nombre });
  }
  const lista = unicas(fotos);
  if (lista.length) return lista;
  return unicas((REFERENCIALES[e.categoria] || []).map((f) => ({ ...f, tipo: "referencial" })));
}
function fotosLocal(r) { return unicas((r.fotos || []).map((f) => ({ ...f, tipo: "local" }))); }

function datosFotos(ref) {
  const tipo = ref.slice(0, 1), id = ref.slice(2);
  if (tipo === "e") {
    const e = porId(id);
    return e ? { titulo: e.titulo, fotos: fotosEvento(e) } : null;
  }
  if (tipo === "t") {
    const x = TIENDAS.find((y) => y.id === id);
    if (!x) return null;
    let fotos = fotosLocal(x);
    // Una tienda sin fotos propias dentro de una galería muestra las de la galería (con su sello)
    const g = !fotos.length && x.en ? TIENDAS.find((y) => y.id === x.en) : null;
    if (g) fotos = fotosLocal(g).map((f) => ({ ...f, tipo: "galeria" }));
    return { titulo: x.nombre, fotos };
  }
  const r = RESTAURANTES.find((x) => x.id === id);
  return r ? { titulo: r.nombre, fotos: fotosLocal(r) } : null;
}

/** Fotos de una tarjeta: se ve una a la vez, completa y sin recortes (una copia desenfocada del mismo archivo,
 *  que el navegador baja una sola vez, rellena el recuadro). Las demás se pasan deslizando con el dedo, con las
 *  flechas ‹ › o con ←/→, y al tocar una se abre en grande en el visor.
 *  De entrada solo se baja la primera; las demás, cuando la persona llega a la galería (la toca, le pasa el mouse
 *  o la enfoca), de a una adelante: así la agenda no baja cientos de fotos que nadie va a mirar. */
function htmlGaleria(ref, clase) {
  const d = datosFotos(ref);
  if (!d || !d.fotos.length) return "";
  const { titulo, fotos } = d;
  const n = fotos.length;
  const r = esc(ref);
  const diapos = fotos.map((f, i) => {
    const s = esc(f.url);
    const fuente = i ? `data-src="${s}"` : `src="${s}" loading="lazy"`;
    const que = f.tipo === "afiche" ? "afiche del evento" : f.descripcion || f.lugar || titulo;
    const nombre = n > 1 ? `Foto ${i + 1} de ${n}: ${que}. Ver en grande` : `Ver en grande la foto de ${titulo}`;
    return `<button type="button" class="marco-foto" data-accion="fotos" data-ref="${r}" data-i="${i}"${i ? ' tabindex="-1"' : ""} aria-label="${esc(nombre)}">` +
      `<img class="fondo" ${fuente} alt="" decoding="async" referrerpolicy="no-referrer">` +
      `<img class="imagen" ${fuente} alt="" decoding="async" referrerpolicy="no-referrer" data-url="${s}"${i ? "" : ' onload="ajustarMarco(this)"'} onerror="fotoRota(this)">` +
      (f.tipo === "referencial" ? `<span class="sello">Imagen referencial</span>` : "") +
      (f.tipo === "galeria" ? `<span class="sello">Foto de la galería</span>` : "") +
      `</button>`;
  }).join("");
  // Las flechas son para el mouse (con el dedo se desliza y con el teclado se usan ←/→): no suman paradas al tabulador
  const controles = n < 2 ? "" :
    `<button type="button" class="flecha-foto ant" data-accion="foto-ant" tabindex="-1" aria-label="Foto anterior" disabled>‹</button>` +
    `<button type="button" class="flecha-foto sig" data-accion="foto-sig" tabindex="-1" aria-label="Foto siguiente">›</button>` +
    `<span class="contador" aria-hidden="true">1 / ${n}</span>`;
  return `<div class="galeria ${clase}" data-ref="${r}" data-clase="${esc(clase)}">` +
    `<div class="carrusel"${n > 1 ? ` role="group" aria-label="${esc(`${n} fotos de ${titulo}`)}"` : ""}>${diapos}</div>` +
    controles + `</div>`;
}
/** Las miniaturas de la agenda toman la forma de su primera foto (el CSS la limita), para no dejar franjas grandes;
 *  las siguientes se ven completas dentro del mismo recuadro. */
function ajustarMarco(img) {
  const g = img.closest(".galeria.miniatura");
  if (!g || !img.naturalWidth || !img.naturalHeight) return;
  g.style.setProperty("--proporcion", (img.naturalWidth / img.naturalHeight).toFixed(3));
}
/** Una foto no cargó: se quita del visor y se rehacen todas las galerías que la tenían
 *  (las fotos de un lugar se repiten en los eventos de ese lugar). Mientras haya un dedo sobre la pantalla no se
 *  rehace ninguna: se espera a que se suelte y se detenga. Si se reemplazara la que está bajo un dedo, el gesto
 *  se perdería y su touchend no llegaría. */
function fotoRota(img) {
  const url = img.dataset.url || img.getAttribute("src");
  const propia = img.closest(".galeria");
  const afectadas = [...document.querySelectorAll(".galeria")].filter((g) =>
    g === propia || datosFotos(g.dataset.ref)?.fotos.some((f) => f.url === url));
  FOTOS_ROTAS.add(url);
  const figura = img.closest(".visor-foto");
  if (figura) quitarDelVisor(figura);
  const esperar = dedoAbajo();
  afectadas.forEach((g) => { if (esperar) PENDIENTES.add(g); else rehacerGaleria(g); });
}
function rehacerGaleria(g) {
  if (!document.contains(g)) return;
  if (g.closest("#mapa-ficha")) { pintarFicha(); return; }   // la ficha del mapa sabe qué poner si ya no quedan fotos
  const tarjeta = g.closest("article");
  const viejo = g.querySelector(".carrusel");
  const i0 = viejo ? indiceCarrusel(viejo) : 0;
  const vista = viejo?.children[i0]?.querySelector(".imagen")?.dataset.url;   // la foto que se estaba mirando
  const primera = viejo?.querySelector(".imagen")?.dataset.url;
  // si el visor se abrió desde esta galería, el foco debe volver a la foto equivalente de la galería nueva
  const abria = !!visor.abridor && g.contains(visor.abridor);
  const conFoco = g.contains(document.activeElement);
  const html = htmlGaleria(g.dataset.ref, g.dataset.clase);
  if (!html) {
    g.remove();
    tarjeta?.classList.add("sin-foto");
    const otro = tarjeta?.querySelector("h2 a, h3 a, a, button") || null;
    if (abria) visor.abridor = otro;
    if (conFoco) otro?.focus({ preventScroll: true });
    return;
  }
  const t = document.createElement("template");
  t.innerHTML = html;
  const nueva = t.content.firstElementChild;
  const proporcion = g.style.getPropertyValue("--proporcion");
  if (proporcion && nueva.querySelector(".imagen")?.dataset.url === primera) nueva.style.setProperty("--proporcion", proporcion);
  g.replaceWith(nueva);
  // Se sigue en la misma foto; si la que se fue era justo esa, en la que quedó en su lugar
  const urls = [...nueva.querySelectorAll(".carrusel .imagen")].map((im) => im.dataset.url);
  const i = urls.indexOf(vista);
  irACarrusel(nueva, i >= 0 ? i : i0, { enfocar: conFoco });
  if (abria) visor.abridor = nueva.querySelector(".carrusel").children[indiceCarrusel(nueva.querySelector(".carrusel"))];
}

// ---------- carrusel de cada tarjeta ----------
// destino: la foto a la que va un desplazamiento suave (las flechas suman desde ahí, no desde la posición a medio camino)
const CARRUSELES = new WeakMap();   // carrusel -> { destino, indice, cuadro, fin }
const MOVIMIENTO_REDUCIDO = window.matchMedia("(prefers-reduced-motion: reduce)");
function estadoCarrusel(c) {
  let s = CARRUSELES.get(c);
  if (!s) CARRUSELES.set(c, (s = { destino: null, indice: 0, cuadro: 0, fin: 0 }));
  return s;
}
/** La foto que se ve (o a la que se va). */
function indiceCarrusel(c) {
  const s = estadoCarrusel(c);
  const i = s.destino ?? (c.clientWidth ? Math.round(c.scrollLeft / c.clientWidth) : s.indice);
  return Math.min(Math.max(0, i), c.children.length - 1);
}
/** Baja la foto que se ve y sus vecinas (justo antes de que la persona las pase). */
function cargarVecinas(c, i) {
  for (const k of [i - 1, i, i + 1]) {
    c.children[k]?.querySelectorAll("img[data-src]").forEach((img) => {
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    });
  }
}
/** Contador, flechas y foco según la foto que se ve. Solo esa foto es una parada del tabulador.
 *  En los extremos la flecha se desactiva (no se esconde): si desapareciera bajo el mouse, el clic siguiente
 *  caería en la foto y abriría el visor sin querer. */
function pintarCarrusel(g) {
  const c = g?.querySelector(".carrusel");
  if (!c || !g.isConnected) return;   // una galería que ya se reemplazó
  const n = c.children.length;
  const i = indiceCarrusel(c);
  estadoCarrusel(c).indice = i;
  for (let k = 0; k < n; k++) c.children[k].tabIndex = k === i ? 0 : -1;
  cargarVecinas(c, i);
  if (n < 2) return;
  const cont = g.querySelector(".contador");
  if (cont) cont.textContent = `${i + 1} / ${n}`;
  const ant = g.querySelector(".flecha-foto.ant"), sig = g.querySelector(".flecha-foto.sig");
  const foco = document.activeElement;
  if (ant) ant.disabled = i <= 0;
  if (sig) sig.disabled = i >= n - 1;
  // Una flecha que se desactiva con el foco encima lo perdería: pasa a la foto que se ve
  if ((foco === ant || foco === sig) && foco.disabled) c.children[i].focus({ preventScroll: true });
}
function irACarrusel(g, i, { suave = false, enfocar = false } = {}) {
  const c = g?.querySelector(".carrusel");
  if (!c || !c.children.length) return;
  i = Math.min(Math.max(0, i), c.children.length - 1);
  const s = estadoCarrusel(c);
  const izquierda = i * c.clientWidth;
  const mover = c.clientWidth > 0 && Math.abs(c.scrollLeft - izquierda) > 1;
  const animar = mover && suave && !MOVIMIENTO_REDUCIDO.matches;
  s.destino = animar ? i : null;
  s.indice = i;
  if (mover) c.scrollTo({ left: izquierda, behavior: animar ? "smooth" : "auto" });
  if (animar) {   // por si el navegador no avisa el fin del desplazamiento
    clearTimeout(s.fin);
    s.fin = setTimeout(() => { s.destino = null; pintarCarrusel(g); }, 900);
  }
  pintarCarrusel(g);
  if (enfocar) c.children[i].focus({ preventScroll: true });
}
function moverCarrusel(g, paso, enfocar = false) {
  const c = g?.querySelector(".carrusel");
  if (!c) return;
  const actual = indiceCarrusel(c);
  const i = Math.min(Math.max(0, actual + paso), c.children.length - 1);
  if (i !== actual) irACarrusel(g, i, { suave: true, enfocar });
}
// El carrusel se desliza con el dedo o el trackpad: el contador sigue a la foto que queda
// (los eventos "scroll" de los elementos no burbujean: se escuchan en la captura)
document.addEventListener("scroll", (ev) => {
  const c = ev.target;
  if (!(c instanceof Element) || !c.classList.contains("carrusel")) return;
  const s = estadoCarrusel(c);
  s.ultimo = performance.now();
  cancelAnimationFrame(s.cuadro);
  s.cuadro = requestAnimationFrame(() => pintarCarrusel(c.parentElement));
  clearTimeout(s.fin);
  s.fin = setTimeout(() => { s.destino = null; pintarCarrusel(c.parentElement); alQuietarse(c); }, 180);
}, true);

// Respaldo del "scroll-snap": con algunos gestos muy rápidos el navegador puede dejar el carrusel (o el visor)
// entre dos fotos. Cuando el dedo se levanta y el desplazamiento se detiene, se lleva a la foto más cercana.
let DEDOS = 0;          // dedos sobre la pantalla: mientras alguien arrastra no se acomoda ni se rehace nada
let TOCADO = null;      // el carrusel (o el carril del visor) donde empezó el toque, o null
const PENDIENTES = new Set();      // galerías con una foto rota que esperan que se suelte el dedo para rehacerse
const ACOMODADO = new WeakMap();   // cuándo se acomodó por última vez cada uno (a lo más una vez por segundo)
/** ¿Hay un dedo sobre la pantalla? Si lo que se tocaba salió de la página, su touchend no llegará: se da por suelto. */
function dedoAbajo() {
  if (DEDOS && TOCADO && !TOCADO.isConnected) { DEDOS = 0; TOCADO = null; }
  return DEDOS > 0;
}
/** Si quedó entre dos fotos, lo lleva a la más cercana. Devuelve true si lo puso en movimiento. */
function acomodar(c) {
  if (dedoAbajo() || !c?.clientWidth || !c.children.length || !c.isConnected) return false;
  const ancho = c.scrollWidth / c.children.length;   // ancho real de cada foto (clientWidth viene redondeado)
  const i = Math.round(c.scrollLeft / ancho);
  if (Math.abs(c.scrollLeft - i * ancho) <= 3 || performance.now() - (ACOMODADO.get(c) || -1e9) < 1000) return false;
  ACOMODADO.set(c, performance.now());
  c.scrollTo({ left: i * ancho, behavior: MOVIMIENTO_REDUCIDO.matches ? "auto" : "smooth" });
  return true;
}
function rehacerPendientes() {
  for (const g of [...PENDIENTES]) { PENDIENTES.delete(g); rehacerGaleria(g); }
}
/** Se soltó el dedo y el carrusel (o el visor) se detuvo: se acomoda en una foto y después se rehacen
 *  las galerías pendientes. */
function alQuietarse(c) {
  if (c?.classList?.contains("arrastrando")) return;   // con el mouse apretado: se decide al soltar
  if (dedoAbajo()) {
    // El banner se detuvo con un dedo en otra parte (por ejemplo, bajando por la página): se revisa de nuevo
    // cuando ese dedo se suelte; si no, el banner quedaría en una sección y la página en otra
    if (c?.id === "banners-carril" && TOCADO !== c) { clearTimeout(banners.fin); banners.fin = setTimeout(() => alQuietarse(c), 160); }
    return;
  }
  // se mueve otra vez: cuando se detenga se vuelve a pasar por aquí
  if (c?.id === "banners-carril") { if (bannerQuieto(c)) return; }
  else if (c && acomodar(c)) return;
  rehacerPendientes();
}
document.addEventListener("touchstart", (ev) => {
  DEDOS = ev.touches.length;
  if (DEDOS === 1) TOCADO = ev.target instanceof Element ? ev.target.closest(".carrusel, .visor-carril, .banners-carril") : null;
  if (TOCADO?.id === "banners-carril") {
    banners.programado = false;   // si la página lo estaba moviendo, ahora manda la persona
    banners.x0 = ev.touches[0].clientX; banners.k0 = indiceVisibleBanners(TOCADO); banners.vuelta = null;
  }
}, { passive: true });
/** Cuándo se movió por última vez el carrusel, el visor o el banner. */
function ultimoMovimiento(c) {
  if (!c) return 0;
  if (c.classList.contains("visor-carril")) return visor.ultimo;
  if (c.id === "banners-carril") return banners.ultimo;
  return CARRUSELES.get(c)?.ultimo;
}
function soltar(ev) {
  DEDOS = ev.touches.length;
  if (DEDOS) return;
  const c = TOCADO;
  TOCADO = null;
  // En el último banner, seguir deslizando hacia la izquierda lleva al primero (y en el primero, hacia la derecha, al último)
  if (c?.id === "banners-carril" && ev.changedTouches?.length) {
    const dx = ev.changedTouches[0].clientX - banners.x0, n = BANNERS.length;
    if (banners.k0 === n - 1 && dx < -50) banners.vuelta = 0;
    else if (banners.k0 === 0 && dx > 50) banners.vuelta = n - 1;
  }
  // Si el navegador sigue moviéndolo (inercia o su propio ajuste), se espera a que termine
  setTimeout(() => {
    const ultimo = ultimoMovimiento(c);
    if (!ultimo || performance.now() - ultimo > 150) alQuietarse(c);
  }, 220);
}
document.addEventListener("touchend", soltar, { passive: true });
document.addEventListener("touchcancel", soltar, { passive: true });
// Al tocar la galería, pasarle el mouse o enfocarla, se baja la foto siguiente
function prepararGaleria(ev) {
  const c = ev.target instanceof Element ? ev.target.closest(".galeria")?.querySelector(".carrusel") : null;
  if (c) cargarVecinas(c, indiceCarrusel(c));
}
document.addEventListener("pointerover", prepararGaleria, { passive: true });
document.addEventListener("focusin", prepararGaleria);
document.addEventListener("keydown", (ev) => {
  if ((ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  if ($("#visor")?.open) return;   // el visor tiene sus propias flechas
  const diapo = ev.target instanceof Element ? ev.target.closest(".carrusel > .marco-foto") : null;
  if (!diapo) return;
  ev.preventDefault();
  moverCarrusel(diapo.closest(".galeria"), ev.key === "ArrowRight" ? 1 : -1, true);
});
/** Deja cada carrusel visible en la foto que mostraba. Se usa al cambiar el ancho de la pantalla y al volver
 *  a mostrar una pestaña: una galería escondida no se puede desplazar (por ejemplo, si se rehízo por una foto
 *  rota que se descubrió desde otra pestaña) y, al mostrarla, el navegador la puede dejar en otra foto. */
function reubicarCarruseles(raiz = document) {
  raiz.querySelectorAll(".carrusel").forEach((c) => {
    if (dedoAbajo() && c === TOCADO) return;   // el que se está arrastrando lo acomoda el navegador al soltar
    const s = CARRUSELES.get(c);
    if (!s || !c.clientWidth || !c.children.length) return;
    const ancho = c.scrollWidth / c.children.length;
    const i = Math.min(s.indice, c.children.length - 1);
    s.destino = null;
    if (Math.abs(c.scrollLeft - i * ancho) > 1) c.scrollTo({ left: i * ancho, behavior: "auto" });
    pintarCarrusel(c.parentElement);
  });
}
window.addEventListener("resize", () => reubicarCarruseles());

// ---------- banners de la cabecera: cada uno muestra su sección ----------
// indice: el banner de la sección que se muestra (o el último, en Mis favoritos)
// programado: lo está moviendo la página (no la persona): al detenerse no cambia la sección
const banners = { indice: 0, programado: false, ultimo: 0, fin: 0, cuadro: 0, seguro: 0, x0: 0, k0: 0, vuelta: null };
/** El banner da la vuelta: después del último viene el primero y antes del primero, el último. */
function bannerVecino(paso) { const n = BANNERS.length; return ((banners.indice + paso) % n + n) % n; }
function carrilBanners() { return document.getElementById("banners-carril"); }   // null con un index.html viejo
function anchoBanner(c) { return c.children.length ? c.scrollWidth / c.children.length : 0; }
function indiceVisibleBanners(c) {
  const a = anchoBanner(c);
  return a ? Math.min(Math.max(0, Math.round(c.scrollLeft / a)), c.children.length - 1) : banners.indice;
}
/** Puntos y flechas según el banner k (null: ninguno marcado, como en Mis favoritos). */
function pintarPuntos(k) {
  document.querySelectorAll(".banners-puntos .punto").forEach((p, i) => {
    if (i === k) p.setAttribute("aria-current", "true"); else p.removeAttribute("aria-current");
  });
  const i = k ?? banners.indice;
  carrilBanners()?.querySelectorAll(".banner-cabecera").forEach((b, j) => {
    if (j === i) b.removeAttribute("aria-hidden"); else b.setAttribute("aria-hidden", "true");
  });
  const ant = $(".banners-flecha.ant"), sig = $(".banners-flecha.sig");
  // El banner da la vuelta: las flechas siempre sirven
  if (ant) ant.disabled = false;
  if (sig) sig.disabled = false;
}
/** Lleva el banner a la posición k, salvo que la persona lo esté arrastrando. */
function moverBanners(k, suave = false) {
  const c = carrilBanners();
  if (!c || (dedoAbajo() && TOCADO === c)) return;
  activarBanner(c.children[k]);
  const a = anchoBanner(c);
  if (!a || Math.abs(c.scrollLeft - k * a) <= 1) return;
  banners.programado = true;
  clearTimeout(banners.seguro);
  banners.seguro = setTimeout(() => { banners.programado = false; }, 1500);   // por si no llega el fin del desplazamiento
  c.scrollTo({ left: k * a, behavior: suave && !MOVIMIENTO_REDUCIDO.matches ? "smooth" : "auto" });
}
/** El banner pasa al de lo que se está mostrando (al cambiar de pestaña, de tema o de dirección). */
function sincronizarBanners(suave = false) {
  const k = bannerActual();
  pintarPuntos(k);
  if (k === null) return;
  banners.indice = k;
  moverBanners(k, suave);
}
/** Muestra la sección del banner k (al deslizarlo o tocar uno de sus puntos o flechas). */
function irABanner(k, suave = true) {
  const b = BANNERS[k];
  if (!b) return;
  banners.indice = k;
  const antes = estado.seccion;
  if (b.seccion === "agenda" && (estado.cat !== b.cat || estado.soloNuevos)) {
    estado.cat = b.cat;
    estado.soloNuevos = false;   // "Nuevos" muestra lo nuevo sin filtros: al elegir un banner se ve la agenda con su tema
    pintarChips(); pintar();
  }
  estado.seccion = b.seccion;
  // Pasar entre los banners de la agenda (todos menos Restaurantes) no deja pasos en el historial;
  // ir a Restaurantes o volver, sí (como una pestaña)
  const hash = `#${b.hash}`;
  if (antes !== b.seccion) history.pushState(null, "", hash);
  else if (location.hash !== hash) history.replaceState(null, "", hash);
  pintarSecciones(suave);
  const anuncio = $("#anuncio-banner");   // para lectores de pantalla
  if (anuncio) anuncio.textContent = `Sección: ${b.nombre || b.id}`;
}
/** El banner se detuvo. Si lo deslizó la persona y quedó en otro, se muestra su sección.
 *  Devuelve true si lo puso en movimiento otra vez (cuando se detenga se vuelve a pasar por aquí). */
function bannerQuieto(c) {
  if (banners.programado) {   // lo movió la página: solo se asegura de que quede justo en su lugar
    banners.programado = false;
    clearTimeout(banners.seguro);
    moverBanners(banners.indice);
    pintarPuntos(bannerActual());
    return banners.programado;
  }
  if (acomodar(c)) return true;   // quedó entre dos: se lleva al más cercano
  const k = indiceVisibleBanners(c);
  if (banners.vuelta !== null) {   // se siguió deslizando más allá del extremo: da la vuelta
    const v = banners.vuelta;
    banners.vuelta = null;
    if (k === banners.k0) { irABanner(v); return false; }
  }
  if (k !== banners.indice) irABanner(k, false);
  else pintarPuntos(bannerActual());
  return false;
}
/** Arrastrar con el mouse lo que se desliza de lado (con el dedo ya funciona solo): las filas de temas y el banner.
 *  alSoltar(dx): qué hacer al soltar (el banner pasa al de al lado o da la vuelta). Un arrastre no cuenta como clic. */
function arrastreConMouse(el, alSoltar) {
  let x0 = 0, s0 = 0, activo = false, movido = false, fin = 0;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "mouse" || ev.button !== 0) return;
    activo = true; movido = false; x0 = ev.clientX; s0 = el.scrollLeft;
  });
  window.addEventListener("pointermove", (ev) => {
    if (!activo) return;
    const dx = ev.clientX - x0;
    if (!movido && Math.abs(dx) < 6) return;
    if (!movido) { movido = true; el.classList.add("arrastrando"); }
    el.scrollLeft = s0 - dx;
  });
  window.addEventListener("pointerup", (ev) => {
    if (!activo) return;
    activo = false;
    if (!movido) return;
    fin = performance.now();
    el.classList.remove("arrastrando");
    alSoltar?.(ev.clientX - x0);
  });
  el.addEventListener("click", (ev) => { if (performance.now() - fin < 300) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  el.addEventListener("dragstart", (ev) => ev.preventDefault());
}
document.querySelectorAll(".chips").forEach((fila) => arrastreConMouse(fila));
if (carrilBanners()) {
  arrastreConMouse(carrilBanners(), (dx) => {
    if (dx < -40) irABanner(bannerVecino(1));
    else if (dx > 40) irABanner(bannerVecino(-1));
    else moverBanners(banners.indice, true);
  });
}
/** Los banners que no se ven se bajan cuando la página terminó de cargar, o antes si la persona llega al banner. */
function activarBanner(pic) {
  pic?.querySelectorAll("[data-srcset], [data-src]").forEach((el) => {
    if (el.dataset.srcset) { el.srcset = el.dataset.srcset; el.removeAttribute("data-srcset"); }
    if (el.dataset.src) { el.src = el.dataset.src; el.removeAttribute("data-src"); }
  });
  const img = pic?.querySelector("img");
  if (img) img.loading = "eager";   // con "lazy", Chromium no baja el banner que está a dos o más de distancia
}
function cargarBanners() {
  document.querySelectorAll(".banner-cabecera").forEach(activarBanner);
}
if (carrilBanners()) {
  const c = carrilBanners();
  c.addEventListener("scroll", () => {
    banners.ultimo = performance.now();
    cancelAnimationFrame(banners.cuadro);
    // Mientras se desliza, los puntos siguen al banner que se ve (si lo mueve la página, ya muestran su destino)
    banners.cuadro = requestAnimationFrame(() => { if (!banners.programado) pintarPuntos(indiceVisibleBanners(c)); });
    clearTimeout(banners.fin);
    banners.fin = setTimeout(() => alQuietarse(c), 160);
  }, { passive: true });
  // Si la persona lo toma con el mouse o el trackpad mientras la página lo movía, manda ella
  c.addEventListener("wheel", () => { banners.programado = false; }, { passive: true });
  c.addEventListener("pointerdown", () => { banners.programado = false; }, { passive: true });
  // Un cambio de ancho (ventana, giro, barra de desplazamiento) deja el banner a medio camino: se vuelve a poner en su lugar
  if ("ResizeObserver" in window) new ResizeObserver(() => moverBanners(banners.indice)).observe(c);
  else window.addEventListener("resize", () => moverBanners(banners.indice));
  window.addEventListener("load", () => setTimeout(cargarBanners, 800), { once: true });
  $("#banners").addEventListener("pointerover", cargarBanners, { once: true, passive: true });
  $("#banners").addEventListener("focusin", cargarBanners, { once: true });
  // Con el foco en un punto, ← y → pasan al banner de al lado
  $(".banners-puntos").addEventListener("keydown", (ev) => {
    if ((ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    const puntos = [...document.querySelectorAll(".banners-puntos .punto")];
    const base = Math.max(0, puntos.indexOf(document.activeElement));   // desde el punto enfocado
    const n = BANNERS.length, k = ((base + (ev.key === "ArrowRight" ? 1 : -1)) % n + n) % n;
    if (k !== banners.indice || bannerActual() === null) irABanner(k);
    document.querySelectorAll(".banners-puntos .punto")[k]?.focus();
  });
}

// ---------- visor de fotos (se desliza con el dedo, con las flechas o con el teclado) ----------
// destino: la foto a la que va un desplazamiento suave (las flechas suman desde ahí, no desde la posición a medio camino)
const visor = { ref: null, abridor: null, indice: 0, cuadro: 0, destino: null, fin: 0 };
const QUE_ES = { afiche: "Afiche del evento", evento: "Foto del evento", referencial: "Imagen referencial: aún no tenemos una foto de este lugar" };

function figuraVisor(f, titulo) {
  const que = f.tipo === "lugar" ? `El lugar: ${f.lugar}` : QUE_ES[f.tipo] || "";
  const credito = !f.credito ? "" : urlSegura(f.pagina)
    ? `<a href="${esc(f.pagina)}" target="_blank" rel="noopener">${esc(f.credito)} ↗</a>` : esc(f.credito);
  const texto = [que && `<b>${esc(que)}</b>`, f.tipo === "afiche" ? "" : esc(f.descripcion || ""), credito].filter(Boolean).join(" · ");
  return `<figure class="visor-foto"><div class="visor-marco">` +
    `<img src="${esc(f.url)}" alt="${esc(f.descripcion || que || titulo)}" decoding="async" referrerpolicy="no-referrer" data-url="${esc(f.url)}" onerror="fotoRota(this)">` +
    `</div>${texto ? `<figcaption>${texto}</figcaption>` : ""}</figure>`;
}
function figurasVisor() { return [...$("#visor-carril").children]; }

/** url: la foto que se tocó. Se busca por dirección y no por posición, porque la lista de la tarjeta puede
 *  ir un paso atrás de la del visor (una foto rota que se quitará cuando se suelte el dedo). */
function abrirVisor(ref, i, abridor, url) {
  const d = datosFotos(ref);
  if (!d || !d.fotos.length || !$("#visor")) return;
  visor.ref = ref;
  visor.abridor = abridor;
  $("#visor-titulo").textContent = d.titulo;
  $("#visor-carril").innerHTML = d.fotos.map((f) => figuraVisor(f, d.titulo)).join("");
  const dlg = $("#visor");
  if (!dlg.open) dlg.showModal();
  const k = url ? d.fotos.findIndex((f) => f.url === url) : -1;
  irAFoto(k >= 0 ? k : i, false);
}
function irAFoto(i, suave = true) {
  const carril = $("#visor-carril");
  const n = figurasVisor().length;
  if (!n) { $("#visor").close(); return; }
  visor.indice = Math.min(Math.max(0, i), n - 1);
  const izquierda = visor.indice * carril.clientWidth;
  const animar = suave && !MOVIMIENTO_REDUCIDO.matches && Math.abs(carril.scrollLeft - izquierda) > 1;
  visor.destino = animar ? visor.indice : null;
  // El temporizador del desplazamiento anterior no debe borrar este destino (se perdería una flecha rápida)
  clearTimeout(visor.fin);
  if (animar) visor.fin = setTimeout(() => { visor.destino = null; sincronizarVisor(); }, 900);   // por si no llega ningún "scroll"
  carril.scrollTo({ left: izquierda, behavior: animar ? "smooth" : "auto" });
  pintarContador();
}
function pintarContador() {
  const n = figurasVisor().length;
  const ant = $("#visor-ant"), sig = $("#visor-sig");
  const foco = document.activeElement;
  $("#visor-contador").textContent = n > 1 ? `${visor.indice + 1} de ${n}` : "";
  ant.hidden = sig.hidden = n < 2;
  ant.disabled = visor.indice <= 0;
  sig.disabled = visor.indice >= n - 1;
  // Una flecha que se deshabilita pierde el foco y el navegador lo manda fuera del visor: se pasa a la otra
  if ((foco === ant || foco === sig) && (foco.disabled || foco.hidden)) {
    const otra = foco === ant ? sig : ant;
    (otra.disabled || otra.hidden ? $("#visor-carril") : otra).focus({ preventScroll: true });
  }
}
function quitarDelVisor(figura) {
  const k = figurasVisor().indexOf(figura);
  if (k < 0) return;
  figura.remove();
  irAFoto(k < visor.indice ? visor.indice - 1 : visor.indice, false);   // si se fue una anterior, la actual se corrió
}
/** La foto que se ve según la posición del carril (cuando no va camino a un destino). */
function sincronizarVisor() {
  const c = $("#visor-carril");
  if (!c.clientWidth || visor.destino !== null) return;
  const i = Math.min(Math.round(c.scrollLeft / c.clientWidth), figurasVisor().length - 1);
  if (i >= 0 && i !== visor.indice) { visor.indice = i; pintarContador(); }
}
if ($("#visor")) {   // (una versión vieja de index.html en caché no tiene visor: el resto de la página sigue funcionando)
  $("#visor-carril").addEventListener("scroll", () => {
    visor.ultimo = performance.now();
    cancelAnimationFrame(visor.cuadro);
    visor.cuadro = requestAnimationFrame(sincronizarVisor);
    clearTimeout(visor.fin);
    // terminó el desplazamiento (sirve también en los navegadores sin el evento "scrollend"): si quedó entre
    // dos fotos, se acomoda en la más cercana, y se rehacen las galerías que esperaban que se soltara el dedo
    visor.fin = setTimeout(() => { visor.destino = null; alQuietarse($("#visor-carril")); sincronizarVisor(); }, 180);
  });
  $("#visor-ant").addEventListener("click", () => irAFoto(visor.indice - 1));
  $("#visor-sig").addEventListener("click", () => irAFoto(visor.indice + 1));
  $("#visor-cerrar").addEventListener("click", () => $("#visor").close());
  $("#visor").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });   // tocar fuera de la foto
  // En el documento y no en el diálogo: así las flechas funcionan aunque el foco haya quedado en otra parte
  document.addEventListener("keydown", (ev) => {
    if (!$("#visor").open || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === "ArrowRight") { ev.preventDefault(); irAFoto(visor.indice + 1); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); irAFoto(visor.indice - 1); }
  });
  $("#visor").addEventListener("close", () => {
    const vista = figurasVisor()[visor.indice]?.querySelector("img")?.dataset.url;   // la foto que se miraba
    $("#visor-carril").innerHTML = "";
    visor.destino = null;
    clearTimeout(visor.fin);
    // Las galerías con una foto rota que esperaban que se soltara el dedo se rehacen antes de volver a la tarjeta
    // (rehacerGaleria actualiza visor.abridor)
    if (!dedoAbajo()) rehacerPendientes();
    const a = visor.abridor;
    visor.abridor = null;
    if (!a || !document.contains(a)) return;
    // La tarjeta queda en la foto que se estaba mirando en grande (se busca por dirección: si una foto se rompió
    // con el visor abierto, la tarjeta pudo cambiar su lista), y el foco vuelve a ella
    const g = a.closest(".galeria");
    if (!g) { a.focus({ preventScroll: true }); return; }
    const k = [...g.querySelectorAll(".carrusel .imagen")].findIndex((im) => im.dataset.url === vista);
    irACarrusel(g, k >= 0 ? k : visor.indice, { enfocar: true });
  });
  window.addEventListener("resize", () => { if ($("#visor").open) irAFoto(visor.indice, false); });
}

function cuandoBusqueda() {
  if (!ULTIMA.fecha) return null;
  const f = new Date(ULTIMA.fecha);
  const hora = `${String(f.getHours()).padStart(2, "0")}:${String(f.getMinutes()).padStart(2, "0")}`;
  const d = new Date(f.getFullYear(), f.getMonth(), f.getDate());
  const n = dias(d, hoy());
  if (n === 0) return `hoy a las ${hora}`;
  if (n === 1) return `ayer a las ${hora}`;
  return `el ${DIAS_LARGOS[f.getDay()]} ${f.getDate()} de ${MESES[f.getMonth()]} a las ${hora}`;
}

function pintarNuevos(lista) {
  const n = EVENTOS.filter((e) => NUEVOS.has(e.id) && vigente(e)).length;
  $("#cuenta-nuevos").textContent = n ? String(n) : "";
  $("#btn-nuevos").setAttribute("aria-pressed", String(estado.soloNuevos));
  const banner = $("#banner-nuevos");
  banner.hidden = !estado.soloNuevos;
  if (!estado.soloNuevos) return;
  const cuando = cuandoBusqueda();
  if (!cuando) {
    $("#banner-texto").innerHTML = "<b>No hay eventos nuevos.</b><span class=\"fino\">Todavía no se ha hecho ninguna búsqueda.</span>";
  } else if (lista.length) {
    // nuevos_desde: el robot busca cada hora y "Nuevos" junta lo de las últimas 24 horas
    const enQue = ULTIMA.nuevos_desde ? `en las últimas ${ULTIMA.horas_nuevos || 24} horas` : `en la búsqueda de ${esc(cuando)}`;
    $("#banner-texto").innerHTML = `${ico("i-fuego")}<b>${lista.length} evento${lista.length === 1 ? "" : "s"} nuevo${lista.length === 1 ? "" : "s"}</b> ${enQue}.` +
      `<span class="fino">Ya quedaron en la agenda; aquí están solo ellos, ordenados por fecha.</span>`;
  } else {
    const leidas = ULTIMA.paginas_revisadas ? ` revisó ${ULTIMA.paginas_revisadas} páginas y` : "";
    $("#banner-texto").innerHTML = `<b>No hay eventos nuevos.</b>` +
      `<span class="fino">La última búsqueda (${esc(cuando)})${leidas} no encontró nada distinto a lo que ya tenías. La página vuelve a buscar cada hora.</span>`;
  }
}

/** Exposiciones y temporadas largas que ya están abiertas: en la agenda van juntas, por fecha de cierre. */
function temporadaLarga(e) {
  if (!e.fecha_fin) return false;
  const i = fecha(e.fecha_inicio);
  return i < hoy() && dias(i, fecha(e.fecha_fin)) >= 7;
}

function pintarPortada(lista) {
  const cont = $("#portada");
  if (estado.soloNuevos || estado.texto || lista.length < 3) { cont.innerHTML = ""; return; }
  // La portada es para lo que viene: las exposiciones que ya están abiertas tienen su propio grupo
  const proximos = lista.filter((e) => !temporadaLarga(e));
  const base = proximos.length >= 3 ? proximos : [...proximos, ...lista.filter(temporadaLarga)];   // lo que viene va primero
  const conFoto = base.filter((e) => urlSegura(e.imagen) && !FOTOS_ROTAS.has(e.imagen));
  const elegidos = (conFoto.length >= 3 ? conFoto : base).slice(0, 3);
  const enlace = (e) => urlSegura(e.url) || "#";
  // Tarjetas como en la maqueta del usuario: foto, cuándo (HOY, MAÑANA…), título, lugar, fecha y la estrella.
  // El detalle completo (descripción, calendario, cómo llegar, compartir) está en la misma nota más abajo.
  cont.innerHTML = elegidos.map((e, k) => {
    const lugar = lugarTexto(e);
    const fechaHora = rangoTexto(e) + (e.hora ? ` · ${e.hora} h` : "");
    return `
    <article class="${k === 0 ? "principal" : "secundaria"}">
      ${htmlGaleria(`e:${e.id}`, "foto")}
      <div class="tarjeta-texto">
        <p class="cuando-grande">${esc(cuandoRelativo(e))}</p>
        <h2><a href="${esc(enlace(e))}" target="_blank" rel="noopener">${esc(e.titulo)}</a></h2>
        <p class="datos datos-columna">${lugar ? `<span class="dato">${ico("i-pin", "ico-pin")}${esc(lugar)}</span>` : ""}` +
          `<span class="dato">${ico("i-calendario")}${esc(fechaHora)}</span></p>
        ${botonFavorito("e", e.id, favEventos.has(e.id), true)}
      </div>
    </article>`;
  }).join("");
}

/** prefijo del id: "e" en la agenda (los enlaces compartidos llevan a #e-<id>) y "f" en Mis favoritos. */
function htmlNota(e, prefijo = "e") {
  const h = hoy();
  const i = fecha(e.fecha_inicio);
  const enCurso = i < h;
  const foto = htmlGaleria(`e:${e.id}`, "miniatura");
  return `<article class="nota${foto ? "" : " sin-foto"}" id="${prefijo}-${esc(e.id)}">
    <div class="dia-bloque${enCurso ? " en-curso" : ""}" aria-hidden="true">
      <span class="sem">${enCurso ? "hasta" : DIAS[i.getDay()]}</span>
      <span class="num">${enCurso ? fecha(e.fecha_fin).getDate() : i.getDate()}</span>
      <span class="mesc">${MESES[(enCurso ? fecha(e.fecha_fin) : i).getMonth()].slice(0, 3)}</span>
    </div>
    <div class="cuerpo">
      ${antetitulo(e)}
      <h3><a href="${esc(urlSegura(e.url) || "#")}" target="_blank" rel="noopener">${esc(e.titulo)}</a></h3>
      ${e.fecha_fin ? `<p class="datos"><span class="dato">${ico("i-calendario")}${esc(rangoTexto(e))}</span></p>` : ""}
      ${datosLinea(e)}
      ${e.descripcion ? `<p class="desc">${esc(e.descripcion)}</p>` : ""}
      ${fuenteLinea(e)}
      ${acciones(e)}
    </div>
    ${foto}
  </article>`;
}

function pintarAgenda(lista) {
  const h = hoy();
  const largas = lista.filter(temporadaLarga).sort((a, b) => a.fecha_fin.localeCompare(b.fecha_fin));
  const grupos = new Map([["Ahora mismo", []]]);
  for (const e of lista) {
    if (temporadaLarga(e)) continue;
    const i = fecha(e.fecha_inicio);
    const clave = i < h ? "Ahora mismo" : `${MESES[i.getMonth()]} ${i.getFullYear()}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(e);
  }
  let html = "";
  for (const [mes, evs] of grupos) {
    if (evs.length) html += `<h2 class="mes">${esc(mes)}</h2>` + evs.map((e) => htmlNota(e)).join("");
    if (mes === "Ahora mismo" && largas.length) html += htmlTemporadas(largas);   // después de lo de hoy, antes de los meses
  }
  $("#agenda").innerHTML = html;
}

/** Las exposiciones abiertas por semanas o meses no tapan la agenda: se ven las 3 que cierran antes
 *  y un botón muestra el resto (al filtrar por Museos, arte y cultura, o al buscar, se ven todas). */
function htmlTemporadas(largas) {
  const todas = estado.verTemporadas || largas.length <= 4 || !!estado.texto || estado.soloNuevos
    || !!catsFiltro()?.every((c) => c === "museos");   // también con el banner Museos
  const visibles = todas ? largas : largas.slice(0, 3);
  return `<h2 class="mes" id="t-temporadas" tabindex="-1">Exposiciones y temporadas abiertas</h2>` +
    visibles.map((e) => htmlNota(e)).join("") +
    (todas ? "" : `<p class="ver-mas"><button type="button" class="boton secundario" data-accion="temporadas">` +
      `Ver las ${largas.length} exposiciones y temporadas abiertas</button></p>`);
}

function pintar() {
  const lista = filtrar();
  pintarNuevos(lista);
  pintarPortada(lista);
  pintarAgenda(lista);
  const vacio = $("#vacio");
  vacio.hidden = lista.length > 0 || estado.soloNuevos;   // en "Nuevos" el aviso lo da el recuadro
  VACIO_NORMAL ??= vacio.innerHTML;
  const cats = catsFiltro();
  if (AGENDA_FALLO) {
    vacio.innerHTML = `<p class="vacio-titulo">No se pudo cargar la agenda.</p><p>Revisa tu conexión y recarga la página.</p>`;
  } else if (cats && !estado.texto && !estado.soloRM && EVENTOS_CARGADOS && !EVENTOS.some((e) => vigente(e) && cats.includes(e.categoria))) {
    // Un tema sin ningún evento todavía (por ejemplo, uno recién agregado): no es "culpa" de los filtros
    vacio.innerHTML = `<p class="vacio-titulo">Todavía no hay eventos de ${esc(CATS[estado.cat]?.nombre || "este tema")}.</p>` +
      `<p>El robot los busca varias veces al día: apenas encuentre algo, aparece aquí.</p>`;
  } else {
    vacio.innerHTML = VACIO_NORMAL;
  }
}
let VACIO_NORMAL = null;   // el aviso de "Nada por aquí con esos filtros" de index.html

function alternarNuevos(activar) {
  estado.soloNuevos = activar;
  pintar();
  if (activar) $("#banner-nuevos").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("#btn-nuevos").addEventListener("click", () => alternarNuevos(!estado.soloNuevos));
$("#btn-salir-nuevos").addEventListener("click", () => alternarNuevos(false));

// ---------- restaurantes temáticos ----------
/** prefijo del id: "r" en Restaurantes (los enlaces compartidos llevan a #r-<id>) y "fr" en Mis favoritos. */
function htmlLocal(r, prefijo = "r") {
  const t = TEMAS[r.tema] || { nombre: r.tema, emoji: "•" };
  const datos = [];
  const dir = unirPartes([r.direccion, r.comuna]).join(", ");
  if (dir) datos.push(`<span class="dato">${ico("i-pin", "ico-pin")}${esc(dir)}</span>`);
  if (r.horario) datos.push(`<span class="dato">${ico("i-reloj")}${esc(r.horario)}</span>`);
  if (r.precio) datos.push(`<span class="dato">${ico("i-ticket")}${esc(r.precio)}</span>`);
  const enlaces = [];
  if (urlSegura(r.instagram)) enlaces.push(`<a class="accion" href="${esc(r.instagram)}" target="_blank" rel="noopener">Instagram ↗</a>`);
  if (urlSegura(r.web)) enlaces.push(`<a class="accion" href="${esc(r.web)}" target="_blank" rel="noopener">Sitio web ↗</a>`);
  const galeria = htmlGaleria(`r:${r.id}`, "foto-local");
  return `<article class="local${galeria ? "" : " sin-foto"}" id="${prefijo}-${esc(r.id)}">
    ${galeria}
    <p class="antetitulo"><span class="emoji" aria-hidden="true">${esc(t.emoji)}</span>${esc(t.nombre)}</p>
    <h3>${esc(r.nombre)}</h3>
    ${datos.length ? `<p class="datos datos-columna">${datos.join("")}</p>` : ""}
    ${r.descripcion ? `<p class="desc">${esc(r.descripcion)}</p>` : ""}
    ${r.dudas ? `<p class="aviso-local">${ico("i-aviso")}${esc(r.dudas)}</p>` : ""}
    <div class="acciones">
      ${botonFavorito("r", r.id, favRest.has(r.id))}
      <a class="accion" href="${esc(urlComoLlegar(consultaLocal(r)))}" target="_blank" rel="noopener">${ico("i-ruta")}Cómo llegar</a>
      ${enlaces.join("")}
    </div>
  </article>`;
}

function pintarRestaurantes() {
  const cuenta = (id) => RESTAURANTES.filter((r) => r.tema === id).length;
  const chips = [{ id: "todos", nombre: "Todos", emoji: "🍽", n: RESTAURANTES.length },
    ...ORDEN_TEMAS.map((t) => ({ ...t, n: cuenta(t.id) })).filter((t) => t.n)];
  $("#chips-temas").innerHTML = chips.map((c) =>
    `<button type="button" class="chip" data-tema="${esc(c.id)}" aria-pressed="${estado.tema === c.id}">` +
    `<span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.nombre)} <span class="cuenta">${c.n}</span></button>`).join("");
  const lista = RESTAURANTES.filter((r) => estado.tema === "todos" || r.tema === estado.tema);
  const vacioTexto = RESTAURANTES.length ? "Nada en este tema."
    : { cargando: "Cargando restaurantes…", fallo: "No se pudo cargar la lista de restaurantes. Prueba recargando la página." }[ESTADO_RESTAURANTES]
      || "Todavía no hay restaurantes en la lista.";
  $("#lista-restaurantes").innerHTML = lista.length
    ? lista.map((r) => htmlLocal(r)).join("")
    : `<div class="vacio"><p class="vacio-titulo">${esc(vacioTexto)}</p></div>`;
  $("#nota-restaurantes").textContent = REVISADO
    ? `Lista revisada el ${fecha(REVISADO).toLocaleDateString("es-CL", { dateStyle: "long" })}. Los horarios y precios cambian: confírmalos en sus redes antes de ir.`
    : "";
}

// ---------- Mapa del Aventurero ----------
// Tiendas (data/tiendas.json) y restaurantes temáticos (los de data/restaurantes.json que tienen lat y lng) en un mapa
// de Leaflet. El mapa base son las teselas de OpenStreetMap (gratis con su crédito, para un sitio de poco tráfico;
// las de CARTO ya piden clave). Un filtro sepia las deja color pergamino.
// Los íconos de las categorías están en el sprite de index.html (dibujados en código, a la espera de los del usuario).
const LEAFLET = "vendor/leaflet-1.9.4/";
const TESELAS = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const CREDITO_MAPA = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>';
const CENTRO_SANTIAGO = [-33.44, -70.62];
const CELULAR = window.matchMedia("(max-width: 979px)");
// data/tiendas.json puede traer sus propias categorías (nombre, ícono del sprite y color)
let CATS_MAPA = [
  { id: "tcg", nombre: "Cartas TCG", icono: "i-cartas", color: "#7446c9" },
  { id: "mesa", nombre: "Juegos de mesa", icono: "i-dado6", color: "#8f6406" },
  { id: "rol", nombre: "Rol (RPG)", icono: "i-dado", color: "#c62a2a" },
  { id: "miniaturas", nombre: "Miniaturas", icono: "i-meeple", color: "#18786f" },
  { id: "anime", nombre: "Anime y manga", icono: "i-gato", color: "#b93279" },
  { id: "videojuegos", nombre: "Videojuegos", icono: "i-mando", color: "#2f63c9" },
  { id: "restaurantes", nombre: "Restaurantes temáticos", icono: "i-cubiertos", color: "#a84f1c" },
];
const DATOS_MAPA = { listos: false, revisado: null };
const MAPA = {
  preparado: false, lugares: [], cats: new Set(), texto: "", comuna: "", torneos: false, espacio: false, online: false,
  orden: "nombre", vista: "mapa", sel: null, yo: null,
  mapa: null, capa: null, grupos: [], grupoDe: new Map(), racimos: [], globo: null, capaYo: null,
  desdeHash: true,      // al abrir, si la dirección es #m-…, se elige ese lugar
  encuadrar: "todo",    // "todo": el mapa muestra los lugares filtrados; "sel": el elegido; null: no se mueve
};

function prepararTiendas(datos) {
  if (Array.isArray(datos.categorias) && datos.categorias.length) CATS_MAPA = datos.categorias;
  TIENDAS = (datos.tiendas || []).filter((x) => x && x.id && x.nombre);
  DATOS_MAPA.revisado = datos.revisado || null;
}
function catMapa(id) { return CATS_MAPA.find((c) => c.id === id) || { id, nombre: id, icono: "i-pin-rm", color: "#7a5230" }; }
function claveLugar(l) { return `${l.tipo}-${l.id}`; }
function lugarPorClave(k) { return MAPA.lugares.find((l) => claveLugar(l) === k) || null; }
function conCoordenadas(x) { return Number.isFinite(x.lat) && Number.isFinite(x.lng); }

function armarLugares() {
  const conocida = (c) => CATS_MAPA.some((k) => k.id === c);
  const tiendas = TIENDAS.filter(conCoordenadas).map((x) => ({ ...x, tipo: "t", ref: `t:${x.id}`, cats: (x.categorias || []).filter(conocida) }));
  // Un restaurante donde se juega (o de anime) aparece también en esas categorías (categorias_mapa), y su marcador
  // es el de la primera de ellas: un café de juegos de mesa se ve con su dado.
  const rest = RESTAURANTES.filter(conCoordenadas).map((r) => ({
    id: r.id, tipo: "r", ref: `r:${r.id}`, cats: [...(r.categorias_mapa || []).filter(conocida), "restaurantes"],
    nombre: r.nombre, tema: r.tema, mapa: r.mapa, direccion: r.direccion, comuna: r.comuna, lat: r.lat, lng: r.lng,
    descripcion: r.descripcion, horario: r.horario, precio: r.precio, web: r.web, instagram: r.instagram, dudas: r.dudas,
    torneos: r.torneos, espacio_juego: r.espacio_juego, venta_online: r.venta_online }));
  MAPA.lugares = [...tiendas, ...rest].filter((l) => l.cats.length);
}

function distanciaKm(a, b) {
  const rad = (g) => g * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function textoDistancia(km) { return km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1).replace(".", ",")} km`; }

function lugaresFiltrados() {
  const q = sinTildes(MAPA.texto.trim());
  const lista = MAPA.lugares.filter((l) => {
    if (MAPA.cats.size && !l.cats.some((c) => MAPA.cats.has(c))) return false;
    if (MAPA.comuna && l.comuna !== MAPA.comuna) return false;
    if (MAPA.torneos && !l.torneos) return false;
    if (MAPA.espacio && l.espacio_juego !== true) return false;
    if (MAPA.online && l.venta_online !== true) return false;
    if (q) {
      const t = sinTildes([l.nombre, l.descripcion, l.comuna, l.direccion, l.torneos, TEMAS[l.tema]?.nombre,
        ...l.cats.map((c) => catMapa(c).nombre)].join(" "));
      if (!q.split(/\s+/).every((p) => t.includes(p))) return false;
    }
    return true;
  });
  const nombre = (a, b) => a.nombre.localeCompare(b.nombre, "es");
  if (MAPA.orden === "cerca" && MAPA.yo) lista.sort((a, b) => distanciaKm(MAPA.yo, [a.lat, a.lng]) - distanciaKm(MAPA.yo, [b.lat, b.lng]));
  else if (MAPA.orden === "comuna") lista.sort((a, b) => (a.comuna || "").localeCompare(b.comuna || "", "es") || nombre(a, b));
  else lista.sort(nombre);
  return lista;
}

/** Se llama al mostrar la sección (y al terminar de cargar los datos). */
function abrirMapa() {
  if (!DATOS_MAPA.listos || !$("#sec-mapa")) return;   // iniciar() la llama cuando llegan los datos
  if (!MAPA.preparado) {
    MAPA.preparado = true;
    armarLugares();
    prepararControlesMapa();
  }
  if (MAPA.desdeHash) {
    MAPA.desdeHash = false;
    const h = hashActual();
    const l = h.startsWith("m-") ? lugarPorClave(h.slice(2)) : null;
    if (l) {
      MAPA.sel = claveLugar(l);
      if (!lugaresFiltrados().includes(l)) limpiarFiltrosMapa(false);   // un enlace compartido siempre muestra su lugar
      MAPA.encuadrar = "sel";
      MAPA.llevarA = MAPA.sel;   // cuando el mapa esté listo, la página baja hasta él
    } else if (h === "mapa") {
      MAPA.sel = null;
    }
  }
  pintarMapa();
  if (MAPA.vista === "mapa") prepararLeaflet();
}

let promesaLeaflet = null;
function cargarLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!promesaLeaflet) {
    promesaLeaflet = new Promise((ok, mal) => {
      if (!document.querySelector(`link[href="${LEAFLET}leaflet.css"]`)) {   // al reintentar no se duplica
        const css = document.createElement("link");
        css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css";
        document.head.appendChild(css);
      }
      const s = document.createElement("script");
      s.src = LEAFLET + "leaflet.js";
      s.onload = () => ok(window.L);
      s.onerror = () => { promesaLeaflet = null; s.remove(); mal(new Error("No se pudo cargar Leaflet")); };
      document.head.appendChild(s);
    });
  }
  return promesaLeaflet;
}

async function prepararLeaflet() {
  if (!MAPA.mapa) {
    try {
      await cargarLeaflet();
    } catch (e) {
      console.error(e);
      avisar("No se pudo cargar el mapa: te muestro la lista");
      MAPA.vista = "lista";
      pintarMapa();
      return;
    }
  }
  if (estado.seccion !== "mapa" || MAPA.vista !== "mapa") return;   // se escondió mientras bajaba Leaflet
  if (!MAPA.mapa) crearMapa();
  pintarMarcadores();   // mide el recuadro de nuevo (invalidateSize) y encuadra lo pendiente
  // Enlace directo a un lugar (#m-…): la página baja hasta el mapa (en el celular, con el lugar sobre la ficha)
  const destino = MAPA.llevarA && lugarPorClave(MAPA.llevarA);
  MAPA.llevarA = null;
  if (destino) {
    if (CELULAR.matches) acomodarParaFicha(destino);
    else $(".mapa-cuerpo").scrollIntoView({ block: "start" });
  }
}

function crearMapa() {
  const L = window.L;
  const m = L.map("mapa-lienzo", { center: CENTRO_SANTIAGO, zoom: 12, minZoom: 9, maxZoom: 19, zoomSnap: 0.5, scrollWheelZoom: false, zoomControl: false });
  L.control.zoom({ zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(m);   // title y aria-label en español
  L.tileLayer(TESELAS, { maxZoom: 19, attribution: CREDITO_MAPA }).addTo(m);
  m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  // La rueda del mouse acerca el mapa solo después de hacer clic en él: si no, al bajar por la página se quedaría pegada
  m.on("click focus", () => m.scrollWheelZoom.enable());
  m.on("mouseout blur", () => m.scrollWheelZoom.disable());
  const Ubicarme = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const b = L.DomUtil.create("button", "mapa-ubicarme leaflet-bar");
      b.type = "button"; b.title = "Mostrar dónde estoy"; b.setAttribute("aria-label", "Mostrar dónde estoy");
      b.innerHTML = ico("i-ubicacion");
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => ubicarme(true));
      return b;
    },
  });
  new Ubicarme().addTo(m);
  MAPA.mapa = m;
  MAPA.capa = L.layerGroup().addTo(m);
  m.on("zoomend", agrupar);   // al acercar o alejar, los racimos se arman de nuevo
  crearMarcadores();
  if (MAPA.yo) dibujarYo();
}

function htmlTooltip(l) {
  const cats = l.cats.map((c) => { const k = catMapa(c); return `<span class="pin-mini" style="--c:${esc(k.color)}">${ico(k.icono)}</span>`; }).join("");
  return `<span class="tt-nombre">${ico(l.tipo === "r" ? "i-cubiertos" : "i-tienda")}<b>${esc(l.nombre)}</b></span><span class="tt-cats">${cats}</span>`;
}

// ---------- marcadores ----------
/** Enter o Espacio sobre un marcador (Leaflet les da tabindex y role=button, pero no los convierte en clic). */
function esActivar(e) {
  if (e.key !== "Enter" && e.key !== " ") return false;
  e.preventDefault();   // Espacio no baja la página
  return true;
}
/** El nombre del marcador (title, que leen los lectores de pantalla): Leaflet no lo cambia al cambiar el ícono. */
function rotular(g) {
  const el = g.mk.getElement();
  if (el) { el.title = g.mk.options.title; el.setAttribute("aria-label", g.mk.options.title); }
}
// Los lugares de una misma dirección (una galería, un mall, el persa) van en UN marcador con su número; al tocarlo
// se abre una lista para elegir. Así ninguno queda tapado por otro (con marcadores separados, los de abajo no se
// podían tocar). Si los filtros dejan uno solo, el marcador es el de ese lugar.
function nombreGrupo(g) {
  if (g.principal) return g.principal.nombre;
  const primera = String(g.visibles[0]?.direccion || "").replace(/\s*\([^)]*\)/g, "").split(",")[0].trim();
  return primera || g.visibles[0]?.nombre || "";
}
function tituloGrupo(g) {
  return g.visibles.length === 1 ? g.visibles[0].nombre : `${nombreGrupo(g)}: ${g.visibles.length} lugares`;
}
function tooltipGrupo(g) {
  const sel = g.visibles.find((l) => claveLugar(l) === MAPA.sel);
  if (sel || g.visibles.length === 1) return htmlTooltip(sel || g.visibles[0]);
  return `<span class="tt-nombre">${ico("i-tienda")}<b>${esc(nombreGrupo(g))}</b></span>` +
    `<span class="tt-sub">${g.visibles.length} lugares aquí: toca para elegir</span>`;
}
function iconoGrupo(g) {
  const solo = g.visibles.length === 1 ? g.visibles[0] : null;
  const c = solo ? catMapa(solo.cats[0]) : { color: "#6b4423", icono: "i-tienda" };
  const cuenta = solo ? "" : `<span class="pin-cuenta">${g.visibles.length}</span>`;
  return window.L.divIcon({
    className: `marcador${solo ? "" : " grupo"}`,
    html: `<span class="pin-mapa" style="--c:${esc(c.color)}">${ico(c.icono)}${cuenta}</span>`,
    iconSize: [40, 46], iconAnchor: [20, 43], tooltipAnchor: [0, -46],
  });
}

const MISMO_PUNTO_KM = 0.03;   // a menos de 30 m es la misma dirección (dos locales de un mall, una galería)
function crearMarcadores() {
  const L = window.L;
  const puntos = [];   // [{ centro: [lat, lng], lugares: [...] }]
  // Primero las galerías, para que sus locales se junten con ellas
  for (const l of [...MAPA.lugares].sort((a, b) => (b.es_galeria ? 1 : 0) - (a.es_galeria ? 1 : 0))) {
    const p = puntos.find((x) => distanciaKm(x.centro, [l.lat, l.lng]) < MISMO_PUNTO_KM);
    if (p) p.lugares.push(l); else puntos.push({ centro: [l.lat, l.lng], lugares: [l] });
  }
  MAPA.grupos = puntos.map(({ lugares }) => {
    const g = { lugares, visibles: lugares, principal: lugares.find((l) => l.es_galeria) || null, firma: null, activo: false };
    const centro = g.principal || lugares[0];
    g.mk = L.marker([centro.lat, centro.lng], { icon: iconoGrupo(g), title: tituloGrupo(g), keyboard: true, riseOnHover: true });
    g.mk.bindTooltip(tooltipGrupo(g), { direction: "top", className: "tooltip-mapa", opacity: 1 });
    const activar = (tecla) => {
      if (g.visibles.length === 1) elegirLugar(claveLugar(g.visibles[0]), { desdeMapa: true, enfocar: tecla });
      else abrirGrupo(g, tecla);
    };
    g.mk.on("click", () => activar(false));
    g.mk.on("keydown", (ev) => { if (esActivar(ev.originalEvent)) activar(true); });
    for (const l of lugares) MAPA.grupoDe.set(claveLugar(l), g);
    return g;
  });
}

/** La lista de un marcador con varios lugares (un globo con un botón por lugar). */
function abrirGrupo(g, enfocar) {
  g.mk.closeTooltip();
  abrirLista(g.visibles, g.mk.getLatLng(), nombreGrupo(g), enfocar, 38);
}
function abrirLista(lugares, donde, titulo, enfocar, alto) {
  const filas = lugares.map((l) => {
    const c = catMapa(l.cats[0]);
    return `<li><button type="button" class="popup-lugar" data-lugar="${esc(claveLugar(l))}">` +
      `<span class="pin-mini" style="--c:${esc(c.color)}">${ico(c.icono)}</span>` +
      `<span><b>${esc(l.nombre)}</b><small>${esc(l.cats.map((x) => catMapa(x).nombre).join(" · "))}</small></span></button></li>`;
  }).join("");
  MAPA.globo = window.L.popup({ className: "popup-mapa", maxWidth: 320, minWidth: 230, offset: [0, -alto], autoPanPadding: [30, 30] })
    .setLatLng(donde)
    .setContent(`<p class="popup-titulo">${ico("i-tienda")}${esc(titulo)} · ${lugares.length} lugares</p><ul class="popup-lista">${filas}</ul>`)
    .openOn(MAPA.mapa);
  MAPA.globo.getElement()?.querySelector(".leaflet-popup-close-button")?.setAttribute("aria-label", "Cerrar la lista");
  if (enfocar) MAPA.globo.getElement()?.querySelector(".popup-lugar")?.focus();
}

function pintarMarcadores() {
  if (!MAPA.mapa) return;
  const lista = lugaresFiltrados();
  const visibles = new Set(lista.map(claveLugar));
  MAPA.mapa.closePopup();
  for (const g of MAPA.grupos) {
    g.visibles = g.lugares.filter((l) => visibles.has(claveLugar(l)));
    if (!g.visibles.length) {
      if (MAPA.capa.hasLayer(g.mk)) MAPA.capa.removeLayer(g.mk);
      continue;
    }
    const firma = g.visibles.map(claveLugar).join("|");
    if (firma !== g.firma) {   // cambió qué lugares de este punto se ven: número, ícono y globo nuevos
      g.firma = firma;
      g.mk.options.title = tituloGrupo(g);
      g.mk.setIcon(iconoGrupo(g));
      rotular(g);
      g.mk.setTooltipContent(tooltipGrupo(g));
      g.activo = null;
    }
  }
  const aLaVista = estado.seccion === "mapa" && MAPA.vista === "mapa" && !$("#mapa-lienzo").hidden;
  if (aLaVista) MAPA.mapa.invalidateSize();   // pudo cambiar de tamaño escondido (otra pestaña, la Lista, girar el teléfono)
  agrupar();
  marcarActivo();
  if (MAPA.encuadrar && aLaVista) encuadrarMapa(lista);   // escondido no tiene tamaño: se encuadra al volver
}

// ---------- racimos ----------
// Con el mapa alejado, los marcadores a menos de RADIO_RACIMO píxeles se juntan en un racimo con su número
// (en Los Leones o Barrio Italia hay varios por cuadra y se tapaban). Al tocarlo, el mapa se acerca hasta
// separarlos. Desde el zoom 17 ya no se juntan, y el lugar elegido nunca queda dentro de un racimo.
const RADIO_RACIMO = 38;
function mostrarGrupo(g, ver) {
  if (ver && !MAPA.capa.hasLayer(g.mk)) { MAPA.capa.addLayer(g.mk); rotular(g); }
  else if (!ver && MAPA.capa.hasLayer(g.mk)) MAPA.capa.removeLayer(g.mk);
}
function agrupar() {
  if (!MAPA.mapa) return;
  for (const r of MAPA.racimos) MAPA.capa.removeLayer(r);
  MAPA.racimos = [];
  const z = MAPA.mapa.getZoom();
  const vivos = MAPA.grupos.filter((g) => g.visibles.length).sort((a, b) => b.visibles.length - a.visibles.length);
  const elegido = MAPA.sel ? MAPA.grupoDe.get(MAPA.sel) : null;
  const punto = new Map(vivos.map((g) => [g, MAPA.mapa.latLngToLayerPoint(g.mk.getLatLng())]));
  const libres = new Set(vivos);
  for (const g of vivos) {
    if (!libres.has(g)) continue;
    libres.delete(g);
    const juntos = [g];
    if (z < 17 && g !== elegido) {
      for (const h of vivos) {
        if (libres.has(h) && h !== elegido && punto.get(h).distanceTo(punto.get(g)) < RADIO_RACIMO) {
          juntos.push(h);
          libres.delete(h);
        }
      }
    }
    if (juntos.length === 1) { mostrarGrupo(g, true); continue; }
    for (const h of juntos) mostrarGrupo(h, false);
    MAPA.racimos.push(crearRacimo(juntos));
  }
}
function crearRacimo(grupos) {
  const L = window.L;
  const lugares = grupos.flatMap((g) => g.visibles);
  const pts = grupos.map((g) => g.mk.getLatLng());
  const centro = L.latLng(pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lng, 0) / pts.length);
  const n = lugares.length;
  const mk = L.marker(centro, {
    icon: L.divIcon({ className: "marcador racimo", html: `<span class="pin-racimo">${n}</span>`, iconSize: [46, 46], iconAnchor: [23, 23], tooltipAnchor: [0, -24] }),
    title: `${n} lugares juntos: acerca el mapa para verlos`, keyboard: true, riseOnHover: true,
  });
  mk.bindTooltip(`<span class="tt-nombre">${ico("i-mapa")}<b>${n} lugares</b></span><span class="tt-sub">Toca para acercar el mapa</span>`,
    { direction: "top", className: "tooltip-mapa", opacity: 1 });
  const activar = (tecla) => {
    const caja = L.latLngBounds(pts);
    // si no se pueden separar más (misma cuadra y ya muy cerca), la lista de todos
    if (MAPA.mapa.getZoom() >= 17) { abrirLista(lugares, centro, "Aquí", tecla, 20); return; }
    // con el teclado, el foco queda en el mapa (el racimo desaparece al acercarse)
    if (tecla) MAPA.mapa.once("zoomend", () => MAPA.mapa.getContainer().focus({ preventScroll: true }));
    MAPA.mapa.fitBounds(caja.pad(0.4), { maxZoom: 17, animate: !MOVIMIENTO_REDUCIDO.matches });
  };
  mk.on("click", () => activar(false));
  mk.on("keydown", (ev) => { if (esActivar(ev.originalEvent)) activar(true); });
  MAPA.capa.addLayer(mk);
  return mk;
}

/** Lleva el mapa a lo que hay que mostrar. Los lugares lejos del centro (Cajón del Maipo) no achican el mapa
 *  de Santiago, salvo que sean los únicos que quedan con los filtros. */
function encuadrarMapa(lista) {
  const modo = MAPA.encuadrar;
  MAPA.encuadrar = null;
  const sel = MAPA.sel && lugarPorClave(MAPA.sel);
  if (modo === "sel" && sel) {
    MAPA.mapa.setView([sel.lat, sel.lng], 16);
    MAPA.grupoDe.get(MAPA.sel)?.mk.openTooltip();
    return;
  }
  if (!lista.length) return;
  const cerca = lista.filter((l) => distanciaKm(CENTRO_SANTIAGO, [l.lat, l.lng]) < 22);
  const puntos = (cerca.length ? cerca : lista).map((l) => [l.lat, l.lng]);
  MAPA.mapa.fitBounds(window.L.latLngBounds(puntos), { paddingTopLeft: [40, 96], paddingBottomRight: [40, 36], maxZoom: 16 });
}

function marcarActivo() {
  for (const g of MAPA.grupos || []) {
    const activo = g.visibles.some((l) => claveLugar(l) === MAPA.sel);
    g.mk.getElement()?.classList.toggle("activo", activo);
    g.mk.setZIndexOffset(activo ? 1000 : 0);
    if (g.activo !== activo) g.mk.setTooltipContent(tooltipGrupo(g));   // el globo dice cuál de sus lugares se eligió
    g.activo = activo;
  }
}

function elegirLugar(k, { desdeMapa = false, enfocar = false } = {}) {
  const l = lugarPorClave(k);
  if (!l) return;
  MAPA.sel = k;
  history.replaceState(null, "", `#m-${k}`);
  pintarFicha();
  agrupar();
  marcarActivo();
  document.querySelectorAll(".fila-lugar").forEach((b) => {
    if (b.dataset.lugar === k) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
  if (MAPA.mapa && MAPA.vista === "mapa") {
    MAPA.mapa.closePopup();
    if (CELULAR.matches) acomodarParaFicha(l);
    else if (desdeMapa) MAPA.mapa.panInside([l.lat, l.lng], { padding: [60, 60] });
    else MAPA.mapa.setView([l.lat, l.lng], Math.max(MAPA.mapa.getZoom(), 15));
    MAPA.grupoDe.get(k)?.mk.openTooltip();
  }
  if (enfocar) $("#ficha-titulo")?.focus({ preventScroll: CELULAR.matches });
}

/** En el celular la ficha sube desde abajo y tapa parte de la pantalla: la página sube hasta el mapa y el mapa
 *  se corre para que el lugar elegido quede a la vista, encima de la ficha. */
function acomodarParaFicha(l) {
  const lienzo = $("#mapa-lienzo");
  let caja = lienzo.getBoundingClientRect();
  if (caja.top < 0 || caja.top > window.innerHeight * 0.2) {
    window.scrollBy({ top: caja.top - 8, behavior: "auto" });
    caja = lienzo.getBoundingClientRect();
  }
  const libreAbajo = window.innerHeight - $("#mapa-ficha").offsetHeight - 16;
  const arriba = Math.max(caja.top, 0), abajo = Math.min(caja.bottom, libreAbajo);
  if (MAPA.mapa.getZoom() < 14) MAPA.mapa.setView([l.lat, l.lng], 15, { animate: false });
  const punto = MAPA.mapa.latLngToContainerPoint([l.lat, l.lng]);
  const meta = window.L.point(caja.width / 2, Math.max(70, (arriba + abajo) / 2 - caja.top + 20));
  MAPA.mapa.panBy(punto.subtract(meta), { animate: !MOVIMIENTO_REDUCIDO.matches });
}

function cerrarFicha({ teclado = false } = {}) {
  const k = MAPA.sel;
  MAPA.sel = null;
  history.replaceState(null, "", "#mapa");
  pintarFicha();
  marcarActivo();
  agrupar();
  const g = MAPA.grupoDe.get(k);
  if (teclado) {
    // el foco vuelve a donde se eligió el lugar: su fila de la lista, su marcador o, si quedó en un racimo, el mapa
    const fila = MAPA.vista === "lista" ? document.querySelector(`.fila-lugar[data-lugar="${CSS.escape(k || "")}"]`) : null;
    const destino = fila || g?.mk.getElement() || (MAPA.mapa && MAPA.vista === "mapa" ? MAPA.mapa.getContainer() : $("#t-mapa"));
    destino?.focus({ preventScroll: true });
  }
  g?.mk.closeTooltip();   // después del foco: Leaflet abre el globo cuando el marcador recibe el foco
}

function siNo(v) { return v === true ? "Sí" : v === false ? "No" : "Sin datos"; }
function etiquetasMapa(cats) {
  return cats.map((c) => { const k = catMapa(c); return `<span class="etiqueta-mapa" style="--c:${esc(k.color)}">${ico(k.icono)}${esc(k.nombre)}</span>`; }).join("");
}

function htmlFicha(l) {
  const c0 = catMapa(l.cats[0]);
  const galeria = htmlGaleria(l.ref, "foto-ficha");
  const foto = galeria || `<div class="ficha-sin-foto" style="--c:${esc(c0.color)}">${ico(c0.icono)}<span>Aún sin fotos de este lugar</span></div>`;
  const dir = unirPartes([l.direccion, l.comuna]).join(", ");
  const info = [];
  if (l.tipo === "t") {
    info.push(`<li>${ico("i-trofeo")}<span><b>Torneos:</b> ${esc(l.torneos || "Sin datos")}</span></li>`);
    info.push(`<li>${ico("i-mesa")}<span><b>Mesas de juego:</b> ${siNo(l.espacio_juego)}</span></li>`);
    info.push(`<li>${ico("i-carro")}<span><b>Venta online:</b> ${siNo(l.venta_online)}</span></li>`);
  } else {
    const t = TEMAS[l.tema];
    if (t) info.push(`<li><span class="emoji" aria-hidden="true">${esc(t.emoji)}</span><span><b>Tema:</b> ${esc(t.nombre)}</span></li>`);
    if (l.torneos) info.push(`<li>${ico("i-trofeo")}<span><b>Torneos:</b> ${esc(l.torneos)}</span></li>`);
    if (l.espacio_juego === true) info.push(`<li>${ico("i-mesa")}<span><b>Para jugar:</b> sí, en el local</span></li>`);
    if (l.precio) info.push(`<li>${ico("i-ticket")}<span><b>Precios:</b> ${esc(l.precio)}</span></li>`);
  }
  const enlaces = [];
  if (urlSegura(l.web)) enlaces.push(`<a class="accion" href="${esc(l.web)}" target="_blank" rel="noopener">${ico("i-web")}Sitio web</a>`);
  if (urlSegura(l.instagram)) enlaces.push(`<a class="accion" href="${esc(l.instagram)}" target="_blank" rel="noopener">Instagram ↗</a>`);
  return `<button type="button" class="ficha-cerrar" data-accion="cerrar-ficha" aria-label="Cerrar la ficha">✕</button>
    <div class="ficha-foto">${foto}${botonFavorito(l.tipo, l.id, conjuntoFav(l.tipo).has(l.id), true)}</div>
    <div class="ficha-cuerpo">
      <h3 id="ficha-titulo" class="ficha-titulo" tabindex="-1">${ico(l.tipo === "r" ? "i-cubiertos" : "i-tienda", "ico-ficha")}${esc(l.nombre)}</h3>
      ${dir ? `<p class="ficha-dir">${ico("i-pin", "ico-pin")}${esc(dir)}</p>` : ""}
      <p class="ficha-etiquetas">${etiquetasMapa(l.cats)}</p>
      ${l.descripcion ? `<p class="desc">${esc(l.descripcion)}</p>` : ""}
      ${l.dudas ? `<p class="aviso-local">${ico("i-aviso")}${esc(l.dudas)}</p>` : ""}
      <div class="ficha-cajas">
        ${info.length ? `<ul class="ficha-caja ficha-datos">${info.join("")}</ul>` : ""}
        <div class="ficha-caja ficha-horario">${ico("i-reloj")}<div><b>Horario</b><p>${esc(l.horario || "Sin datos: confírmalo en sus redes")}</p></div></div>
      </div>
      <div class="acciones">
        <a class="accion accion-fuerte" href="${esc(urlComoLlegar(consultaLocal(l)))}" target="_blank" rel="noopener">${ico("i-ruta")}Cómo llegar</a>
        ${enlaces.join("")}
        <button type="button" class="accion" data-accion="compartir-lugar" data-lugar="${esc(claveLugar(l))}">${ico("i-compartir")}Compartir</button>
      </div>
    </div>`;
}

function pintarFicha() {
  const l = MAPA.sel && lugarPorClave(MAPA.sel);
  const f = $("#mapa-ficha");
  f.classList.remove("sin-foto");
  f.classList.toggle("abierta", !!l);
  f.setAttribute("aria-label", l ? `Ficha de ${l.nombre}` : "Ficha del lugar");
  f.innerHTML = l ? htmlFicha(l)
    : `<div class="ficha-vacia">${ico("i-brujula", "ficha-rosa")}<p class="vacio-titulo">Elige un lugar</p>` +
      `<p>Toca un marcador del mapa o un lugar de la lista para ver sus fotos, sus datos y cómo llegar.</p></div>`;
}

function htmlFilaLugar(l) {
  const k = claveLugar(l), c = catMapa(l.cats[0]);
  const d = MAPA.yo ? distanciaKm(MAPA.yo, [l.lat, l.lng]) : null;
  const sub = [l.comuna, l.cats.map((x) => catMapa(x).nombre).join(" · ")].filter(Boolean).join(" — ");
  return `<button type="button" class="fila-lugar" data-lugar="${esc(k)}"${k === MAPA.sel ? ' aria-current="true"' : ""}>` +
    `<span class="pin-mini" style="--c:${esc(c.color)}">${ico(c.icono)}</span>` +
    `<span class="fila-texto"><b>${esc(l.nombre)}</b><span>${esc(sub)}</span></span>` +
    (d != null ? `<span class="fila-dist">${textoDistancia(d)}</span>` : "") + `</button>`;
}

function pintarMapa() {
  const lista = lugaresFiltrados();
  const cuenta = (id) => MAPA.lugares.filter((l) => l.cats.includes(id)).length;
  $("#mapa-chips").innerHTML = CATS_MAPA.filter((c) => cuenta(c.id)).map((c) =>
    `<button type="button" class="chip chip-mapa" data-mcat="${esc(c.id)}" aria-pressed="${MAPA.cats.has(c.id)}" style="--c:${esc(c.color)}">` +
    `<span class="chip-ico">${ico(c.icono)}</span>${esc(c.nombre)} <span class="cuenta">${cuenta(c.id)}</span></button>`).join("");
  const n = lista.length;
  $("#mapa-cuenta").textContent = MAPA.lugares.length ? `${n} ${n === 1 ? "lugar encontrado" : "lugares encontrados"}` : "Aún no hay lugares en el mapa";
  const activos = [MAPA.texto.trim(), MAPA.comuna, MAPA.torneos, MAPA.espacio, MAPA.online].filter(Boolean).length;
  $("#mapa-filtros-cuenta").textContent = activos ? String(activos) : "";
  $("#mapa-lienzo").hidden = MAPA.vista !== "mapa";
  $("#mapa-lista").hidden = MAPA.vista !== "lista";
  document.querySelectorAll("#sec-mapa [data-vista]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.vista === MAPA.vista)));
  if (MAPA.vista === "lista") {
    $("#mapa-lista").innerHTML = n ? lista.map(htmlFilaLugar).join("")
      : `<div class="vacio"><p class="vacio-titulo">Nada con esos filtros.</p><p>Prueba con otra categoría o toca «Limpiar filtros».</p></div>`;
  }
  if (MAPA.sel && !lista.some((l) => claveLugar(l) === MAPA.sel)) {   // los filtros dejaron fuera al elegido
    MAPA.sel = null;
    history.replaceState(null, "", "#mapa");
  }
  pintarFicha();
  pintarMarcadores();
  const revisado = DATOS_MAPA.revisado ? `Lista de tiendas revisada el ${fecha(DATOS_MAPA.revisado).toLocaleDateString("es-CL", { dateStyle: "long" })}. ` : "";
  $("#nota-mapa").textContent = `${revisado}Los horarios y los torneos cambian: confírmalos en sus redes antes de ir. Mapa: © colaboradores de OpenStreetMap.`;
}

function limpiarFiltrosMapa(repintar = true) {
  Object.assign(MAPA, { cats: new Set(), texto: "", comuna: "", torneos: false, espacio: false, online: false, encuadrar: "todo" });
  $("#mapa-buscar").value = ""; $("#mapa-comuna").value = "";
  for (const id of ["mapa-torneos", "mapa-espacio", "mapa-online"]) $(`#${id}`).checked = false;
  if (repintar) pintarMapa();
}

function prepararControlesMapa() {
  const comunas = [...new Set(MAPA.lugares.map((l) => l.comuna).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  $("#mapa-comuna").innerHTML = `<option value="">Todas</option>` + comunas.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  let espera;
  $("#mapa-buscar").addEventListener("input", (ev) => {
    clearTimeout(espera);
    espera = setTimeout(() => { MAPA.texto = ev.target.value; MAPA.encuadrar = "todo"; pintarMapa(); }, 150);
  });
  $("#mapa-comuna").addEventListener("change", (ev) => { MAPA.comuna = ev.target.value; MAPA.encuadrar = "todo"; pintarMapa(); });
  for (const [id, campo] of [["mapa-torneos", "torneos"], ["mapa-espacio", "espacio"], ["mapa-online", "online"]]) {
    $(`#${id}`).addEventListener("change", (ev) => { MAPA[campo] = ev.target.checked; MAPA.encuadrar = "todo"; pintarMapa(); });
  }
  $("#mapa-orden").addEventListener("change", (ev) => cambiarOrden(ev.target.value));
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (ev.target.closest?.("input, select, textarea")) return;
    if (estado.seccion === "mapa" && MAPA.sel && CELULAR.matches) cerrarFicha({ teclado: true });
  });
}

/** La Lista empieza arriba: en el computador tiene su propio desplazamiento; en el celular, la página baja a ella. */
function alComienzoDeLaLista() {
  const lista = $("#mapa-lista");
  lista.scrollTop = 0;
  if (CELULAR.matches) lista.scrollIntoView({ block: "start", behavior: "auto" });
}

async function cambiarOrden(v) {
  MAPA.orden = v;
  if (v === "cerca" && !MAPA.yo && !(await ubicarme(MAPA.vista === "mapa"))) {
    MAPA.orden = "nombre";
    $("#mapa-orden").value = "nombre";
  }
  pintarMapa();
  if (MAPA.vista === "lista") alComienzoDeLaLista();
}

function dibujarYo() {
  const L = window.L;
  if (!MAPA.mapa || !MAPA.yo) return;
  if (MAPA.capaYo) MAPA.capaYo.setLatLng(MAPA.yo);
  else {
    MAPA.capaYo = L.circleMarker(MAPA.yo, { radius: 9, color: "#fff", weight: 3, fillColor: "#2f63c9", fillOpacity: 1 })
      .bindTooltip("Estás aquí", { direction: "top", className: "tooltip-mapa" }).addTo(MAPA.mapa);
  }
}

function ubicarme(centrar) {
  return new Promise((ok) => {
    if (!navigator.geolocation) { avisar("Este navegador no puede dar tu ubicación"); ok(null); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      MAPA.yo = [p.coords.latitude, p.coords.longitude];
      dibujarYo();
      if (centrar && MAPA.mapa) MAPA.mapa.setView(MAPA.yo, 14);
      if (MAPA.vista === "lista") pintarMapa();
      ok(MAPA.yo);
    }, () => {
      avisar("No se pudo saber dónde estás: revisa el permiso de ubicación del navegador");
      ok(null);
    }, { timeout: 12000, maximumAge: 300000 });
  });
}

async function compartirLugar(k) {
  const l = lugarPorClave(k);
  if (!l) return;
  const url = `${location.origin}${location.pathname}#m-${k}`;
  const texto = `${l.nombre}${l.comuna ? ` (${l.comuna})` : ""} en el Mapa del Aventurero de IMP TRAVEL`;
  try {
    if (navigator.share) { await navigator.share({ title: l.nombre, text: texto, url }); return; }
    await navigator.clipboard.writeText(`${texto}\n${url}`);
    avisar("Enlace copiado");
  } catch { /* cancelado */ }
}

/** Clics de la sección del mapa. Devuelve true si el clic era de ella. */
function clicMapa(ev) {
  const cat = ev.target.closest("[data-mcat]");
  if (cat) {
    const id = cat.dataset.mcat;
    if (MAPA.cats.has(id)) MAPA.cats.delete(id); else MAPA.cats.add(id);
    MAPA.encuadrar = "todo";
    pintarMapa();
    $(`#mapa-chips [data-mcat="${CSS.escape(id)}"]`)?.focus();   // la fila de chips se redibujó
    return true;
  }
  if (ev.target.closest("#mapa-limpiar")) { limpiarFiltrosMapa(); return true; }
  const vista = ev.target.closest("#sec-mapa [data-vista]");
  if (vista) {
    MAPA.vista = vista.dataset.vista;
    if (MAPA.vista === "mapa") MAPA.encuadrar = MAPA.sel ? "sel" : "todo";
    pintarMapa();
    if (MAPA.vista === "mapa") prepararLeaflet();
    else alComienzoDeLaLista();
    return true;
  }
  const filtros = ev.target.closest("#mapa-filtros-boton");
  if (filtros) {
    const abrir = filtros.getAttribute("aria-expanded") !== "true";
    filtros.setAttribute("aria-expanded", String(abrir));
    filtros.closest(".mapa-filtros").classList.toggle("abierto", abrir);
    return true;
  }
  const fila = ev.target.closest(".fila-lugar");
  if (fila) { elegirLugar(fila.dataset.lugar, { enfocar: true }); return true; }
  const deGrupo = ev.target.closest(".popup-lugar");   // un lugar de la lista de un marcador con varios
  if (deGrupo) { elegirLugar(deGrupo.dataset.lugar, { desdeMapa: true, enfocar: ev.detail === 0 }); return true; }
  const btn = ev.target.closest("[data-accion='cerrar-ficha'], [data-accion='compartir-lugar']");
  if (btn) {
    if (btn.dataset.accion === "cerrar-ficha") cerrarFicha({ teclado: ev.detail === 0 }); else compartirLugar(btn.dataset.lugar);
    return true;
  }
  return false;
}

/** Tarjeta de una tienda en Mis favoritos. */
function htmlTienda(x, prefijo = "t") {
  const galeria = htmlGaleria(`t:${x.id}`, "foto-local");
  const datos = [];
  const dir = unirPartes([x.direccion, x.comuna]).join(", ");
  if (dir) datos.push(`<span class="dato">${ico("i-pin", "ico-pin")}${esc(dir)}</span>`);
  if (x.horario) datos.push(`<span class="dato">${ico("i-reloj")}${esc(x.horario)}</span>`);
  if (x.torneos) datos.push(`<span class="dato">${ico("i-trofeo")}${esc(x.torneos)}</span>`);
  return `<article class="local${galeria ? "" : " sin-foto"}" id="${prefijo}-${esc(x.id)}">
    ${galeria}
    <p class="ficha-etiquetas">${etiquetasMapa((x.categorias || []).filter((c) => CATS_MAPA.some((k) => k.id === c)))}</p>
    <h3>${esc(x.nombre)}</h3>
    ${datos.length ? `<p class="datos datos-columna">${datos.join("")}</p>` : ""}
    ${x.descripcion ? `<p class="desc">${esc(x.descripcion)}</p>` : ""}
    <div class="acciones">
      ${botonFavorito("t", x.id, favTiendas.has(x.id))}
      ${conCoordenadas(x) ? `<a class="accion" href="#m-t-${esc(x.id)}">${ico("i-brujula")}Ver en el mapa</a>` : ""}
      <a class="accion" href="${esc(urlComoLlegar(consultaLocal(x)))}" target="_blank" rel="noopener">${ico("i-ruta")}Cómo llegar</a>
      ${urlSegura(x.web) ? `<a class="accion" href="${esc(x.web)}" target="_blank" rel="noopener">Sitio web ↗</a>` : ""}
    </div>
  </article>`;
}

// ---------- mis favoritos ----------
function pintarFavoritos() {
  const aviso = $("#aviso-cuenta");
  if (!CUENTA.disponible) {
    aviso.innerHTML = `<p>Tus favoritos se guardan en este navegador. Marca ☆ Favorito en cualquier evento o restaurante.</p>`;
  } else if (!CUENTA.usuario) {
    aviso.innerHTML = `<p><b>Inicia sesión con Google</b> para guardar tus favoritos en tu cuenta y verlos en el celular y en el computador.</p>
      <button type="button" class="btn-google" data-accion="entrar">${LOGO_GOOGLE}Iniciar sesión con Google</button>`;
  } else {
    // Solo se dice que quedan en la cuenta cuando ya se pudo leer (si no, siguen en el navegador, sin aviso de error)
    aviso.innerHTML = `<p>Sesión iniciada como <b>${esc(CUENTA.usuario.nombre)}</b>.${CUENTA.sincronizada ? " Tus favoritos quedan guardados en tu cuenta." : ""}</p>`;
  }
  const evs = EVENTOS.filter((e) => favEventos.has(e.id) && vigente(e))
    .sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
  const rs = RESTAURANTES.filter((r) => favRest.has(r.id));
  const ts = TIENDAS.filter((x) => favTiendas.has(x.id));
  $("#fav-titulo-eventos").hidden = !evs.length;
  $("#fav-titulo-restaurantes").hidden = !rs.length;
  if ($("#fav-titulo-tiendas")) $("#fav-titulo-tiendas").hidden = !ts.length;
  $("#fav-eventos").innerHTML = evs.map((e) => htmlNota(e, "f")).join("");
  $("#fav-restaurantes").innerHTML = rs.map((r) => htmlLocal(r, "fr")).join("");
  if ($("#fav-tiendas")) $("#fav-tiendas").innerHTML = ts.map((x) => htmlTienda(x, "ft")).join("");
  const hay = evs.length + rs.length + ts.length > 0;
  // El estado vacío depende de lo guardado, no de lo pintado: mientras carga la agenda no se dice "no tienes favoritos"
  const guardados = favEventos.size + favRest.size + favTiendas.size;
  let vacio = "";
  if (!hay) {
    if (guardados && !EVENTOS_CARGADOS && !AGENDA_FALLO) vacio = `<p class="vacio-titulo">Cargando tus favoritos…</p>`;
    else if (guardados && AGENDA_FALLO) vacio = `<p class="vacio-titulo">No se pudo cargar la agenda.</p><p>Tus favoritos siguen guardados; prueba recargando la página.</p>`;
    else if ((favTiendas.size && TIENDAS_FALLO) || (favRest.size && ESTADO_RESTAURANTES === "fallo")) {
      vacio = `<p class="vacio-titulo">No se pudo cargar la lista de tiendas o de restaurantes.</p><p>Tus favoritos siguen guardados; prueba recargando la página.</p>`;
    }
    else vacio = `<p class="vacio-titulo">Aún no tienes favoritos.</p><p>Marca ☆ Favorito en un evento de la agenda, en un restaurante temático o en una tienda del Mapa del Aventurero y aparecerá aquí.</p>`;
  }
  $("#fav-vacio").innerHTML = vacio;
  $("#fav-vacio").hidden = hay;
  $("#fav-contenido").hidden = !hay;
}

const LOGO_GOOGLE = `<svg class="logo-g" viewBox="0 0 48 48" aria-hidden="true" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

// ---------- acciones ----------
function porId(id) { return EVENTOS.find((e) => e.id === id); }

function icsTexto(e) {
  const limpio = (t) => String(t || "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
  const d = (iso) => iso.replace(/-/g, "");
  const ahora = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//IMP TRAVEL//ES", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${e.id}@el-pregonero`, `DTSTAMP:${ahora}`];
  if (e.hora) {
    const [hh, mm] = e.hora.split(":").map(Number);
    const fin = Math.min(hh + 3, 23);
    lineas.push(`DTSTART;TZID=America/Santiago:${d(e.fecha_inicio)}T${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}00`);
    lineas.push(`DTEND;TZID=America/Santiago:${d(e.fecha_fin || e.fecha_inicio)}T${String(fin).padStart(2, "0")}${String(mm).padStart(2, "0")}00`);
  } else {
    const f = fecha(e.fecha_fin || e.fecha_inicio); f.setDate(f.getDate() + 1);
    const sig = `${f.getFullYear()}${String(f.getMonth() + 1).padStart(2, "0")}${String(f.getDate()).padStart(2, "0")}`;
    lineas.push(`DTSTART;VALUE=DATE:${d(e.fecha_inicio)}`, `DTEND;VALUE=DATE:${sig}`);
  }
  lineas.push(`SUMMARY:${limpio(e.titulo)}`);
  const l = [e.lugar, e.direccion, e.comuna].filter(Boolean).join(", ");
  if (l) lineas.push(`LOCATION:${limpio(l)}`);
  lineas.push(`DESCRIPTION:${limpio([e.descripcion, e.horario && "Horario: " + e.horario, e.precio && "Precio: " + e.precio, e.url].filter(Boolean).join("\n"))}`);
  if (urlSegura(e.url)) lineas.push(`URL:${e.url}`);
  lineas.push("END:VEVENT", "END:VCALENDAR");
  return lineas.join("\r\n");
}

function descargarIcs(e) {
  const blob = new Blob([icsTexto(e)], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sinTildes(e.titulo).replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function compartir(e) {
  const url = `${location.origin}${location.pathname}#e-${e.id}`;
  const texto = `${e.titulo} — ${rangoTexto(e)}${lugarTexto(e) ? ", " + lugarTexto(e) : ""}`;
  try {
    if (navigator.share) { await navigator.share({ title: e.titulo, text: texto, url }); return; }
    await navigator.clipboard.writeText(`${texto}\n${url}`);
    avisar("Enlace copiado");
  } catch { /* cancelado */ }
}

/** Se eligió un tema con sus botones: el banner pasa al que le corresponde (el del tema, o Agenda si no tiene)
 *  y la dirección lo dice (#medieval, #conciertos… o #eventos), salvo que apunte a un evento. */
function temaCambiado() {
  const h = hashActual();
  if (!h || BANNERS.some((b) => b.hash === h)) history.replaceState(null, "", `#${BANNERS[bannerDeCat()].hash}`);
  sincronizarBanners(true);
}

document.addEventListener("click", (ev) => {
  const pestana = ev.target.closest(".pestana");
  if (pestana) { ev.preventDefault(); irA(pestana.dataset.seccion); return; }
  const punto = ev.target.closest(".banners-puntos .punto");
  if (punto) { irABanner(BANNERS.findIndex((b) => b.id === punto.dataset.banner)); return; }
  const flecha = ev.target.closest("[data-banner-paso]");
  if (flecha) { irABanner(bannerVecino(Number(flecha.dataset.bannerPaso))); return; }
  if (ev.target.closest("#btn-entrar, [data-accion='entrar']")) { entrar(); return; }
  if (ev.target.closest("#btn-salir")) { salir(); return; }
  if (clicMapa(ev)) return;
  const chip = ev.target.closest(".chip");
  if (chip) {
    if (chip.dataset.tema) { estado.tema = chip.dataset.tema; pintarRestaurantes(); return; }
    if (chip.dataset.rm) estado.soloRM = !estado.soloRM;
    else estado.cat = chip.dataset.cat;
    pintarChips(); pintar();
    if (!chip.dataset.rm) temaCambiado();
    return;
  }
  const btn = ev.target.closest("[data-accion]");
  if (!btn) return;
  const accion = btn.dataset.accion;
  if (accion === "favorito") { alternarFavorito(btn.dataset.tipo, btn.dataset.id, btn); return; }
  if (accion === "fotos") {
    abrirVisor(btn.dataset.ref, Number(btn.dataset.i) || 0, btn, btn.querySelector(".imagen")?.dataset.url);
    return;
  }
  if (accion === "foto-ant" || accion === "foto-sig") { moverCarrusel(btn.closest(".galeria"), accion === "foto-sig" ? 1 : -1); return; }
  if (accion === "temporadas") {
    estado.verTemporadas = true;
    pintar();
    $("#t-temporadas")?.focus({ preventScroll: true });
    return;
  }
  const e = porId(btn.dataset.id);
  if (!e) return;
  if (accion === "calendario") descargarIcs(e);
  else if (accion === "compartir") compartir(e);
});

let espera;
$("#buscar").addEventListener("input", (ev) => {
  clearTimeout(espera);
  espera = setTimeout(() => { estado.texto = ev.target.value; pintar(); }, 150);
});
// En el celular el buscador comparte la fila con "Nuevos": el texto de ayuda largo no cabe
const ANGOSTO = window.matchMedia("(max-width: 760px)");
const AYUDA_BUSCAR = $("#buscar").placeholder;
function ayudaBuscar() { $("#buscar").placeholder = ANGOSTO.matches ? "Buscar…" : AYUDA_BUSCAR; }
ayudaBuscar();
ANGOSTO.addEventListener?.("change", ayudaBuscar);

window.addEventListener("popstate", () => {
  const cat = estado.cat;
  aplicarHash();
  if (estado.seccion === "mapa") MAPA.desdeHash = true;
  if (estado.cat !== cat) { pintarChips(); pintar(); }
  pintarSecciones();
});

// ---------- instalar como app (PWA) ----------
// "Descargar la app" va arriba a la izquierda (en el celular no se muestra: lo esconde el CSS). Si el navegador
// ofrece instalarla, abre su ventana; si no (ya instalada, o un navegador sin esa ventana), dice cómo hacerlo.
// Dentro de la app instalada no se muestra.
let promptInstalar = null;
const btnInstalar = $("#btn-instalar");
if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) btnInstalar.hidden = true;
window.addEventListener("beforeinstallprompt", (ev) => { ev.preventDefault(); promptInstalar = ev; });
window.addEventListener("appinstalled", () => {
  promptInstalar = null; btnInstalar.hidden = true;
  avisar("IMP TRAVEL quedó instalada como app");
});
btnInstalar.addEventListener("click", async () => {
  if (promptInstalar) {
    const p = promptInstalar;
    promptInstalar = null;
    p.prompt();
    const r = await p.userChoice.catch(() => null);
    if (r?.outcome === "accepted") btnInstalar.hidden = true;
    return;
  }
  avisar("Para instalarla, usa el ícono de instalar en la barra de direcciones de Chrome o Edge. Si ya la instalaste, ábrela desde tu escritorio.");
});
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- inicio ----------
async function cargarJson(ruta) {
  const r = await fetch(ruta, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${ruta}: ${r.status}`);
  return r.json();
}

async function iniciar() {
  $("#btn-buscar").href = URL_BUSCAR;
  $("#btn-gustos").href = URL_GUSTOS;
  // Accesos directos antiguos (?ver=...): se aplican una vez y se quitan de la dirección,
  // para que al recargar no vuelvan a mandar a esa pestaña o a ese filtro
  const ver = new URLSearchParams(location.search).get("ver");
  if (ver) {
    const destino = { guardados: "#favoritos", favoritos: "#favoritos", restaurantes: "#restaurantes", nuevos: "#eventos" }[ver];
    if (ver === "nuevos") estado.soloNuevos = true;
    history.replaceState(null, "", location.pathname + (destino || location.hash));
  }
  aplicarHash();
  pintarSecciones();
  const [agenda, locales, lugares, tiendas] = await Promise.allSettled([
    Promise.all([cargarJson("config/gustos.json"), cargarJson("data/eventos.json")]),
    cargarJson("data/restaurantes.json"),
    cargarJson("data/lugares.json"),
    cargarJson("data/tiendas.json"),
  ]);
  if (tiendas.status === "fulfilled") prepararTiendas(tiendas.value);
  else { TIENDAS_FALLO = true; console.error(tiendas.reason); }   // sin tiendas, el mapa muestra igual los restaurantes
  if (lugares.status === "fulfilled") prepararLugares(lugares.value);
  else console.error(lugares.reason);   // sin fotos de los lugares la agenda igual funciona
  if (agenda.status === "fulfilled") {
    const [cfg, datos] = agenda.value;
    ORDEN_CATS = cfg.categorias;
    CATS = Object.fromEntries(cfg.categorias.map((c) => [c.id, c]));
    // Un evento con un tema que ya no existe (p. ej. "metal", si una vuelta del robot con la configuración
    // anterior lo subió justo al renombrar los temas) se muestra en su tema nuevo según temas_renombrados.
    // El robot lo corrige en el archivo en su vuelta siguiente; si el tema se repartió (lista), va al primero.
    const renombrados = cfg.temas_renombrados || {};
    EVENTOS = (datos.eventos || []).map((e) => {
      if (CATS[e.categoria]) return e;
      const destino = [renombrados[e.categoria]].flat().find((id) => CATS[id]);
      return destino ? { ...e, categoria: destino } : e;
    });
    EVENTOS_CARGADOS = true;
    ULTIMA = datos.ultima_busqueda || {};
    if (Array.isArray(ULTIMA.nuevos_ids)) {
      NUEVOS = new Set(ULTIMA.nuevos_ids);
    } else if (ULTIMA.fecha && ULTIMA.eventos_nuevos) {
      // búsquedas antiguas sin lista de id: lo agregado ese mismo día
      const dia = ULTIMA.fecha.slice(0, 10);
      NUEVOS = new Set(EVENTOS.filter((e) => e.agregado === dia).map((e) => e.id));
    }
    pintarCabecera(datos);
  } else {
    AGENDA_FALLO = true;
    const est = $("#estado-busqueda");   // solo en un index.html viejo
    if (est) est.textContent = "No se pudo cargar la agenda";
    console.error(agenda.reason);
  }
  if (locales.status === "fulfilled") {
    ORDEN_TEMAS = locales.value.temas || [];
    TEMAS = Object.fromEntries(ORDEN_TEMAS.map((t) => [t.id, t]));
    RESTAURANTES = locales.value.restaurantes || [];
    REVISADO = locales.value.revisado || null;
  } else {
    console.error(locales.reason);
  }
  ESTADO_RESTAURANTES = locales.status === "fulfilled" ? "listo" : "fallo";
  DATOS_MAPA.listos = true;
  const h = hashActual();
  mostrarTemporadaDe(h);
  pintarTodo();
  pintarCuenta();
  if (h.startsWith("e-") || h.startsWith("r-")) document.getElementById(h)?.scrollIntoView({ block: "center" });
}
/** Un enlace compartido a una exposición que está entre las "Ver las N…" (escondidas) las muestra todas. */
function mostrarTemporadaDe(h) {
  if (!h.startsWith("e-") || estado.verTemporadas) return false;
  const e = porId(h.slice(2));
  if (!e || !temporadaLarga(e)) return false;
  estado.verTemporadas = true;
  return true;
}
window.addEventListener("hashchange", () => {
  const h = hashActual();
  if (document.getElementById(h) || !mostrarTemporadaDe(h)) return;
  pintar();
  document.getElementById(h)?.scrollIntoView({ block: "center" });
});
iniciar();
