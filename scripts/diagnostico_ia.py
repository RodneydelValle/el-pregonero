#!/usr/bin/env python3
"""Prueba rápida de la IA configurada en config/gustos.json -> "ia" (corre en GitHub Actions).

Muestra los modelos disponibles y la respuesta en 3 casos: texto, afiche (imagen) y listado de ticketera.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import actualizar as a  # noqa: E402

CFG = a.cargar_json(a.CONFIG, None)
CONF = CFG.get("ia") or {}
CLAVE = os.environ.get(CONF.get("clave_env", "GEMINI_API_KEY"), "")
if not CLAVE:
    sys.exit(f"Falta el secreto {CONF.get('clave_env')} en GitHub (Settings → Secrets and variables → Actions).")
if os.environ.get("MODELO"):
    CONF = {**CONF, "modelos": [os.environ["MODELO"]] + CONF.get("modelos", [])}

ia = a.IA(CONF, CLAVE, 6)
print("Proveedor:", CONF.get("nombre"), "|", ia.url)
ia.elegir_modelo()
print("Modelo elegido:", ia.modelo, "| respaldo:", ", ".join(ia.preferidos[1:]), "\n")

sistema = a.instrucciones_base(CFG) + "Responde solo JSON con esta forma: " + a.ESQUEMA_EVENTO
print("1) Texto de una feria")
r = ia.json(sistema, "Feria Medieval de Ñuñoa: sábado 14 y domingo 15 de noviembre de 2026, de 12:00 a 20:00 "
                     "en Plaza Ñuñoa. Entrada liberada. Habrá combates, artesanos y música celta.", max_tokens=2000)
print("  ", json.dumps(r, ensure_ascii=False)[:700])

print("2) Afiche (solo imagen, sin texto de apoyo)")
pagina, _, final = a.descargar("https://www.puntoticket.com/emperor")
meta = a.metadatos(pagina)
url_img = meta.get("og:image")
print("   imagen:", url_img)
img = a.preparar_imagen(url_img) if url_img else None
if img:
    r = ia.json(sistema, [{"type": "text", "text": "Lee este afiche y extrae el evento (solo lo que diga la imagen)."},
                          {"type": "image_url", "image_url": {"url": img[0]}}], max_tokens=2000)
    print("  ", json.dumps(r, ensure_ascii=False)[:700])
else:
    print("   no se pudo preparar la imagen")

print("3) Clasificar 60 eventos de PuntoTicket (bandas de metal, anime, etc.)")
pagina, _, final = a.descargar("https://www.puntoticket.com/todos")
filas = a.listado_puntoticket(pagina, final)
for f, e in a.ia_clasificar_listado(ia, CFG, "PuntoTicket", filas[:60]):
    print("   ✓", f["titulo"], "→", e.get("categoria"), "|", e.get("descripcion"))
print(f"\nLlamadas: {ia.usadas}, respuestas buenas: {ia.buenas}, cupo agotado: {ia.agotada}, extra: {ia.extra}")
