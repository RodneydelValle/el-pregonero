/* El Pregonero — lee data/eventos.json y arma el diario. Sin dependencias. */
"use strict";

const REPO = "RodneydelValle/el-pregonero";
const URL_BUSCAR = `https://github.com/${REPO}/actions/workflows/buscar-eventos.yml`;
const URL_GUSTOS = `https://github.com/${REPO}/edit/main/config/gustos.json`;
const CLAVE_GUARDADOS = "pregonero:guardados";
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const COMUNAS_RM = /santiago|metropolitana|providencia|[ñn]u[ñn]oa|las condes|vitacura|lo barnechea|la reina|pe[ñn]alol[ée]n|macul|la florida|puente alto|maip[úu]|estaci[óo]n central|quinta normal|recoleta|independencia|conchal[íi]|huechuraba|quilicura|renca|cerro navia|lo prado|pudahuel|cerrillos|pedro aguirre cerda|san miguel|san joaqu[íi]n|la cisterna|el bosque|la granja|la pintana|san ram[óo]n|lo espejo|san bernardo|buin|colina|lampa|talagante|pe[ñn]aflor|melipilla|pirque|san jos[ée] de maipo|movistar arena|caupolic[áa]n|teatro coliseo|blondie|santander arena|espacio riesco|matucana|gam\b|parque o.?higgins/i;

const estado = { cat: "todas", periodo: "todo", texto: "", soloRM: false, soloNuevos: false };
let EVENTOS = [];
let ULTIMA = {};          // datos de la última búsqueda
let NUEVOS = new Set();   // id de los eventos que agregó la última búsqueda
let CATS = {};
let ORDEN_CATS = [];
let guardados = leerGuardados();

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
function leerGuardados() {
  try { return new Set(JSON.parse(localStorage.getItem(CLAVE_GUARDADOS) || "[]")); } catch { return new Set(); }
}
function escribirGuardados() {
  try { localStorage.setItem(CLAVE_GUARDADOS, JSON.stringify([...guardados])); } catch { /* sin almacenamiento */ }
}
function avisar(texto) {
  const a = $("#aviso");
  a.textContent = texto; a.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => { a.hidden = true; }, 2600);
}

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
function lugarTexto(e) {
  const partes = [e.lugar, e.comuna || e.ciudad].filter(Boolean);
  const unico = [];
  partes.forEach((p) => { if (!unico.some((u) => sinTildes(u).includes(sinTildes(p)) || sinTildes(p).includes(sinTildes(u)))) unico.push(p); });
  return unico.join(", ");
}

// ---------- filtros ----------
function filtrar() {
  const h = hoy();
  const limite = estado.periodo === "semana" ? 7 : estado.periodo === "mes" ? 30 : Infinity;
  const q = sinTildes(estado.texto.trim());
  return EVENTOS.filter((e) => {
    const fin = e.fecha_fin ? fecha(e.fecha_fin) : fecha(e.fecha_inicio);
    if (fin < h) return false;
    if (estado.soloNuevos) return NUEVOS.has(e.id);   // "Nuevos" muestra todo lo nuevo, sin otros filtros
    if (dias(h, fecha(e.fecha_inicio)) > limite) return false;
    if (estado.cat === "guardados" && !guardados.has(e.id)) return false;
    if (estado.cat !== "todas" && estado.cat !== "guardados" && e.categoria !== estado.cat) return false;
    if (estado.soloRM && !COMUNAS_RM.test([e.lugar, e.comuna, e.ciudad, e.region, e.direccion].join(" "))) return false;
    if (q) {
      const t = sinTildes([e.titulo, e.lugar, e.comuna, e.ciudad, e.descripcion, CATS[e.categoria]?.nombre].join(" "));
      if (!q.split(/\s+/).every((p) => t.includes(p))) return false;
    }
    return true;
  });
}

// ---------- pintar ----------
function pintarCabecera(datos) {
  const h = new Date();
  $("#fecha-hoy").textContent = `${DIAS_LARGOS[h.getDay()]} ${h.getDate()} de ${MESES[h.getMonth()]} de ${h.getFullYear()} · Santiago de Chile`;
  const u = datos.ultima_busqueda || {};
  let txt = "Aún sin búsquedas";
  if (u.fecha) {
    const f = new Date(u.fecha);
    const horas = Math.round((Date.now() - f) / 3600000);
    const cuando = horas < 1 ? "hace un rato" : horas < 24 ? `hace ${horas} h` : `hace ${Math.round(horas / 24)} días`;
    txt = `Última búsqueda ${cuando}${u.eventos_nuevos ? ` · ${u.eventos_nuevos} nuevos` : ""}`;
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
  const h = hoy();
  const vigentes = EVENTOS.filter((e) => fecha(e.fecha_fin || e.fecha_inicio) >= h);
  const cuenta = (id) => vigentes.filter((e) => e.categoria === id).length;
  const chips = [
    { id: "todas", nombre: "Todo", emoji: "📰", n: vigentes.length },
    ...ORDEN_CATS.map((c) => ({ id: c.id, nombre: c.nombre, emoji: c.emoji, n: cuenta(c.id) })),
    { id: "guardados", nombre: "Guardados", emoji: "★", n: vigentes.filter((e) => guardados.has(e.id)).length },
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

function acciones(e) {
  const g = guardados.has(e.id);
  const mapa = lugarTexto(e) || e.direccion;
  return `<div class="acciones">
    <button type="button" class="accion${g ? " guardado" : ""}" data-accion="guardar" data-id="${esc(e.id)}" aria-pressed="${g}">${g ? "★ Guardado" : "☆ Guardar"}</button>
    <button type="button" class="accion" data-accion="calendario" data-id="${esc(e.id)}">📅 Calendario</button>
    ${mapa ? `<a class="accion" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([e.direccion, mapa, "Chile"].filter(Boolean).join(", "))}" target="_blank" rel="noopener">🗺 Cómo llegar</a>` : ""}
    <button type="button" class="accion" data-accion="compartir" data-id="${esc(e.id)}">↗ Compartir</button>
  </div>`;
}

function imagen(e, clase, ancho) {
  const src = urlSegura(e.imagen);
  if (!src) return "";
  return `<img class="${clase}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="${ancho}" onerror="this.remove()">`;
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
  const n = EVENTOS.filter((e) => NUEVOS.has(e.id) && fecha(e.fecha_fin || e.fecha_inicio) >= hoy()).length;
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
  if (estado.soloNuevos || estado.texto || estado.cat === "guardados" || lista.length < 3) { cont.innerHTML = ""; return; }
  const conFoto = lista.filter((e) => urlSegura(e.imagen));
  const elegidos = (conFoto.length >= 3 ? conFoto : lista).slice(0, 3);
  const [p, ...s] = elegidos;
  const enlace = (e) => urlSegura(e.url) || "#";
  cont.innerHTML = `
    <article class="principal">
      ${imagen(p, "foto", 800)}
      <p class="cuando-grande">${esc(cuandoRelativo(p))}</p>
      ${antetitulo(p)}
      <h2><a href="${esc(enlace(p))}" target="_blank" rel="noopener">${esc(p.titulo)}</a></h2>
      ${datosLinea(p)}
      ${p.descripcion ? `<p class="desc">${esc(p.descripcion)}</p>` : ""}
      ${acciones(p)}
    </article>
    ${s.map((e) => `
    <article class="secundaria">
      ${imagen(e, "foto", 400)}
      <p class="cuando-grande">${esc(cuandoRelativo(e))}</p>
      <h2><a href="${esc(enlace(e))}" target="_blank" rel="noopener">${esc(e.titulo)}</a></h2>
      ${datosLinea(e)}
    </article>`).join("")}`;
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
    html += `<h2 class="mes">${esc(mes)}</h2>`;
    for (const e of evs) {
      const i = fecha(e.fecha_inicio);
      const enCurso = i < h;
      const foto = imagen(e, "miniatura", 180);
      html += `<article class="nota${foto ? "" : " sin-foto"}" id="e-${esc(e.id)}">
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
          ${acciones(e)}
        </div>
        ${foto}
      </article>`;
    }
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

// ---------- acciones ----------
function porId(id) { return EVENTOS.find((e) => e.id === id); }

function icsTexto(e) {
  const limpio = (t) => String(t || "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
  const d = (iso) => iso.replace(/-/g, "");
  const ahora = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//El Pregonero//ES", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
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
  const chip = ev.target.closest(".chip");
  if (chip) {
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
  const e = porId(btn.dataset.id);
  if (!e) return;
  if (btn.dataset.accion === "guardar") {
    if (guardados.has(e.id)) { guardados.delete(e.id); avisar("Quitado de guardados"); }
    else { guardados.add(e.id); avisar("Guardado ★"); }
    escribirGuardados(); pintarChips(); pintar();
  } else if (btn.dataset.accion === "calendario") {
    descargarIcs(e);
  } else if (btn.dataset.accion === "compartir") {
    compartir(e);
  }
});

let espera;
$("#buscar").addEventListener("input", (ev) => {
  clearTimeout(espera);
  espera = setTimeout(() => { estado.texto = ev.target.value; pintar(); }, 150);
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
  const params = new URLSearchParams(location.search);
  if (params.get("ver") === "guardados") estado.cat = "guardados";
  if (params.get("ver") === "nuevos") estado.soloNuevos = true;
  try {
    const [cfg, datos] = await Promise.all([cargarJson("config/gustos.json"), cargarJson("data/eventos.json")]);
    ORDEN_CATS = cfg.categorias;
    CATS = Object.fromEntries(cfg.categorias.map((c) => [c.id, c]));
    EVENTOS = datos.eventos || [];
    ULTIMA = datos.ultima_busqueda || {};
    if (Array.isArray(ULTIMA.nuevos_ids)) {
      NUEVOS = new Set(ULTIMA.nuevos_ids);
    } else if (ULTIMA.fecha && ULTIMA.eventos_nuevos) {
      // búsquedas antiguas sin lista de id: lo agregado ese mismo día
      const dia = ULTIMA.fecha.slice(0, 10);
      NUEVOS = new Set(EVENTOS.filter((e) => e.agregado === dia).map((e) => e.id));
    }
    pintarCabecera(datos);
  } catch (err) {
    $("#estado-busqueda").textContent = "No se pudo cargar la agenda";
    console.error(err);
  }
  pintarChips();
  pintar();
  if (location.hash.startsWith("#e-")) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
}
iniciar();
