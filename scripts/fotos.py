"""Fotos de IMP TRAVEL: qué lugares aún no tienen foto y qué fotos dejaron de cargar.

Uso:
  python scripts/fotos.py pendientes   eventos que hoy muestran una imagen referencial (ni afiche ni foto
                                       de su lugar) y restaurantes sin foto
  python scripts/fotos.py revisar      prueba todas las fotos de data/lugares.json y data/restaurantes.json
                                       (sin Referer, como el navegador de un visitante) y lista las que fallan

Las fotos de cada lugar están en data/lugares.json; un evento calza con un lugar si su "lugar" o su
"direccion" contienen el nombre o un alias del lugar como palabras enteras (igual que en app.js).
"""
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; ElPregonero/1.0; revision de fotos; +https://github.com/RodneydelValle/el-pregonero)"


def sin_tildes(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", str(t or "")) if unicodedata.category(c) != "Mn").lower()


def clave(t: str) -> str:
    """Igual que claveTexto() en app.js: ' teatro caupolican santiago centro '."""
    return " " + re.sub(r"[^a-z0-9]+", " ", sin_tildes(t)).strip() + " "


def cargar(nombre: str) -> dict:
    return json.loads((RAIZ / nombre).read_text(encoding="utf-8"))


def claves_de(lista) -> list[str]:
    return [c for c in (clave(x) for x in (lista or []) if x) if len(c.strip()) >= 3]


def lugares_de(evento: dict, lugares: list[dict]) -> list[dict]:
    """Igual que lugaresDe() en app.js: los lugares nombrados en el lugar o la dirección, en el orden del texto."""
    t = clave(" ".join(str(x) for x in (evento.get("lugar"), evento.get("direccion")) if x))
    if not t.strip():
        return []
    todo = clave(" ".join(str(evento.get(k) or "") for k in ("lugar", "direccion", "comuna", "ciudad", "region")))
    hallados = []
    for l in lugares:
        if any(x in todo for x in claves_de(l.get("excluir"))):
            continue  # el texto nombra otra sede ("quinta normal" no es el MAC del Parque Forestal)
        claves = claves_de([l.get("nombre"), *(l.get("alias") or [])])
        alias = max((c for c in claves if c in t), key=len, default=None)
        if alias:
            hallados.append((l, alias, t.index(alias), claves))
    # Se descarta un lugar si otro que también calzó tiene un alias más largo que contiene el suyo
    quedan = [(l, pos) for l, a, pos, _ in hallados
              if not any(o is not l and any(len(c) > len(a) and a in c for c in cs) for o, _, _, cs in hallados)]
    return [l for l, _ in sorted(quedan, key=lambda x: x[1])]


def https(u) -> bool:
    return isinstance(u, str) and bool(re.match(r"https?://", u, re.I))


def fotos_del_lugar_en(evento: dict, lugares: list[dict]) -> bool:
    """¿La web le muestra al evento alguna foto de su lugar? (hasta 3 lugares, como en app.js)"""
    return any(any(https(f.get("url")) for f in l.get("fotos") or []) for l in lugares_de(evento, lugares)[:3])


def pendientes():
    lugares = cargar("data/lugares.json").get("lugares", [])
    hoy = time.strftime("%Y-%m-%d")
    sin_foto: dict[str, list[str]] = {}
    for e in cargar("data/eventos.json").get("eventos", []):
        if (e.get("fecha_fin") or e.get("fecha_inicio") or "") < hoy:
            continue  # ya pasó
        if https(e.get("imagen")) or any(https(u) for u in e.get("fotos") or []):
            continue
        if fotos_del_lugar_en(e, lugares):
            continue
        nombre = e.get("lugar") or e.get("direccion") or "(sin lugar)"
        sin_foto.setdefault(nombre, []).append(f'{e["fecha_inicio"]} {e["titulo"]}')
    if sin_foto:
        print("Lugares sin foto (sus eventos muestran una imagen referencial). Agrégalos a data/lugares.json:")
        for nombre, evs in sorted(sin_foto.items()):
            print(f"  - {nombre}: " + "; ".join(evs[:3]) + (f" y {len(evs) - 3} más" if len(evs) > 3 else ""))
    else:
        print("Todos los eventos tienen afiche o foto de su lugar.")
    sin = [r.get("nombre", r.get("id")) for r in cargar("data/restaurantes.json").get("restaurantes", [])
           if not any(https(f.get("url")) for f in r.get("fotos") or [])]
    print(("Restaurantes sin foto: " + ", ".join(sin)) if sin else "Todos los restaurantes tienen foto.")


def probar(url: str) -> str | None:
    """None si carga como imagen; si no, el motivo."""
    if not url.startswith("https://"):
        return "no es https"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/webp,image/jpeg,image/png,image/*"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            tipo = r.headers.get("Content-Type", "")
            r.read(64)
            return None if tipo.startswith("image/") else f"no es imagen ({tipo})"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return str(e)[:120]


def revisar():
    fotos = []
    for l in cargar("data/lugares.json").get("lugares", []):
        fotos += [(l.get("nombre", l.get("id")), f) for f in l.get("fotos") or []]
    for cat, lista in (cargar("data/lugares.json").get("referenciales") or {}).items():
        fotos += [(f"referencial {cat}", f) for f in lista or []]
    for r in cargar("data/restaurantes.json").get("restaurantes", []):
        fotos += [(r.get("nombre", r.get("id")), f) for f in r.get("fotos") or []]
    malas = 0
    for dueno, f in fotos:
        for campo in ("url", "mini"):
            if f.get(campo):
                motivo = probar(f[campo])
                if motivo:
                    malas += 1
                    print(f"  ✗ {dueno} ({campo}): {motivo} — {f[campo]}")
                time.sleep(0.3)
    print(f"{len(fotos)} fotos revisadas, {malas} con problemas.")
    print("Nota: algunos sitios rechazan a los programas (403) pero sí cargan en el navegador, y otros al revés "
          "(bloqueos que solo afectan al navegador): ante la duda, ábrelas en la web antes de quitarlas.")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    accion = sys.argv[1] if len(sys.argv) > 1 else ""
    if accion == "pendientes":
        pendientes()
    elif accion == "revisar":
        revisar()
    else:
        sys.exit(__doc__)
