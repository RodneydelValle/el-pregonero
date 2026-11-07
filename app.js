/* IMP TRAVEL (antes El Pregonero) — agenda de eventos, restaurantes temáticos y favoritos. Sin dependencias.
 * Datos: data/eventos.json (lo actualiza el robot) y data/restaurantes.json (lista revisada a mano).
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

const estado = { seccion: "agenda", cat: "todas", periodo: "todo", texto: "", soloRM: false, soloNuevos: false, tema: "todos" };
let EVENTOS = [];
let EVENTOS_CARGADOS = false;
let AGENDA_FALLO = false;
let ESTADO_RESTAURANTES = "cargando";   // "cargando" | "listo" | "fallo"
const FOTOS_ROTAS = new Set();   // afiches que no cargaron: no se vuelven a pintar
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
const seleccion = { restaurantes: null, favoritos: null };   // "e:<id>" o "r:<id>" que muestra cada mapa

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
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
/** Une partes de una dirección sin repetir ("Ñuñoa" ya incluido en "Casa de la Cultura de Ñuñoa"). */
function unirPartes(partes) {
  const unico = [];
  partes.filter(Boolean).forEach((p) => {
    if (!unico.some((u) => sinTildes(u).includes(sinTildes(p)) || sinTildes(p).includes(sinTildes(u)))) unico.push(p);
  });
  return unico;
}
function urlMaps(q) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`; }

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
    b.textContent = en ? "★ En favoritos" : "☆ Favorito";
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
function irA(seccion) {
  if (estado.seccion !== seccion) history.pushState(null, "", `#${HASH_SECCION[seccion]}`);
  estado.seccion = seccion;
  pintarSecciones();
  const nav = $(".secciones");
  if (window.scrollY > nav.offsetTop) window.scrollTo({ top: nav.offsetTop, behavior: "smooth" });
  // Para lectores de pantalla y teclado: el foco pasa al título de la sección que se abrió
  $(`#t-${seccion}`)?.focus({ preventScroll: true });
}
function contarFavoritos() {
  return EVENTOS.filter((e) => favEventos.has(e.id) && vigente(e)).length
    + RESTAURANTES.filter((r) => favRest.has(r.id)).length;
}
function pintarSecciones() {
  for (const s of ["agenda", "restaurantes", "favoritos"]) {
    $(`#sec-${s}`).hidden = estado.seccion !== s;
    const p = $(`.pestana[data-seccion="${s}"]`);
    if (estado.seccion === s) p.setAttribute("aria-current", "page"); else p.removeAttribute("aria-current");
  }
  const n = contarFavoritos();
  $("#cuenta-favoritos").textContent = n ? String(n) : "";
  if (estado.seccion === "restaurantes") pintarRestaurantes();
  if (estado.seccion === "favoritos") pintarFavoritos();
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
  return EVENTOS.filter((e) => {
    if (!vigente(e)) return false;
    if (estado.soloNuevos) return NUEVOS.has(e.id);   // "Nuevos" muestra todo lo nuevo, sin otros filtros
    if (dias(h, fecha(e.fecha_inicio)) > limite) return false;
    if (estado.cat !== "todas" && e.categoria !== estado.cat) return false;
    if (estado.soloRM && !COMUNAS_RM.test([e.lugar, e.comuna, e.ciudad, e.region, e.direccion].join(" "))) return false;
    if (q) {
      const t = sinTildes([e.titulo, e.lugar, e.comuna, e.ciudad, e.descripcion, CATS[e.categoria]?.nombre].join(" "));
      if (!q.split(/\s+/).every((p) => t.includes(p))) return false;
    }
    return true;
  });
}

// ---------- agenda: pintar ----------
function pintarCabecera(datos) {
  const h = new Date();
  $("#fecha-hoy").textContent = `${DIAS_LARGOS[h.getDay()]} ${h.getDate()} de ${MESES[h.getMonth()]} de ${h.getFullYear()} · Santiago de Chile`;
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
  $("#estado-busqueda").textContent = txt;
}

function pintarChips() {
  const vigentes = EVENTOS.filter(vigente);
  const cuenta = (id) => vigentes.filter((e) => e.categoria === id).length;
  const chips = [
    { id: "todas", nombre: "Todo", emoji: "📰", n: vigentes.length },
    ...ORDEN_CATS.map((c) => ({ id: c.id, nombre: c.nombre, emoji: c.emoji, n: cuenta(c.id) })),
  ];
  $("#chips").innerHTML = chips.map((c) =>
    `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${estado.cat === c.id}">` +
    `<span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.nombre)} <span class="cuenta">${c.n}</span></button>`
  ).join("") +
    `<button type="button" class="chip" data-rm="1" aria-pressed="${estado.soloRM}"><span aria-hidden="true">📍</span>Solo Región Metropolitana</button>`;
}

function antetitulo(e) {
  const c = CATS[e.categoria] || { nombre: e.categoria, emoji: "•" };
  const nuevo = e.agregado && dias(fecha(e.agregado), hoy()) <= 2 ? '<span class="etiqueta nuevo">NUEVO</span>' : "";
  return `<p class="antetitulo"><span aria-hidden="true">${esc(c.emoji)}</span> ${esc(c.nombre)}${nuevo}</p>`;
}

function datosLinea(e) {
  const partes = [];
  const l = lugarTexto(e);
  if (l) partes.push(`<span>📍 ${esc(l)}</span>`);
  if (e.hora) partes.push(`<span>🕖 ${esc(e.hora)} h</span>`);
  if (e.precio) partes.push(`<span>🎟 ${esc(e.precio)}</span>`);
  return partes.length ? `<p class="datos">${partes.join('<span class="sep">|</span>')}</p>` : "";
}

function fuenteLinea(e) {
  const fuentes = (e.fuentes || []).filter((f) => urlSegura(f.url)).slice(0, 3)
    .map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nombre || "fuente")}</a>`).join(", ");
  const marcas = [];
  if (e.desde_imagen) marcas.push('<span class="marca" title="La fecha o el lugar se leyeron de un afiche">📷 leído del afiche</span>');
  if (e.confianza === "baja") marcas.push('<span class="marca aviso-baja" title="Conviene confirmar en la fuente">⚠ por confirmar</span>');
  return `<p class="fuente">${fuentes ? "Fuente: " + fuentes : ""}${marcas.join("")}</p>`;
}

function consultaEvento(e) { return unirPartes([e.lugar, e.direccion, e.comuna || e.ciudad]).concat("Chile").join(", "); }
function consultaLocal(r) {
  // "mapa" es una búsqueda limpia para direcciones confusas (pisos, galerías, accesos por otra calle)
  const dir = r.mapa ? [r.mapa] : [String(r.direccion || "").replace(/\s*\([^)]*\)/g, ""), r.comuna];
  return unirPartes([r.nombre, ...dir]).concat("Chile").join(", ");
}

function botonFavorito(tipo, id, enFavoritos) {
  return `<button type="button" class="accion${enFavoritos ? " guardado" : ""}" data-accion="favorito" data-tipo="${tipo}" data-id="${esc(id)}" aria-pressed="${enFavoritos}">${enFavoritos ? "★ En favoritos" : "☆ Favorito"}</button>`;
}

function acciones(e, panel) {
  const tieneLugar = lugarTexto(e) || e.direccion;
  const verMapa = panel && tieneLugar
    ? `<button type="button" class="accion" data-accion="mapa" data-panel="${panel}" data-ref="e:${esc(e.id)}">📍 Ver en el mapa</button>` : "";
  return `<div class="acciones">
    ${botonFavorito("e", e.id, favEventos.has(e.id))}
    ${verMapa}
    <button type="button" class="accion" data-accion="calendario" data-id="${esc(e.id)}">📅 Calendario</button>
    ${tieneLugar ? `<a class="accion" href="${esc(urlMaps(consultaEvento(e)))}" target="_blank" rel="noopener">🗺 Cómo llegar</a>` : ""}
    <button type="button" class="accion" data-accion="compartir" data-id="${esc(e.id)}">↗ Compartir</button>
  </div>`;
}

/** Afiche completo, sin recortes: la imagen va entera dentro del recuadro y una copia desenfocada
 *  (el mismo archivo, que el navegador baja una sola vez) rellena los bordes. */
function imagen(e, clase) {
  const src = urlSegura(e.imagen);
  if (!src || FOTOS_ROTAS.has(src)) return "";
  const s = esc(src);
  return `<div class="${clase} marco-foto">` +
    `<img class="fondo" src="${s}" alt="" aria-hidden="true" loading="lazy" decoding="async" referrerpolicy="no-referrer">` +
    `<img class="imagen" src="${s}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="ajustarMarco(this)" onerror="fotoRota(this)">` +
    `</div>`;
}
/** Las miniaturas toman la forma de su imagen (el CSS la limita), para no dejar franjas grandes. */
function ajustarMarco(img) {
  const marco = img.closest(".miniatura");
  if (!marco || !img.naturalWidth || !img.naturalHeight) return;
  marco.style.setProperty("--proporcion", (img.naturalWidth / img.naturalHeight).toFixed(3));
}
function fotoRota(img) {
  FOTOS_ROTAS.add(img.getAttribute("src"));
  const nota = img.closest(".nota");
  (img.closest(".marco-foto") || img).remove();
  if (nota && !nota.querySelector(".marco-foto")) nota.classList.add("sin-foto");
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
    $("#banner-texto").innerHTML = `🆕 <b>${lista.length} evento${lista.length === 1 ? "" : "s"} nuevo${lista.length === 1 ? "" : "s"}</b> en la búsqueda de ${esc(cuando)}.` +
      `<span class="fino">Ya quedaron en la agenda; aquí están solo ellos, ordenados por fecha.</span>`;
  } else {
    const leidas = ULTIMA.paginas_revisadas ? ` revisó ${ULTIMA.paginas_revisadas} páginas y` : "";
    $("#banner-texto").innerHTML = `<b>No hay eventos nuevos.</b>` +
      `<span class="fino">La última búsqueda (${esc(cuando)})${leidas} no encontró nada distinto a lo que ya tenías. La próxima es ${new Date().getHours() < 6 ? "hoy" : "mañana"} a las 06:00.</span>`;
  }
}

function pintarPortada(lista) {
  const cont = $("#portada");
  if (estado.soloNuevos || estado.texto || lista.length < 3) { cont.innerHTML = ""; return; }
  const conFoto = lista.filter((e) => urlSegura(e.imagen));
  const elegidos = (conFoto.length >= 3 ? conFoto : lista).slice(0, 3);
  const [p, ...s] = elegidos;
  const enlace = (e) => urlSegura(e.url) || "#";
  cont.innerHTML = `
    <article class="principal">
      ${imagen(p, "foto")}
      <p class="cuando-grande">${esc(cuandoRelativo(p))}</p>
      ${antetitulo(p)}
      <h2><a href="${esc(enlace(p))}" target="_blank" rel="noopener">${esc(p.titulo)}</a></h2>
      ${datosLinea(p)}
      ${p.descripcion ? `<p class="desc">${esc(p.descripcion)}</p>` : ""}
      ${acciones(p)}
    </article>
    ${s.map((e) => `
    <article class="secundaria">
      ${imagen(e, "foto")}
      <p class="cuando-grande">${esc(cuandoRelativo(e))}</p>
      <h2><a href="${esc(enlace(e))}" target="_blank" rel="noopener">${esc(e.titulo)}</a></h2>
      ${datosLinea(e)}
    </article>`).join("")}`;
}

function htmlNota(e, panel) {
  const h = hoy();
  const i = fecha(e.fecha_inicio);
  const enCurso = i < h;
  const foto = imagen(e, "miniatura");
  const ref = panel ? ` data-ref="e:${esc(e.id)}"` : "";
  const elegido = panel && seleccion[panel] === `e:${e.id}` ? " elegida" : "";
  return `<article class="nota${foto ? "" : " sin-foto"}${elegido}" id="${panel ? "f" : "e"}-${esc(e.id)}"${ref}>
    <div class="dia-bloque${enCurso ? " en-curso" : ""}" aria-hidden="true">
      <span class="sem">${enCurso ? "hasta" : DIAS[i.getDay()]}</span>
      <span class="num">${enCurso ? fecha(e.fecha_fin).getDate() : i.getDate()}</span>
      <span class="mesc">${MESES[(enCurso ? fecha(e.fecha_fin) : i).getMonth()].slice(0, 3)}</span>
    </div>
    <div class="cuerpo">
      ${antetitulo(e)}
      <h3><a href="${esc(urlSegura(e.url) || "#")}" target="_blank" rel="noopener">${esc(e.titulo)}</a></h3>
      ${e.fecha_fin ? `<p class="datos"><span>🗓 ${esc(rangoTexto(e))}</span></p>` : ""}
      ${datosLinea(e)}
      ${e.descripcion ? `<p class="desc">${esc(e.descripcion)}</p>` : ""}
      ${fuenteLinea(e)}
      ${acciones(e, panel)}
    </div>
    ${foto}
  </article>`;
}

function pintarAgenda(lista) {
  const h = hoy();
  const grupos = new Map();
  for (const e of lista) {
    const i = fecha(e.fecha_inicio);
    const clave = i < h ? "Ahora mismo" : `${MESES[i.getMonth()]} ${i.getFullYear()}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(e);
  }
  let html = "";
  for (const [mes, evs] of grupos) {
    html += `<h2 class="mes">${esc(mes)}</h2>` + evs.map((e) => htmlNota(e)).join("");
  }
  $("#agenda").innerHTML = html;
}

function pintar() {
  const lista = filtrar();
  pintarNuevos(lista);
  pintarPortada(lista);
  pintarAgenda(lista);
  $("#vacio").hidden = lista.length > 0 || estado.soloNuevos;   // en "Nuevos" el aviso lo da el recuadro
}

function alternarNuevos(activar) {
  estado.soloNuevos = activar;
  pintar();
  if (activar) $("#banner-nuevos").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("#btn-nuevos").addEventListener("click", () => alternarNuevos(!estado.soloNuevos));
$("#btn-salir-nuevos").addEventListener("click", () => alternarNuevos(false));

// ---------- mapa (Google Maps incrustado: sin clave ni costo) ----------
function datosMapa(ref) {
  if (!ref) return null;
  const [tipo, id] = [ref.slice(0, 1), ref.slice(2)];
  if (tipo === "e") {
    const e = EVENTOS.find((x) => x.id === id);
    if (!e) return null;
    return { titulo: e.titulo, detalle: [lugarTexto(e), e.direccion].filter(Boolean).join(" · "), q: consultaEvento(e) };
  }
  const r = RESTAURANTES.find((x) => x.id === id);
  if (!r) return null;
  return { titulo: r.nombre, detalle: unirPartes([r.direccion, r.comuna]).join(", "), q: consultaLocal(r) };
}

function pintarMapa(panel) {
  const cont = $(`#mapa-${panel}`);
  const d = datosMapa(seleccion[panel]);
  if (!d) {
    cont.innerHTML = `<div class="mapa-vacio"><span aria-hidden="true">🗺</span><p>Elige “📍 Ver en el mapa” en cualquier lugar para verlo aquí.</p></div>`;
    return;
  }
  const embed = `https://maps.google.com/maps?q=${encodeURIComponent(d.q)}&hl=es&z=15&output=embed`;
  const abrir = urlMaps(d.q);
  const marco = cont.querySelector("iframe");
  if (marco && marco.dataset.q === d.q) {
    // Mismo lugar (por ejemplo, dos conciertos en el Caupolicán): no se recarga el mapa, pero sí sus textos
    marco.title = `Mapa de ${d.titulo}`;
    cont.querySelector(".mapa-toque").setAttribute("aria-label", `Abrir ${d.titulo} en Google Maps`);
    cont.querySelector(".mapa-pie p").innerHTML = `<b>${esc(d.titulo)}</b>${d.detalle ? `<br><span>${esc(d.detalle)}</span>` : ""}`;
    return;
  }
  cont.innerHTML = `
    <div class="mapa-marco">
      <iframe src="${esc(embed)}" data-q="${esc(d.q)}" title="Mapa de ${esc(d.titulo)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <a class="mapa-toque" href="${esc(abrir)}" target="_blank" rel="noopener" aria-label="Abrir ${esc(d.titulo)} en Google Maps">
        <span>Toca el mapa para abrirlo en Google Maps ↗</span>
      </a>
    </div>
    <div class="mapa-pie">
      <p><b>${esc(d.titulo)}</b>${d.detalle ? `<br><span>${esc(d.detalle)}</span>` : ""}</p>
      <a class="boton" href="${esc(abrir)}" target="_blank" rel="noopener">🗺 Abrir en Google Maps</a>
    </div>`;
}

function elegirEnMapa(panel, ref, desplazar) {
  seleccion[panel] = ref;
  document.querySelectorAll(`#sec-${panel} [data-ref]`).forEach((n) => {
    if (n.matches("article")) n.classList.toggle("elegida", n.dataset.ref === ref);
  });
  pintarMapa(panel);
  if (desplazar && window.matchMedia("(max-width: 900px)").matches) {
    $(`#mapa-${panel}`).scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ---------- restaurantes temáticos ----------
function htmlLocal(r, panel) {
  const t = TEMAS[r.tema] || { nombre: r.tema, emoji: "•" };
  const datos = [];
  const dir = unirPartes([r.direccion, r.comuna]).join(", ");
  if (dir) datos.push(`<span>📍 ${esc(dir)}</span>`);
  if (r.horario) datos.push(`<span>🕖 ${esc(r.horario)}</span>`);
  if (r.precio) datos.push(`<span>💲 ${esc(r.precio)}</span>`);
  const elegido = seleccion[panel] === `r:${r.id}` ? " elegida" : "";
  const enlaces = [];
  if (urlSegura(r.instagram)) enlaces.push(`<a class="accion" href="${esc(r.instagram)}" target="_blank" rel="noopener">Instagram ↗</a>`);
  if (urlSegura(r.web)) enlaces.push(`<a class="accion" href="${esc(r.web)}" target="_blank" rel="noopener">Sitio web ↗</a>`);
  return `<article class="local${elegido}" id="${panel === "favoritos" ? "fr" : "r"}-${esc(r.id)}" data-ref="r:${esc(r.id)}">
    <p class="antetitulo"><span aria-hidden="true">${esc(t.emoji)}</span> ${esc(t.nombre)}</p>
    <h3>${esc(r.nombre)}</h3>
    ${datos.length ? `<p class="datos">${datos.join('<span class="sep">|</span>')}</p>` : ""}
    ${r.descripcion ? `<p class="desc">${esc(r.descripcion)}</p>` : ""}
    ${r.dudas ? `<p class="aviso-local"><span aria-hidden="true">⚠</span> ${esc(r.dudas)}</p>` : ""}
    <div class="acciones">
      ${botonFavorito("r", r.id, favRest.has(r.id))}
      ${dir ? `<button type="button" class="accion" data-accion="mapa" data-panel="${panel}" data-ref="r:${esc(r.id)}">📍 Ver en el mapa</button>` : ""}
      <a class="accion" href="${esc(urlMaps(consultaLocal(r)))}" target="_blank" rel="noopener">🗺 Cómo llegar</a>
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
  if (!lista.some((r) => seleccion.restaurantes === `r:${r.id}`)) {
    const primero = lista.find((r) => r.direccion);
    seleccion.restaurantes = primero ? `r:${primero.id}` : null;
  }
  const vacioTexto = RESTAURANTES.length ? "Nada en este tema."
    : { cargando: "Cargando restaurantes…", fallo: "No se pudo cargar la lista de restaurantes. Prueba recargando la página." }[ESTADO_RESTAURANTES]
      || "Todavía no hay restaurantes en la lista.";
  $("#lista-restaurantes").innerHTML = lista.length
    ? lista.map((r) => htmlLocal(r, "restaurantes")).join("")
    : `<div class="vacio"><p class="vacio-titulo">${esc(vacioTexto)}</p></div>`;
  $("#mapa-restaurantes").hidden = !lista.length;
  $("#nota-restaurantes").textContent = REVISADO
    ? `Lista revisada el ${fecha(REVISADO).toLocaleDateString("es-CL", { dateStyle: "long" })}. Los horarios y precios cambian: confírmalos en sus redes antes de ir.`
    : "";
  pintarMapa("restaurantes");
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
    aviso.innerHTML = `<p>Sesión iniciada como <b>${esc(CUENTA.usuario.nombre)}</b>. Tus favoritos quedan guardados en tu cuenta.</p>`;
  }
  const evs = EVENTOS.filter((e) => favEventos.has(e.id) && vigente(e))
    .sort((a, b) => a.fecha_inicio.localeCompare(b.fecha_inicio));
  const rs = RESTAURANTES.filter((r) => favRest.has(r.id));
  const refs = [...evs.map((e) => `e:${e.id}`), ...rs.map((r) => `r:${r.id}`)];
  if (!refs.includes(seleccion.favoritos)) {
    const primero = evs.find((e) => lugarTexto(e) || e.direccion);
    seleccion.favoritos = primero ? `e:${primero.id}` : (rs.find((r) => r.direccion) ? `r:${rs.find((r) => r.direccion).id}` : null);
  }
  $("#fav-titulo-eventos").hidden = !evs.length;
  $("#fav-titulo-restaurantes").hidden = !rs.length;
  $("#fav-eventos").innerHTML = evs.map((e) => htmlNota(e, "favoritos")).join("");
  $("#fav-restaurantes").innerHTML = rs.map((r) => htmlLocal(r, "favoritos")).join("");
  const hay = evs.length + rs.length > 0;
  // El estado vacío depende de lo guardado, no de lo pintado: mientras carga la agenda no se dice "no tienes favoritos"
  const guardados = favEventos.size + favRest.size;
  let vacio = "";
  if (!hay) {
    if (guardados && !EVENTOS_CARGADOS && !AGENDA_FALLO) vacio = `<p class="vacio-titulo">Cargando tus favoritos…</p>`;
    else if (guardados && AGENDA_FALLO) vacio = `<p class="vacio-titulo">No se pudo cargar la agenda.</p><p>Tus favoritos siguen guardados; prueba recargando la página.</p>`;
    else vacio = `<p class="vacio-titulo">Aún no tienes favoritos.</p><p>Marca ☆ Favorito en un evento de la agenda o en un restaurante temático y aparecerá aquí con su mapa.</p>`;
  }
  $("#fav-vacio").innerHTML = vacio;
  $("#fav-vacio").hidden = hay;
  $("#fav-contenido").hidden = !hay;
  pintarMapa("favoritos");
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
  lineas.push(`DESCRIPTION:${limpio([e.descripcion, e.precio && "Precio: " + e.precio, e.url].filter(Boolean).join("\n"))}`);
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

document.addEventListener("click", (ev) => {
  const pestana = ev.target.closest(".pestana");
  if (pestana) { ev.preventDefault(); irA(pestana.dataset.seccion); return; }
  if (ev.target.closest("#btn-entrar, [data-accion='entrar']")) { entrar(); return; }
  if (ev.target.closest("#btn-salir")) { salir(); return; }
  const chip = ev.target.closest(".chip");
  if (chip) {
    if (chip.dataset.tema) { estado.tema = chip.dataset.tema; pintarRestaurantes(); return; }
    if (chip.dataset.rm) estado.soloRM = !estado.soloRM;
    else estado.cat = chip.dataset.cat;
    pintarChips(); pintar();
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
  if (accion === "mapa") { elegirEnMapa(btn.dataset.panel, btn.dataset.ref, true); return; }
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

window.addEventListener("popstate", () => { estado.seccion = seccionDeHash(); pintarSecciones(); });

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
  estado.seccion = seccionDeHash();
  pintarSecciones();
  const [agenda, locales] = await Promise.allSettled([
    Promise.all([cargarJson("config/gustos.json"), cargarJson("data/eventos.json")]),
    cargarJson("data/restaurantes.json"),
  ]);
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
    $("#estado-busqueda").textContent = "No se pudo cargar la agenda";
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
  pintarTodo();
  pintarCuenta();
  const h = hashActual();
  if (h.startsWith("e-") || h.startsWith("r-")) document.getElementById(h)?.scrollIntoView({ block: "center" });
}
iniciar();
