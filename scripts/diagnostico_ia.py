#!/usr/bin/env python3
"""Prueba rápida de GitHub Models (corre en GitHub Actions; la red de la oficina bloquea models.github.ai).

Muestra la respuesta cruda de la IA en 5 casos para saber qué formato funciona.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import actualizar as a  # noqa: E402

TOKEN = os.environ["GITHUB_TOKEN"]
CFG = a.cargar_json(a.CONFIG, None)
MODELO = os.environ.get("MODELO") or CFG["modelo_ia"]


def llamar(cuerpo):
    cuerpo = {"model": MODELO, "temperature": 0.1, **cuerpo}
    req = urllib.request.Request(a.URL_IA, data=json.dumps(cuerpo).encode(), headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            print("   estado", r.status, "| cupo restante:", r.headers.get("x-ratelimit-remaining-requests"),
                  "de", r.headers.get("x-ratelimit-limit-requests"))
            bruto = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        print("   HTTP", e.code, e.read().decode("utf-8", "replace")[:600])
        return
    try:
        d = json.loads(bruto)
        c = d["choices"][0]
    except Exception:  # noqa: BLE001
        print("   cuerpo no JSON:", repr(bruto[:600]))
        return
    print("   fin:", c.get("finish_reason"), "| uso:", d.get("usage"))
    print("   contenido:", repr((c["message"].get("content") or "")[:700]))


sistema = a.instrucciones_base(CFG) + "Responde solo JSON con esta forma: " + a.ESQUEMA_EVENTO
texto = ("Feria Medieval de Ñuñoa: sábado 14 y domingo 15 de noviembre de 2026, de 12:00 a 20:00 en Plaza Ñuñoa. "
         "Entrada liberada. Habrá combates, artesanos y música celta.")
print(f"Modelo: {MODELO}\n")
print("1) Texto simple")
llamar({"messages": [{"role": "user", "content": "Di hola en una palabra"}], "max_tokens": 10})
print("2) JSON con response_format=json_object")
llamar({"messages": [{"role": "system", "content": sistema}, {"role": "user", "content": texto}],
        "max_tokens": 800, "response_format": {"type": "json_object"}})
print("3) JSON sin response_format")
llamar({"messages": [{"role": "system", "content": sistema}, {"role": "user", "content": texto}], "max_tokens": 800})

print("4) Afiche real (imagen)")
pagina, _, final = a.descargar("https://www.puntoticket.com/todos")
filas = a.listado_puntoticket(pagina, final)
fila = next((f for f in filas if f.get("imagen") and "metal" in (f["titulo"] + f.get("tipo", "")).lower()), filas[0])
print("   afiche de:", fila["titulo"], fila["imagen"])
img = a.preparar_imagen(fila["imagen"])
if img:
    llamar({"messages": [{"role": "system", "content": sistema}, {"role": "user", "content": [
        {"type": "text", "text": f"URL: {fila['url']}\nLee el afiche y extrae el evento."},
        {"type": "image_url", "image_url": {"url": img[0], "detail": "high"}}]}], "max_tokens": 800})
else:
    print("   no se pudo preparar la imagen")

print("5) Clase IA del buscador clasificando 60 eventos de PuntoTicket")
ia = a.IA(TOKEN, MODELO, 4)
elegidos = a.ia_clasificar_listado(ia, CFG, "PuntoTicket", filas[:60])
for f, e in elegidos:
    print("   ✓", f["titulo"], "→", e.get("categoria"), "|", e.get("descripcion"))
print(f"   {len(elegidos)} elegidos, llamadas: {ia.usadas}, buenas: {ia.buenas}, modo_json: {ia.modo_json}")
