#!/usr/bin/env python3
"""Ventana de progreso de El Pregonero.

Muestra en una ventanita el avance de la búsqueda de eventos que corre en GitHub Actions
y, al terminar, qué encontró. También permite lanzar una búsqueda nueva.

Uso:
  python herramientas/ventana_progreso.py --abrir            # sigue la última búsqueda
  python herramientas/ventana_progreso.py --run 123 --abrir  # sigue una búsqueda específica
Se cierra sola un par de minutos después de cerrar la ventana.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = "RodneydelValle/el-pregonero"
WORKFLOW = "buscar-eventos.yml"
WEB = "https://rodneydelvalle.github.io/el-pregonero/"
AQUI = Path(__file__).resolve().parent
SIN_CONSOLA = 0x08000000 if os.name == "nt" else 0
CHROME = [r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
          r"C:\Program Files\Google\Chrome\Application\chrome.exe"]
DURACION_DEFECTO = 22 * 60  # segundos que suele tardar "Buscar eventos" (se ajusta con el historial)


def gh(*args: str, texto=False):
    r = subprocess.run(["gh", *args], capture_output=True, timeout=60, creationflags=SIN_CONSOLA)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace").strip()[:300])
    salida = r.stdout.decode("utf-8", "replace")
    return salida if texto else json.loads(salida)


def fecha(t):
    return dt.datetime.fromisoformat(t.replace("Z", "+00:00")) if t else None


def ahora():
    return dt.datetime.now(dt.timezone.utc)


class Seguidor:
    def __init__(self, run_fijo: int | None):
        self.run_fijo = run_fijo
        self.lock = threading.Lock()
        self.cache: dict = {}
        self.cache_t = 0.0
        self.logs: dict[int, dict] = {}
        self.duracion = None
        self.ultimo_pedido = time.time()

    # ---- historial: cuánto suele tardar la búsqueda
    def duracion_tipica(self) -> int:
        if self.duracion is not None:
            return self.duracion
        tiempos = []
        try:
            runs = gh("api", f"repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=15&status=success")["workflow_runs"]
            for r in [r for r in runs if r["event"] != "push"][:4]:
                for j in gh("api", f"repos/{REPO}/actions/runs/{r['id']}/jobs")["jobs"]:
                    for s in j.get("steps", []):
                        if s["name"] == "Buscar eventos" and s.get("started_at") and s.get("completed_at"):
                            tiempos.append((fecha(s["completed_at"]) - fecha(s["started_at"])).total_seconds())
        except Exception:  # noqa: BLE001
            pass
        self.duracion = int(sorted(tiempos)[len(tiempos) // 2]) if tiempos else DURACION_DEFECTO
        return self.duracion

    def run_actual(self) -> dict:
        if self.run_fijo:
            return gh("api", f"repos/{REPO}/actions/runs/{self.run_fijo}")
        runs = gh("api", f"repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=10")["workflow_runs"]
        busquedas = [r for r in runs if r["event"] != "push"]
        return (busquedas or runs)[0]

    # ---- lectura del registro cuando la búsqueda terminó
    def resumen_log(self, job_id: int) -> dict:
        if job_id in self.logs:
            return self.logs[job_id]
        res = {"eventos": [], "listo": None, "avisos": [], "paginas": 0, "busquedas": None}
        try:
            texto = gh("api", f"repos/{REPO}/actions/jobs/{job_id}/logs", texto=True)
        except Exception as e:  # noqa: BLE001
            res["avisos"].append(f"No pude leer el registro: {e}")
            self.logs[job_id] = res
            return res
        vistos = set()
        for linea in texto.splitlines():
            l = re.sub(r"^\S+Z\s", "", linea).strip()
            m = re.match(r"✓ (\d{4}-\d{2}-\d{2}) (.+) \(([a-z]+)(?:, (.+))?\)$", l)
            if m:
                clave = (m[1], m[2].lower())
                if clave not in vistos:
                    vistos.add(clave)
                    res["eventos"].append({"fecha": m[1], "titulo": m[2], "categoria": m[3], "extra": m[4] or ""})
                continue
            if l.startswith("[página]"):
                res["paginas"] += 1
            m = re.match(r"Listo: (\d+) eventos vigentes, (\d+) nuevos, (\d+) llamadas", l)
            if m:
                res["listo"] = {"total": int(m[1]), "nuevos": int(m[2]), "ia": int(m[3])}
            m = re.match(r"\[búsquedas\] (\d+) resultados nuevos, (\d+) prometedores", l)
            if m:
                res["busquedas"] = {"resultados": int(m[1]), "prometedores": int(m[2])}
            if l.startswith("IA:") and ("cupo" in l or "permiso" in l):
                res["avisos"].append(l)
            if "Traceback" in l or l.startswith("Error"):
                res["avisos"].append(l[:200])
        self.logs[job_id] = res
        return res

    # ---- estado completo para la ventana
    def estado(self) -> dict:
        self.ultimo_pedido = time.time()
        with self.lock:
            if time.time() - self.cache_t < 6 and self.cache:
                return self.cache
            try:
                e = self._estado()
            except Exception as ex:  # noqa: BLE001
                e = {"error": str(ex), **({"previo": self.cache} if self.cache else {})}
            self.cache, self.cache_t = e, time.time()
            return e

    def _estado(self) -> dict:
        run = self.run_actual()
        jobs = {j["name"]: j for j in gh("api", f"repos/{REPO}/actions/runs/{run['id']}/jobs")["jobs"]}
        buscar, publicar = jobs.get("buscar"), jobs.get("publicar")
        tipica = self.duracion_tipica()
        pasos_b = {s["name"]: s for s in (buscar or {}).get("steps", [])}

        def paso(nombre_amable, peso, estado, frac, detalle=""):
            return {"nombre": nombre_amable, "peso": peso, "estado": estado, "frac": frac, "detalle": detalle}

        def estado_de(s):
            if not s:
                return "pendiente"
            if s["status"] == "completed":
                return "ok" if s.get("conclusion") in ("success", "skipped") else "error"
            return "en_curso" if s["status"] == "in_progress" else "pendiente"

        pasos = []
        # 1. Preparar
        prep = [pasos_b.get(n) for n in ("Set up job", "Run actions/checkout@v4", "Run actions/setup-python@v5", "Preparar")]
        hechos = sum(1 for s in prep if s and s["status"] == "completed")
        est = "ok" if hechos == 4 else ("en_curso" if buscar and buscar["status"] != "queued" else "pendiente")
        pasos.append(paso("Preparando la imprenta", 4, est, hechos / 4))
        # 2. Buscar
        sb = pasos_b.get("Buscar eventos")
        est = estado_de(sb)
        frac, restante, detalle = (1.0 if est in ("ok", "error") else 0.0), None, ""
        if est == "en_curso" and sb.get("started_at"):
            transcurrido = (ahora() - fecha(sb["started_at"])).total_seconds()
            frac = min(0.96, transcurrido / tipica)
            restante = max(0, int(tipica - transcurrido))
            detalle = f"{int(transcurrido // 60)} min leyendo"
        pasos.append(paso("Buscando y leyendo afiches", 78, est, frac, detalle))
        # 3. Guardar
        pasos.append(paso("Guardando la agenda", 3, estado_de(pasos_b.get("Guardar resultados")),
                          1.0 if estado_de(pasos_b.get("Guardar resultados")) == "ok" else 0.0))
        # 4. Publicar
        est_p, frac_p = "pendiente", 0.0
        if publicar:
            if publicar["status"] == "completed":
                est_p = "ok" if publicar["conclusion"] == "success" else ("omitido" if publicar["conclusion"] == "skipped" else "error")
                frac_p = 1.0
            elif publicar["status"] == "in_progress":
                est_p = "en_curso"
                frac_p = min(0.9, (ahora() - fecha(publicar["started_at"])).total_seconds() / 70)
        pasos.append(paso("Publicando la web", 15, est_p, frac_p))

        total = sum(p["peso"] for p in pasos)
        avance = sum(p["peso"] * p["frac"] for p in pasos) / total
        terminado = run["status"] == "completed"
        if terminado:
            avance = 1.0
        resultado = None
        if buscar and buscar["status"] == "completed":
            resultado = self.resumen_log(buscar["id"])
        inicio = fecha(run.get("run_started_at") or run["created_at"])
        return {
            "run": {"id": run["id"], "url": run["html_url"], "evento": run["event"], "estado": run["status"],
                    "conclusion": run.get("conclusion"), "inicio": run.get("run_started_at") or run["created_at"],
                    "minutos": int(((fecha(run["updated_at"]) if terminado else ahora()) - inicio).total_seconds() // 60)},
            "pasos": pasos, "avance": round(avance, 4), "restante_s": restante, "tipica_s": tipica,
            "terminado": terminado, "resultado": resultado, "web": WEB,
        }

    def lanzar(self) -> dict:
        gh("workflow", "run", WORKFLOW, "-R", REPO, texto=True)
        self.run_fijo = None
        with self.lock:
            self.cache_t = 0
        return {"ok": True}


class Manejador(BaseHTTPRequestHandler):
    seguidor: Seguidor = None  # type: ignore

    def log_message(self, *a):
        pass

    def _enviar(self, codigo, cuerpo: bytes, tipo: str):
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        if self.path.startswith("/estado.json"):
            datos = json.dumps(self.seguidor.estado(), ensure_ascii=False).encode()
            self._enviar(200, datos, "application/json; charset=utf-8")
        elif self.path in ("/", "/index.html"):
            self._enviar(200, (AQUI / "ventana.html").read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/icono.png":
            self._enviar(200, (AQUI.parent / "icons" / "icono-192.png").read_bytes(), "image/png")
        else:
            self._enviar(404, b"no", "text/plain")

    def do_POST(self):
        # Solo desde la propia ventana: exige una cabecera que otra página no puede poner sin permiso (CORS)
        if self.path != "/buscar" or self.headers.get("X-Pregonero") != "1":
            self._enviar(403, b"no", "text/plain")
            return
        try:
            datos = self.seguidor.lanzar()
        except Exception as e:  # noqa: BLE001
            datos = {"ok": False, "error": str(e)}
        self._enviar(200, json.dumps(datos, ensure_ascii=False).encode(), "application/json; charset=utf-8")


def abrir_ventana(url: str):
    for c in CHROME:
        if Path(c).exists():
            subprocess.Popen([c, f"--app={url}", "--window-size=440,780"], creationflags=SIN_CONSOLA)
            return
    import webbrowser
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=int, help="id de la ejecución a seguir (por defecto, la última búsqueda)")
    ap.add_argument("--puerto", type=int, default=8767)
    ap.add_argument("--abrir", action="store_true", help="abrir la ventana en Chrome")
    args = ap.parse_args()
    seguidor = Seguidor(args.run)
    Manejador.seguidor = seguidor
    servidor = ThreadingHTTPServer(("127.0.0.1", args.puerto), Manejador)
    url = f"http://127.0.0.1:{args.puerto}/"
    print(f"Ventana de progreso en {url}", flush=True)
    if args.abrir:
        abrir_ventana(url)

    def vigilante():  # se apaga solo cuando la ventana lleva un rato cerrada
        while True:
            time.sleep(20)
            if time.time() - seguidor.ultimo_pedido > 150:
                servidor.shutdown()
                return
    threading.Thread(target=vigilante, daemon=True).start()
    servidor.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
