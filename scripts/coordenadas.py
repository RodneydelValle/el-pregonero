#!/usr/bin/env python3
"""Coordenadas (lat, lng) desde OpenStreetMap para el Mapa del Aventurero.

Completa "lat" y "lng" de los lugares de data/restaurantes.json y data/tiendas.json que no las tienen.
Usa la API Overpass (no Nominatim: su robots.txt no deja usarlo así), con pocas consultas grandes:
  1) por nombre, entre restaurantes, cafés, bares, tiendas, malls y galerías del mapa;
  2) por dirección: todos los números de esas calles (dirección exacta o interpolada entre dos números);
  3) la comuna de cada punto (is_in), que debe ser la del dato. Si no calza, no se guarda.
Pistas opcionales en cada lugar: "lat_propuesta"/"lng_propuesta"/"fuente_propuesta" (coordenadas de su sitio
oficial o de Wikipedia: se prueban primero y también deben caer en la comuna), "buscar_osm" (otro nombre para buscar,
p. ej. el mall donde está), "comunas_aceptadas" (para un local en una calle que es límite entre dos comunas,
como Av. Ossa entre Ñuñoa y La Reina: el punto de la calle puede caer en la vecina) y "en"
(el id de la galería donde está: toma sus coordenadas, así todos los de la galería van en un mismo marcador).
Corre en GitHub Actions (workflow «Coordenadas»): la red de la oficina no llega a overpass-api.de.

Uso: python scripts/coordenadas.py [--todos] [--probar]
  --todos   recalcula también los que ya tienen coordenadas
  --probar  muestra lo que haría sin guardar
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
ARCHIVOS = [RAIZ / "data" / "restaurantes.json", RAIZ / "data" / "tiendas.json"]
LISTAS = {"restaurantes.json": "restaurantes", "tiendas.json": "tiendas"}
OVERPASS = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
UA = "ElPregonero/1.0 (agenda personal; +https://github.com/RodneydelValle/el-pregonero)"
BBOX = "(-33.80,-70.95,-33.25,-70.25)"   # Región Metropolitana, con el Cajón del Maipo


def log(*a):
    print(*a, flush=True)


def overpass(q: str, timeout: int = 200) -> list[dict]:
    for intento in range(3):
        try:
            datos = urllib.parse.urlencode({"data": q}).encode()
            r = urllib.request.urlopen(urllib.request.Request(OVERPASS, data=datos, headers={"User-Agent": UA}), timeout=timeout)
            res = json.load(r)["elements"]
            time.sleep(1)
            return res
        except Exception as e:  # noqa: BLE001
            log(f"   Overpass: {e}")
            time.sleep(15 * (intento + 1))
    return []


def st(t) -> str:
    return unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode().lower().strip()


def pos(e: dict):
    return (e.get("lat") or e.get("center", {}).get("lat"), e.get("lon") or e.get("center", {}).get("lon"))


VOC = {"a": "[aáàä]", "e": "[eéè]", "i": "[iíì]", "o": "[oóò]", "u": "[uúüù]", "n": "[nñ]"}


def rx(t: str) -> str:
    """Regex que calza el texto con o sin tildes."""
    out = []
    for ch in st(t):
        out.append(VOC.get(ch) or (ch if ch.isalnum() or ch == " " else "."))
    return "".join(out)


NO_CALLE = re.compile(r"^(local|locales|piso|oficina|of\.|nivel|metro|galer|mall|centro comercial|portal|sector|"
                      r"esquina|entre|patio|barrio|caracol)", re.I)


def calle_numero(direccion: str):
    """'Galería de la Merced, Huérfanos 635, local 22 (…)' -> ('Huérfanos', '635').
    El número va como texto: en Chile '0350' (con cero delante, el tramo de Providencia) no es el 350."""
    d = re.sub(r"\(.*?\)", "", direccion or "")
    for parte in d.split(","):
        parte = parte.strip()
        if not parte or NO_CALLE.match(parte):
            continue
        m = re.match(r"^(.*?[A-Za-zÁÉÍÓÚÑáéíóúñ.'’])\s+(\d{1,5}(?:\.\d{3})?)\b", parte)
        if m:
            calle = re.sub(r"^(av\.?|avda\.?|avenida|calle|pasaje|psje\.?|paseo)\s+", "", m.group(1).strip(), flags=re.I)
            calle = re.sub(r"^dr\.?\s+", "Doctor ", calle, flags=re.I).replace("’", "'")
            return calle.strip(), m.group(2).replace(".", "")
    return None, None


def con_cero(n: str) -> bool:
    return len(n) > 1 and n.startswith("0")


def distancia_km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def variantes(calle: str) -> list[str]:
    """Cómo puede estar escrita la calle en OpenStreetMap (se busca con igualdad exacta, que es rápida)."""
    sin_tildes = "".join(c for c in unicodedata.normalize("NFD", calle) if unicodedata.category(c) != "Mn")
    base = {calle, sin_tildes, calle.replace("Bío Bío", "Biobío"), calle.replace("Biobío", "Bío Bío")}
    out = []
    for c in base:
        for v in (c, f"Avenida {c}", f"Paseo {c}", f"Calle {c}", f"Pasaje {c}"):
            if v not in out:
                out.append(v)
    return out


def comillas(t: str) -> str:
    return t.replace("\\", "\\\\").replace('"', '\\"')


def nombre_buscado(x: dict) -> str:
    return re.sub(r"\(.*?\)", "", x.get("buscar_osm") or x["nombre"]).strip()


def centro_de_calle_corta(calle: str, largo_max_km: float = 0.6) -> list[tuple]:
    """Último recurso, cuando OSM no tiene ni el local ni números en esa calle: si la calle es corta (un pasaje,
    unas pocas cuadras), su punto medio queda a lo más a unos 300 m del local. Se marca como aproximada.
    Si hay varias calles con ese nombre (en distintas comunas), cada una es un intento: la comuna decide."""
    partes = "".join(f'way["highway"]["name"="{comillas(v)}"]{BBOX};' for v in variantes(calle))
    tramos = overpass(f"[out:json][timeout:120];({partes});out geom;")
    # se juntan los tramos que se tocan o casi (una misma calle partida en varios trozos)
    calles = []
    for w in tramos:
        pts = [(p["lat"], p["lon"]) for p in w.get("geometry", [])]
        if len(pts) < 2:
            continue
        c = next((c for c in calles if min(distancia_km(a, b) for a in c for b in (pts[0], pts[-1])) < 0.05), None)
        if c is not None:
            c.extend(pts)
        else:
            calles.append(list(pts))
    intentos = []
    for pts in calles:
        largo = sum(distancia_km(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        if largo > largo_max_km:
            continue
        la = sum(p[0] for p in pts) / len(pts)
        lo = sum(p[1] for p in pts) / len(pts)
        intentos.append((la, lo, f"aproximada: centro de {calle} ({round(largo * 1000)} m de largo; OSM no tiene sus números)"))
    return intentos


def geocodificar(lugares: list[dict]) -> dict[str, dict]:
    # 1) nombres: entre lugares con nombre que sean comercios, comida, malls o galerías
    nombres = sorted({nombre_buscado(x) for x in lugares})
    alt = "|".join(rx(n) for n in nombres)
    log(f"[nombres] {len(nombres)} nombres")
    q = (f'[out:json][timeout:180];('
         f'nwr["amenity"]["name"~"{alt}",i]{BBOX};'
         f'nwr["shop"]["name"~"{alt}",i]{BBOX};'
         f'nwr["building"]["name"~"{alt}",i]{BBOX};'
         f'nwr["leisure"]["name"~"{alt}",i]{BBOX};'
         f'nwr["tourism"]["name"~"{alt}",i]{BBOX};'
         f');out center tags;')
    por_nombre = overpass(q)
    log(f"   {len(por_nombre)} objetos con nombres parecidos")
    # 2) direcciones: igualdad exacta con cada forma de escribir la calle
    calles = {}
    for x in lugares:
        c, n = calle_numero(x.get("direccion"))
        x["_calle"], x["_num"] = c, n
        if c:
            calles[c] = variantes(c)
    partes = "".join(f'nwr["addr:street"="{comillas(v)}"]["addr:housenumber"]{BBOX};' for vs in calles.values() for v in vs)
    log(f"[direcciones] {len(calles)} calles")
    numeros = []
    if partes:
        for e in overpass(f"[out:json][timeout:180];({partes});out center tags;"):
            t = e.get("tags", {})
            la, lo = pos(e)
            m = re.match(r"\d+", t.get("addr:housenumber", "").strip())
            if la is not None and m:
                numeros.append({"txt": m.group(), "num": int(m.group()), "cero": con_cero(m.group()),
                                "lat": la, "lng": lo, "calle": t.get("addr:street", "")})
    log(f"   {len(numeros)} números de esas calles")

    comunas = {}

    def comuna_de(la, lo):
        k = (round(la, 5), round(lo, 5))
        if k not in comunas:
            area = overpass(f'[out:json][timeout:60];is_in({la},{lo})->.a;'
                            f'area.a["admin_level"="8"]["boundary"="administrative"];out tags;', timeout=90)
            comunas[k] = area[0]["tags"].get("name") if area else None
        return comunas[k]

    resultados = {}
    for x in lugares:
        clave = x["_clave"]
        buscado = st(nombre_buscado(x))
        calle, numtxt = x["_calle"], x["_num"]
        de_calle = {st(v) for v in calles.get(calle, [])} if calle else set()
        # Candidatos en orden de confianza; se queda el primero que cae en la comuna del dato
        fuertes, debiles = [], []
        for e in por_nombre:
            t = e.get("tags", {})
            la, lo = pos(e)
            nom = st(t.get("name"))
            if la is None or not nom or not (buscado in nom or (len(nom) >= 5 and nom in buscado)):
                continue
            puntos = 1
            if calle and st(t.get("addr:street")) in de_calle:
                puntos += 2
            hn = re.match(r"\d+", t.get("addr:housenumber", "").strip())
            if numtxt and hn and hn.group() == numtxt:
                puntos += 2
            fuente = f"OpenStreetMap, por nombre: {t.get('name')} {t.get('addr:street') or ''} {t.get('addr:housenumber') or ''}".strip()
            (fuertes if puntos >= 3 else debiles).append((puntos, la, lo, fuente))
        fuertes.sort(key=lambda c: -c[0])
        intentos = [(la, lo, f) for _, la, lo, f in fuertes[:2]]
        if isinstance(x.get("lat_propuesta"), (int, float)) and isinstance(x.get("lng_propuesta"), (int, float)):
            intentos.insert(0, (x["lat_propuesta"], x["lng_propuesta"], x.get("fuente_propuesta") or "coordenadas propuestas"))
        if calle and numtxt:
            n, cero = int(numtxt), con_cero(numtxt)
            misma = [p for p in numeros if st(p["calle"]) in de_calle and p["cero"] == cero]
            for p in [p for p in misma if p["num"] == n][:2]:
                intentos.append((p["lat"], p["lng"], f"OpenStreetMap, dirección: {p['calle']} {p['txt']}"))
            menores = sorted([p for p in misma if p["num"] < n], key=lambda p: -p["num"])[:8]
            mayores = sorted([p for p in misma if p["num"] > n], key=lambda p: p["num"])[:8]
            pares = sorted(((a, b) for a in menores for b in mayores
                            if a["calle"] == b["calle"] and b["num"] - a["num"] <= 600
                            and distancia_km((a["lat"], a["lng"]), (b["lat"], b["lng"])) <= 1.5),
                           key=lambda ab: ab[1]["num"] - ab[0]["num"])
            for a, b in pares[:3]:
                f = (n - a["num"]) / (b["num"] - a["num"])
                intentos.append((a["lat"] + f * (b["lat"] - a["lat"]), a["lng"] + f * (b["lng"] - a["lng"]),
                                 f"OpenStreetMap, entre {a['calle']} {a['txt']} y {b['txt']}"))
            for p in [p for p in sorted(misma, key=lambda p: abs(p["num"] - n)) if abs(p["num"] - n) <= 40][:2]:
                intentos.append((p["lat"], p["lng"], f"OpenStreetMap, número cercano: {p['calle']} {p['txt']}"))
        if x.get("buscar_osm") or not calle or len(debiles) <= 3:
            intentos += [(la, lo, f) for _, la, lo, f in sorted(debiles, key=lambda c: -c[0])[:3]]
        if not intentos and calle:
            intentos += centro_de_calle_corta(calle)
        elegido, vistos = None, []
        aceptadas = {st(x.get("comuna"))} | {st(c) for c in x.get("comunas_aceptadas") or []}
        for la, lo, fuente in intentos[:7]:
            comuna = comuna_de(la, lo)
            if comuna and st(comuna) in aceptadas:
                elegido = {"lat": la, "lng": lo, "fuente": fuente}
                break
            vistos.append(f"{fuente} -> {comuna}")
        if not elegido:
            log(f"?? {clave}: sin coordenadas en {x.get('comuna')} ({len(intentos)} intentos: {'; '.join(vistos[:3])})")
            continue
        log(f"OK {clave}: {elegido['lat']:.6f}, {elegido['lng']:.6f} ({elegido['fuente']})")
        resultados[clave] = elegido
    return resultados


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--todos", action="store_true")
    ap.add_argument("--probar", action="store_true")
    args = ap.parse_args()
    datos, lugares = {}, []
    for ruta in ARCHIVOS:
        if not ruta.exists():
            continue
        d = json.load(open(ruta, encoding="utf-8"))
        datos[ruta] = d
        for x in d.get(LISTAS[ruta.name], []):
            if args.todos or not (isinstance(x.get("lat"), (int, float)) and isinstance(x.get("lng"), (int, float))):
                lugares.append({**x, "_clave": f"{ruta.name}:{x['id']}"})
    log(f"{len(lugares)} lugares sin coordenadas")
    if not lugares:
        return
    propios = [x for x in lugares if not x.get("en")]
    resultados = geocodificar(propios) if propios else {}
    # Los que están dentro de una galería toman sus coordenadas (las nuevas o las que ya tenía)
    for x in lugares:
        if not x.get("en"):
            continue
        archivo = x["_clave"].split(":")[0]
        dueno = f"{archivo}:{x['en']}"
        lista = next(d for r, d in datos.items() if r.name == archivo).get(LISTAS[archivo], [])
        g = next((y for y in lista if y["id"] == x["en"]), None)
        if dueno in resultados:
            resultados[x["_clave"]] = {**resultados[dueno], "fuente": f"la de {g['nombre'] if g else x['en']}"}
        elif g and isinstance(g.get("lat"), (int, float)):
            resultados[x["_clave"]] = {"lat": g["lat"], "lng": g["lng"], "fuente": f"la de {g['nombre']}"}
        else:
            log(f"?? {x['_clave']}: su galería ({x['en']}) aún no tiene coordenadas")
    log(f"\n{len(resultados)} de {len(lugares)} con coordenadas")
    if args.probar:
        return
    for ruta, d in datos.items():
        cambio = False
        for x in d.get(LISTAS[ruta.name], []):
            r = resultados.get(f"{ruta.name}:{x['id']}")
            if r:
                x["lat"], x["lng"] = round(r["lat"], 6), round(r["lng"], 6)
                x["coordenadas_fuente"] = r["fuente"]
                for k in ("lat_propuesta", "lng_propuesta", "fuente_propuesta"):
                    x.pop(k, None)
                cambio = True
        if cambio:
            with open(ruta, "w", encoding="utf-8", newline="") as f:
                json.dump(d, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
