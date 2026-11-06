@echo off
rem Abre la ventanita que muestra cómo va la búsqueda de El Pregonero en GitHub.
cd /d "%~dp0"
start "" /min python -I ventana_progreso.py --abrir
