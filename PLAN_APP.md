# Plan: de web a app

El Pregonero se pensó desde el inicio para convertirse en app sin rehacerlo. Toda la información vive en un solo archivo público, `data/eventos.json`, que funciona como una "API" gratuita. La web, la versión instalable y una futura app de Android leen ese mismo archivo, así que no hace falta ningún servidor pagado.

Regla de oro: **cero costo extra**. Todo lo de abajo es gratis, salvo lo que está marcado con 💲, que queda como opción para decidir más adelante.

## Fase 0 · Lista: web instalable (PWA)

- [x] `manifest.webmanifest` con nombre, colores e íconos (incluido un ícono adaptable para Android).
- [x] `sw.js` (service worker): la agenda queda guardada en el teléfono y se puede ver sin conexión.
- [x] Botón **Instalar como app** (Chrome y Edge en Android y PC). En iPhone se instala desde Safari con Compartir → *Agregar a inicio*.
- [x] Atajo **Mis guardados** al mantener presionado el ícono.
- [x] Guardados (★), exportar al calendario (.ics), mapa y compartir.

## Fase 1 · Avisos de eventos nuevos (gratis)

- Usar **ntfy.sh** (gratis y sin cuenta): el robot diario publica en un tema privado, por ejemplo `pregonero-<algo-secreto>`, cuando encuentra eventos de alta confianza. En el teléfono se instala la app ntfy y se suscribe a ese tema.
  - Cambio: un paso más en `.github/workflows/buscar-eventos.yml` con `curl -d "3 eventos nuevos: …" ntfy.sh/<tema>`.
  - El nombre del tema se guarda como *secret* del repositorio, no en el código.
- Avisos por categoría: solo metal y medieval, por ejemplo, configurable en `config/gustos.json`.
- Recordatorio de los eventos guardados el día antes: hoy lo cubre el .ics; más adelante, con notificaciones locales en la app.

## Fase 2 · App Android (gratis)

Hay dos caminos y ambos reutilizan esta misma web:

1. **TWA con PWABuilder** (recomendado): pwabuilder.com toma la URL de GitHub Pages y genera un `.apk`/`.aab` firmado. La app es la misma web a pantalla completa y se actualiza sola cuando cambia la web.
2. **Capacitor**: envuelve los archivos (`index.html`, `app.js`, `styles.css`) en un proyecto Android nativo. Sirve si más adelante se quieren funciones nativas (notificaciones locales, widget de inicio, calendario del teléfono).
   - Requiere Android Studio (gratis) y Node.

Distribución:
- **Gratis**: instalar el `.apk` directo en tu teléfono (permitir "orígenes desconocidos") o compartirlo con amigos.
- 💲 **Google Play**: cuenta de desarrollador con pago único de US$25. Solo si algún día se quiere publicar en la tienda.
- 💲 **App Store (iPhone)**: US$99 al año. En iPhone basta la PWA desde Safari.

## Fase 3 · Funciones de app

- Vista **mapa** con todos los eventos (Leaflet + OpenStreetMap, gratis).
- **"Voy / No me interesa"**: hoy "No me interesa" se resuelve agregando el título a `data/ocultos.json`. En la app sería un botón que crea ese cambio, con una GitHub Action disparada por *issue* o *repository_dispatch*.
- Filtro por **comuna** y por **precio** (gratis / pagado).
- **Widget** de "próximo evento guardado" (Capacitor).
- Sincronizar guardados entre teléfono y PC, sin servidor: guardarlos en un *gist* privado de GitHub con el mismo inicio de sesión.

## Contrato de datos (no romper)

`data/eventos.json`, versión 1:

```json
{
  "version": 1,
  "actualizado": "2026-11-06T07:15-03:00",
  "ultima_busqueda": { "fecha": "…", "eventos_nuevos": 3, "llamadas_ia": 40 },
  "total": 25,
  "eventos": [{
    "id": "a1b2c3d4e5", "titulo": "…", "categoria": "medieval",
    "fecha_inicio": "2026-11-14", "fecha_fin": "2026-11-15", "hora": "12:00",
    "lugar": "…", "direccion": "…", "comuna": "…", "ciudad": "…", "region": "…",
    "precio": "Gratis", "descripcion": "…", "imagen": "https://…", "url": "https://…",
    "fuentes": [{ "nombre": "…", "url": "…" }],
    "desde_imagen": true, "confianza": "alta|media|baja",
    "agregado": "2026-11-06", "actualizado": "2026-11-06"
  }]
}
```

- El `id` no cambia aunque el evento se actualice, y de eso dependen los guardados.
- Si se agregan campos, son opcionales. Si se cambia algo incompatible, se sube a `"version": 2` y la app debe aceptar ambas versiones por un tiempo.
