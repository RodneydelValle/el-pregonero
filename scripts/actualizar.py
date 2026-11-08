#!/usr/bin/env python3
"""IMP TRAVEL (antes El Pregonero): busca eventos en Chile según config/gustos.json y actualiza data/eventos.json.

Solo usa servicios gratuitos:
  * Búsqueda: Bing Noticias (RSS), DuckDuckGo, ticketeras, agendas (sitemaps de VAMOH! y Keai)
    y páginas de entradas (TUU, Passline...). Todo lo que trae datos estructurados se lee sin IA.
  * IA: Gemini, plan gratis de Google AI Studio (con límite diario). Lee el texto y también
    las imágenes (afiches), porque muchas veces la fecha y el lugar solo están ahí.

Uso:
  python scripts/actualizar.py                 # búsqueda completa
  python scripts/actualizar.py --modo auto     # GitHub Actions, cada hora: la completa si ya pasaron
                                               # "horas_entre_completas"; si no, la rápida (solo ticketeras y agendas)
  python scripts/actualizar.py --sin-ia        # solo fuentes que no necesitan IA
  python scripts/actualizar.py --agregar x.json --origen claude   # une eventos encontrados a mano
  python scripts/actualizar.py --limpiar       # solo quita eventos pasados y ocultos
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import email.utils
import gzip
import hashlib
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from html.parser import HTMLParser
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DATA = RAIZ / "data"
CONFIG = RAIZ / "config" / "gustos.json"
ARCH_EVENTOS = DATA / "eventos.json"
ARCH_VISTOS = DATA / "vistos.json"
ARCH_OCULTOS = DATA / "ocultos.json"
URL_IA = "https://models.github.ai/inference/chat/completions"
# Se identifica tal cual es: una agenda personal que lee pocas páginas al día.
UA = "Mozilla/5.0 (compatible; ElPregonero/1.0; agenda personal; +https://github.com/RodneydelValle/el-pregonero)"
UA_ROBOTS = "ElPregonero"

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/Santiago")
except Exception:  # sin base de zonas horarias (Windows sin tzdata)
    TZ = dt.timezone(dt.timedelta(hours=-3))

try:
    from PIL import Image  # opcional: achica los afiches antes de mandarlos a la IA
except Exception:
    Image = None

HOY = dt.datetime.now(TZ).date()
HORAS_NUEVOS = 24   # el botón "Nuevos" muestra lo agregado en las últimas 24 horas
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]
DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
RE_FECHA_TEXTO = re.compile(
    r"\b(\d{1,2})\s*(?:de\s+)?(" + "|".join(MESES) + r"|setiembre)\b(?:\s*(?:de|del)?\s*(\d{4}))?",
    re.I)


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- utilidades de texto

def sin_tildes(t: str) -> str:
    t = unicodedata.normalize("NFKD", t or "")
    return "".join(c for c in t if not unicodedata.combining(c)).lower()


RE_SURROGATE = re.compile("[\ud800-\udfff]")


def sin_surrogates(t: str) -> str:
    """Repara las letras partidas por la mitad. Algunos sitios recortan sus textos en JavaScript justo en medio de
    una letra «decorada» (𝐅𝐄𝐒𝐓) o de un emoji, y su JSON trae la mitad suelta ("\\ud835"). Con eso Python no puede
    escribir el archivo en UTF-8 y se perdía la búsqueda completa (8-11-2026). Junta las mitades que vienen
    seguidas y borra las que quedaron solas."""
    if not RE_SURROGATE.search(t):
        return t
    t = t.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    return RE_SURROGATE.sub("", t)


def limpiar(t) -> str:
    if t is None:
        return ""
    t = sin_surrogates(html.unescape(str(t)))
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def palabras_titulo(t: str) -> set[str]:
    vacias = {"de", "la", "el", "los", "las", "en", "y", "del", "a", "un", "una", "con", "por",
              "para", "al", "the", "of", "and", "chile", "santiago", "2025", "2026", "2027",
              "tour", "show", "concierto", "evento", "festival", "feria"}
    return {w for w in re.findall(r"[a-z0-9]+", sin_tildes(t)) if len(w) > 1 and w not in vacias}


def parecido(a: str, b: str) -> float:
    x, y = palabras_titulo(a), palabras_titulo(b)
    if not x or not y:
        return 0.0
    return len(x & y) / len(x | y)


def fecha_iso(valor) -> str | None:
    if not valor:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(valor))
    if not m:
        return None
    try:
        return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:
        return None


def a_hora_chile(valor) -> dt.datetime | None:
    """'2026-11-09T02:59:59.999Z' → fecha y hora en Chile (las páginas suelen dar la hora en UTC)."""
    s = str(valor or "").strip()
    if "T" not in s:
        return None
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.astimezone(TZ) if d.tzinfo else d


def hora_hhmm(valor) -> str | None:
    if not valor:
        return None
    m = re.search(r"(\d{1,2})[:.h](\d{2})", str(valor))
    if not m or int(m[1]) > 23 or int(m[2]) > 59:
        return None
    return f"{int(m[1]):02d}:{m[2]}"


def fechas_desde_texto(texto: str) -> list[dt.date]:
    """Convierte '06 de noviembre 2026' (y similares) en fechas. Si falta el año, usa el próximo."""
    res = []
    for d, mes, anio in RE_FECHA_TEXTO.findall(texto or ""):
        mes = "septiembre" if mes.lower() == "setiembre" else mes.lower()
        n_mes = MESES.index(mes) + 1
        a = int(anio) if anio else HOY.year
        try:
            f = dt.date(a, n_mes, int(d))
        except ValueError:
            continue
        if not anio and f < HOY - dt.timedelta(days=31):
            f = f.replace(year=a + 1)
        res.append(f)
    return res


# ---------------------------------------------------------------- red

def descargar(url: str, binario=False, max_bytes=4_000_000, timeout=25, intentos=2, revisar_robots=True):
    if revisar_robots and not binario and not permitido(url):
        raise NoPermitido(f"robots.txt no permite leer {url}")
    ultimo = None
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept-Language": "es-CL,es;q=0.9,en;q=0.6",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
                "Accept-Encoding": "gzip, deflate",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                datos = r.read(max_bytes + 1)
                tipo = r.headers.get("Content-Type", "") or ""
                final = r.geturl()
                enc = (r.headers.get("Content-Encoding") or "").lower()
            if enc == "gzip":
                datos = gzip.decompress(datos)
            elif enc == "deflate":
                datos = zlib.decompress(datos)
            if binario:
                if len(datos) > max_bytes:
                    return None, tipo, final
                return datos, tipo, final
            m = re.search(r"charset=([\w-]+)", tipo, re.I)
            juego = m.group(1) if m else "utf-8"
            try:
                texto = datos.decode(juego, errors="replace")
            except LookupError:
                texto = datos.decode("utf-8", errors="replace")
            return texto, tipo, final
        except Exception as e:  # noqa: BLE001
            ultimo = e
            time.sleep(1.5 * (i + 1))
    raise ultimo


def dominio(url: str) -> str:
    d = urllib.parse.urlparse(url).netloc.lower()
    return d[4:] if d.startswith("www.") else d


_ROBOTS: dict[str, object] = {}


def permitido(url: str) -> bool:
    """Respeta robots.txt de cada sitio (si no se puede leer, se asume permitido)."""
    import urllib.robotparser
    p = urllib.parse.urlparse(url)
    base = f"{p.scheme}://{p.netloc}"
    if base not in _ROBOTS:
        rp = urllib.robotparser.RobotFileParser()
        try:
            texto, _, _ = descargar(base + "/robots.txt", timeout=10, intentos=1, revisar_robots=False)
            rp.parse(texto.splitlines())
        except Exception:  # noqa: BLE001
            rp = None
        _ROBOTS[base] = rp
    rp = _ROBOTS[base]
    return True if rp is None else rp.can_fetch(UA_ROBOTS, url)


class NoPermitido(Exception):
    pass


# ---------------------------------------------------------------- búsqueda

def buscar_bing(consulta: str, tipo: str = "noticias") -> list[dict]:
    """Bing Noticias por RSS (su robots.txt lo permite; la búsqueda web de Bing no, así que no se usa)."""
    url = "https://www.bing.com/news/search?" + urllib.parse.urlencode(
        {"q": consulta, "format": "rss", "setlang": "es-CL", "cc": "CL", "mkt": "es-CL"})
    texto, _, _ = descargar(url)
    res = []
    try:
        raiz = ET.fromstring(texto.encode("utf-8", errors="replace"))
    except ET.ParseError:
        return res
    for item in raiz.iter("item"):
        enlace = (item.findtext("link") or "").strip()
        if "apiclick.aspx" in enlace:
            enlace = urllib.parse.parse_qs(urllib.parse.urlparse(enlace).query).get("url", [enlace])[0]
        if not enlace.startswith("http"):
            continue
        res.append({
            "url": enlace,
            "titulo": limpiar(item.findtext("title")),
            "resumen": limpiar(item.findtext("description")),
            "publicado": (item.findtext("pubDate") or "").strip(),
            "origen": f"bing-{tipo}",
            "consulta": consulta,
        })
    return res


def buscar_ddg(consulta: str) -> list[dict]:
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": consulta, "kl": "cl-es"})
    texto, _, _ = descargar(url)
    res = []
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?'
                         r'class="result__snippet"[^>]*>(.*?)</(?:a|td|div)>', texto, re.S):
        enlace = html.unescape(m.group(1))
        if "uddg=" in enlace:
            enlace = urllib.parse.parse_qs(urllib.parse.urlparse(enlace).query).get("uddg", [enlace])[0]
        if enlace.startswith("//"):
            enlace = "https:" + enlace
        if "duckduckgo.com/y.js" in enlace or "ad_domain=" in enlace:  # avisos pagados
            continue
        if enlace.startswith("http"):
            res.append({"url": enlace, "titulo": limpiar(m.group(2)), "resumen": limpiar(m.group(3)),
                         "publicado": "", "origen": "duckduckgo", "consulta": consulta})
    return res


# ---------------------------------------------------------------- lectura de páginas

class Lector(HTMLParser):
    BLOQUES = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "section",
               "article", "time", "td", "dd", "dt", "figcaption", "blockquote", "ul", "ol", "table"}

    def __init__(self, saltar: set[str]):
        super().__init__(convert_charrefs=True)
        self.saltar_tags = saltar
        self.nivel = 0
        self.partes: list[str] = []
        self.imagenes: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.saltar_tags:
            self.nivel += 1
            return
        if tag in self.BLOQUES:
            self.partes.append("\n")
        if tag == "img" and self.nivel == 0:
            a = dict(attrs)
            src = a.get("data-src") or a.get("data-lazy-src") or a.get("src") or ""
            srcset = a.get("data-srcset") or a.get("srcset") or ""
            if srcset:
                ultimo = srcset.split(",")[-1].strip().split(" ")[0]
                if ultimo:
                    src = ultimo
            if src and not src.startswith("data:"):
                self.imagenes.append({"src": src, "alt": a.get("alt") or "",
                                      "ancho": a.get("width") or "", "alto": a.get("height") or ""})

    def handle_startendtag(self, tag, attrs):
        if tag in self.saltar_tags:
            return
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in self.saltar_tags:
            self.nivel = max(0, self.nivel - 1)
        elif tag in self.BLOQUES:
            self.partes.append("\n")

    def handle_data(self, data):
        if self.nivel == 0:
            self.partes.append(data)

    def texto(self) -> str:
        lineas, previa = [], None
        for l in "".join(self.partes).split("\n"):
            l = re.sub(r"\s+", " ", l).strip()
            if l and l != previa:
                lineas.append(l)
            previa = l
        return "\n".join(lineas)


def leer_html(pagina: str):
    for saltar in ({"script", "style", "noscript", "svg", "nav", "footer", "header", "form",
                    "iframe", "template", "select", "button"},
                   {"script", "style", "noscript", "svg", "template"}):
        lector = Lector(saltar)
        try:
            lector.feed(pagina)
        except Exception:  # noqa: BLE001
            pass
        txt = lector.texto()
        if len(txt) > 300:
            return txt, lector.imagenes
    return txt, lector.imagenes


def metadatos(pagina: str) -> dict:
    meta = {}
    for m in re.finditer(r"<meta\s[^>]*>", pagina, re.I):
        etiqueta = m.group(0)
        clave = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', etiqueta, re.I)
        valor = re.search(r'content\s*=\s*["\']([^"\']*)["\']', etiqueta, re.I)
        if clave and valor:
            meta.setdefault(clave.group(1).lower(), html.unescape(valor.group(1)))
    t = re.search(r"<title[^>]*>(.*?)</title>", pagina, re.I | re.S)
    meta["_title"] = limpiar(t.group(1)) if t else ""
    return meta


CLAVES_FECHA_PUBLICACION = ("article:published_time", "article:modified_time", "og:published_time",
                            "og:updated_time", "datepublished", "datemodified", "date", "pubdate", "publishdate",
                            "publish-date", "sailthru.date", "parsely-pub-date", "dc.date", "dcterms.date",
                            "dcterms.modified", "cxenseparse:recs:publishtime")


def fecha_publicacion(pagina: str, meta: dict) -> dt.date | None:
    """Fecha en que se publicó (o actualizó por última vez) una noticia; None si la página no la dice."""
    fechas = [fecha_iso(meta.get(k)) for k in CLAVES_FECHA_PUBLICACION]
    for bloque in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                             pagina, re.S | re.I):
        fechas += [fecha_iso(v) for v in re.findall(r'"date(?:Published|Modified)"\s*:\s*"([^"]+)"', bloque)]
    fechas += [fecha_iso(v) for v in re.findall(
        r'<time[^>]+datetime=["\'](\d{4}-\d{2}-\d{2})[^"\']*["\'][^>]*(?:pubdate|itemprop=["\']datePublished)',
        pagina, re.I)]
    fechas = [dt.date.fromisoformat(f) for f in fechas if f]
    return max(fechas) if fechas else None


def es_pagina_de_evento(url: str) -> bool:
    d = dominio(url)
    ruta = urllib.parse.urlparse(url).path.lower()
    return (any(d == x or d.endswith("." + x) for x in DOMINIOS_ENTRADAS)
            or bool(re.search(r"/(evento|eventos|events?|panorama|panoramas)/.", ruta)))


def noticia_vieja(c: dict, desde: dt.date) -> bool:
    """Sin abrir la página: ¿el buscador o la dirección ya muestran que es una noticia de antes de `desde`?"""
    publicado = c.get("publicado")
    if publicado:
        try:
            if email.utils.parsedate_to_datetime(publicado).date() < desde:
                return True
        except (TypeError, ValueError):
            pass
    ruta = urllib.parse.urlparse(c["url"]).path
    m = re.search(r"/(20\d\d)/(\d{1,2})(?:/(\d{1,2}))?/", ruta)
    if m and 1 <= int(m[2]) <= 12:
        anio, mes = int(m[1]), int(m[2])
        if m[3]:
            try:
                return dt.date(anio, mes, int(m[3])) < desde
            except ValueError:
                pass
        return (anio, mes) < (desde.year, desde.month)
    anios = [int(a) for a in re.findall(r"/(20[0-3]\d)/", ruta)]
    if anios and max(anios) < desde.year:
        return True
    anios = [int(a) for a in re.findall(r"\b(20[0-3]\d)\b", c.get("titulo") or "")]
    return bool(anios) and max(anios) < HOY.year


def texto_relevante(texto: str, patron: re.Pattern, maximo=4200) -> str:
    if len(texto) <= maximo:
        return texto
    lineas = texto.split("\n")
    elegidas = set(range(min(len(lineas), 12)))
    for i, l in enumerate(lineas):
        if patron.search(sin_tildes(l)):
            elegidas.update(range(max(0, i - 4), min(len(lineas), i + 6)))
    salida, total, previo = [], 0, -2
    for i in sorted(elegidas):
        if i != previo + 1:
            salida.append("[…]")
        salida.append(lineas[i])
        total += len(lineas[i]) + 1
        previo = i
        if total > maximo:
            break
    return "\n".join(salida)[:maximo]


# ---------------------------------------------------------------- datos estructurados (JSON-LD)

def _recorrer(nodo):
    if isinstance(nodo, dict):
        yield nodo
        for v in nodo.values():
            yield from _recorrer(v)
    elif isinstance(nodo, list):
        for v in nodo:
            yield from _recorrer(v)


def _es_evento(d: dict) -> bool:
    t = d.get("@type")
    tipos = t if isinstance(t, list) else [t]
    return any(isinstance(x, str) and x.endswith("Event") for x in tipos) and bool(d.get("startDate"))


def _urls_imagen(img) -> list[str]:
    """Todas las imágenes de un campo "image" de JSON-LD (texto, objeto o lista), sin repetir."""
    res: list[str] = []
    for x in img if isinstance(img, list) else [img]:
        if isinstance(x, dict):
            x = x.get("url") or x.get("contentUrl")
        if isinstance(x, str) and x.startswith("http") and x not in res:
            res.append(x)
    return res


def eventos_jsonld(pagina: str, url_base: str) -> list[dict]:
    res = []
    for bloque in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                             pagina, re.S | re.I):
        bloque = bloque.strip().replace("<!--", "").replace("-->", "")
        try:
            datos = json.loads(bloque)
        except json.JSONDecodeError:
            try:  # algunos sitios dejan saltos de línea sin escapar dentro de los textos
                datos = json.loads(bloque, strict=False)
            except json.JSONDecodeError:
                continue
        for d in _recorrer(datos):
            if not _es_evento(d):
                continue
            if "Online" in str(d.get("eventAttendanceMode", "")):
                continue
            lugar = d.get("location") or {}
            if isinstance(lugar, list):
                lugar = lugar[0] if lugar else {}
            nombre_lugar, direccion, comuna, pais = "", "", "", ""
            if isinstance(lugar, dict):
                nombre_lugar = limpiar(lugar.get("name"))
                adr = lugar.get("address") or {}
                if isinstance(adr, dict):
                    direccion = limpiar(adr.get("streetAddress"))
                    comuna = limpiar(adr.get("addressLocality"))
                    pais = limpiar(adr.get("addressCountry") if not isinstance(adr.get("addressCountry"), dict)
                                   else adr["addressCountry"].get("name"))
                else:
                    direccion = limpiar(adr)
            elif isinstance(lugar, str):
                nombre_lugar = limpiar(lugar)
            if pais and sin_tildes(pais) not in ("cl", "chile"):
                continue
            if comuna and sin_tildes(comuna) == sin_tildes(nombre_lugar):  # Passline repite el lugar como comuna
                comuna = ""
            precio = None
            ofertas = d.get("offers")
            if isinstance(ofertas, list):
                ofertas = ofertas[0] if ofertas else None
            if isinstance(ofertas, dict):
                p = ofertas.get("lowPrice") or ofertas.get("price")
                try:
                    if p is not None and float(p) == 0:
                        precio = "Gratis"
                    elif p is not None:
                        precio = f"Desde ${int(float(p)):,}".replace(",", ".")
                except (TypeError, ValueError):
                    pass
            imagenes = _urls_imagen(d.get("image"))
            inicio, termino = str(d.get("startDate")), d.get("endDate")
            di, df = a_hora_chile(inicio), a_hora_chile(termino)
            if di and (di.hour or di.minute):
                hora = di.strftime("%H:%M")
            else:
                hora = hora_hhmm(inicio[10:]) if "T" in inicio and not di else None
            res.append({
                "titulo": limpiar(d.get("name")),
                "fecha_inicio": di.date().isoformat() if di else fecha_iso(inicio),
                "fecha_fin": df.date().isoformat() if df else fecha_iso(termino),
                "hora": hora,
                "_texto": f'{limpiar(d.get("name"))} {limpiar(d.get("description"))[:3000]}',
                "lugar": nombre_lugar or None,
                "direccion": direccion or None,
                "comuna": comuna or None,
                "precio": precio,
                "descripcion": limpiar(d.get("description"))[:240] or None,
                "imagen": imagenes[0] if imagenes else None,
                "fotos": imagenes[1:5],  # si la página trae más fotos del evento, la web las muestra en su galería
                "url": urllib.parse.urljoin(url_base, d.get("url") or url_base),
                "desde_imagen": False,
                "confianza": "alta",
            })
    return res


def texto_plano(pagina: str) -> str:
    t = re.sub(r"<(script|style|noscript|svg|template)\b.*?</\1>", " ", pagina, flags=re.S | re.I)
    return limpiar(t)


MESES_CORTOS = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7, "ago": 8,
                "sep": 9, "set": 9, "oct": 10, "nov": 11, "dic": 12}
RE_TUU = re.compile(r"\b(Comienza|Finaliza) el (\d{1,2}) ([a-zé]{3,10})\.? (\d{4}),? (\d{1,2}):(\d{2})(?::\d{2})? UTC",
                    re.I)


def eventos_tuu(pagina: str, meta: dict, url: str) -> list[dict]:
    """Entradas de TUU (tuu.cl), muy usado por comunidades: no traen datos estructurados,
    pero siempre dicen 'Comienza el 7 nov 2026, 14:00:00 UTC ... Ubicación ...'."""
    texto = texto_plano(pagina)
    fechas = {}
    for tipo, d, mes, anio, h, m in RE_TUU.findall(texto):
        n = MESES_CORTOS.get(sin_tildes(mes)[:3])
        if not n:
            continue
        try:
            f = dt.datetime(int(anio), n, int(d), int(h), int(m), tzinfo=dt.timezone.utc).astimezone(TZ)
        except ValueError:
            continue
        fechas.setdefault(tipo.lower(), f)
    ini, fin = fechas.get("comienza"), fechas.get("finaliza")
    if not ini or not meta.get("og:title"):
        return []
    m = re.search(r"Ubicaci[oó]n\s+(.{5,160}?)\s+(?:Elige tus tickets|Comparte|Organiza|Preguntas|$)", texto)
    direccion = m.group(1).strip() if m else None
    comuna = None
    for parte in (direccion or "").split(",")[1:]:  # "Av. Irarrázaval 4055, 7760077 Ñuñoa, Región Metropolitana, Chile"
        parte = re.sub(r"^\s*\d{5,7}\s*", "", parte).strip()
        if parte and not re.match(r"(?i)regi[oó]n|chile$", parte):
            comuna = parte
            break
    precios = [int(x.replace(".", "")) for x in re.findall(r"\$\s?(\d{1,3}(?:\.\d{3})+|\d+)\s*CLP", texto)]
    precios = [p for p in precios if p > 0]
    descripcion = meta.get("og:description") or meta.get("description") or ""
    return [{
        "titulo": limpiar(meta["og:title"]),
        "fecha_inicio": ini.date().isoformat(),
        "fecha_fin": fin.date().isoformat() if fin else None,
        "hora": ini.strftime("%H:%M"),
        "_texto": f'{meta["og:title"]} {descripcion}',
        "lugar": None,
        "direccion": direccion,
        "comuna": comuna,
        "precio": f"Desde ${min(precios):,}".replace(",", ".") if precios else None,
        "descripcion": limpiar(descripcion)[:240] or None,
        "imagen": meta.get("og:image"),
        "url": url,
        "desde_imagen": False,
        "confianza": "alta",
    }]


# ---------------------------------------------------------------- imágenes (afiches)

RE_IMG_MALA = re.compile(r"logo|icon|favicon|avatar|sprite|pixel|gravatar|emoji|badge|placeholder|"
                         r"blank|spacer|loader|\.svg|\.gif", re.I)


def preparar_imagen(url: str):
    """Descarga y achica una imagen. Devuelve (data_url, ancho, alto) o None."""
    try:
        datos, tipo, _ = descargar(url, binario=True, max_bytes=8_000_000, timeout=20, intentos=1)
    except Exception:  # noqa: BLE001
        return None
    if not datos:
        return None
    if Image is None:
        if "image" not in tipo:
            return None
        return url, 0, 0  # sin Pillow, la IA la descarga directo
    try:
        im = Image.open(io.BytesIO(datos))
        im.load()
    except Exception:  # noqa: BLE001
        return None
    ancho, alto = im.size
    if min(ancho, alto) < 300:
        return None
    im = im.convert("RGB")
    im.thumbnail((1024, 1024))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), ancho, alto


def elegir_imagenes(meta: dict, imgs: list[dict], url_base: str, maximo=2):
    candidatas = []
    for clave in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"):
        if meta.get(clave):
            candidatas.append(meta[clave])
    for i in imgs:
        if RE_IMG_MALA.search(i["src"]):
            continue
        try:
            if i["ancho"] and int(re.sub(r"\D", "", i["ancho"]) or 0) < 250:
                continue
        except ValueError:
            pass
        candidatas.append(i["src"])
    vistas, finales = set(), []
    for c in candidatas:
        c = urllib.parse.urljoin(url_base, html.unescape(c.strip()))
        if not c.startswith("http") or c in vistas:
            continue
        vistas.add(c)
        finales.append(c)
    elegidas, portada = [], None
    for url in finales[:7]:
        p = preparar_imagen(url)
        if not p:
            continue
        if portada is None:
            portada = url
        elegidas.append((p[1] * p[2], p[0], url))
        if len(elegidas) >= 4:
            break
    if not elegidas:
        return portada, []
    primera = elegidas[0]
    resto = sorted(elegidas[1:], key=lambda x: -x[0])
    seleccion = [primera] + resto
    return portada, [s[1] for s in seleccion[:maximo]]


# ---------------------------------------------------------------- IA (GitHub Models)

class SinCupo(Exception):
    pass


class IA:
    """Cliente de IA compatible con la API de OpenAI (por defecto, Gemini gratis de Google AI Studio).

    Se configura en config/gustos.json -> "ia". Elige solo un modelo disponible, se adapta si el
    proveedor rechaza algún parámetro y se detiene al llegar al cupo gratis del día.
    """

    def __init__(self, conf: dict | None, clave: str | None, maximo: int):
        conf = conf or {}
        self.url = conf.get("url", URL_IA)
        self.base = self.url.rsplit("/chat/completions", 1)[0]
        self.preferidos = list(conf.get("modelos") or ["openai/gpt-4.1-mini"])
        self.modelo = self.preferidos[0]
        self.modelo_elegido = False
        self.pausa = float(conf.get("pausa_s", 4.3))
        self.extra = dict(conf.get("extra") or {})
        self.modo_json = bool(conf.get("modo_json", False))
        self.token = clave
        self.maximo = maximo
        self.usadas = 0
        self.buenas = 0
        self.agotada = not clave
        self.ultima = 0.0
        self.sin_cupo: set[str] = set()

    def disponible(self) -> bool:
        return not self.agotada and self.usadas < self.maximo

    def elegir_modelo(self):
        """Pregunta qué modelos hay y usa el primero de la lista de preferidos (o un 'flash' cualquiera)."""
        if self.modelo_elegido or not self.token:
            return
        self.modelo_elegido = True
        try:
            req = urllib.request.Request(self.base + "/models", headers={"Authorization": f"Bearer {self.token}"})
            with urllib.request.urlopen(req, timeout=30) as r:
                datos = json.loads(r.read().decode("utf-8"))
            ids = [str(m.get("id", "")).replace("models/", "") for m in datos.get("data", [])]
        except Exception as e:  # noqa: BLE001
            log(f"  IA: no pude ver la lista de modelos ({e}); uso {self.modelo}")
            return
        for m in self.preferidos:
            if m in ids:
                self.modelo = m
                break
        else:
            flash = [i for i in ids if "flash" in i and not re.search(r"image|tts|audio|live|embed|thinking", i)]
            if flash:
                self.modelo = sorted(flash, key=lambda i: ("preview" in i or "exp" in i, "lite" in i))[0]
        # respaldo: los preferidos disponibles y después cualquier otro "flash" de texto (por si alguno se satura)
        otros_flash = sorted((i for i in ids if "flash" in i and not re.search(r"image|tts|audio|live|embed|thinking", i)),
                             key=lambda i: ("preview" in i or "exp" in i, "lite" in i))
        self.preferidos = [self.modelo] + [m for m in self.preferidos if m != self.modelo and m in ids]
        self.preferidos += [m for m in otros_flash if m not in self.preferidos][:4]
        flash_txt = ", ".join(i for i in ids if "flash" in i)[:300]
        log(f"  IA: modelo {self.modelo} (con 'flash' disponibles: {flash_txt})")

    @staticmethod
    def _parsear(txt: str):
        """Saca el JSON de la respuesta aunque venga con ``` o con texto alrededor."""
        txt = re.sub(r"^\s*```(?:json)?|```\s*$", "", txt or "").strip()
        if not txt:
            return None
        try:
            return json.loads(txt)
        except json.JSONDecodeError:
            a, b = txt.find("{"), txt.rfind("}")
            if a >= 0 and b > a:
                try:
                    return json.loads(txt[a:b + 1])
                except json.JSONDecodeError:
                    return None
            return None

    def json(self, sistema: str, contenido, max_tokens=4000) -> dict:
        if not self.disponible():
            raise SinCupo()
        self.elegir_modelo()
        for _ in range(6):
            cuerpo = {"model": self.modelo, "temperature": 0.1, "max_tokens": max_tokens,
                      "messages": [{"role": "system", "content": sistema},
                                   {"role": "user", "content": contenido}], **self.extra}
            if self.modo_json:
                cuerpo["response_format"] = {"type": "json_object"}
            espera = self.pausa - (time.time() - self.ultima)  # respeta el límite por minuto del plan gratis
            if espera > 0:
                time.sleep(espera)
            self.ultima = time.time()
            req = urllib.request.Request(self.url, data=json.dumps(cuerpo).encode(), headers={
                "Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=150) as r:
                    bruto = r.read().decode("utf-8", errors="replace")
            except urllib.error.HTTPError as e:
                detalle = e.read().decode("utf-8", errors="replace")[:600]
                d = detalle.lower()
                if e.code == 429:
                    pausa = int(float(e.headers.get("retry-after") or 60))
                    if pausa > 180 or "day" in d or "diar" in d:
                        # En el plan gratis cada modelo tiene su propio cupo diario: se pasa al siguiente
                        self.sin_cupo.add(self.modelo)
                        restantes = [m for m in self.preferidos if m not in self.sin_cupo]
                        if restantes:
                            log(f"  IA: {self.modelo} agotó su cupo gratis de hoy; sigo con {restantes[0]}")
                            self.modelo = restantes[0]
                            continue
                        log(f"  IA: se acabó el cupo gratis de hoy en todos los modelos ({detalle[:120]})")
                        self.agotada = True
                        raise SinCupo()
                    log(f"  IA: límite por minuto, espero {pausa}s")
                    time.sleep(pausa)
                    continue
                if e.code in (401, 403) or "api key" in d or "api_key" in d:
                    log(f"  IA: la clave no sirve o no tiene permiso ({e.code}): {detalle[:200]}")
                    self.agotada = True
                    raise SinCupo()
                if e.code in (400, 404):
                    quitado = [k for k in list(self.extra) if k in d]
                    for k in quitado:
                        self.extra.pop(k)
                    if self.modo_json and "response_format" in d:
                        self.modo_json = False
                        quitado.append("response_format")
                    if quitado:
                        log(f"  IA: el proveedor no acepta {', '.join(quitado)}; sigo sin eso")
                        continue
                    if "model" in d and len(self.preferidos) > 1:
                        self.preferidos.pop(0)
                        self.modelo = self.preferidos[0]
                        log(f"  IA: pruebo con el modelo {self.modelo}")
                        continue
                if e.code in (500, 502, 503, 504) or "unavailable" in d or "overloaded" in d:
                    # Modelo saturado ("high demand"): se pasa al siguiente modelo de la lista
                    if len(self.preferidos) > 1:
                        self.preferidos.append(self.preferidos.pop(0))
                        self.modelo = self.preferidos[0]
                        log(f"  IA: modelo saturado ({e.code}); cambio a {self.modelo}")
                        time.sleep(3)
                    else:
                        log(f"  IA: modelo saturado ({e.code}); espero 20 s")
                        time.sleep(20)
                    continue
                if e.code == 413 or ("token" in d and re.search(r"exceed|too long|too large|maximum", d)):
                    raise ValueError("contenido demasiado largo") from e
                log(f"  IA: error {e.code}: {detalle[:240]}")
                time.sleep(5)
                continue
            except Exception as e:  # noqa: BLE001
                log(f"  IA: fallo de red ({e})")
                time.sleep(5)
                continue
            self.usadas += 1
            if bruto.strip() == "OK":
                # Así responde GitHub Models desde nov. 2026: servicio sin contenido
                log("  IA: el servicio responde 'OK' sin contenido; sigo sin IA")
                self.agotada = True
                raise SinCupo()
            try:
                datos = json.loads(bruto)
                eleccion = datos["choices"][0]
                txt = eleccion["message"].get("content") or ""
                fin = eleccion.get("finish_reason")
            except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                log(f"  IA: respuesta rara del servidor: {bruto[:300]!r}")
                return {}
            res = self._parsear(txt)
            if isinstance(res, dict):
                self.buenas += 1
                return res
            log(f"  IA: no vino JSON (fin={fin}): {txt[:240]!r}")
            if self.modo_json and self.buenas == 0:
                self.modo_json = False
                log("  IA: sigo sin el modo JSON (las instrucciones ya piden responder en JSON)")
                continue
            return {}
        return {}


def instrucciones_base(cfg: dict) -> str:
    cats = "\n".join(f'- "{c["id"]}": {c["nombre"]} ({c["descripcion"]})' for c in cfg["categorias"])
    return (
        f"Eres el editor de una agenda personal de eventos en {cfg['zona']}. "
        f"Hoy es {DIAS[HOY.weekday()]} {HOY.isoformat()} (hora de Chile).\n"
        f"Intereses (usa exactamente estos id de categoría):\n{cats}\n"
        "Reglas:\n"
        "- Solo eventos presenciales en Chile que calcen claramente con algún interés.\n"
        "- Solo eventos que terminen hoy o después. Si falta el año, usa el más cercano a futuro.\n"
        "- Lee también el texto de las imágenes (afiches): ahí suelen estar la fecha, la hora, el lugar y el precio.\n"
        "- No inventes: si un dato no aparece, usa null. No confundas la fecha de publicación con la del evento.\n"
        "- Si no aparece el DÍA exacto del evento (solo el mes o el año), pon fecha_inicio null: nunca uses el día 1 "
        "ni el 1 de enero como relleno.\n"
        "- Exposiciones y muestras: fecha_inicio = día de la inauguración (si ya está abierta y no lo dice, la fecha "
        "de hoy) y fecha_fin = día exacto de cierre. Si no aparece el día de cierre, NO incluyas la exposición. "
        "El horario de visita va en 'horario' (corto, p. ej. 'Mar a dom, 10:00–18:00') y 'hora' queda null.\n"
        "- Ojo con 'Santiago' de otros países (España, Rep. Dominicana, Argentina): solo Chile.\n"
        "- Escribe en español de Chile. La descripción, máximo 200 caracteres, dice qué es y por qué calza.\n"
    )


ESQUEMA_EVENTO = (
    '{"eventos": [{"titulo": str, "categoria": id, "fecha_inicio": "AAAA-MM-DD", '
    '"fecha_fin": "AAAA-MM-DD"|null, "hora": "HH:MM"|null, "horario": str|null, "lugar": str|null, '
    '"direccion": str|null, "comuna": str|null, "ciudad": str|null, "region": str|null, '
    '"precio": str|null, "descripcion": str, "url_entradas": str|null, '
    '"desde_imagen": bool (true si la fecha o el lugar los sacaste de un afiche), '
    '"confianza": "alta"|"media"|"baja"}]}'
)


def ia_pagina(ia: IA, cfg: dict, url: str, titulo: str, texto: str, imagenes: list[str],
              max_tokens=3500) -> list[dict]:
    sistema = instrucciones_base(cfg) + "Responde solo JSON con esta forma: " + ESQUEMA_EVENTO + \
        '. Si no hay eventos que calcen, responde {"eventos": []}.'
    partes = [{"type": "text", "text": f"URL: {url}\nTítulo: {titulo}\n\nTexto de la página:\n{texto}"}]
    for i, img in enumerate(imagenes):
        partes.append({"type": "image_url", "image_url": {"url": img}})
    try:
        r = ia.json(sistema, partes, max_tokens=max_tokens)
    except ValueError:
        partes = [{"type": "text", "text": partes[0]["text"][:5000]}] + (
            [{"type": "image_url", "image_url": {"url": imagenes[0]}}] if imagenes else [])
        try:
            r = ia.json(sistema, partes, max_tokens=max_tokens)
        except ValueError:
            return []
    return (r.get("eventos") or []) if isinstance(r, dict) else []


def ia_resumenes_redes(ia: IA, cfg: dict, resultados: list[dict]) -> list[tuple[dict, dict]]:
    """Publicaciones de Instagram/Facebook vistas solo como resultado de búsqueda (título + resumen)."""
    sistema = instrucciones_base(cfg) + (
        "Recibirás resultados de búsqueda de publicaciones en redes sociales (solo título y resumen). "
        "Extrae únicamente eventos con fecha clara. Responde solo JSON: "
        '{"eventos": [{"n": número del resultado, ...campos...}]} donde los campos son los de este esquema: '
        + ESQUEMA_EVENTO + '. Si ninguno sirve: {"eventos": []}.')
    salida = []
    for i in range(0, len(resultados), 20):
        bloque = resultados[i:i + 20]
        texto = "\n\n".join(f'{i + j}. [{r["url"]}]\n{r["titulo"]}\n{r["resumen"]}' for j, r in enumerate(bloque))
        try:
            r = ia.json(sistema, texto, max_tokens=3000)
        except (ValueError, SinCupo):
            break
        for x in bloque:
            x["_revisado"] = True
        for e in (r.get("eventos") or []) if isinstance(r, dict) else []:
            try:
                n = int(e.get("n"))
            except (TypeError, ValueError):
                continue
            if 0 <= n < len(resultados):
                salida.append((resultados[n], e))
    return salida


def ia_filtrar_sueltos(ia: IA, cfg: dict, eventos: list[dict], fuente: str,
                       pendientes: list | None = None) -> list[dict]:
    """Lo que se encontró solo por palabras clave pasa por un filtro barato (una llamada cada 60 eventos):
    'esmalte sobre metal' no es música metal y un cantante llamado Manga no es manga.
    Si no hay IA o se acaba el cupo, se quedan todos; pero si se pasa 'pendientes', lo que no alcanzó a
    filtrarse por falta de cupo va ahí (para leerlo en otra vuelta) y no a la agenda."""
    if not eventos or not ia.disponible():
        return eventos
    ids = {c["id"] for c in cfg["categorias"]}
    sistema = instrucciones_base(cfg) + (
        "Recibirás eventos que una búsqueda por palabras clave encontró en una agenda; algunos calzan por casualidad "
        "(por ejemplo 'esmalte sobre metal' no es música metal, un cantante apellidado Manga no es manga, una actividad "
        "escolar o infantil no es para el usuario). Devuelve SOLO los que de verdad calzan con los intereses, con la "
        'categoría correcta. Responde solo JSON: {"eventos": [{"n": número, "categoria": id}]}. '
        'Si ninguno calza: {"eventos": []}.')
    salida = []
    for i in range(0, len(eventos), 60):
        bloque = eventos[i:i + 60]
        texto = f"Fuente: {fuente}\n" + "\n".join(
            f'{j}. {e["titulo"]} | {e.get("lugar") or e.get("comuna") or ""} | {(e.get("descripcion") or "")[:160]}'
            for j, e in enumerate(bloque))
        try:
            r = ia.json(sistema, texto, max_tokens=1500)
        except SinCupo:
            (pendientes if pendientes is not None else salida).extend(bloque)
            continue
        except ValueError:
            salida.extend(bloque)
            continue
        elegidos = set()
        for x in (r.get("eventos") or []) if isinstance(r, dict) else []:
            try:
                n = int(x.get("n"))
            except (TypeError, ValueError):
                continue
            if 0 <= n < len(bloque) and n not in elegidos:
                elegidos.add(n)
                if x.get("categoria") in ids:
                    bloque[n]["categoria"] = x["categoria"]
                salida.append(bloque[n])
        quitados = [e["titulo"] for j, e in enumerate(bloque) if j not in elegidos]
        if quitados:
            log(f"  la IA descartó {len(quitados)}: " + "; ".join(t[:40] for t in quitados[:12]))
    return salida


def ia_clasificar_listado(ia: IA, cfg: dict, fuente: str, filas: list[dict]) -> tuple[list, list[str]]:
    """Manda un listado compacto (título | lugar | fecha) y la IA dice cuáles calzan (p. ej. bandas de metal).
    Devuelve los elegidos y las direcciones de las filas que la IA alcanzó a revisar."""
    sistema = instrucciones_base(cfg) + (
        "Recibirás un listado numerado de una ticketera. Usa tu conocimiento (por ejemplo, el género de cada banda) "
        "para elegir SOLO los que calcen con los intereses. Responde solo JSON: "
        '{"eventos": [{"n": número, "categoria": id, "titulo": "nombre limpio del evento, sin lugar, fecha ni precio", '
        '"lugar": str|null, "precio": str|null, "fecha_inicio": "AAAA-MM-DD"|null, '
        '"fecha_fin": "AAAA-MM-DD"|null, "descripcion": "qué es y por qué calza, máx 160 caracteres", '
        '"confianza": "alta"|"media"|"baja"}]}. Si ninguno calza: {"eventos": []}.')
    elegidos, revisadas = [], []
    for i in range(0, len(filas), 110):
        bloque = filas[i:i + 110]
        texto = f"Fuente: {fuente}\n" + "\n".join(
            f'{i + j}. {f["titulo"]} | {f.get("lugar") or ""} | {f.get("fecha_texto") or ""}'
            for j, f in enumerate(bloque))
        try:
            r = ia.json(sistema, texto)
        except (ValueError, SinCupo):
            break
        revisadas += [f["url"] for f in bloque]
        for e in (r.get("eventos") or []) if isinstance(r, dict) else []:
            try:
                n = int(e.get("n"))
            except (TypeError, ValueError):
                continue
            if 0 <= n < len(filas):
                elegidos.append((filas[n], e))
    return elegidos, revisadas


# ---------------------------------------------------------------- fuentes fijas

def listado_puntoticket(pagina: str, base: str) -> list[dict]:
    filas = []
    for art in re.findall(r"<article[^>]*>(.*?)</article>", pagina, re.S):
        href = re.search(r'<a[^>]+href="([^"]+)"', art)
        titulo = re.search(r"<h3[^>]*>(.*?)</h3>", art, re.S)
        if not href or not titulo:
            continue
        desc = re.search(r'class="descripcion"[^>]*>(.*?)</p>', art, re.S)
        fecha = re.search(r'class="fecha"[^>]*>(.*?)</p>', art, re.S)
        img = re.search(r'<img[^>]+src="([^"]+)"[^>]*class="img--evento"', art)
        desc_txt = limpiar(desc.group(1)) if desc else ""
        lugar, _, tipo = desc_txt.partition(" / ")
        filas.append({"titulo": limpiar(titulo.group(1)), "lugar": lugar.strip() or None, "tipo": tipo.strip(),
                      "fecha_texto": limpiar(fecha.group(1)) if fecha else "",
                      "url": urllib.parse.urljoin(base, href.group(1)),
                      "imagen": img.group(1) if img else None})
    return filas


def listado_generico(pagina: str, base: str, patron: str) -> list[dict]:
    filas, vistas = [], set()
    for m in re.finditer(r'<a\s[^>]*href="([^"]*' + re.escape(patron) + r'[^"]*)"[^>]*>(.*?)</a>', pagina, re.S):
        url = urllib.parse.urljoin(base, html.unescape(m.group(1)))
        if url in vistas:
            continue
        interior = m.group(2)
        texto = limpiar(interior)
        if len(texto) < 3:
            continue
        vistas.add(url)
        img = re.search(r'<img[^>]+(?:data-src|src)="([^"]+)"', interior)
        fechas = fechas_desde_texto(texto)
        filas.append({"titulo": texto[:140], "lugar": None, "fecha_texto": texto[:200] if fechas else "",
                      "url": url, "imagen": urllib.parse.urljoin(base, img.group(1)) if img else None})
    return filas


# ---------------------------------------------------------------- almacenamiento y unión

def cargar_json(ruta: Path, defecto):
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return defecto


def guardar_json(ruta: Path, datos):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    # sin_surrogates: por si algún texto no pasó por limpiar(); una letra partida no debe botar la vuelta entera
    ruta.write_text(sin_surrogates(json.dumps(datos, ensure_ascii=False, indent=1)) + "\n", encoding="utf-8")


CAMPOS = ["titulo", "categoria", "fecha_inicio", "fecha_fin", "hora", "horario", "lugar", "direccion", "comuna",
          "ciudad", "region", "precio", "descripcion", "imagen", "fotos", "url"]
RANGO_CONFIANZA = {"baja": 0, "media": 1, "alta": 2}


MINUSCULAS = {"de", "del", "la", "las", "el", "los", "y", "e", "en", "a", "al", "con", "por", "para", "o", "u"}


def sin_gritar(t: str) -> str:
    """'NOVIEMBRE - MEDIEVAL PARTY & VELADAA' → 'Noviembre - Medieval Party & Veladaa'."""
    letras = [c for c in t if c.isalpha()]
    if len(letras) < 12 or sum(c.isupper() for c in letras) < 0.85 * len(letras):
        return t
    palabras = t.lower().split(" ")
    return " ".join(w if (i and w in MINUSCULAS) else w[:1].upper() + w[1:] for i, w in enumerate(palabras))


def url_https(u) -> str | None:
    """La web es https: una imagen http:// el navegador la pide igual por https (o no la muestra)."""
    if not isinstance(u, str) or not re.match(r"https?://", u.strip(), re.I):
        return None
    u = u.strip()
    return "https://" + u[7:] if u[:7].lower() == "http://" else u


def normalizar_evento(e: dict, cfg: dict, fuente_nombre: str, fuente_url: str, origen: str) -> dict | None:
    ids = {c["id"] for c in cfg["categorias"]}
    titulo = sin_gritar(limpiar(e.get("titulo"))[:160])
    inicio = fecha_iso(e.get("fecha_inicio"))
    if not titulo or not inicio:
        return None
    if origen.startswith("ia") and inicio[5:] == "01-01" and not re.search(
            r"enero|año nuevo|ano nuevo|01[/.-]01", sin_tildes(f"{titulo} {e.get('descripcion') or ''}")):
        return None  # "1 de enero" sin respaldo: la IA rellenó una fecha que no sabía
    fin = fecha_iso(e.get("fecha_fin"))
    if fin and fin < inicio:
        fin = None
    termino = dt.date.fromisoformat(fin or inicio)
    if termino < HOY or dt.date.fromisoformat(inicio) > HOY + dt.timedelta(days=400):
        return None
    pais = sin_tildes(str(e.get("pais") or ""))
    if pais and pais not in ("chile", "cl"):
        return None
    cat = e.get("categoria")
    if cat not in ids:
        cat = categorias_por_palabras(cfg, f"{titulo} {e.get('descripcion') or ''}")
        cat = cat[0] if cat else None
    if not cat:
        return None
    url = e.get("url_entradas") or e.get("url") or fuente_url
    if not (isinstance(url, str) and url.startswith("http")):
        url = fuente_url
    if (origen.startswith("ia") and not fin and inicio == HOY.isoformat() and cat in ("arte", "museos")
            and not hora_hhmm(e.get("hora"))):
        return None  # una muestra "abierta desde hoy" sin día de cierre: volvería cada día con otro id
    imagen = url_https(e.get("imagen"))
    fotos_in = e.get("fotos")
    fotos_in = [fotos_in] if isinstance(fotos_in, str) else fotos_in if isinstance(fotos_in, list) else []
    horario = e.get("horario")
    fotos = []
    for u in fotos_in:
        u = url_https(u)
        if u and u != imagen and u not in fotos:
            fotos.append(u)
    ev = {
        "titulo": titulo,
        "categoria": cat,
        "fecha_inicio": inicio,
        "fecha_fin": fin if fin and fin != inicio else None,
        "hora": hora_hhmm(e.get("hora")),
        "horario": (limpiar(horario)[:80] or None) if isinstance(horario, str) else None,  # horario de visita
        "lugar": limpiar(e.get("lugar"))[:120] or None,
        "direccion": limpiar(e.get("direccion"))[:160] or None,
        "comuna": limpiar(e.get("comuna"))[:60] or None,
        "ciudad": limpiar(e.get("ciudad"))[:60] or None,
        "region": limpiar(e.get("region"))[:60] or None,
        "precio": limpiar(e.get("precio"))[:80] or None,
        "descripcion": limpiar(e.get("descripcion"))[:240] or None,
        "imagen": imagen,
        "fotos": fotos[:4] or None,
        "url": url,
        "fuentes": [{"nombre": fuente_nombre or dominio(fuente_url), "url": fuente_url}],
        "desde_imagen": bool(e.get("desde_imagen")),
        "confianza": e.get("confianza") if e.get("confianza") in RANGO_CONFIANZA else "media",
        "origen": origen,
    }
    return ev


def mismo_evento(a: dict, b: dict) -> bool:
    ini_a, fin_a = a["fecha_inicio"], a.get("fecha_fin") or a["fecha_inicio"]
    ini_b, fin_b = b["fecha_inicio"], b.get("fecha_fin") or b["fecha_inicio"]
    se_cruzan = ini_a <= fin_b and ini_b <= fin_a
    if not se_cruzan:
        return False
    p = parecido(a["titulo"], b["titulo"])
    if p >= 0.5:
        return True
    # "Noche de Museos" y "Noche de Museos 2026 - Museo de la Música": uno contiene al otro
    x, y = sorted((palabras_titulo(a["titulo"]), palabras_titulo(b["titulo"])), key=len)
    if x and x <= y and (len(x) >= 2 or len(next(iter(x))) >= 6):
        return True
    lugar_igual = a.get("lugar") and b.get("lugar") and parecido(a["lugar"], b["lugar"]) >= 0.5
    if lugar_igual and p >= 0.3:
        return True
    # "Chile Terror Fest 2026" y "ChileTerror Fest II": mismo comienzo, mismo lugar y mismas fechas
    na, nb = (re.sub(r"[^a-z0-9]", "", sin_tildes(t)) for t in (a["titulo"], b["titulo"]))
    misma_fecha = ini_a == ini_b and fin_a == fin_b
    return bool(lugar_igual and misma_fecha and len(na) >= 12 and len(nb) >= 12 and na[:12] == nb[:12])


def compactar(eventos: list[dict]) -> list[dict]:
    """Une duplicados que ya estaban en la agenda (se queda el primero que se agregó y suma sus fuentes)."""
    eventos = sorted(eventos, key=lambda e: (e.get("agregado") or "", e.get("id") or ""))
    res: list[dict] = []
    for e in eventos:
        igual = next((r for r in res if mismo_evento(r, e)), None)
        if igual is None:
            res.append(e)
            continue
        # si el repetido es el evento "general" ("Noche de Museos 2026"), sus datos mandan
        general = (len(e["titulo"]) < len(igual["titulo"])
                   and palabras_titulo(e["titulo"]) <= palabras_titulo(igual["titulo"]))
        for c in CAMPOS:
            if e.get(c) and (not igual.get(c) or general):
                igual[c] = e[c]
        urls = {f["url"] for f in igual.get("fuentes", [])}
        igual.setdefault("fuentes", []).extend(f for f in e.get("fuentes", []) if f["url"] not in urls)
        igual["desde_imagen"] = igual.get("desde_imagen") or e.get("desde_imagen", False)
    return res


def nuevo_id(ev: dict) -> str:
    base = sin_tildes(ev["titulo"]) + "|" + ev["fecha_inicio"]
    return hashlib.sha1(base.encode()).hexdigest()[:10]


def unir(existentes: list[dict], nuevos: list[dict]) -> tuple[list[dict], list[str]]:
    """Une los eventos encontrados con la agenda. Devuelve la agenda y los id de los eventos recién agregados."""
    agregados: list[str] = []
    hoy = HOY.isoformat()
    for n in nuevos:
        igual = next((e for e in existentes if mismo_evento(e, n)), None)
        if igual is None:
            n["id"] = nuevo_id(n)
            n["agregado"] = hoy
            n["actualizado"] = hoy
            existentes.append(n)
            agregados.append(n["id"])
            continue
        mejor = RANGO_CONFIANZA.get(n["confianza"], 1) > RANGO_CONFIANZA.get(igual.get("confianza"), 1)
        for c in CAMPOS:
            if n.get(c) and (not igual.get(c) or (mejor and c not in ("titulo", "categoria"))):
                igual[c] = n[c]
        urls = {f["url"] for f in igual.get("fuentes", [])}
        for f in n["fuentes"]:
            if f["url"] not in urls:
                igual.setdefault("fuentes", []).append(f)
        igual["desde_imagen"] = igual.get("desde_imagen") or n["desde_imagen"]
        if mejor:
            igual["confianza"] = n["confianza"]
        igual["actualizado"] = hoy
    return existentes, agregados


def vigentes(eventos: list[dict], ocultos: list[str]) -> list[dict]:
    hoy = HOY.isoformat()
    ocultos_n = [sin_tildes(o) for o in ocultos]
    res = []
    for e in eventos:
        if (e.get("fecha_fin") or e["fecha_inicio"]) < hoy:
            continue
        if e.get("id") in ocultos or any(o and o in sin_tildes(e["titulo"]) for o in ocultos_n):
            continue
        res.append(e)
    res.sort(key=lambda e: (e["fecha_inicio"], e.get("hora") or "99", e["titulo"]))
    return res


# ---------------------------------------------------------------- relevancia

def patron_intereses(cfg: dict) -> re.Pattern:
    palabras = sorted({sin_tildes(p) for c in cfg["categorias"] for p in c["palabras"]}, key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(re.escape(p) for p in palabras) + r")\b")


def categorias_por_palabras(cfg: dict, texto: str) -> list[str]:
    t = sin_tildes(texto)
    return [c["id"] for c in cfg["categorias"]
            if re.search(r"\b(" + "|".join(re.escape(sin_tildes(p)) for p in c["palabras"]) + r")\b", t)]


RE_CHILE = re.compile(r"\b(chile|santiago|providencia|nunoa|las condes|maipu|valparaiso|vina del mar|"
                      r"concepcion|estacion central|recoleta|la florida|puente alto|temuco|la serena|"
                      r"antofagasta|rancagua|talca|movistar arena|teatro caupolican|blondie|gam|"
                      r"parque o'?higgins|matucana|espacio riesco|teatro coliseo|club chocolate)\b")
DOMINIOS_ENTRADAS = {"tuu.cl", "passline.com", "ticketplus.cl", "puntoticket.com", "eventbrite.cl",
                     "eventbrite.com", "keai.cl", "vamoh.cl", "ecopass.cl", "welcu.com", "joinnus.com",
                     "ticketpro.cl", "portaldisc.com", "eventrid.cl"}
RE_DOMINIO_EXTRANJERO = re.compile(r"\.(es|mx|ar|pe|co|uy|ec|ve|bo|py|gt|cr|pa|do|cu|hn|sv|ni|pt|it|fr|de|uk|br)$")
RE_OTRO_PAIS = re.compile(r"\b(argentina|buenos aires|mexico|espana|madrid|barcelona|peru|lima|colombia|"
                          r"bogota|uruguay|montevideo|compostela|dominicana|ecuador|venezuela)\b")


def puntaje(c: dict, patron: re.Pattern) -> int:
    t = sin_tildes(f'{c["titulo"]} {c["resumen"]}')
    p = 0
    if patron.search(sin_tildes(c["titulo"])):
        p += 3
    if patron.search(t):
        p += 2
    if RE_CHILE.search(t):
        p += 2
    if RE_OTRO_PAIS.search(t) and not RE_CHILE.search(t):
        p -= 4
    if RE_FECHA_TEXTO.search(t) or re.search(r"\b20(2[6-9])\b", t):
        p += 1
    if c["origen"] == "bing-noticias":
        p += 1
    # páginas de un evento con entradas (suelen traer datos estructurados: no gastan IA)
    if es_pagina_de_evento(c["url"]):
        p += 2
    # sitios de otros países (diariodesantiago.es, .com.ar, ...)
    if RE_DOMINIO_EXTRANJERO.search(dominio(c["url"])):
        p -= 5
    return p


# ---------------------------------------------------------------- proceso principal

def token_github() -> str | None:
    t = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if t:
        return t
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=20).stdout.strip() or None
    except Exception:  # noqa: BLE001
        return None


class NoticiaVieja(Exception):
    pass


def procesar_pagina(url, titulo_busqueda, ia, cfg, patron, cat_fuente=None, nombre_fuente=None,
                    confiar_categoria=False, agenda=False, noticias_desde: dt.date | None = None,
                    huellas: dict | None = None):
    """Lee una página: primero datos estructurados; si no hay, texto + afiches con IA.

    confiar_categoria=True solo para fuentes fijas ya filtradas por tema (p. ej. búsqueda 'anime' de Eventbrite).
    noticias_desde: si la página no es de un evento y se publicó antes de esa fecha, no se lee (NoticiaVieja).
    huellas: para las agendas que se leen cada hora (data/vistos.json). Si el texto no cambió desde la última
    lectura con IA, no se vuelve a gastar IA: sus eventos ya están en la agenda.
    """
    pagina, tipo, final = descargar(url)
    if "html" not in tipo.lower() and "<html" not in pagina[:500].lower():
        return [], False
    meta = metadatos(pagina)
    nombre = nombre_fuente or meta.get("og:site_name") or dominio(final)
    titulo = meta.get("og:title") or meta.get("_title") or titulo_busqueda
    estructurados = []
    ld = eventos_jsonld(pagina, final)
    if not ld and dominio(final).endswith("tuu.cl"):
        ld = eventos_tuu(pagina, meta, final)
    pagina_de_un_evento = len(ld) == 1 and bool(patron.search(sin_tildes(titulo)))
    for e in ld:
        cats = categorias_por_palabras(cfg, e.get("_texto") or f'{e["titulo"]} {e.get("descripcion") or ""}')
        if cats:
            e["categoria"] = cats[0]
        elif cat_fuente and (confiar_categoria or pagina_de_un_evento):
            e["categoria"] = cat_fuente
        else:
            continue
        estructurados.append(normalizar_evento(e, cfg, nombre, final, "datos-estructurados"))
    estructurados = [e for e in estructurados if e]
    d = dominio(final)
    sin_ia = any(d == x or d.endswith("." + x) for x in cfg.get("solo_datos_estructurados", []))
    if estructurados or sin_ia:
        return estructurados, False
    publicada = None if es_pagina_de_evento(final) else fecha_publicacion(pagina, meta)
    if noticias_desde and publicada and publicada < noticias_desde:
        raise NoticiaVieja(publicada.isoformat())
    if not ia.disponible():
        return [], None  # None = queda pendiente: se lee con IA otro día
    texto, imgs = leer_html(pagina)
    descripcion = meta.get("og:description") or meta.get("description") or ""
    texto = (descripcion + "\n" + texto) if descripcion and descripcion not in texto else texto
    if publicada:  # para que una fecha sin año ("23 de enero") se lea respecto de cuándo se escribió
        texto = (f"[Esta página se publicó o actualizó el {publicada.isoformat()}. Si una fecha no trae año, "
                 f"es la próxima a partir de ese día; si ya pasó, el evento ya pasó.]\n" + texto)
    if agenda:  # agenda larga de fans: mucho texto y sin afiches, para que quepan todas las fechas
        texto = texto_relevante(texto, patron, maximo=12000)
        portada, imagenes = (meta.get("og:image"), [])
    else:
        texto = texto_relevante(texto, patron)
        portada, imagenes = elegir_imagenes(meta, imgs, final)
    clave_huella, huella = "#huella " + final, hashlib.sha1(f"{titulo}\n{texto}".encode()).hexdigest()[:16]
    # El valor lleva la fecha delante: la limpieza de vistos.json (por fecha) la borra a los 60 días, y una agenda
    # que no cambia igual se vuelve a leer con IA cada "dias_para_revisar_de_nuevo" (por si la lectura anterior falló).
    previa = (huellas or {}).get(clave_huella, "")
    vence = (HOY - dt.timedelta(days=cfg.get("dias_para_revisar_de_nuevo", 7))).isoformat()
    if huellas is not None and previa.endswith("|" + huella) and previa[:10] > vence:
        log("  sin cambios desde la última lectura")
        return [], False
    crudos = ia_pagina(ia, cfg, final, titulo, texto, imagenes, max_tokens=6000 if agenda else 3500)
    if huellas is not None:
        huellas[clave_huella] = f"{HOY.isoformat()}|{huella}"
    res = []
    for e in crudos:
        # La imagen principal de la página solo sirve de respaldo si la página es de UN evento:
        # en una cartelera es el afiche de otro (p. ej. el de A Perfect Circle en la de Sonorock).
        if not e.get("imagen") and portada and len(crudos) == 1:
            e["imagen"] = portada
        n = normalizar_evento(e, cfg, nombre, final, "ia")
        if n:
            res.append(n)
    # Si varios eventos de la misma página quedaron con la misma imagen, es la de la página: se quita
    veces: dict[str, int] = {}
    for n in res:
        if n.get("imagen"):
            veces[n["imagen"]] = veces.get(n["imagen"], 0) + 1
    for n in res:
        if n.get("imagen") and veces[n["imagen"]] > 1:
            n["imagen"] = None
    return res, True


def fuente_sitemap(f: dict, cfg: dict, patron: re.Pattern, vistos: dict) -> list[dict]:
    """Agendas grandes (VAMOH!, Keai): de su sitemap se abren solo los eventos aún no vistos
    y se leen sus datos estructurados. No gasta IA."""
    texto, _, _ = descargar(f["url"], max_bytes=20_000_000, timeout=90)
    filas = re.findall(r"<loc>\s*(.*?)\s*</loc>(?:\s*<lastmod>\s*(.*?)\s*</lastmod>)?", texto)
    desde = (HOY - dt.timedelta(days=f.get("dias_lastmod", 60))).isoformat()
    excluir = None
    if f.get("excluir"):
        excluir = re.compile(r"\b(" + "|".join(re.escape(sin_tildes(p)) for p in f["excluir"]) + r")\b")
    pendientes = []
    for loc, lastmod in filas:
        loc = html.unescape(loc)
        if f.get("patron_enlace", "/") not in loc or loc in vistos:
            continue
        if lastmod and lastmod[:10] < desde:
            continue
        slug = sin_tildes(urllib.parse.unquote(urllib.parse.urlparse(loc).path)).replace("-", " ").replace("/", " ")
        if f.get("filtro_slug") and not patron.search(slug):
            continue
        if excluir and excluir.search(slug):
            continue
        pendientes.append((lastmod or "", loc))
    pendientes.sort(reverse=True)  # lo más reciente primero
    maximo = int(f.get("max_por_dia", 100))
    log(f"  {len(pendientes)} eventos sin revisar; hoy se abren {min(len(pendientes), maximo)}")
    res = []
    for _, loc in pendientes[:maximo]:
        try:
            pagina, _, final = descargar(loc, intentos=1)
        except NoPermitido:
            vistos[loc] = HOY.isoformat()
            continue
        except urllib.error.HTTPError as e:
            if e.code == 429:  # el sitio pide calma: se sigue mañana
                log("  el sitio pidió ir más lento (429); sigo mañana")
                break
            if e.code in (404, 410):
                vistos[loc] = HOY.isoformat()
            continue
        except Exception:  # noqa: BLE001  (se reintenta otro día)
            continue
        vistos[loc] = HOY.isoformat()
        for e in eventos_jsonld(pagina, final):
            cats = categorias_por_palabras(cfg, e.get("_texto") or e["titulo"])
            if not cats or (excluir and excluir.search(sin_tildes(e["titulo"]))):
                continue
            e["categoria"] = cats[0]
            n = normalizar_evento(e, cfg, f["nombre"], final, "datos-estructurados")
            if n:
                res.append(n)
        time.sleep(float(f.get("pausa_s", 0.7)))
    return res


# Chile Cultura (agenda del Ministerio de las Culturas): API JSON pública con el nombre, el lugar, la comuna y
# las fechas de apertura y de cierre de cada actividad. También trae talleres, charlas, visitas mediadas y videos
# de YouTube: se dejan solo las muestras presenciales que duran de una semana a poco más de un año.
RE_CC_NO = re.compile(
    r"\b(taller(es)?|conversatorio|seminario|encuentro|charlas?|curso|clases?|masterclass|lanzamiento|"
    r"convocatoria|laboratorio|visitas?|recorridos?|mediacion(es)?|mediad[oa]s|sesion(es)?|ciclo de cine|"
    r"funcion(es)?|concierto|infancias?|ninos|ninas|escolar(es)?|educacionales|cecrea)\b")
RE_CC_EN_LINEA = re.compile(r"youtube|youtu\.be|instagram|facebook|tiktok|suyai|\bradio\b|en linea|online|virtual|"
                            r"streaming|zoom")


def resumen(t: str, maximo: int = 220) -> str:
    """Las primeras frases de un texto (puede traer HTML), sin cortar palabras."""
    t = limpiar(t)
    t = re.sub(r"([«“(¿¡])\s+", r"\1", t)  # las etiquetas quitadas dejan espacios junto a comillas y signos
    t = re.sub(r"\s+([»”),.;:!?])", r"\1", t)
    if len(t) <= maximo:
        return t
    corte = t[:maximo]
    fin = max(corte.rfind(". "), corte.rfind("! "), corte.rfind("? "))
    if fin >= maximo // 2:
        return corte[:fin + 1]
    return corte[:corte.rfind(" ")].rstrip(",;:") + "…"


def titulo_muestra(t: str) -> str:
    """'Apertura exposición temporal “Electrizando la mente”' → 'Electrizando la mente'."""
    t = limpiar(t)
    sin = re.sub(r"^(apertura\s+(de\s+la\s+)?)?(nueva\s+)?(exposici[oó]n|muestra|exhibici[oó]n)(\s+temporal)?\s*:?\s*",
                 "", t, flags=re.I)
    if len(sin) >= 4:
        t = sin
    # "… - Exposición en el Centro de Extensión UC", "… - CCLM"
    t = re.sub(r"\s+[-–]\s*(exposici[oó]n|muestra)\b.*$", "", t, flags=re.I)
    t = re.sub(r"\s+[-–]\s*(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,6}$", "", t)
    m = re.fullmatch(r"[«“\"'](.+?)[»”\"']", t)
    if m:
        t = m.group(1)
    return t[:1].upper() + t[1:]


def fuente_chilecultura(f: dict, cfg: dict) -> list[dict]:
    """Muestras de la agenda Chile Cultura (API JSON; sin IA). La categoría viene de la fuente."""
    res: list[dict] = []
    url, paginas = f["url"], 0
    while url and paginas < 5:
        texto, _, final = descargar(url, max_bytes=20_000_000, timeout=60)
        datos = json.loads(texto)
        paginas += 1
        for e in datos.get("results") or []:
            nombre, lugar = limpiar(e.get("name")), limpiar(e.get("venue_name"))
            enlace = str(e.get("permalink") or "")
            inicio, fin = fecha_iso(e.get("start_date")), fecha_iso(e.get("end_date"))
            if not (nombre and inicio and fin) or RE_CC_NO.search(sin_tildes(nombre)):
                continue
            if not lugar or RE_CC_EN_LINEA.search(sin_tildes(lugar)) or re.search(r"youtu\.?be|suyai", enlace, re.I):
                continue  # sin lugar, videos y "galerías" en línea
            dias = (dt.date.fromisoformat(fin) - dt.date.fromisoformat(inicio)).days
            if not 6 <= dias <= 400:
                continue  # actividad de un día o colección permanente
            if re.search(r"\b(convoca(n)? a (participar|postular)|postulaciones|bases del concurso)\b",
                         sin_tildes(limpiar(e.get("description"))[:400])):
                continue  # el plazo de un concurso, no una muestra
            region = limpiar(e.get("region"))
            ev = {
                "titulo": titulo_muestra(nombre), "categoria": f.get("categoria"),
                "fecha_inicio": inicio, "fecha_fin": fin,
                "lugar": lugar or None, "comuna": limpiar(e.get("commune")) or None,
                "ciudad": "Santiago" if "metropolitana" in sin_tildes(region) else None,
                "region": re.sub(r"\s+de\s+santiago$", "", region, flags=re.I) or None,
                "precio": "Gratis" if e.get("free") is True else None,
                "descripcion": resumen(e.get("description") or ""),
                "imagen": e.get("image"),
                "url": enlace if enlace.startswith("http") and not RE_CC_EN_LINEA.search(enlace) else e.get("url"),
                "confianza": "media",
            }
            n = normalizar_evento(ev, cfg, f["nombre"], e.get("url") or final, "datos-estructurados")
            if n:
                res.append(n)
        url = datos.get("next")
        if url:
            time.sleep(2)
    return res


def busqueda_completa(cfg: dict, ia: IA, vistos: dict, noticias_desde: dt.date | None = None,
                      completa: bool = True) -> tuple[list[dict], dict]:
    """noticias_desde: solo se leen noticias publicadas desde esa fecha (la búsqueda completa anterior).
    Las ticketeras, agendas y páginas de eventos se leen siempre.
    completa=False es la búsqueda rápida de cada hora: solo ticketeras y agendas (lo que cambia seguido),
    sin buscadores ni noticias, sin Chile Cultura ni las carteleras de museos (que se leen cada pocos días)."""
    noticias_desde = noticias_desde or HOY
    patron = patron_intereses(cfg)
    encontrados: list[dict] = []
    stats = {"paginas_revisadas": 0, "busquedas": 0, "fuentes_fijas": 0, "errores": 0,
             "noticias_desde": noticias_desde.isoformat(), "noticias_viejas_descartadas": 0}
    viejas: set[str] = set()
    limite_vistos = (HOY - dt.timedelta(days=cfg.get("dias_para_revisar_de_nuevo", 7))).isoformat()

    # 1) Fuentes fijas (ticketeras y agendas)
    for f in cfg.get("fuentes", []):
        cada = int(f.get("cada_dias") or 1)
        if not completa and (cada > 1 or f["tipo"] == "chilecultura"):
            continue
        if cada > 1 and vistos.get(f["url"], "") > (HOY - dt.timedelta(days=cada)).isoformat():
            # carteleras de museos: las exposiciones duran meses, no hace falta gastar IA en leerlas a diario
            log(f"[fuente] {f['nombre']}: se lee cada {cada} días (última vez: {vistos[f['url']]})")
            continue
        log(f"[fuente] {f['nombre']}: {f['url']}")
        if f["tipo"] == "sitemap":
            d = dominio(f["url"])
            filtrar = not any(d == x or d.endswith("." + x) for x in cfg.get("solo_datos_estructurados", []))
            if filtrar and ia.token and not ia.disponible():
                # La IA se quedó sin cupo: sin su filtro entrarían talleres y visitas escolares.
                # Los eventos nuevos de la agenda se quedan sin abrir para una vuelta con IA.
                log("  la IA no está disponible ahora; esta agenda se lee en una vuelta con IA")
                continue
            try:
                res = fuente_sitemap(f, cfg, patron, vistos)
                stats["fuentes_fijas"] += 1
                if filtrar:
                    sin_filtrar: list[dict] = []
                    res = ia_filtrar_sueltos(ia, cfg, res, f["nombre"], sin_filtrar if ia.token else None)
                    for e in sin_filtrar:   # se vuelven a abrir cuando haya IA
                        for fu in e.get("fuentes", []):
                            vistos.pop(fu["url"], None)
                for n in res:
                    log(f"   ✓ {n['fecha_inicio']} {n['titulo']} ({n['categoria']}, {f['nombre']})")
                encontrados.extend(res)
                log(f"  {len(res)} calzan con tus gustos")
            except Exception as e:  # noqa: BLE001
                log(f"  no se pudo abrir: {e}")
                stats["errores"] += 1
            continue
        if f["tipo"] == "chilecultura":
            try:
                res = fuente_chilecultura(f, cfg)
                stats["fuentes_fijas"] += 1
                for n in res:
                    log(f"   ✓ {n['fecha_inicio']} → {n['fecha_fin']} {n['titulo']} ({n['categoria']}, {n.get('lugar')})")
                encontrados.extend(res)
                log(f"  {len(res)} muestras")
            except Exception as e:  # noqa: BLE001
                log(f"  no se pudo abrir: {e}")
                stats["errores"] += 1
            continue
        try:
            pagina, _, final = descargar(f["url"])
        except Exception as e:  # noqa: BLE001
            log(f"  no se pudo abrir: {e}")
            stats["errores"] += 1
            continue
        stats["fuentes_fijas"] += 1
        leida = True
        if f["tipo"] in ("puntoticket", "listado"):
            filas = (listado_puntoticket(pagina, final) if f["tipo"] == "puntoticket"
                     else listado_generico(pagina, final, f.get("patron_enlace", "/")))
            propias = {f["url"].rstrip("/"), final.rstrip("/")}
            filas = [x for x in filas if x["url"].rstrip("/") not in propias]   # el enlace al mismo listado
            # Las filas que la IA ya revisó hace poco no se le vuelven a mandar: las que calzaban ya están en la
            # agenda. Así la vuelta de cada hora solo gasta IA en lo que apareció desde la anterior.
            total = len(filas)
            filas = [x for x in filas if vistos.get(x["url"], "") < limite_vistos]
            log(f"  {total} eventos en el listado, {len(filas)} sin revisar")
            leida = ia.disponible()   # sin IA solo queda el respaldo por palabras: se vuelve a leer después
            elegidos, revisadas = (ia_clasificar_listado(ia, cfg, f["nombre"], filas)
                                   if filas and ia.disponible() else ([], []))
            for u in revisadas:
                vistos[u] = HOY.isoformat()
            # respaldo por palabras clave (también sirve si la IA falla o se queda sin cupo)
            ya = {fila["url"] for fila, _ in elegidos}
            for fila in filas:
                cats = categorias_por_palabras(cfg, f'{fila["titulo"]} {fila.get("tipo", "")}')
                if cats and fila["url"] not in ya:
                    elegidos.append((fila, {"categoria": cats[0], "confianza": "media"}))
            for fila, e in elegidos:
                fechas = fechas_desde_texto(fila.get("fecha_texto", ""))
                ev = {"titulo": e.get("titulo") or fila["titulo"], "categoria": e.get("categoria"),
                      "fecha_inicio": (fechas[0].isoformat() if fechas else e.get("fecha_inicio")),
                      "fecha_fin": (fechas[-1].isoformat() if len(fechas) > 1 else e.get("fecha_fin")),
                      "lugar": fila.get("lugar") or e.get("lugar"), "precio": e.get("precio"),
                      "descripcion": e.get("descripcion"),
                      "imagen": fila.get("imagen"), "url": fila["url"], "confianza": e.get("confianza")}
                n = normalizar_evento(ev, cfg, f["nombre"], fila["url"], "ticketera")
                if n:
                    log(f"   ✓ {n['fecha_inicio']} {n['titulo']} ({n['categoria']}, {f['nombre']})")
                    encontrados.append(n)
                elif not ev["fecha_inicio"]:  # sin IA igual sirven los datos estructurados de la página
                    try:
                        res, _ = procesar_pagina(fila["url"], fila["titulo"], ia, cfg, patron,
                                                 e.get("categoria"), f["nombre"])
                        encontrados.extend(res)
                    except SinCupo:
                        pass
                    except Exception:  # noqa: BLE001
                        stats["errores"] += 1
            log(f"  {len(elegidos)} calzan con tus gustos")
        else:
            try:
                res, uso_ia = procesar_pagina(f["url"], f["nombre"], ia, cfg, patron, f.get("categoria"), f["nombre"],
                                              confiar_categoria=bool(f.get("categoria")), agenda=True,
                                              huellas=vistos)
                leida = uso_ia is not None   # None: necesitaba la IA y no estaba (queda pendiente)
                encontrados.extend(res)
                log(f"  {len(res)} eventos")
            except SinCupo:
                leida = False
        if leida or not f.get("cada_dias"):
            vistos[f["url"]] = HOY.isoformat()

    if not completa:
        return encontrados, stats

    # 2) Búsquedas por interés
    candidatos: dict[str, dict] = {}
    omitidos = set(cfg.get("dominios_omitidos", []))
    redes = set(cfg.get("redes_solo_resumen", []))
    de_redes: dict[str, dict] = {}
    for cat in cfg["categorias"]:
        for consulta in cat["busquedas"]:
            stats["busquedas"] += 1
            resultados = []
            for buscador, fn in (("bing-noticias", buscar_bing), ("duckduckgo", buscar_ddg)):
                try:
                    resultados += fn(consulta)
                except Exception as e:  # noqa: BLE001
                    log(f"  {buscador} falló con '{consulta}': {e}")
                time.sleep(2.0)
            for r in resultados[:30]:
                d = dominio(r["url"])
                if any(d == o or d.endswith("." + o) for o in omitidos):
                    continue
                if any(d == o or d.endswith("." + o) for o in redes):
                    # No se abre la red social: solo se guarda lo que muestra el buscador
                    if r["resumen"] and r["url"] not in vistos:
                        r["categoria"] = cat["id"]
                        de_redes[r["url"]] = r
                    continue
                if urllib.parse.urlparse(r["url"]).path in ("", "/"):
                    continue
                if vistos.get(r["url"], "") >= limite_vistos:
                    continue
                if not es_pagina_de_evento(r["url"]) and noticia_vieja(r, noticias_desde):
                    viejas.add(r["url"])  # noticia de antes de la búsqueda anterior: no se lee
                    continue
                r["categoria"] = cat["id"]
                r["puntaje"] = puntaje(r, patron)
                previo = candidatos.get(r["url"])
                if not previo or previo["puntaje"] < r["puntaje"]:
                    candidatos[r["url"]] = r
    ordenados = sorted(candidatos.values(), key=lambda c: -c["puntaje"])
    ordenados = [c for c in ordenados if c["puntaje"] >= 2]
    # Se intercalan las categorías (medieval, anime, metal, ...) para que el cupo de IA alcance para todas
    por_categoria: dict[str, list[dict]] = {}
    for c in ordenados:
        por_categoria.setdefault(c["categoria"], []).append(c)
    ordenados = []
    while any(por_categoria.values()):
        for lista in por_categoria.values():
            if lista:
                ordenados.append(lista.pop(0))
    viejas -= set(candidatos)
    log(f"[búsquedas] {len(candidatos)} resultados nuevos, {len(ordenados)} prometedores, "
        f"{len(viejas)} noticias anteriores al {noticias_desde.strftime('%d-%m-%Y')} descartadas sin leer")

    # 3) Publicaciones de comunidades en redes sociales (solo lo que muestra el buscador).
    #    Van antes que las páginas: son baratas (20 por llamada) y ahí avisan las ferias chicas.
    if de_redes and ia.disponible():
        lista = list(de_redes.values())[:60]
        log(f"[redes] {len(lista)} publicaciones vistas en el buscador")
        for r, e in ia_resumenes_redes(ia, cfg, lista):
            n = normalizar_evento(e, cfg, dominio(r["url"]), r["url"], "ia-resumen")
            if n:
                n["confianza"] = "baja" if n["confianza"] == "alta" else n["confianza"]
                log(f"   ✓ {n['fecha_inicio']} {n['titulo']} ({n['categoria']}, red social)")
                encontrados.append(n)
        for r in lista:
            if r.get("_revisado"):  # las que no alcanzó a leer (sin cupo) quedan para mañana
                vistos[r["url"]] = HOY.isoformat()
    stats["redes_vistas"] = len(de_redes)

    # 4) Páginas: reparte el cupo de IA entre categorías para que ninguna se quede sin revisar.
    #    Si se acaba el cupo, igual se leen las que traen datos estructurados (no gastan IA);
    #    las demás quedan pendientes para el día siguiente.
    por_cat: dict[str, int] = {}
    tope = cfg.get("max_paginas_por_busqueda", 6) * 2
    sin_ia_max, sin_ia_hechas = int(cfg.get("max_paginas_sin_ia", 80)), 0
    for c in ordenados:
        if not ia.disponible():
            if sin_ia_hechas >= sin_ia_max:
                break
            sin_ia_hechas += 1
        elif por_cat.get(c["categoria"], 0) >= tope:
            continue
        log(f"[página] ({c['puntaje']}) {c['titulo'][:80]} — {c['url'][:100]}")
        try:
            res, uso_ia = procesar_pagina(c["url"], c["titulo"], ia, cfg, patron, c["categoria"],
                                          noticias_desde=noticias_desde)
            stats["paginas_revisadas"] += 1
            if uso_ia:
                por_cat[c["categoria"]] = por_cat.get(c["categoria"], 0) + 1
            for e in res:
                log(f"   ✓ {e['fecha_inicio']} {e['titulo']} ({e['categoria']}{', afiche' if e['desde_imagen'] else ''})")
            encontrados.extend(res)
            if uso_ia is not None:
                vistos[c["url"]] = HOY.isoformat()
        except SinCupo:
            continue  # queda pendiente para mañana
        except NoticiaVieja as e:
            log(f"   noticia publicada el {e}: no se lee")
            viejas.add(c["url"])
            vistos[c["url"]] = HOY.isoformat()
        except Exception as e:  # noqa: BLE001
            stats["errores"] += 1
            log(f"   no se pudo leer: {e}")
            if not (isinstance(e, urllib.error.HTTPError) and (e.code == 429 or e.code >= 500)):
                vistos[c["url"]] = HOY.isoformat()  # un error pasajero se reintenta mañana
    stats["noticias_viejas_descartadas"] = len(viejas)
    return encontrados, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sin-ia", action="store_true", help="no usar GitHub Models")
    ap.add_argument("--agregar", help="archivo JSON con eventos para unir (lista o {'eventos': [...]})")
    ap.add_argument("--origen", default="manual", help="quién encontró los eventos de --agregar")
    ap.add_argument("--limpiar", action="store_true", help="solo quitar eventos pasados y ocultos")
    ap.add_argument("--modo", choices=["completa", "rapida", "auto"], default="completa",
                    help="auto: la completa si ya pasaron 'horas_entre_completas' desde la anterior; si no, la rápida")
    args = ap.parse_args()
    inicio = dt.datetime.now(TZ)
    try:  # errors="replace": una línea del registro con una letra partida no debe botar al robot
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    cfg = cargar_json(CONFIG, None)
    if not cfg:
        sys.exit("No encuentro config/gustos.json")
    base = cargar_json(ARCH_EVENTOS, {"eventos": []})
    eventos = base.get("eventos", [])
    vistos = cargar_json(ARCH_VISTOS, {})
    ocultos = cargar_json(ARCH_OCULTOS, [])
    stats: dict = {}
    nuevos: list[dict] = []
    conf_ia = cfg.get("ia") or {}
    ia = IA(conf_ia, None, 0)

    if args.agregar:
        datos = cargar_json(Path(args.agregar), [])
        lista = datos.get("eventos", []) if isinstance(datos, dict) else datos
        for e in lista:
            fuente_url = e.get("fuente_url") or e.get("url") or ""
            n = normalizar_evento(e, cfg, e.get("fuente_nombre") or dominio(fuente_url), fuente_url, args.origen)
            if n:
                nuevos.append(n)
            else:
                log(f"  descartado (sin fecha válida, pasado o fuera de tus gustos): {e.get('titulo')}")
        stats = {"agregados_a_mano": len(lista)}
    elif not args.limpiar:
        variable = conf_ia.get("clave_env")
        clave = None if args.sin_ia else (os.environ.get(variable) if variable else token_github())
        ia = IA(conf_ia, clave, int(conf_ia.get("max_llamadas", 80)))
        if clave:
            log(f"Hoy: {HOY}  |  IA: sí ({conf_ia.get('nombre', ia.url)})")
        else:
            log(f"Hoy: {HOY}  |  IA: no" + (f" (falta el secreto {variable})" if variable and not args.sin_ia else ""))
        previa = base.get("ultima_busqueda", {})
        completa_anterior = previa.get("ultima_completa") or previa.get("fecha")
        modo = args.modo
        if modo == "auto":
            horas = float(cfg.get("horas_entre_completas", 6))
            try:
                pasaron = (inicio - dt.datetime.fromisoformat(completa_anterior)).total_seconds() / 3600
            except (TypeError, ValueError):
                pasaron = horas
            # media hora de holgura: GitHub no parte los horarios exactos
            modo = "completa" if pasaron >= horas - 0.5 else "rapida"
            log(f"Búsqueda {'rápida' if modo == 'rapida' else modo}: la completa anterior fue hace {pasaron:.1f} h (se hace cada {horas:g} h)")
        stats["modo"] = modo
        if modo == "completa":
            stats["ultima_completa"] = inicio.isoformat(timespec="minutes")
        elif completa_anterior:
            stats["ultima_completa"] = completa_anterior
        # Noticias: solo las publicadas desde la búsqueda completa anterior (la rápida no las lee),
        # con un tope de días por si las búsquedas estuvieron pausadas.
        anterior = fecha_iso(completa_anterior)
        desde = dt.date.fromisoformat(anterior) if anterior else HOY - dt.timedelta(days=1)
        desde = max(min(desde, HOY), HOY - dt.timedelta(days=int(cfg.get("max_dias_noticias", 7))))
        if modo == "completa":
            log(f"Noticias: solo las publicadas desde el {desde.strftime('%d-%m-%Y')}")
        nuevos, encontrado = busqueda_completa(cfg, ia, vistos, desde, completa=(modo == "completa"))
        stats.update(encontrado)

    eventos, ids_nuevos = unir(eventos, nuevos)
    eventos = vigentes(compactar(eventos), ocultos)
    ids_vigentes = {e["id"] for e in eventos}
    ids_nuevos = [i for i in ids_nuevos if i in ids_vigentes]
    agregados = len(ids_nuevos)
    corte = (HOY - dt.timedelta(days=60)).isoformat()
    vistos = {u: f for u, f in vistos.items() if f >= corte}

    ahora_dt = dt.datetime.now(TZ)
    ahora = ahora_dt.isoformat(timespec="minutes")
    ultima = base.get("ultima_busqueda", {})
    # "Nuevos" = lo agregado en las últimas HORAS_NUEVOS horas: como el robot busca cada hora, cada vuelta
    # suma lo suyo a lo anterior en vez de reemplazarlo. nuevos_desde guarda cuándo llegó cada uno.
    marcas = dict(ultima.get("nuevos_desde") or {})
    if not marcas and ultima.get("nuevos_ids") and ultima.get("fecha"):  # formato anterior: sin hora por evento
        marcas = {i: ultima["fecha"] for i in ultima["nuevos_ids"]}
    for i in ids_nuevos:
        marcas.setdefault(i, ahora)
    limite_nuevos = ahora_dt - dt.timedelta(hours=HORAS_NUEVOS)

    def reciente(t) -> bool:
        try:
            return dt.datetime.fromisoformat(t) >= limite_nuevos
        except (TypeError, ValueError):
            return False
    marcas = {i: t for i, t in marcas.items() if i in ids_vigentes and reciente(t)}
    ids_recientes = sorted(marcas, key=lambda i: marcas[i])
    if args.agregar and args.origen == "manual":
        # Agregar a mano no es una búsqueda: se suman a los "nuevos" sin cambiar la hora de la búsqueda
        ultima = {**ultima, "nuevos_ids": ids_recientes, "nuevos_desde": marcas, "eventos_nuevos": len(marcas)}
    elif not args.limpiar:
        ultima = {"fecha": ahora, "origen": args.origen if args.agregar else
                  ("github-actions" if os.environ.get("GITHUB_ACTIONS") else "local"),
                  "eventos_nuevos": len(marcas), "nuevos_esta_vez": agregados,
                  "nuevos_ids": ids_recientes, "nuevos_desde": marcas, "horas_nuevos": HORAS_NUEVOS,
                  "llamadas_ia": ia.usadas, "ia_sin_cupo": ia.agotada and ia.usadas > 0,
                  "ultima_completa": ultima.get("ultima_completa") or ultima.get("fecha"), **stats}
    salida = {"version": 1, "actualizado": ahora, "zona_horaria": "America/Santiago",
              "ultima_busqueda": ultima, "total": len(eventos), "eventos": eventos}
    guardar_json(ARCH_EVENTOS, salida)
    guardar_json(ARCH_VISTOS, vistos)
    if not ARCH_OCULTOS.exists():
        guardar_json(ARCH_OCULTOS, [])
    log(f"\nListo: {len(eventos)} eventos vigentes, {agregados} nuevos, {ia.usadas} llamadas a la IA.")


if __name__ == "__main__":
    main()
