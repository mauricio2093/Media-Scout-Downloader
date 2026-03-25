// popup.js: renders detected media for the active tab and exposes filtering, download and utility actions.

const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const listEl = document.getElementById("media-list");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");
const searchInput = document.getElementById("search");
const typeFilter = document.getElementById("type-filter");
const sortFilter = document.getElementById("sort-filter");

const state = {
  allMedia: [],
  query: "",
  type: "all",
  sort: "recent",
};

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  void loadMediaList();
});

function bindEvents() {
  refreshButton.addEventListener("click", () => refreshAndRescan());
  clearButton.addEventListener("click", clearCurrentTabMedia);
  listEl.addEventListener("click", onListClick);
  searchInput.addEventListener("input", onFiltersChange);
  typeFilter.addEventListener("change", onFiltersChange);
  sortFilter.addEventListener("change", onFiltersChange);
}

function onFiltersChange() {
  state.query = searchInput.value.trim().toLowerCase();
  state.type = typeFilter.value;
  state.sort = sortFilter.value;
  renderCurrentState();
}

async function loadMediaList(manualRefresh = false) {
  setStatus(manualRefresh ? "Actualizando detecciones..." : "Cargando medios detectados...");
  listEl.innerHTML = "";

  const activeTab = await getActiveTab();
  if (!activeTab) {
    setStatus("No se pudo identificar la pestaña activa.");
    renderSummary(0, 0);
    renderEmptyState("No se pudo acceder a la pestaña activa.");
    return;
  }

  state.allMedia = await fetchMediaForTab(activeTab.id);
  renderCurrentState();
  setStatus(state.allMedia.length
    ? (manualRefresh ? "Detecciones actualizadas." : "Lista lista para usar.")
    : "No hay medios detectados todavia en esta pestana.");
}

async function refreshAndRescan() {
  setStatus("Actualizando detecciones...");
  const activeTab = await getActiveTab();
  if (!activeTab) {
    setStatus("No se pudo identificar la pestaña activa.");
    return;
  }

  try {
    await requestRescan(activeTab.id);
  } catch (error) {
    // ignore and continue with catalog refresh
  }

  await loadMediaList(true);
}

async function fetchMediaForTab(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getMediaList", tabId });
    return Array.isArray(response?.media) ? response.media : [];
  } catch (error) {
    setStatus("No se pudo recuperar la lista de medios.");
    return [];
  }
}

function renderCurrentState() {
  const filteredMedia = getFilteredMedia(state.allMedia);
  renderSummary(filteredMedia.length, state.allMedia.length);
  renderMedia(filteredMedia);
}

function getFilteredMedia(mediaList) {
  const filtered = mediaList.filter((entry) => {
    if (state.type !== "all" && getEntryKind(entry) !== state.type) {
      return false;
    }

    if (!state.query) {
      return true;
    }

    const haystack = [
      entry.suggestedFileName,
      entry.url,
      entry.pageTitle,
      hostLabel(entry.url),
      entry.mimeType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(state.query);
  });

  filtered.sort((left, right) => compareEntries(left, right, state.sort));
  return filtered;
}

function compareEntries(left, right, sortMode) {
  if (sortMode === "size") {
    const leftSize = left.contentLength || 0;
    const rightSize = right.contentLength || 0;
    if (leftSize !== rightSize) {
      return rightSize - leftSize;
    }
  }

  if (sortMode === "host") {
    const hostCompare = hostLabel(left.url).localeCompare(hostLabel(right.url), "es", { sensitivity: "base" });
    if (hostCompare !== 0) {
      return hostCompare;
    }
  }

  return (right.addedAt || 0) - (left.addedAt || 0);
}

function renderMedia(mediaList) {
  listEl.innerHTML = "";

  if (!mediaList.length) {
    const emptyMessage = state.allMedia.length
      ? "No hay coincidencias con los filtros actuales."
      : "No hay medios detectados. Reproduce el contenido y vuelve a actualizar.";
    renderEmptyState(emptyMessage);
    return;
  }

  mediaList.forEach((entry) => {
    const card = buildMediaCard(entry);
    listEl.appendChild(card);
  });
}

function buildMediaCard(entry) {
  const card = document.createElement("article");
  card.className = "media-card";

  const thumb = buildThumb(entry);
  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = entry.suggestedFileName || deriveTitle(entry.url);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(
    buildChip(sourceLabel(entry.source)),
    buildChip(typeLabel(entry), "kind"),
    buildChip(entry.isPlaylist ? "Playlist HLS/DASH" : (entry.mimeType || "MIME no disponible")),
    buildChip(hostLabel(entry.url)),
    buildChip(entry.contentLength ? humanSize(entry.contentLength) : "Tamaño desconocido"),
  );

  if (entry.duration) {
    meta.append(buildChip(humanDuration(entry.duration)));
  }

  const urlLine = document.createElement("p");
  urlLine.className = "url";
  urlLine.textContent = truncateUrl(entry.url);
  urlLine.title = entry.url;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    buildActionButton("Descargar", "primary", { download: "true", url: entry.url, filename: entry.suggestedFileName || "", mediatype: entry.type || "unknown" }),
    buildActionButton("Copiar URL", "secondary-btn", { copy: entry.url }),
    buildActionButton("Abrir URL", "ghost-btn", { open: entry.url }),
  );

  body.append(title, meta, urlLine);
  card.append(thumb, body, actions);
  return card;
}

function buildThumb(entry) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = typeLabel(entry).toUpperCase();

  const placeholder = document.createElement("div");
  placeholder.className = "thumb-placeholder";

  if (entry.thumbnail) {
    const image = document.createElement("img");
    image.className = "thumb-image";
    image.src = entry.thumbnail;
    image.alt = "miniatura";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => thumb.classList.remove("thumb-has-image"));
    placeholder.appendChild(image);
    thumb.classList.add("thumb-has-image");
  }

  const icon = document.createElement("img");
  icon.className = "icon";
  icon.src = chrome.runtime.getURL("assets/img/favicon.svg");
  icon.alt = "media";
  placeholder.appendChild(icon);

  if (canPreviewVideo(entry)) {
    const videoPreview = document.createElement("video");
    videoPreview.className = "thumb-video";
    videoPreview.src = entry.url;
    if (entry.thumbnail) {
      videoPreview.poster = entry.thumbnail;
    }
    videoPreview.muted = true;
    videoPreview.loop = true;
    videoPreview.playsInline = true;
    videoPreview.preload = "metadata";
    videoPreview.controls = false;

    thumb.addEventListener("mouseenter", () => {
      videoPreview.play().catch(() => {});
      thumb.classList.add("thumb-live");
    });

    thumb.addEventListener("mouseleave", () => {
      videoPreview.pause();
      videoPreview.currentTime = 0;
      thumb.classList.remove("thumb-live");
    });

    videoPreview.addEventListener("error", () => {
      thumb.classList.remove("thumb-live");
      videoPreview.remove();
    });

    thumb.appendChild(videoPreview);
  }

  thumb.append(placeholder, badge);
  return thumb;
}

function buildChip(text, extraClass = "") {
  const chip = document.createElement("span");
  chip.className = `chip secondary ${extraClass}`.trim();
  chip.textContent = text;
  return chip;
}

function buildActionButton(label, className, dataset) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  Object.entries(dataset).forEach(([key, value]) => {
    button.dataset[key] = value;
  });
  return button;
}

async function onListClick(event) {
  const downloadButton = event.target.closest("[data-download]");
  const copyButton = event.target.closest("[data-copy]");
  const openButton = event.target.closest("[data-open]");

  if (downloadButton) {
    const { url, filename, mediatype } = downloadButton.dataset;
    downloadButton.disabled = true;
    const originalText = downloadButton.textContent;
    downloadButton.textContent = "Iniciando...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "downloadMedia",
        url,
        fileName: filename,
        mediaType: mediatype,
      });

      if (!response?.ok) {
        throw new Error(response?.error || "No se pudo iniciar la descarga.");
      }

      downloadButton.textContent = "Descarga iniciada";
      setStatus("Chrome gestionará la descarga. Verifica la barra de descargas.");
    } catch (error) {
      console.error("Download error", error);
      downloadButton.disabled = false;
      downloadButton.textContent = originalText;
      setStatus(`Error al descargar: ${error?.message || "desconocido"}`);
    }
    return;
  }

  if (copyButton) {
    const copied = await copyToClipboard(copyButton.dataset.copy);
    setStatus(copied ? "URL copiada al portapapeles." : "No se pudo copiar la URL.");
    return;
  }

  if (openButton) {
    chrome.tabs.create({ url: openButton.dataset.open });
    setStatus("URL abierta en una nueva pestaña.");
  }
}

function truncateUrl(url) {
  if (!url || url.length <= 80) {
    return url;
  }
  return `${url.slice(0, 50)}…${url.slice(-20)}`;
}

function getEntryKind(entry) {
  if (entry.isPlaylist || entry.type === "playlist") {
    return "playlist";
  }
  return entry.type || "unknown";
}

function typeLabel(entry) {
  switch (getEntryKind(entry)) {
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "playlist":
      return "Playlist";
    default:
      return "Medio";
  }
}

function sourceLabel(source) {
  if (source === "both") {
    return "Origen: DOM + red";
  }
  if (source === "network") {
    return "Origen: red";
  }
  if (source === "dom") {
    return "Origen: DOM";
  }
  return "Origen: desconocido";
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

function renderSummary(visibleCount, totalCount) {
  if (!totalCount) {
    summaryEl.hidden = true;
    summaryEl.textContent = "";
    return;
  }

  summaryEl.hidden = false;
  summaryEl.textContent = visibleCount === totalCount
    ? `${totalCount} recurso(s) detectado(s) en esta pestaña.`
    : `${visibleCount} de ${totalCount} recurso(s) visibles con los filtros actuales.`;
}

async function clearCurrentTabMedia() {
  const activeTab = await getActiveTab();
  if (!activeTab) {
    setStatus("No se pudo identificar la pestaña activa.");
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: "clearMediaForTab", tabId: activeTab.id });
    state.allMedia = [];
    renderCurrentState();
    setStatus("Catálogo de la pestaña limpiado.");
  } catch (error) {
    setStatus("No se pudo limpiar el catálogo de la pestaña.");
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function requestRescan(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "rescanMedia" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(response?.ok);
    });
  });
}

function hostLabel(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch (error) {
    return "Host desconocido";
  }
}

function deriveTitle(url) {
  try {
    const pathname = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (pathname) {
      return decodeURIComponent(pathname);
    }
  } catch (error) {
    // ignore
  }
  return "Recurso sin nombre";
}

async function copyToClipboard(text) {
  if (!text) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.appendChild(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    return copied;
  }
}

function renderEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  listEl.appendChild(empty);
}

function humanSize(bytes) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function humanDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function canPreviewVideo(entry) {
  if (getEntryKind(entry) !== "video") {
    return false;
  }

  const url = entry.url || "";
  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) {
    return false;
  }

  if (entry.mimeType && !entry.mimeType.startsWith("video/")) {
    return false;
  }

  return /\.(mp4|webm|ogv|ogg|m4v|mov)(?:[?#]|$)/i.test(url) || !entry.mimeType;
}
