# IMP TRAVEL

_(antes «El Pregonero»)_

Agenda personal de eventos en Chile, con formato de diario. Sus temas (en `config/gustos.json`): **Medieval, fantasía y rol** (ferias medievales y vikingas, recreación, Tolkien, rol, cine fantástico y de terror), **Yokai y Japón tradicional**, **Anime, manga y cosplay** (también videojuegos), **Ilustración y cómic**, **Conciertos** (metal y rock duro, y conciertos con música de videojuegos o de fantasía), **Juegos de mesa** (también cartas coleccionables y wargames) y **Museos, arte y cultura** (exposiciones de arte, museos y patrimonio). Los temas se reorganizaron el 8-11-2026: antes «Fantasía, rol y juegos», «Exposiciones de arte» y «Conciertos de metal» eran temas aparte.

**Web:** https://rodneydelvalle.github.io/el-pregonero/ (se puede instalar como app: en el computador, con «Descargar la app» arriba a la izquierda; en el celular, desde el menú del navegador)

## Cómo se actualiza

| Cuándo | Qué hace | Costo |
|---|---|---|
| Cada hora (minuto 17) | GitHub Actions corre `scripts/actualizar.py --modo auto`. **Cada 6 horas** (`horas_entre_completas` en `config/gustos.json`) hace la búsqueda completa; en las otras vueltas hace la **rápida**: solo ticketeras y agendas (PuntoTicket, Ticketplus, Eventbrite, VAMOH!, Keai y las agendas de fans), y la IA lee solo lo que apareció desde la vuelta anterior (las filas ya revisadas y las agendas sin cambios no gastan IA). La completa busca en Bing Noticias y DuckDuckGo, en agendas de fans, sitios de comunidades y ticketeras, revisa los eventos nuevos de las agendas **VAMOH!** y **Keai**, y lee las exposiciones de arte y de museos de la Región Metropolitana en la agenda **Chile Cultura** del Ministerio de las Culturas (con su fecha de cierre; sin talleres, charlas ni videos). Las carteleras de los museos del Estado, del MAC, del Precolombino y del GAM se leen cada 3 días (`"cada_dias"` en la fuente), porque sus muestras duran meses. Las páginas de entradas (TUU, Passline, Ticketplus…) se leen sin IA. La IA **Gemini** (plan gratis de Google AI Studio) lee las demás páginas **y sus afiches**, y saca fecha, hora, lugar y precio. | Gratis (cupo diario del plan gratis) |
| Cuando quieras (desde el PC o el celular) | En GitHub: **Actions → Buscar eventos → Run workflow**. Es el botón "Buscar eventos ahora" al pie de la web. | Gratis |
| Búsqueda profunda | En Claude Code: `/buscar-eventos`. Claude busca, abre las cuentas de comunidades en Instagram y Facebook con tu Chrome, lee los afiches y publica. | Incluido en tu plan de Claude |

La búsqueda automática no entra a Instagram ni a Facebook: respeta sus reglas y el `robots.txt` de cada sitio. De esas redes solo usa lo que muestran los buscadores, y las cuentas las revisa `/buscar-eventos` con tu sesión.

## Secciones

La cabecera tiene un banner por sección. Al deslizarlo con el dedo, tocar sus puntos, usar las flechas ‹ › (en el computador) o ← → con el foco en un punto, la página muestra la sección de ese banner:

- **Agenda** (el diablillo con el mapa): todos los eventos, con filtros, buscador y botón 🆕 Nuevos. Las exposiciones que ya están abiertas van juntas en «Exposiciones y temporadas abiertas» (primero las que cierran antes), para no tapar lo que viene.
- **Medieval** (el dragón caballero, el diablillo mago y la elfa arquera en la feria): la agenda con el tema «Medieval, fantasía y rol».
- **Anime** (los tres en cosplay): la agenda con el tema «Anime, manga y cosplay».
- **Ilustración** (la feria de ilustración, manga y cómic): la agenda con el tema «Ilustración y cómic».
- **Conciertos** (el festival de metal): la agenda con el tema «Conciertos».
- **Juegos** (la tienda de juegos): la agenda con el tema «Juegos de mesa».
- **Museos** (el museo): la agenda con el tema «Museos, arte y cultura».
- **Restaurantes** (el ramen): restaurantes temáticos japoneses, vikingos y medievales, góticos y geek en Santiago (`data/restaurantes.json`). La lista se armó el 6-11-2026: cada lugar lo verificó un agente independiente (que siga abierto, la dirección y que la temática sea real) y los que tienen algo por confirmar muestran un aviso ⚠. Los que cerraron o no calzaban quedaron fuera.

Bajo la cabecera hay tres pestañas: **Agenda** (vuelve a la agenda completa), **Mapa del Aventurero** y **Mis favoritos** (lo que marcaste con ☆ Favorito). Elegir un tema en la agenda también mueve el banner (por ejemplo, «Juegos de mesa» lo pasa a Juegos; Yokai no tiene banner propio y deja el de Agenda). Cada sección tiene su dirección: `#eventos`, `#medieval`, `#anime`, `#ilustracion`, `#conciertos`, `#juegos`, `#museos`, `#restaurantes`, `#mapa` y `#favoritos`. Los banners están en `img/banner-*.webp` (3:1, en 900, 1400 y el tamaño original, más un JPG de 1200 de respaldo); su orden y su sección, en `BANNERS` de `app.js`.

En cada evento, restaurante y tienda, **🗺 Cómo llegar** abre Google Maps (en el celular, su app) con la ruta desde donde estás hasta el lugar.

## Mapa del Aventurero

Pestaña aparte (`#mapa`), pedida el 7-11-2026 con una maqueta del usuario. Muestra en un mapa las **tiendas** de cartas (TCG), juegos de mesa, rol, miniaturas, anime y manga y videojuegos (`data/tiendas.json`) y los **restaurantes temáticos** que tienen coordenadas (`lat` y `lng` en `data/restaurantes.json`).

- **Filtros:** categorías (una o más, con su color e ícono), buscador, comuna y «con torneos», «con espacio de juego» y «venta online». «Limpiar filtros» vuelve a mostrar todo.
- **Ficha:** al tocar un marcador (o una fila de la vista **Lista**) se ven sus fotos, categorías, descripción, torneos, mesas de juego, venta online y horario, con ☆ Favorito, Cómo llegar, Sitio web y Compartir. En el computador va a la derecha; en el celular sube desde abajo. Cada lugar tiene su dirección: `#m-t-<id>` (tienda) o `#m-r-<id>` (restaurante).
- **Ordenar por** nombre, comuna o «Más cercanas» (pide la ubicación al navegador; también el botón ⌖ del mapa).
- **Mapa:** [Leaflet 1.9.4](https://leafletjs.com) (en `vendor/`, licencia BSD-2; se carga solo al abrir la pestaña) con las teselas de OpenStreetMap y un filtro sepia para que combine con el pergamino. Las de CARTO quedaron fuera: desde 2026 piden clave.
- **Íconos:** dibujados en código en el sprite de `index.html` (`i-cartas`, `i-dado6`, `i-dado`, `i-meeple`, `i-gato`, `i-mando`, `i-cubiertos`), a la espera de los del usuario. Las categorías (nombre, ícono y color) están en `categorias` de `data/tiendas.json`.
- **Datos de las tiendas:** lista revisada a mano (el robot no la toca), con evidencia de que siguen abiertas. Las tiendas dentro de una galería llevan `"en": "<id de la galería>"` y comparten su marcador.
- **Coordenadas:** las pone `scripts/coordenadas.py` con OpenStreetMap (API Overpass): por nombre, por dirección exacta o interpolando entre dos números de la misma calle, y solo las guarda si el punto cae en la comuna del dato. Se corre con el botón **Run workflow** del workflow «Coordenadas (OpenStreetMap)» (desde la red de la oficina no se llega a Overpass). Pistas: `buscar_osm` (p. ej. el mall donde está el local).
- **Marcadores:** los lugares de una misma dirección van en un marcador con su número (al tocarlo, la lista para elegir) y, con el mapa alejado, los cercanos se juntan en racimos que al tocarlos acercan el mapa. Las fotos siguen las mismas reglas que las de los lugares (sitio oficial, prensa o Wikimedia Commons; nunca Instagram, Facebook ni Google Maps).
- **Favoritos de tiendas:** en el navegador (`pregonero:tiendas`) y, con sesión iniciada, en la cuenta dentro de la lista de restaurantes con `t-` delante (así no hubo que cambiar las reglas de Firestore).

## Fotos de los lugares

Cada evento muestra al menos una foto, y también cada restaurante del que hay fotos en fuentes que se pueden usar (a Doragon Maid aún le falta). En cada nota se ve una foto a la vez: las demás se pasan deslizando con el dedo, con las flechas ‹ › (en el computador) o con ← → del teclado, y el contador dice cuántas hay. Al tocar una se abre en grande, en un visor que dice de dónde es cada foto. De entrada solo se baja la primera foto de cada nota; las siguientes, cuando alguien toca la galería, le pasa el mouse o la enfoca. Para mantenerlas: `python scripts/fotos.py pendientes` (qué falta) y `python scripts/fotos.py revisar` (qué fotos dejaron de cargar).

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

- **Gustos y búsquedas:** `config/gustos.json`. Ahí se agregan categorías, palabras clave, búsquedas, fuentes fijas y cuentas de comunidades (`comunidades.cuentas`). Una categoría con `"peso": 2` (las que juntan dos temas: Medieval, fantasía y rol; Museos, arte y cultura) lee el doble de páginas con IA en cada búsqueda completa. Si cambias el `id` de una categoría, anota el viejo en `temas_renombrados` (id viejo → id nuevo, o una lista si el tema se repartió). Así el robot pasa solo sus eventos al tema nuevo en la vuelta siguiente, y mientras tanto la página ya los muestra ahí. Cambia también `BANNERS` e `ICONO_CAT` en `app.js` y las claves de `referenciales` en `data/lugares.json`.
- **Ocultar un evento:** agrega su título, o parte de él, o su `id` a `data/ocultos.json`.
- **Agregar eventos a mano:** crea un JSON con la lista de eventos y ejecuta `python scripts/actualizar.py --agregar archivo.json --origen manual`.

## Archivos

- `index.html`, `styles.css`, `app.js`: la web (sin dependencias). Cada vez que cambia alguno de ellos (o `cuenta.js`), se sube en uno el número `?v=` con que `index.html` pide `styles.css` y `app.js`, y el mismo número `V` de `sw.js`. Así nadie queda con una mezcla de la versión vieja y la nueva: con red, la página siempre se pide al servidor; sin conexión se usa la página que se guardó junto con su `app.js` y su `styles.css`.
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
- **Noticias:** solo se leen las publicadas desde la búsqueda completa anterior. Las más viejas se descartan sin gastar IA, ya sea por la fecha que muestra el buscador, por la fecha en la dirección o por la fecha de publicación de la página. Las ticketeras, agendas y páginas de eventos se leen siempre, y una agenda vuelve a leerse cuando se actualiza.
- Keai pide en su `robots.txt` que su contenido no se use con IA: de ahí solo se leen sus datos estructurados (`solo_datos_estructurados` en `config/gustos.json`).
- La clave de Gemini vive como secreto del repositorio (`GEMINI_API_KEY`), nunca en el código. GitHub Models (la IA de GitHub) dejó de responder en noviembre de 2026; el buscador lo detecta solo.
- `Diagnóstico IA` (en Actions) prueba la IA en un minuto: modelos disponibles, lectura de un afiche y clasificación de un listado.
