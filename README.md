# El Pregonero

Agenda personal de eventos en Chile, con formato de diario: ferias medievales, yokai y Japón tradicional, anime y cosplay, ilustración y cómic, conciertos de metal, y fantasía, rol y juegos.

**Web:** https://rodneydelvalle.github.io/el-pregonero/ (se puede instalar como app en el celular)

## Cómo se actualiza

| Cuándo | Qué hace | Costo |
|---|---|---|
| Todos los días, 06:00 (hora de Chile, todo el año) | GitHub Actions corre `scripts/actualizar.py`: busca en Bing Noticias y DuckDuckGo, en agendas de fans, sitios de comunidades y ticketeras, y revisa los eventos nuevos de las agendas **VAMOH!** y **Keai**. Las páginas de entradas (TUU, Passline, Ticketplus…) se leen sin IA. La IA **Gemini** (plan gratis de Google AI Studio) lee las demás páginas **y sus afiches**, y saca fecha, hora, lugar y precio. | Gratis (cupo diario del plan gratis) |
| Cuando quieras (desde el PC o el celular) | En GitHub: **Actions → Buscar eventos → Run workflow**. Es el botón "Buscar eventos ahora" al pie de la web. | Gratis |
| Búsqueda profunda | En Claude Code: `/buscar-eventos`. Claude busca, abre las cuentas de comunidades en Instagram y Facebook con tu Chrome, lee los afiches y publica. | Incluido en tu plan de Claude |

La búsqueda automática no entra a Instagram ni a Facebook: respeta sus reglas y el `robots.txt` de cada sitio. De esas redes solo usa lo que muestran los buscadores, y las cuentas las revisa `/buscar-eventos` con tu sesión.

## Personalizar

- **Gustos y búsquedas:** `config/gustos.json`. Ahí se agregan categorías, palabras clave, búsquedas, fuentes fijas y cuentas de comunidades (`comunidades.cuentas`).
- **Ocultar un evento:** agrega su título, o parte de él, o su `id` a `data/ocultos.json`.
- **Agregar eventos a mano:** crea un JSON con la lista de eventos y ejecuta `python scripts/actualizar.py --agregar archivo.json --origen manual`.

## Archivos

- `index.html`, `styles.css`, `app.js`: la web (sin dependencias).
- `manifest.webmanifest`, `sw.js`, `icons/`: instalable como app y funciona sin conexión.
- `data/eventos.json`: la agenda; es la "API" que leerá la futura app.
- `data/vistos.json`: páginas ya revisadas, para no gastar IA dos veces.
- `scripts/actualizar.py`: buscador. Usa solo la biblioteca estándar de Python; Pillow es opcional.
- `PLAN_APP.md`: plan para pasarlo a app.

## Notas

- GitHub puede pausar las tareas programadas de un repositorio público si pasan 60 días sin actividad. Si eso pasa, se reactiva en la pestaña Actions con "Enable workflow".
- Si la IA gratuita llega a su límite del día, lo que quedó pendiente se revisa al día siguiente. Sin IA igual se suman los eventos de ticketeras por palabras clave y las páginas que traen datos estructurados (VAMOH!, Keai, TUU, Passline). Primero se revisan las publicaciones de comunidades que muestran los buscadores, porque son baratas.
- **Noticias:** solo se leen las publicadas desde la búsqueda anterior (en la diaria, ayer y hoy). Las más viejas se descartan sin gastar IA, ya sea por la fecha que muestra el buscador, por la fecha en la dirección o por la fecha de publicación de la página. Las ticketeras, agendas y páginas de eventos se leen siempre, y una agenda vuelve a leerse cuando se actualiza.
- Keai pide en su `robots.txt` que su contenido no se use con IA: de ahí solo se leen sus datos estructurados (`solo_datos_estructurados` en `config/gustos.json`).
- La clave de Gemini vive como secreto del repositorio (`GEMINI_API_KEY`), nunca en el código. GitHub Models (la IA de GitHub) dejó de responder en noviembre de 2026; el buscador lo detecta solo.
- `Diagnóstico IA` (en Actions) prueba la IA en un minuto: modelos disponibles, lectura de un afiche y clasificación de un listado.
