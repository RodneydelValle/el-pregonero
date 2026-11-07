/* IMP TRAVEL (antes El Pregonero) — agenda de eventos, restaurantes temáticos y favoritos. Sin dependencias.
 * Datos: data/eventos.json (lo actualiza el robot), data/restaurantes.json (lista revisada a mano)
 * y data/lugares.json (fotos de teatros, museos y salas: se muestran en cada evento que ocurre ahí).
 * Favoritos: en el navegador; con sesión de Google (cuenta.js + Firebase) quedan en la cuenta de cada persona. */
"use strict";

const REPO = "RodneydelValle/el-pregonero";
const URL_BUSCAR = `https://github.com/${REPO}/actions/workflows/buscar-eventos.yml`;
const URL_GUSTOS = `https://github.com/${REPO}/edit/main/config/gustos.json`;
const CLAVE_GUARDADOS = "pregonero:guardados";
const CLAVE_REST = "pregonero:restaurantes";
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const COMUNAS_RM = /santiago|metropolitana|providencia|[ñn]u[ñn]oa|las condes|vitacura|lo barnechea|la reina|pe[ñn]alol[ée]n|macul|la florida|puente alto|maip[úu]|estaci[óo]n central|quinta normal|recoleta|independencia|conchal[íi]|huechuraba|quilicura|renca|cerro navia|lo prado|pudahuel|cerrillos|pedro aguirre cerda|san miguel|san joaqu[íi]n|la cisterna|el bosque|la granja|la pintana|san ram[óo]n|lo espejo|san bernardo|buin|colina|lampa|talagante|pe[ñn]aflor|melipilla|pirque|san jos[ée] de maipo|movistar arena|caupolic[áa]n|teatro coliseo|blondie|santander arena|espacio riesco|matucana|gam\b|parque o.?higgins/i;
const HASH_SECCION = { agenda: "eventos", restaurantes: "restaurantes", favoritos: "favoritos" };
// Banners de la cabecera: cada uno es una sección (en ese orden se deslizan). Juegos y Museos son la agenda con su
// tema; "grupo:museos" junta los museos con las exposiciones de arte. Restaurantes no tiene pestaña: se llega por su banner.
const BANNERS = [
  { id: "agenda", hash: "eventos", seccion: "agenda", cat: "todas" },
  { id: "juegos", hash: "juegos", seccion: "agenda", cat: "fantasia" },
  { id: "museos", hash: "museos", seccion: "agenda", cat: "grupo:museos" },
  { id: "restaurantes", hash: "restaurantes", seccion: "restaurantes", cat: null },
];
const GRUPOS = { "grupo:museos": ["museos", "arte"] };

const estado = { seccion: "agenda", cat: "todas", periodo: "todo", texto: "", soloRM: false, soloNuevos: false, tema: "todos", verTemporadas: false };
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
let TEMAS = {};
let ORDEN_TEMAS = [];
let REVISADO = null;
let favEventos = leerSet(CLAVE_GUARDADOS);
let favRest = leerSet(CLAVE_REST);
let CUENTA = { disponible: false, usuario: null };

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
// Íconos: están en el <svg class="sprite"> de index.html. Cada tema de la agenda tiene el suyo
// (un tema nuevo sin ícono muestra su emoji de config/gustos.json).
const ICONO_CAT = { todas: "i-cuadricula", medieval: "i-espadas", yokai: "i-torii", anime: "i-mando", ilustracion: "i-pincel",
  metal: "i-guitarra", fantasia: "i-dado", arte: "i-paleta", museos: "i-museo" };
function ico(id, clase = "") {
  return `<svg class="ico${clase ? " " + clase : ""}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
}
function icoCat(id, emoji) {
  return ICONO_CAT[id] ? ico(ICONO_CAT[id], "ico-cat") : `<span class="emoji" aria-hidden="true">${esc(emoji || "•")}</span>`;
}
function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function urlSegura(u) { return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null; }
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
function favoritosActuales() { return { eventos: [...favEventos], restaurantes: [...favRest] }; }

/** Actualiza en su lugar los botones ☆/★ y el contador, sin redibujar la página (no se pierde el foco ni la posición). */
function refrescarFavoritos(desde) {
  document.querySelectorAll('[data-accion="favorito"]').forEach((b) => {
    const en = (b.dataset.tipo === "r" ? favRest : favEventos).has(b.dataset.id);
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
  const conjunto = tipo === "r" ? favRest : favEventos;
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
    favEventos = new Set(fav.eventos || []); favRest = new Set(fav.restaurantes || []);
    guardarLocal(); refrescarFavoritos();
  },
  locales() { return favoritosActuales(); },
  limpiarLocales() { favEventos = new Set(); favRest = new Set(); guardarLocal(); refrescarFavoritos(); },
  error(msg, e) { console.error(e); avisar(msg); },
};

// Otra pestaña cambió los favoritos (o cerró la sesión y los borró): esta se pone al día
window.addEventListener("storage", (ev) => {
  if (ev.key === null || ev.key === CLAVE_GUARDADOS || ev.key === CLAVE_REST) {
    favEventos = leerSet(CLAVE_GUARDADOS); favRest = leerSet(CLAVE_REST);
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
  if (h === "favoritos") return "favoritos";
  return "agenda";
}
/** Las categorías que deja ver el tema elegido (null: todas). */
function catsFiltro(cat = estado.cat) {
  return cat === "todas" ? null : GRUPOS[cat] || [cat];
}
/** El banner de la agenda que corresponde a un tema: Juegos o Museos si el tema es de ellos; si no, Agenda. */
function bannerDeCat(cat = estado.cat) {
  const cats = catsFiltro(cat);
  if (!cats) return 0;
  const k = BANNERS.findIndex((b) => b.seccion === "agenda" && b.cat !== "todas" && cats.every((c) => catsFiltro(b.cat).includes(c)));
  return k >= 0 ? k : 0;
}
/** El banner de lo que se está mostrando; null en Mis favoritos (ahí el banner se queda donde estaba). */
function bannerActual() {
  if (estado.seccion === "agenda") return bannerDeCat();
  const k = BANNERS.findIndex((b) => b.seccion === estado.seccion);
  return k >= 0 ? k : null;
}
/** Sección y tema según la dirección: #eventos, #juegos, #museos, #restaurantes, #favoritos, #e-…, #r-… */
function aplicarHash() {
  estado.seccion = seccionDeHash();
  const b = BANNERS.find((x) => x.hash === hashActual());
  if (b?.seccion !== "agenda") return;
  if (b.cat !== "todas") estado.cat = b.cat;
  else if (bannerDeCat() !== 0) estado.cat = "todas";   // #eventos con el tema de Juegos o Museos: toda la agenda
}
function irA(seccion) {
  // La pestaña Agenda muestra la agenda completa: si se venía de Juegos o Museos, vuelve a "Todo"
  // (un tema elegido con los botones de temas, como Metal, se mantiene)
  if (seccion === "agenda" && bannerDeCat() !== 0) { estado.cat = "todas"; pintarChips(); pintar(); }
  const hash = `#${HASH_SECCION[seccion]}`;
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
    + RESTAURANTES.filter((r) => favRest.has(r.id)).length;
}
/** suave: el banner pasa al de la sección deslizándose (al tocar una pestaña, un punto o una flecha). */
function pintarSecciones(suave = false) {
  for (const s of ["agenda", "restaurantes", "favoritos"]) {
    $(`#sec-${s}`).hidden = estado.seccion !== s;
    const p = $(`.pestana[data-seccion="${s}"]`);   // Restaurantes no tiene pestaña (sí en un index.html viejo en caché)
    if (!p) continue;
    if (estado.seccion === s) p.setAttribute("aria-current", "page"); else p.removeAttribute("aria-current");
  }
  const n = contarFavoritos();
  $("#cuenta-favoritos").textContent = n ? String(n) : "";
  if (estado.seccion === "restaurantes") pintarRestaurantes();
  if (estado.seccion === "favoritos") pintarFavoritos();
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
  const h = hoy();
  const limite = estado.periodo === "semana" ? 7 : estado.periodo === "mes" ? 30 : Infinity;
  const q = sinTildes(estado.texto.trim());
  const cats = catsFiltro();
  return EVENTOS.filter((e) => {
    if (!vigente(e)) return false;
    if (estado.soloNuevos) return NUEVOS.has(e.id);   // "Nuevos" muestra todo lo nuevo, sin otros filtros
    if (dias(h, fecha(e.fecha_inicio)) > limite) return false;
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
    $("#detalle-busqueda").textContent = `Última búsqueda: ${f.toLocaleString("es-CL", { dateStyle: "long", timeStyle: "short" })}${det.length ? " · " + det.join(" · ") : ""}. Total en agenda: ${datos.total ?? EVENTOS.length}.`;
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
  const cats = catsFiltro();   // con el banner Museos quedan marcados Museos y Exposiciones de arte
  $("#chips").innerHTML = chips.map((c) =>
    `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${c.id === "todas" ? !cats : !!cats?.includes(c.id)}">` +
    `${icoCat(c.id, c.emoji)}${esc(c.nombre)} <span class="cuenta">${c.n}</span></button>`
  ).join("") +
    `<button type="button" class="chip" data-rm="1" aria-pressed="${estado.soloRM}">${ico("i-pin-rm", "ico-pin")}Solo Región Metropolitana</button>`;
  mostrarTemaMarcado();
}
/** La fila de temas se desliza (en el celular no caben): que se vea el tema marcado, por ejemplo al pasar al banner
 *  Juegos o Museos, cuyos temas están al final de la fila. */
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
  if (dedoAbajo()) return;
  // se mueve otra vez: cuando se detenga se vuelve a pasar por aquí
  if (c?.id === "banners-carril") { if (bannerQuieto(c)) return; }
  else if (c && acomodar(c)) return;
  rehacerPendientes();
}
document.addEventListener("touchstart", (ev) => {
  DEDOS = ev.touches.length;
  if (DEDOS === 1) TOCADO = ev.target instanceof Element ? ev.target.closest(".carrusel, .visor-carril, .banners-carril") : null;
  if (TOCADO?.id === "banners-carril") banners.programado = false;   // si la página lo estaba moviendo, ahora manda la persona
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
const banners = { indice: 0, programado: false, ultimo: 0, fin: 0, cuadro: 0, seguro: 0 };
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
  const ant = $(".banners-flecha.ant"), sig = $(".banners-flecha.sig");
  if (ant) ant.disabled = i <= 0;
  if (sig) sig.disabled = i >= BANNERS.length - 1;
}
/** Lleva el banner a la posición k, salvo que la persona lo esté arrastrando. */
function moverBanners(k, suave = false) {
  const c = carrilBanners();
  if (!c || (dedoAbajo() && TOCADO === c)) return;
  const img = c.children[k]?.querySelector("img");
  if (img?.loading === "lazy") img.loading = "eager";
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
  // Pasar entre Agenda, Juegos y Museos no deja pasos en el historial; ir a Restaurantes o volver, sí (como una pestaña)
  const hash = `#${b.hash}`;
  if (antes !== b.seccion) history.pushState(null, "", hash);
  else if (location.hash !== hash) history.replaceState(null, "", hash);
  pintarSecciones(suave);
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
  if (k !== banners.indice) irABanner(k, false);
  else pintarPuntos(bannerActual());
  return false;
}
/** Los banners que no se ven se bajan cuando la página terminó de cargar, o antes si la persona llega al banner. */
function cargarBanners() {
  document.querySelectorAll('.banner-cabecera img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
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
    const k = Math.min(Math.max(0, banners.indice + (ev.key === "ArrowRight" ? 1 : -1)), BANNERS.length - 1);
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
    $("#banner-texto").innerHTML = `${ico("i-fuego")}<b>${lista.length} evento${lista.length === 1 ? "" : "s"} nuevo${lista.length === 1 ? "" : "s"}</b> en la búsqueda de ${esc(cuando)}.` +
      `<span class="fino">Ya quedaron en la agenda; aquí están solo ellos, ordenados por fecha.</span>`;
  } else {
    const leidas = ULTIMA.paginas_revisadas ? ` revisó ${ULTIMA.paginas_revisadas} páginas y` : "";
    $("#banner-texto").innerHTML = `<b>No hay eventos nuevos.</b>` +
      `<span class="fino">La última búsqueda (${esc(cuando)})${leidas} no encontró nada distinto a lo que ya tenías. La próxima es ${new Date().getHours() < 6 ? "hoy" : "mañana"} a las 06:00.</span>`;
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
 *  y un botón muestra el resto (al filtrar por arte o museos, o al buscar, se ven todas). */
function htmlTemporadas(largas) {
  const todas = estado.verTemporadas || largas.length <= 4 || !!estado.texto || estado.soloNuevos
    || ["arte", "museos"].includes(estado.cat);
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
  if (AGENDA_FALLO) {
    vacio.innerHTML = `<p class="vacio-titulo">No se pudo cargar la agenda.</p><p>Revisa tu conexión y recarga la página.</p>`;
  }
}

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
  $("#fav-titulo-eventos").hidden = !evs.length;
  $("#fav-titulo-restaurantes").hidden = !rs.length;
  $("#fav-eventos").innerHTML = evs.map((e) => htmlNota(e, "f")).join("");
  $("#fav-restaurantes").innerHTML = rs.map((r) => htmlLocal(r, "fr")).join("");
  const hay = evs.length + rs.length > 0;
  // El estado vacío depende de lo guardado, no de lo pintado: mientras carga la agenda no se dice "no tienes favoritos"
  const guardados = favEventos.size + favRest.size;
  let vacio = "";
  if (!hay) {
    if (guardados && !EVENTOS_CARGADOS && !AGENDA_FALLO) vacio = `<p class="vacio-titulo">Cargando tus favoritos…</p>`;
    else if (guardados && AGENDA_FALLO) vacio = `<p class="vacio-titulo">No se pudo cargar la agenda.</p><p>Tus favoritos siguen guardados; prueba recargando la página.</p>`;
    else vacio = `<p class="vacio-titulo">Aún no tienes favoritos.</p><p>Marca ☆ Favorito en un evento de la agenda o en un restaurante temático y aparecerá aquí.</p>`;
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

/** Se eligió un tema con sus botones: el banner pasa al que le corresponde (Juegos, Museos o Agenda)
 *  y la dirección lo dice (#juegos, #museos o #eventos), salvo que apunte a un evento. */
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
  if (flecha) { irABanner(banners.indice + Number(flecha.dataset.bannerPaso)); return; }
  if (ev.target.closest("#btn-entrar, [data-accion='entrar']")) { entrar(); return; }
  if (ev.target.closest("#btn-salir")) { salir(); return; }
  const chip = ev.target.closest(".chip");
  if (chip) {
    if (chip.dataset.tema) { estado.tema = chip.dataset.tema; pintarRestaurantes(); return; }
    if (chip.dataset.rm) estado.soloRM = !estado.soloRM;
    else estado.cat = chip.dataset.cat;
    pintarChips(); pintar();
    if (!chip.dataset.rm) temaCambiado();
    return;
  }
  const seg = ev.target.closest("[data-periodo]");
  if (seg) {
    estado.periodo = seg.dataset.periodo;
    document.querySelectorAll("[data-periodo]").forEach((b) => b.setAttribute("aria-pressed", String(b === seg)));
    pintar();
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

window.addEventListener("popstate", () => {
  const cat = estado.cat;
  aplicarHash();
  if (estado.cat !== cat) { pintarChips(); pintar(); }
  pintarSecciones();
});

// ---------- instalar como app (PWA) ----------
let promptInstalar = null;
window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault(); promptInstalar = ev; $("#btn-instalar").hidden = false;
});
$("#btn-instalar").addEventListener("click", async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt();
  await promptInstalar.userChoice.catch(() => null);
  promptInstalar = null; $("#btn-instalar").hidden = true;
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
  const [agenda, locales, lugares] = await Promise.allSettled([
    Promise.all([cargarJson("config/gustos.json"), cargarJson("data/eventos.json")]),
    cargarJson("data/restaurantes.json"),
    cargarJson("data/lugares.json"),
  ]);
  if (lugares.status === "fulfilled") prepararLugares(lugares.value);
  else console.error(lugares.reason);   // sin fotos de los lugares la agenda igual funciona
  if (agenda.status === "fulfilled") {
    const [cfg, datos] = agenda.value;
    ORDEN_CATS = cfg.categorias;
    CATS = Object.fromEntries(cfg.categorias.map((c) => [c.id, c]));
    EVENTOS = datos.eventos || [];
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
