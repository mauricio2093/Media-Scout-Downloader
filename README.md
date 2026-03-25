# Media Scout Downloader

Extensión para Chrome/Chromium basada en Manifest V3 que detecta recursos multimedia accesibles desde la pestaña activa y permite gestionarlos desde un popup: filtrarlos, abrir su URL, copiarlos o descargarlos. Está orientada a contenido sin DRM y no intenta evadir sistemas de protección.

## Qué hace

Media Scout Downloader combina dos vías de detección:

- Escaneo del DOM para localizar elementos `<video>`, `<audio>` y sus `<source>`.
- Inspección de respuestas de red con `chrome.webRequest` para capturar recursos multimedia que no aparecen de forma explícita en el DOM.

La extensión consolida esos hallazgos en un catálogo por pestaña, los enriquece con metadatos y los expone en un popup utilitario.

## Novedades de la versión 0.2.0

- Persistencia del catálogo usando `chrome.storage.session` o `chrome.storage.local` como fallback.
- Fusión de metadatos cuando el mismo recurso se detecta por DOM y por red.
- Deduplicación más segura basada en URL normalizada completa, no solo en `pathname`.
- Filtros y orden en el popup por texto, tipo y tamaño/host/recencia.
- Acción adicional para abrir la URL detectada en una nueva pestaña.
- Escaneo DOM reforzado para contenido dinámico y eventos de carga del reproductor.
- Validación más robusta de descargas y normalización de nombres de archivo.

## Características principales

- Detección híbrida por DOM y tráfico de red.
- Soporte para video, audio y playlists HLS/DASH (`.m3u8`, `.mpd`).
- Catálogo por pestaña con deduplicación y enriquecimiento progresivo.
- Persistencia temporal del catálogo para resistir reinicios del service worker.
- Popup con búsqueda, filtros, orden y acciones rápidas.
- Chips con origen, tipo, host, MIME, tamaño y duración cuando está disponible.
- Miniatura y previsualización hover para algunos videos directos.
- Limpieza automática al recargar o cerrar pestañas.

## Stack técnico

- Chrome Extension Manifest V3
- JavaScript vanilla
- Service worker para la lógica de fondo
- Content script para inspección del DOM
- Popup HTML/CSS/JS sin framework
- Sin proceso de build
- Sin dependencias declaradas en `package.json`

## Estructura del proyecto

```text
.
|-- manifest.json
|-- README.md
|-- release.ps1
|-- release.sh
|-- scripts/
|   `-- m3u8-to-mp4.js
|-- src/
|   |-- background/
|   |   `-- background.js
|   |-- content/
|   |   `-- contentScanner.js
|   `-- ui/
|       |-- popup.css
|       |-- popup.html
|       `-- popup.js
`-- assets/
    `-- img/
        |-- favicon.svg
        |-- icon16.png
        |-- icon32.png
        |-- icon48.png
        `-- icon128.png
```

## Arquitectura

### `manifest.json`
Declara la extensión MV3, el popup, el service worker, el content script y los permisos necesarios.

### `src/background/background.js`
Mantiene el catálogo por `tabId`, clasifica recursos detectados por red, fusiona metadatos, persiste el estado temporal, actualiza el badge y ejecuta descargas con `chrome.downloads`.

### `src/content/contentScanner.js`
Escanea el DOM, observa mutaciones, escucha eventos del reproductor y reporta medios detectados al background.

### `src/ui/popup.*`
Renderiza la lista de medios detectados, aplica filtros y orden, y expone acciones como descargar, copiar URL, abrir URL y limpiar catálogo.

## Requisitos

Para usar la extensión:

- Google Chrome o Chromium con soporte para Manifest V3.

Para utilidades opcionales:

- Node.js para ejecutar `scripts/m3u8-to-mp4.js`.
- `ffmpeg` en `PATH` si se quiere convertir un manifiesto HLS a MP4 fuera de la extensión.
- Git si se quieren usar `release.sh` o `release.ps1` dentro de un repositorio con remoto `origin`.

## Instalación local

1. Descarga o clona el proyecto.
2. Abre `chrome://extensions/`.
3. Activa `Developer mode`.
4. Haz clic en `Load unpacked`.
5. Selecciona la carpeta raíz del proyecto.
6. Verifica que aparezca `Media Scout Downloader` versión `0.2.0`.

## Uso

1. Abre una página con contenido multimedia accesible sin DRM.
2. Reproduce o carga el contenido.
3. Abre el popup de la extensión.
4. Usa la barra de búsqueda y los filtros si necesitas depurar resultados.
5. Ejecuta cualquiera de estas acciones sobre un recurso:
   - `Descargar`
   - `Copiar URL`
   - `Abrir URL`
6. Usa `Actualizar` para forzar un nuevo escaneo o `Limpiar pestaña` para vaciar el catálogo actual.

## Permisos y justificación

- `downloads`: necesario para iniciar descargas.
- `tabs`: necesario para identificar la pestaña activa y abrir URLs detectadas.
- `storage`: necesario para persistencia temporal del catálogo.
- `webRequest`: necesario para detectar recursos multimedia desde respuestas de red.
- `host_permissions: <all_urls>`: requerido para inspección amplia del DOM y del tráfico de recursos.

## Flujo de detección

1. El content script inspecciona `<video>`, `<audio>` y `<source>` en la página y en cambios dinámicos del DOM.
2. El service worker escucha `onHeadersReceived` y clasifica recursos por MIME y extensión.
3. Si un recurso aparece por más de una vía, la entrada se fusiona para conservar MIME, tamaño, duración, miniatura y origen compuesto.
4. El popup consulta el catálogo de la pestaña activa y lo presenta con filtros y acciones.

## Scripts incluidos

### `scripts/m3u8-to-mp4.js`
Helper CLI para convertir un manifiesto HLS a MP4 usando `ffmpeg`.

```bash
node scripts/m3u8-to-mp4.js "https://ejemplo.com/stream.m3u8" salida.mp4
```

Notas:

- Es una utilidad externa a la extensión.
- Requiere `ffmpeg` instalado.
- No resuelve DRM ni flujos protegidos.

### `release.sh`
Script Bash para flujos de versionado/publicación basados en Git.

### `release.ps1`
Versión PowerShell del mismo flujo para Windows.

Importante: ambos scripts asumen que el proyecto vive dentro de un repositorio Git correctamente configurado.

## Limitaciones actuales

- Las playlists HLS/DASH se detectan y pueden descargarse como manifiesto, pero la extensión no reconstruye automáticamente segmentos.
- No se manipula DRM, cifrado ni mecanismos de protección de contenido.
- Algunas URLs expiran rápido o dependen de cookies/cabeceras de sesión, así que una detección exitosa no garantiza descarga exitosa.
- La previsualización del popup depende de que el recurso de video directo sea reproducible desde el contexto de la extensión.
- No hay suite de tests automatizados ni pipeline de build en esta versión.

## Pruebas manuales sugeridas

- Página con `<video src="...">` estático en el DOM.
- Página que inserta el reproductor dinámicamente con JavaScript.
- Recurso de audio HTML5 con varias fuentes `<source>`.
- Stream HLS o DASH público sin DRM para validar detección de manifiesto.
- Reinicio o suspensión del service worker para confirmar persistencia temporal del catálogo.
- Uso combinado de filtros, orden y acciones del popup.

## Consideraciones legales

Usa esta herramienta solo sobre contenido que tengas derecho a descargar o procesar. El proyecto no está diseñado para eludir restricciones técnicas, DRM ni términos de servicio de terceros.

## Estado del proyecto

Versión actual del manifiesto: `0.2.0`.

La extensión es funcional y usable, pero todavía tiene margen de mejora en filtrado avanzado, empaquetado, observabilidad y automatización de pruebas.

## Mejoras futuras posibles

- Panel de opciones para configurar filtros persistentes.
- Exclusión configurable de audios triviales y hosts ruidosos.
- Exportación del catálogo detectado.
- Manejo más avanzado de playlists y detección de calidad.
- Pruebas automatizadas y validaciones previas a release.
