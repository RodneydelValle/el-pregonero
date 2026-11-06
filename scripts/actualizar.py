#!/usr/bin/env python3
"""El Pregonero: busca eventos en Chile según config/gustos.json y actualiza data/eventos.json.

Solo usa servicios gratuitos:
  * Búsqueda: RSS de Bing (noticias y web), DuckDuckGo como respaldo y páginas de ticketeras.
  * IA: GitHub Models (incluido gratis en la cuenta de GitHub, con límite diario). Lee el texto
    y también las imágenes (afiches), porque muchas veces la fecha y el lugar solo están ahí.

Uso:
  python scripts/actualizar.py                 # búsqueda completa (en GitHub Actions)
  python scripts/actualizar.py --sin-ia        # solo fuentes que no necesitan IA
  python scripts/actualizar.py --agregar x.json --origen claude   # une eventos encontrados a mano
  python scripts/actualizar.py --limpiar       # solo quita eventos pasados y ocultos
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
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


def limpiar(t) -> str:
    if t is None:
        return ""
    t = html.unescape(str(t))
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


def _url_imagen(img):
    if isinstance(img, list):
        img = img[0] if img else None
    if isinstance(img, dict):
        img = img.get("url") or img.get("contentUrl")
    return img if isinstance(img, str) and img.startswith("http") else None


def eventos_jsonld(pagina: str, url_base: str) -> list[dict]:
    res = []
    for bloque in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                             pagina, re.S | re.I):
        bloque = bloque.strip().replace("<!--", "").replace("-->", "")
        try:
            datos = json.loads(bloque)
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
            inicio = str(d.get("startDate"))
            res.append({
                "titulo": limpiar(d.get("name")),
                "fecha_inicio": fecha_iso(inicio),
                "fecha_fin": fecha_iso(d.get("endDate")),
                "hora": hora_hhmm(inicio[10:]) if "T" in inicio else None,
                "lugar": nombre_lugar or None,
                "direccion": direccion or None,
                "comuna": comuna or None,
                "precio": precio,
                "descripcion": limpiar(d.get("description"))[:240] or None,
                "imagen": _url_imagen(d.get("image")),
                "url": urllib.parse.urljoin(url_base, d.get("url") or url_base),
                "desde_imagen": False,
                "confianza": "alta",
            })
    return res


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
        self.preferidos = [self.modelo] + [m for m in self.preferidos if m != self.modelo and m in ids]
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
                        log(f"  IA: se acabó el cupo gratis de hoy ({detalle[:160]})")
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
        "- Ojo con 'Santiago' de otros países (España, Rep. Dominicana, Argentina): solo Chile.\n"
        "- Escribe en español de Chile. La descripción, máximo 200 caracteres, dice qué es y por qué calza.\n"
    )


ESQUEMA_EVENTO = (
    '{"eventos": [{"titulo": str, "categoria": id, "fecha_inicio": "AAAA-MM-DD", '
    '"fecha_fin": "AAAA-MM-DD"|null, "hora": "HH:MM"|null, "lugar": str|null, '
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
        for e in (r.get("eventos") or []) if isinstance(r, dict) else []:
            try:
                n = int(e.get("n"))
            except (TypeError, ValueError):
                continue
            if 0 <= n < len(resultados):
                salida.append((resultados[n], e))
    return salida


def ia_clasificar_listado(ia: IA, cfg: dict, fuente: str, filas: list[dict]) -> list[dict]:
    """Manda un listado compacto (título | lugar | fecha) y la IA dice cuáles calzan (p. ej. bandas de metal)."""
    sistema = instrucciones_base(cfg) + (
        "Recibirás un listado numerado de una ticketera. Usa tu conocimiento (por ejemplo, el género de cada banda) "
        "para elegir SOLO los que calcen con los intereses. Responde solo JSON: "
        '{"eventos": [{"n": número, "categoria": id, "fecha_inicio": "AAAA-MM-DD"|null, '
        '"fecha_fin": "AAAA-MM-DD"|null, "descripcion": "qué es y por qué calza, máx 160 caracteres", '
        '"confianza": "alta"|"media"|"baja"}]}. Si ninguno calza: {"eventos": []}.')
    elegidos = []
    for i in range(0, len(filas), 110):
        bloque = filas[i:i + 110]
        texto = f"Fuente: {fuente}\n" + "\n".join(
            f'{i + j}. {f["titulo"]} | {f.get("lugar") or ""} | {f.get("fecha_texto") or ""}'
            for j, f in enumerate(bloque))
        try:
            r = ia.json(sistema, texto)
        except (ValueError, SinCupo):
            break
        for e in (r.get("eventos") or []) if isinstance(r, dict) else []:
            try:
                n = int(e.get("n"))
            except (TypeError, ValueError):
                continue
            if 0 <= n < len(filas):
                elegidos.append((filas[n], e))
    return elegidos


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
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


CAMPOS = ["titulo", "categoria", "fecha_inicio", "fecha_fin", "hora", "lugar", "direccion", "comuna",
          "ciudad", "region", "precio", "descripcion", "imagen", "url"]
RANGO_CONFIANZA = {"baja": 0, "media": 1, "alta": 2}


def normalizar_evento(e: dict, cfg: dict, fuente_nombre: str, fuente_url: str, origen: str) -> dict | None:
    ids = {c["id"] for c in cfg["categorias"]}
    titulo = limpiar(e.get("titulo"))[:160]
    inicio = fecha_iso(e.get("fecha_inicio"))
    if not titulo or not inicio:
        return None
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
    imagen = e.get("imagen")
    ev = {
        "titulo": titulo,
        "categoria": cat,
        "fecha_inicio": inicio,
        "fecha_fin": fin if fin and fin != inicio else None,
        "hora": hora_hhmm(e.get("hora")),
        "lugar": limpiar(e.get("lugar"))[:120] or None,
        "direccion": limpiar(e.get("direccion"))[:160] or None,
        "comuna": limpiar(e.get("comuna"))[:60] or None,
        "ciudad": limpiar(e.get("ciudad"))[:60] or None,
        "region": limpiar(e.get("region"))[:60] or None,
        "precio": limpiar(e.get("precio"))[:80] or None,
        "descripcion": limpiar(e.get("descripcion"))[:240] or None,
        "imagen": imagen if isinstance(imagen, str) and imagen.startswith("http") else None,
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
    lugar_igual = a.get("lugar") and b.get("lugar") and parecido(a["lugar"], b["lugar"]) >= 0.5
    return bool(lugar_igual and p >= 0.3)


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


def procesar_pagina(url, titulo_busqueda, ia, cfg, patron, cat_fuente=None, nombre_fuente=None,
                    confiar_categoria=False, agenda=False):
    """Lee una página: primero datos estructurados; si no hay, texto + afiches con IA.

    confiar_categoria=True solo para fuentes fijas ya filtradas por tema (p. ej. búsqueda 'anime' de Eventbrite).
    """
    pagina, tipo, final = descargar(url)
    if "html" not in tipo.lower() and "<html" not in pagina[:500].lower():
        return [], False
    meta = metadatos(pagina)
    nombre = nombre_fuente or meta.get("og:site_name") or dominio(final)
    titulo = meta.get("og:title") or meta.get("_title") or titulo_busqueda
    estructurados = []
    ld = eventos_jsonld(pagina, final)
    pagina_de_un_evento = len(ld) == 1 and bool(patron.search(sin_tildes(titulo)))
    for e in ld:
        cats = categorias_por_palabras(cfg, f'{e["titulo"]} {e.get("descripcion") or ""}')
        if cats:
            e["categoria"] = cats[0]
        elif cat_fuente and (confiar_categoria or pagina_de_un_evento):
            e["categoria"] = cat_fuente
        else:
            continue
        estructurados.append(normalizar_evento(e, cfg, nombre, final, "datos-estructurados"))
    estructurados = [e for e in estructurados if e]
    if estructurados or not ia.disponible():
        return estructurados, False
    texto, imgs = leer_html(pagina)
    descripcion = meta.get("og:description") or meta.get("description") or ""
    texto = (descripcion + "\n" + texto) if descripcion and descripcion not in texto else texto
    if agenda:  # agenda larga de fans: mucho texto y sin afiches, para que quepan todas las fechas
        texto = texto_relevante(texto, patron, maximo=12000)
        portada, imagenes = (meta.get("og:image"), [])
    else:
        texto = texto_relevante(texto, patron)
        portada, imagenes = elegir_imagenes(meta, imgs, final)
    crudos = ia_pagina(ia, cfg, final, titulo, texto, imagenes, max_tokens=6000 if agenda else 3500)
    res = []
    for e in crudos:
        if not e.get("imagen") and portada:
            e["imagen"] = portada
        n = normalizar_evento(e, cfg, nombre, final, "ia")
        if n:
            res.append(n)
    return res, True


def busqueda_completa(cfg: dict, ia: IA, vistos: dict) -> tuple[list[dict], dict]:
    patron = patron_intereses(cfg)
    encontrados: list[dict] = []
    stats = {"paginas_revisadas": 0, "busquedas": 0, "fuentes_fijas": 0, "errores": 0}
    limite_vistos = (HOY - dt.timedelta(days=cfg.get("dias_para_revisar_de_nuevo", 7))).isoformat()

    # 1) Fuentes fijas (ticketeras y agendas)
    for f in cfg.get("fuentes", []):
        log(f"[fuente] {f['nombre']}: {f['url']}")
        try:
            pagina, _, final = descargar(f["url"])
        except Exception as e:  # noqa: BLE001
            log(f"  no se pudo abrir: {e}")
            stats["errores"] += 1
            continue
        stats["fuentes_fijas"] += 1
        if f["tipo"] in ("puntoticket", "listado"):
            filas = (listado_puntoticket(pagina, final) if f["tipo"] == "puntoticket"
                     else listado_generico(pagina, final, f.get("patron_enlace", "/")))
            log(f"  {len(filas)} eventos en el listado")
            elegidos = ia_clasificar_listado(ia, cfg, f["nombre"], filas) if ia.disponible() else []
            # respaldo por palabras clave (también sirve si la IA falla o se queda sin cupo)
            ya = {fila["url"] for fila, _ in elegidos}
            for fila in filas:
                cats = categorias_por_palabras(cfg, f'{fila["titulo"]} {fila.get("tipo", "")}')
                if cats and fila["url"] not in ya:
                    elegidos.append((fila, {"categoria": cats[0], "confianza": "media"}))
            for fila, e in elegidos:
                fechas = fechas_desde_texto(fila.get("fecha_texto", ""))
                ev = {"titulo": fila["titulo"], "categoria": e.get("categoria"),
                      "fecha_inicio": (fechas[0].isoformat() if fechas else e.get("fecha_inicio")),
                      "fecha_fin": (fechas[-1].isoformat() if len(fechas) > 1 else e.get("fecha_fin")),
                      "lugar": fila.get("lugar"), "descripcion": e.get("descripcion"),
                      "imagen": fila.get("imagen"), "url": fila["url"], "confianza": e.get("confianza")}
                n = normalizar_evento(ev, cfg, f["nombre"], fila["url"], "ticketera")
                if n:
                    log(f"   ✓ {n['fecha_inicio']} {n['titulo']} ({n['categoria']}, {f['nombre']})")
                    encontrados.append(n)
                elif not ev["fecha_inicio"] and ia.disponible():
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
                res, _ = procesar_pagina(f["url"], f["nombre"], ia, cfg, patron, f.get("categoria"), f["nombre"],
                                         confiar_categoria=bool(f.get("categoria")), agenda=True)
                encontrados.extend(res)
                log(f"  {len(res)} eventos")
            except SinCupo:
                pass
        vistos[f["url"]] = HOY.isoformat()

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
                r["categoria"] = cat["id"]
                r["puntaje"] = puntaje(r, patron)
                previo = candidatos.get(r["url"])
                if not previo or previo["puntaje"] < r["puntaje"]:
                    candidatos[r["url"]] = r
    ordenados = sorted(candidatos.values(), key=lambda c: -c["puntaje"])
    ordenados = [c for c in ordenados if c["puntaje"] >= 2]
    log(f"[búsquedas] {len(candidatos)} resultados nuevos, {len(ordenados)} prometedores")

    # reparte el cupo de IA entre categorías para que ninguna se quede sin revisar
    por_cat: dict[str, int] = {}
    tope = cfg.get("max_paginas_por_busqueda", 6) * 2
    for c in ordenados:
        if not ia.disponible():
            break
        if por_cat.get(c["categoria"], 0) >= tope:
            continue
        log(f"[página] ({c['puntaje']}) {c['titulo'][:80]} — {c['url'][:100]}")
        try:
            res, uso_ia = procesar_pagina(c["url"], c["titulo"], ia, cfg, patron, c["categoria"])
            stats["paginas_revisadas"] += 1
            if uso_ia:
                por_cat[c["categoria"]] = por_cat.get(c["categoria"], 0) + 1
            for e in res:
                log(f"   ✓ {e['fecha_inicio']} {e['titulo']} ({e['categoria']}{', afiche' if e['desde_imagen'] else ''})")
            encontrados.extend(res)
            vistos[c["url"]] = HOY.isoformat()
        except SinCupo:
            break
        except Exception as e:  # noqa: BLE001
            stats["errores"] += 1
            log(f"   no se pudo leer: {e}")
            vistos[c["url"]] = HOY.isoformat()

    # 3) Publicaciones de redes sociales: solo con lo que muestra el buscador
    if de_redes and ia.disponible():
        lista = list(de_redes.values())[:60]
        log(f"[redes] {len(lista)} publicaciones vistas en el buscador")
        for r, e in ia_resumenes_redes(ia, cfg, lista):
            n = normalizar_evento(e, cfg, dominio(r["url"]), r["url"], "ia-resumen")
            if n:
                n["confianza"] = "baja" if n["confianza"] == "alta" else n["confianza"]
                log(f"   ✓ {n['fecha_inicio']} {n['titulo']} ({n['categoria']}, red social)")
                encontrados.append(n)
            vistos[r["url"]] = HOY.isoformat()
    stats["redes_vistas"] = len(de_redes)
    return encontrados, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sin-ia", action="store_true", help="no usar GitHub Models")
    ap.add_argument("--agregar", help="archivo JSON con eventos para unir (lista o {'eventos': [...]})")
    ap.add_argument("--origen", default="manual", help="quién encontró los eventos de --agregar")
    ap.add_argument("--limpiar", action="store_true", help="solo quitar eventos pasados y ocultos")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
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
        nuevos, stats = busqueda_completa(cfg, ia, vistos)

    eventos, ids_nuevos = unir(eventos, nuevos)
    eventos = vigentes(eventos, ocultos)
    ids_vigentes = {e["id"] for e in eventos}
    ids_nuevos = [i for i in ids_nuevos if i in ids_vigentes]
    agregados = len(ids_nuevos)
    corte = (HOY - dt.timedelta(days=60)).isoformat()
    vistos = {u: f for u, f in vistos.items() if f >= corte}

    ahora = dt.datetime.now(TZ).isoformat(timespec="minutes")
    ultima = base.get("ultima_busqueda", {})
    if args.agregar and args.origen == "manual":
        # Agregar a mano no es una búsqueda: se suman a los "nuevos" de la última búsqueda
        if "nuevos_ids" in ultima:
            previos = [i for i in ultima["nuevos_ids"] if i in ids_vigentes]
        else:  # búsquedas antiguas sin lista: lo agregado ese día
            dia = str(ultima.get("fecha", ""))[:10]
            previos = [e["id"] for e in eventos if e.get("agregado") == dia and e["id"] not in ids_nuevos]
        ultima = {**ultima, "nuevos_ids": previos + [i for i in ids_nuevos if i not in previos]}
        ultima["eventos_nuevos"] = len(ultima["nuevos_ids"])
    elif not args.limpiar:
        ultima = {"fecha": ahora, "origen": args.origen if args.agregar else
                  ("github-actions" if os.environ.get("GITHUB_ACTIONS") else "local"),
                  "eventos_nuevos": agregados, "nuevos_ids": ids_nuevos, "llamadas_ia": ia.usadas,
                  "ia_sin_cupo": ia.agotada and ia.usadas > 0, **stats}
    salida = {"version": 1, "actualizado": ahora, "zona_horaria": "America/Santiago",
              "ultima_busqueda": ultima, "total": len(eventos), "eventos": eventos}
    guardar_json(ARCH_EVENTOS, salida)
    guardar_json(ARCH_VISTOS, vistos)
    if not ARCH_OCULTOS.exists():
        guardar_json(ARCH_OCULTOS, [])
    log(f"\nListo: {len(eventos)} eventos vigentes, {agregados} nuevos, {ia.usadas} llamadas a la IA.")


if __name__ == "__main__":
    main()
