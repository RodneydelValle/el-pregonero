#!/usr/bin/env python3
"""Coordenadas (lat, lng) desde OpenStreetMap para el Mapa del Aventurero.

Completa "lat" y "lng" de los lugares de data/restaurantes.json y data/tiendas.json que no las tienen.
Usa la API Overpass (no Nominatim: su robots.txt no deja usarlo así), con pocas consultas grandes:
  1) por nombre, entre restaurantes, cafés, bares, tiendas, malls y galerías del mapa;
  2) por dirección: todos los números de esas calles (dirección exacta o interpolada entre dos números);
  3) la comuna de cada punto (is_in), que debe ser la del dato. Si no calza, no se guarda.
Pistas opcionales en cada lugar: "buscar_osm" (otro nombre para buscar, p. ej. el mall donde está) y "en"
(el id de la galería donde está: toma sus coordenadas, así todos los de la galería van en un mismo marcador).
Corre en GitHub Actions (workflow «Coordenadas»): la red de la oficina no llega a overpass-api.de.

Uso: python scripts/coordenadas.py [--todos] [--probar]
  --todos   recalcula también los que ya tienen coordenadas
  --probar  muestra lo que haría sin guardar
"""
from __future__ import annotations

import argparse
import json
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
    """'Galería de la Merced, Huérfanos 635, local 22 (…)' -> ('Huérfanos', 635)."""
    d = re.sub(r"\(.*?\)", "", direccion or "")
    for parte in d.split(","):
        parte = parte.strip()
        if not parte or NO_CALLE.match(parte):
            continue
        m = re.match(r"^(.*?[A-Za-zÁÉÍÓÚÑáéíóúñ.'’])\s+0*(\d{1,5}(?:\.\d{3})?)\b", parte)
        if m:
            calle = re.sub(r"^(av\.?|avda\.?|avenida|calle|pasaje|psje\.?|paseo)\s+", "", m.group(1).strip(), flags=re.I)
            calle = re.sub(r"^dr\.?\s+", "Doctor ", calle, flags=re.I).replace("’", "'")
            return calle.strip(), int(m.group(2).replace(".", ""))
    return None, None


def variantes(calle: str) -> list[str]:
    """Cómo puede estar escrita la calle en OpenStreetMap (se busca con igualdad exacta, que es rápida)."""
    base = {calle, calle.replace("Bío Bío", "Biobío"), calle.replace("Biobío", "Bío Bío")}
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
    for e in overpass(f"[out:json][timeout:180];({partes});out center tags;"):
        t = e.get("tags", {})
        la, lo = pos(e)
        m = re.match(r"\d+", t.get("addr:housenumber", ""))
        if la is not None and m:
            numeros.append({"num": int(m.group()), "lat": la, "lng": lo, "calle": t.get("addr:street", "")})
    log(f"   {len(numeros)} números de esas calles")

    resultados = {}
    for x in lugares:
        clave = x["_clave"]
        buscado = st(nombre_buscado(x))
        calle = x["_calle"]
        de_calle = {st(v) for v in calles.get(calle, [])} if calle else set()
        r = None
        # por nombre: el nombre de OSM contiene el buscado (o al revés) y, si hay calle, que calce
        cand = []
        for e in por_nombre:
            t = e.get("tags", {})
            la, lo = pos(e)
            nom = st(t.get("name"))
            if la is None or not nom or not (buscado in nom or (len(nom) >= 5 and nom in buscado)):
                continue
            puntos = 1
            if calle and st(t.get("addr:street")) in de_calle:
                puntos += 2
            if x["_num"] and str(x["_num"]) == re.sub(r"\D", "", t.get("addr:housenumber", "")):
                puntos += 2
            cand.append((puntos, la, lo, t.get("name"), t.get("addr:street") or "", t.get("addr:housenumber") or ""))
        cand.sort(key=lambda c: -c[0])
        if cand and (cand[0][0] >= 3 or len(cand) == 1 or x.get("buscar_osm")):
            p = cand[0]
            r = {"lat": p[1], "lng": p[2], "fuente": f"OpenStreetMap, por nombre: {p[3]} {p[4]} {p[5]}".strip()}
        elif calle and x["_num"]:
            misma = [n for n in numeros if st(n["calle"]) in de_calle]
            exactos = [n for n in misma if n["num"] == x["_num"]]
            if exactos:
                n = exactos[0]
                r = {"lat": n["lat"], "lng": n["lng"], "fuente": f"OpenStreetMap, dirección: {n['calle']} {n['num']}"}
            else:
                menores = sorted([n for n in misma if n["num"] < x["_num"]], key=lambda n: -n["num"])
                mayores = sorted([n for n in misma if n["num"] > x["_num"]], key=lambda n: n["num"])
                par = None
                for a in menores[:8]:
                    b = next((b for b in mayores[:8] if b["calle"] == a["calle"] and b["num"] - a["num"] <= 600), None)
                    if b:
                        par = (a, b)
                        break
                if par:
                    a, b = par
                    f = (x["_num"] - a["num"]) / (b["num"] - a["num"])
                    r = {"lat": a["lat"] + f * (b["lat"] - a["lat"]), "lng": a["lng"] + f * (b["lng"] - a["lng"]),
                         "fuente": f"OpenStreetMap, entre {a['calle']} {a['num']} y {b['num']}"}
                else:
                    cerca = sorted(misma, key=lambda n: abs(n["num"] - x["_num"]))
                    if cerca and abs(cerca[0]["num"] - x["_num"]) <= 40:
                        n = cerca[0]
                        r = {"lat": n["lat"], "lng": n["lng"], "fuente": f"OpenStreetMap, número cercano: {n['calle']} {n['num']}"}
        if not r:
            log(f"?? {clave}: sin coordenadas (nombre: {len(cand)} parecidos; calle: {calle} {x['_num']})")
            continue
        # 3) la comuna del punto debe ser la del dato
        area = overpass(f'[out:json][timeout:60];is_in({r["lat"]},{r["lng"]})->.a;'
                        f'area.a["admin_level"="8"]["boundary"="administrative"];out tags;', timeout=90)
        comuna = area[0]["tags"].get("name") if area else None
        if not comuna or st(comuna) != st(x.get("comuna")):
            log(f"?? {clave}: {r['fuente']} cae en {comuna}, no en {x.get('comuna')}: no se guarda")
            continue
        log(f"OK {clave}: {r['lat']:.6f}, {r['lng']:.6f} ({r['fuente']})")
        resultados[clave] = r
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
                cambio = True
        if cambio:
            with open(ruta, "w", encoding="utf-8", newline="") as f:
                json.dump(d, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
