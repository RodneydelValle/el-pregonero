# IMP TRAVEL

_(antes «El Pregonero»)_

Agenda personal de eventos en Chile, con formato de diario: ferias medievales, yokai y Japón tradicional, anime y cosplay, ilustración y cómic, conciertos de metal, fantasía, rol y juegos, exposiciones de arte y museos.

**Web:** https://rodneydelvalle.github.io/el-pregonero/ (se puede instalar como app en el celular)

## Cómo se actualiza

| Cuándo | Qué hace | Costo |
|---|---|---|
| Todos los días, 06:00 (hora de Chile, todo el año) | GitHub Actions corre `scripts/actualizar.py`: busca en Bing Noticias y DuckDuckGo, en agendas de fans, sitios de comunidades y ticketeras, revisa los eventos nuevos de las agendas **VAMOH!** y **Keai**, y lee las exposiciones de arte y de museos de la Región Metropolitana en la agenda **Chile Cultura** del Ministerio de las Culturas (con su fecha de cierre; sin talleres, charlas ni videos). Las carteleras de los museos del Estado, del MAC, del Precolombino y del GAM se leen cada 3 días (`"cada_dias"` en la fuente), porque sus muestras duran meses. Las páginas de entradas (TUU, Passline, Ticketplus…) se leen sin IA. La IA **Gemini** (plan gratis de Google AI Studio) lee las demás páginas **y sus afiches**, y saca fecha, hora, lugar y precio. | Gratis (cupo diario del plan gratis) |
| Cuando quieras (desde el PC o el celular) | En GitHub: **Actions → Buscar eventos → Run workflow**. Es el botón "Buscar eventos ahora" al pie de la web. | Gratis |
| Búsqueda profunda | En Claude Code: `/buscar-eventos`. Claude busca, abre las cuentas de comunidades en Instagram y Facebook con tu Chrome, lee los afiches y publica. | Incluido en tu plan de Claude |

La búsqueda automática no entra a Instagram ni a Facebook: respeta sus reglas y el `robots.txt` de cada sitio. De esas redes solo usa lo que muestran los buscadores, y las cuentas las revisa `/buscar-eventos` con tu sesión.

## Pestañas

- **Agenda:** los eventos, con filtros, buscador y botón 🆕 Nuevos. Las exposiciones que ya están abiertas van juntas en «Exposiciones y temporadas abiertas» (primero las que cierran antes), para no tapar lo que viene.
- **Restaurantes temáticos:** japoneses, vikingos y medievales, góticos y geek en Santiago (`data/restaurantes.json`). La lista se armó el 6-11-2026: cada lugar lo verificó un agente independiente (que siga abierto, la dirección y que la temática sea real) y los que tienen algo por confirmar muestran un aviso ⚠. Los que cerraron o no calzaban quedaron fuera.
- **Mis favoritos:** lo que marcaste con ☆ Favorito, con un mapa de Google Maps del lugar elegido. Al tocar el mapa se abre Google Maps (en el celular, la app).

## Fotos de los lugares

Cada evento muestra al menos una foto, y también cada restaurante del que hay fotos en fuentes que se pueden usar (a Doragon Maid aún le falta). Al tocarla se abre un visor con todas (se pasan deslizando o con las flechas) y cada una dice de dónde es. Para mantenerlas: `python scripts/fotos.py pendientes` (qué falta) y `python scripts/fotos.py revisar` (qué fotos dejaron de cargar).

- **Eventos:** primero el afiche y las fotos del evento; después, las del lugar. Las fotos de teatros, salas, museos y centros culturales están en `data/lugares.json`: cada lugar tiene su `nombre`, sus `alias` (cómo lo escriben las ticketeras, por ejemplo «Teatro Caupolicán - Santiago Centro» calza con el alias «teatro caupolican») y sus `fotos`. Así, todos los eventos de un mismo lugar muestran sus fotos, también los que encuentre el robot más adelante.
- **Lugar nuevo sin foto:** se muestra una imagen referencial de la categoría (dice «Imagen referencial»). `/buscar-eventos` revisa esos lugares y les agrega fotos.
- **Restaurantes:** en `fotos` de cada uno, en `data/restaurantes.json`.
- **De dónde salen:** del sitio oficial del lugar, de notas de prensa sobre él o de Wikimedia Commons (licencia libre, con autor y licencia en el crédito). No se usan Instagram, Facebook ni Google Maps, porque sus enlaces caducan o sus reglas no lo permiten. Las fotos no se copian: la web las enlaza.
- Formato de cada foto: `{"url", "mini" (versión chica o null), "pagina" (de dónde es), "credito", "descripcion" (texto alternativo)}`.

## Inicio de sesión con Google (favoritos de cada persona)

Usa **Firebase** en su plan gratis (Spark, sin tarjeta): Authentication con Google y Firestore. Cada persona guarda sus favoritos en `favoritos/{uid}` y las reglas (`firestore.rules`) impiden que alguien vea los de otro. Sin sesión, los favoritos quedan en el navegador; al iniciar sesión se suman a la cuenta. Al cerrar sesión se borran del navegador.

Para activarlo (una sola vez):

1. En [console.firebase.google.com](https://console.firebase.google.com) crea un proyecto (Google Analytics no hace falta). Queda en el plan **Spark, gratis**. No lo pases a Blaze.
2. **Authentication → Comenzar → Método de acceso → Google → Habilitar.** Pon "IMP TRAVEL" como nombre público y guarda.
3. **Authentication → Configuración → Dominios autorizados → Agregar dominio:** `rodneydelvalle.github.io`.
4. **Firestore Database → Crear base de datos** (ubicación `southamerica-east1`, modo producción). En la pestaña **Reglas**, pega `firestore.rules` y publica.
5. **Configuración del proyecto → Tus apps → Web (</>)**: registra la app y copia el objeto `firebaseConfig` en `config/firebase.js`. Esos datos son públicos por diseño; lo que protege los favoritos son las reglas.

## Personalizar

- **Gustos y búsquedas:** `config/gustos.json`. Ahí se agregan categorías, palabras clave, búsquedas, fuentes fijas y cuentas de comunidades (`comunidades.cuentas`).
- **Ocultar un evento:** agrega su título, o parte de él, o su `id` a `data/ocultos.json`.
- **Agregar eventos a mano:** crea un JSON con la lista de eventos y ejecuta `python scripts/actualizar.py --agregar archivo.json --origen manual`.

## Archivos

- `index.html`, `styles.css`, `app.js`: la web (sin dependencias).
- `cuenta.js`, `config/firebase.js`, `firestore.rules`: inicio de sesión con Google y favoritos en la nube.
- `data/restaurantes.json`: restaurantes temáticos (nombre, tema, dirección, redes, fuentes y fotos).
- `data/lugares.json`: teatros, salas, museos y centros culturales con sus fotos, y las imágenes referenciales por categoría.
- `manifest.webmanifest`, `sw.js`, `icons/`: instalable como app y funciona sin conexión.
- `data/eventos.json`: la agenda; es la "API" que leerá la futura app.
- `data/vistos.json`: páginas ya revisadas, para no gastar IA dos veces.
- `scripts/actualizar.py`: buscador. Usa solo la biblioteca estándar de Python; Pillow es opcional.
- `PLAN_APP.md`: plan para pasarlo a app.

## Notas

- GitHub puede pausar las tareas programadas de un repositorio público si pasan 60 días sin actividad. Si eso pasa, se reactiva en la pestaña Actions con "Enable workflow".
- Si la IA gratuita llega a su límite del día, lo que quedó pendiente se revisa al día siguiente. Sin IA igual se suman los eventos de ticketeras por palabras clave y las páginas que traen datos estructurados (VAMOH!, Keai, TUU, Passline, Chile Cultura). Primero se revisan las publicaciones de comunidades que muestran los buscadores, porque son baratas.
- **Noticias:** solo se leen las publicadas desde la búsqueda anterior (en la diaria, ayer y hoy). Las más viejas se descartan sin gastar IA, ya sea por la fecha que muestra el buscador, por la fecha en la dirección o por la fecha de publicación de la página. Las ticketeras, agendas y páginas de eventos se leen siempre, y una agenda vuelve a leerse cuando se actualiza.
- Keai pide en su `robots.txt` que su contenido no se use con IA: de ahí solo se leen sus datos estructurados (`solo_datos_estructurados` en `config/gustos.json`).
- La clave de Gemini vive como secreto del repositorio (`GEMINI_API_KEY`), nunca en el código. GitHub Models (la IA de GitHub) dejó de responder en noviembre de 2026; el buscador lo detecta solo.
- `Diagnóstico IA` (en Actions) prueba la IA en un minuto: modelos disponibles, lectura de un afiche y clasificación de un listado.
