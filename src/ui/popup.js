// popup.js: renders grouped media detections for the active tab and exposes download/open/copy actions.

const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const listEl = document.getElementById("media-list");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");
const searchInput = document.getElementById("search");
const typeFilter = document.getElementById("type-filter");
const sortFilter = document.getElementById("sort-filter");
const settingsButton = document.getElementById("settings");

const state = {
  allMedia: [],
  query: "",
  type: "all",
  sort: "recent",
  selectedVariantByGroup: {},
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
  settingsButton.addEventListener("click", openSettingsPage);
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
    renderSummary([], []);
    renderEmptyState("No se pudo acceder a la pestaña activa.");
    return;
  }

  await ensureAutoDetection(activeTab.id);
  state.allMedia = await fetchMediaForTab(activeTab.id);
  renderCurrentState();
  setStatus(state.allMedia.length
    ? (manualRefresh ? "Detecciones actualizadas." : "Lista de medios actualizada.")
    : "No hay medios detectados todavia en esta pestana.");
}

async function refreshAndRescan() {
  setStatus("Actualizando detecciones...");
  const activeTab = await getActiveTab();
  if (!activeTab) {
    setStatus("No se pudo identificar la pestaña activa.");
    return;
  }

  await ensureAutoDetection(activeTab.id, true);
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
  const allGroups = buildMediaGroups(state.allMedia);
  const visibleGroups = getFilteredGroups(allGroups);
  renderSummary(visibleGroups, allGroups);
  renderMediaGroups(visibleGroups);
}

function buildMediaGroups(mediaList) {
  const groups = new Map();

  mediaList.forEach((entry) => {
    const key = getGroupKey(entry);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        entries: [],
        pageUrl: entry.pageUrl || null,
        pageTitle: entry.pageTitle || "",
        thumbnail: entry.thumbnail || null,
        duration: entry.duration || null,
      });
    }

    const group = groups.get(key);
    group.entries.push(entry);

    if (!group.pageUrl && entry.pageUrl) {
      group.pageUrl = entry.pageUrl;
    }

    if (!group.pageTitle && entry.pageTitle) {
      group.pageTitle = entry.pageTitle;
    }

    if (!group.thumbnail && entry.thumbnail) {
      group.thumbnail = entry.thumbnail;
    }

    if (!group.duration && entry.duration) {
      group.duration = entry.duration;
    }
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    entries: dedupeGroupEntries(group.entries),
  }));
}

function dedupeGroupEntries(entries) {
  const deduped = new Map();

  [...entries].sort((left, right) => compareEntries(left, right, "recent")).forEach((entry) => {
    const key = variantKey(entry);
    const current = deduped.get(key);
    if (!current || compareEntries(entry, current, "recent") < 0) {
      deduped.set(key, entry);
    }
  });

  return Array.from(deduped.values()).sort((left, right) => compareEntries(left, right, "recent"));
}

function getFilteredGroups(groups) {
  const visibleGroups = groups
    .map((group) => {
      const visibleEntries = group.entries.filter(entryMatchesFilters);
      if (!visibleEntries.length) {
        return null;
      }

      const displayEntries = selectDisplayEntries(visibleEntries);
      const activeEntry = resolveActiveEntry(group, displayEntries, visibleEntries);
      const previewEntry = pickPreviewEntry(group, activeEntry);
      const companion = pickCompanionEntry(activeEntry, visibleEntries);

      return {
        ...group,
        visibleEntries,
        displayEntries,
        activeEntry,
        previewEntry,
        companion,
      };
    })
    .filter(Boolean);

  visibleGroups.sort(compareGroups);
  return visibleGroups;
}

function entryMatchesFilters(entry) {
  if (state.type !== "all" && getEntryKind(entry) !== state.type) {
    return false;
  }

  if (!state.query) {
    return true;
  }

  const haystack = [
    entry.suggestedFileName,
    entry.pageTitle,
    entry.pageUrl,
    entry.url,
    entry.qualityLabel,
    entry.container,
    entry.streamRole,
    entry.platform,
    entry.mimeType,
    hostLabel(entry.url),
    variantLabel(entry),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(state.query);
}

function compareGroups(left, right) {
  if (state.sort === "host") {
    const hostCompare = hostLabel(left.activeEntry.url).localeCompare(hostLabel(right.activeEntry.url), "es", { sensitivity: "base" });
    if (hostCompare !== 0) {
      return hostCompare;
    }
  }

  if (state.sort === "size") {
    const leftSize = Math.max(...left.visibleEntries.map((entry) => entry.contentLength || 0));
    const rightSize = Math.max(...right.visibleEntries.map((entry) => entry.contentLength || 0));
    if (leftSize !== rightSize) {
      return rightSize - leftSize;
    }
  }

  const priorityDelta = entryPriorityScore(right.activeEntry) - entryPriorityScore(left.activeEntry);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return (right.activeEntry.addedAt || 0) - (left.activeEntry.addedAt || 0);
}

function compareEntries(left, right, sortMode) {
  if (sortMode === "recent") {
    const priorityDelta = entryPriorityScore(right) - entryPriorityScore(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
  }

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

function entryPriorityScore(entry) {
  let score = 0;

  switch (entry.streamRole) {
    case "muxed":
      score += 5000;
      break;
    case "video_only":
      score += 3500;
      break;
    case "audio_only":
      score += 2000;
      break;
    default:
      break;
  }

  if (entry.container === "MP4") {
    score += 600;
  } else if (entry.container === "WEBM") {
    score += 450;
  } else if (entry.container === "HLS") {
    score += 300;
  }

  if (typeof entry.qualityLabel === "string") {
    const videoMatch = entry.qualityLabel.match(/(\d{3,4})p/i);
    if (videoMatch) {
      score += Number.parseInt(videoMatch[1], 10) || 0;
    } else if (/alto/i.test(entry.qualityLabel)) {
      score += 300;
    } else if (/medio/i.test(entry.qualityLabel)) {
      score += 220;
    } else if (/bajo/i.test(entry.qualityLabel)) {
      score += 120;
    }
  }

  if (typeof entry.contentLength === "number" && entry.contentLength > 0) {
    score += Math.min(Math.round(entry.contentLength / (1024 * 100)), 900);
  }

  return score;
}

function selectDisplayEntries(entries) {
  const buckets = {
    muxed: [],
    video_only: [],
    audio_only: [],
    other: [],
  };

  [...entries]
    .sort((left, right) => compareEntries(left, right, "recent"))
    .forEach((entry) => {
      const key = entry.streamRole && Object.hasOwn(buckets, entry.streamRole)
        ? entry.streamRole
        : "other";
      buckets[key].push(entry);
    });

  const selected = [
    ...buckets.muxed.slice(0, 2),
    ...buckets.video_only.slice(0, buckets.muxed.length ? 3 : 4),
    ...buckets.audio_only.slice(0, 3),
    ...buckets.other.slice(0, 2),
  ];

  return selected.sort((left, right) => compareEntries(left, right, "recent"));
}

function resolveActiveEntry(group, displayEntries, visibleEntries) {
  const preferredVariantId = state.selectedVariantByGroup[group.key];
  const preferredEntry = displayEntries.find((entry) => entry.id === preferredVariantId);
  if (preferredEntry) {
    return preferredEntry;
  }

  const fallbackPool = displayEntries.length ? displayEntries : visibleEntries;
  return [...fallbackPool].sort((left, right) => compareEntries(left, right, state.sort))[0];
}

function pickPreviewEntry(group, activeEntry) {
  if (canAttemptMotionPreview(activeEntry)) {
    return activeEntry;
  }

  const previewCandidates = group.entries
    .filter((entry) => canAttemptMotionPreview(entry))
    .sort((left, right) => compareEntries(left, right, "recent"));

  return previewCandidates[0] || activeEntry;
}

function pickCompanionEntry(activeEntry, relatedEntries) {
  if (!Array.isArray(relatedEntries) || !relatedEntries.length) {
    return null;
  }

  if (activeEntry.streamRole === "video_only") {
    const audioEntry = relatedEntries
      .filter((entry) => entry.id !== activeEntry.id && entry.streamRole === "audio_only")
      .sort(compareCompanionCandidates)[0];
    return audioEntry ? { url: audioEntry.url, buttonLabel: "Abrir audio", openType: "audio" } : null;
  }

  if (activeEntry.streamRole === "audio_only") {
    const videoEntry = relatedEntries
      .filter((entry) => entry.id !== activeEntry.id && entry.streamRole !== "audio_only")
      .sort(compareCompanionCandidates)[0];
    return videoEntry ? { url: videoEntry.url, buttonLabel: "Abrir video", openType: "video" } : null;
  }

  return null;
}

function compareCompanionCandidates(left, right) {
  const leftWeight = companionWeight(left);
  const rightWeight = companionWeight(right);
  if (leftWeight !== rightWeight) {
    return rightWeight - leftWeight;
  }
  return (right.addedAt || 0) - (left.addedAt || 0);
}

function companionWeight(entry) {
  let weight = 0;

  if (entry.streamRole === "muxed") {
    weight += 100;
  }

  if (entry.container === "MP4") {
    weight += 20;
  }

  if (typeof entry.qualityLabel === "string" && /\d+p/i.test(entry.qualityLabel)) {
    weight += Number.parseInt(entry.qualityLabel, 10) || 0;
  }

  if (typeof entry.contentLength === "number") {
    weight += Math.min(Math.round(entry.contentLength / 1024), 5000);
  }

  return weight;
}

function renderMediaGroups(groups) {
  listEl.innerHTML = "";

  if (!groups.length) {
    const emptyMessage = state.allMedia.length
      ? "No hay coincidencias con los filtros actuales."
      : "No hay medios detectados. Reproduce el contenido y vuelve a actualizar.";
    renderEmptyState(emptyMessage);
    return;
  }

  groups.forEach((group) => {
    listEl.appendChild(buildMediaCard(group));
  });
}

function buildMediaCard(group) {
  const entry = group.activeEntry;
  const card = document.createElement("article");
  card.className = "media-card";
  card.dataset.groupKey = group.key;

  const thumb = buildThumb(group.previewEntry, entry, groupPlatformLabel(group));
  const body = document.createElement("div");
  body.className = "card-body";
  const top = document.createElement("div");
  top.className = "card-top";
  const titleStack = document.createElement("div");
  titleStack.className = "title-stack";

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = buildGroupTitle(group);
  title.title = title.textContent;

  const subtitle = document.createElement("p");
  subtitle.className = "group-subtitle";
  subtitle.textContent = buildGroupSubtitle(group);

  top.append(titleStack);
  titleStack.append(title, subtitle);

  const selectorRow = buildSelectorRow(group, entry);

  const contextLine = document.createElement("p");
  contextLine.className = "secondary-line";
  contextLine.textContent = [
    streamRoleLabel(entry),
    entry.contentLength ? humanSize(entry.contentLength) : null,
    group.duration || entry.duration ? humanDuration(group.duration || entry.duration) : null,
  ].filter(Boolean).join(" · ");
  contextLine.title = contextLine.textContent;

  const utilityRow = document.createElement("div");
  utilityRow.className = "utility-row";
  utilityRow.append(
    buildActionButton("Copiar url", "quick-copy", {
      copy: entry.url,
      copytype: "url",
    }),
    buildActionMenu(group),
  );

  const linkStack = document.createElement("div");
  linkStack.className = "link-stack";
  linkStack.append(
    buildInfoLine("url", truncateUrl(entry.url), entry.url),
  );

  if (shouldShowPageLink(group)) {
    linkStack.append(buildInfoLine("Página", truncateUrl(group.pageUrl), group.pageUrl));
  }

  body.append(top, selectorRow, contextLine, utilityRow, linkStack);
  card.append(thumb, body);
  return card;
}

function buildSelectorRow(group, entry) {
  const row = document.createElement("div");
  row.className = "selector-row";

  const menu = document.createElement("details");
  menu.className = "selector-menu";

  const summary = document.createElement("summary");
  summary.className = "selector-field";
  summary.title = variantLabel(entry);

  const label = document.createElement("span");
  label.className = "selector-label";
  label.textContent = "Formato";

  const value = document.createElement("span");
  value.className = "selector-value";
  value.textContent = variantLabel(entry);

  const caret = document.createElement("span");
  caret.className = "selector-caret";

  summary.append(label, value, caret);
  menu.append(summary, buildVariantSelectorPanel(group));
  row.append(menu);

  return row;
}

function buildVariantSelectorPanel(group) {
  const panel = document.createElement("div");
  panel.className = "selector-panel";

  buildVariantSections(group).forEach((section) => {
    const block = document.createElement("div");
    block.className = "selector-section";

    const label = document.createElement("p");
    label.className = "selector-section-label";
    label.textContent = section.hiddenCount
      ? `${section.label} · ${section.entries.length} de ${section.totalCount}`
      : section.label;

    const row = document.createElement("div");
    row.className = "selector-options";

    section.entries.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `selector-option${entry.id === group.activeEntry.id ? " is-active" : ""}`;
      button.dataset.groupKey = group.key;
      button.dataset.variantId = entry.id;
      button.textContent = variantLabel(entry);
      button.title = variantLabel(entry);
      row.appendChild(button);
    });

    block.append(label, row);
    panel.appendChild(block);
  });

  return panel;
}

function buildThumb(previewEntry, activeEntry, platformLabel) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";

  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = variantLabel(activeEntry).toUpperCase();

  const platformBadge = document.createElement("span");
  platformBadge.className = "platform-badge";
  platformBadge.textContent = platformLabel;

  const placeholder = document.createElement("div");
  placeholder.className = "thumb-placeholder";

  const poster = activeEntry.thumbnail || previewEntry.thumbnail;
  if (poster) {
    const image = document.createElement("img");
    image.className = "thumb-image";
    image.src = poster;
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

  if (canAttemptMotionPreview(previewEntry)) {
    const videoPreview = document.createElement("video");
    videoPreview.className = "thumb-video";
    videoPreview.src = previewEntry.url;
    videoPreview.crossOrigin = "anonymous";
    if (poster) {
      videoPreview.poster = poster;
    }
    videoPreview.autoplay = true;
    videoPreview.muted = true;
    videoPreview.defaultMuted = true;
    videoPreview.loop = true;
    videoPreview.playsInline = true;
    videoPreview.preload = "auto";
    videoPreview.controls = false;
    videoPreview.disablePictureInPicture = true;

    const activatePreview = () => {
      videoPreview.play()
        .then(() => {
          thumb.classList.add("thumb-ready");
          thumb.classList.add("thumb-live");
        })
        .catch(() => {
          // keep static poster fallback
        });
    };

    videoPreview.addEventListener("loadeddata", activatePreview, { once: true });
    videoPreview.addEventListener("canplay", activatePreview, { once: true });

    thumb.addEventListener("mouseenter", () => {
      activatePreview();
      thumb.classList.add("thumb-live");
      thumb.classList.add("thumb-focus");
    });

    thumb.addEventListener("mouseleave", () => {
      thumb.classList.remove("thumb-focus");
    });

    videoPreview.addEventListener("error", () => {
      videoPreview.pause();
      thumb.classList.remove("thumb-ready");
      thumb.classList.remove("thumb-live");
      thumb.classList.remove("thumb-focus");
      videoPreview.remove();
    });

    thumb.appendChild(videoPreview);
  }

  thumb.append(placeholder, badge, platformBadge);
  return thumb;
}

function buildGroupTitle(group) {
  const title = cleanPageTitle(group.pageTitle) || deriveTitle(group.pageUrl || group.activeEntry.url);
  return title || buildEntryTitle(group.activeEntry);
}

function buildGroupSubtitle(group) {
  const visibleCount = group.visibleEntries.length;
  const displayCount = group.displayEntries.length;
  if (displayCount < visibleCount) {
    return `${visibleCount} opciones, mostrando ${displayCount}`;
  }
  return `${visibleCount} opciones`;
}

function buildVariantSections(group) {
  const sections = [
    buildVariantSection(group, "video", "Video"),
    buildVariantSection(group, "audio", "Audio"),
    buildVariantSection(group, "other", "Otros"),
  ].filter((section) => section.entries.length);

  return sections;
}

function buildVariantSection(group, sectionKey, label) {
  const entries = group.displayEntries.filter((entry) => variantSectionKey(entry) === sectionKey);
  const totalCount = group.visibleEntries.filter((entry) => variantSectionKey(entry) === sectionKey).length;

  return {
    label,
    entries,
    totalCount,
    hiddenCount: Math.max(totalCount - entries.length, 0),
  };
}

function variantSectionKey(entry) {
  if (entry.streamRole === "audio_only") {
    return "audio";
  }
  if (entry.isPlaylist || entry.type === "playlist") {
    return "other";
  }
  return "video";
}

function buildEntryTitle(entry) {
  const titleBase = cleanPageTitle(entry.pageTitle) || entry.suggestedFileName || deriveTitle(entry.url);
  const detailParts = [entry.container || inferContainerFromEntry(entry), buildReadableQuality(entry), streamRoleShortLabel(entry)]
    .filter(Boolean);
  return detailParts.length ? `${titleBase} · ${detailParts.join(" · ")}` : titleBase;
}

function buildPageLine(pageUrl) {
  const line = document.createElement("p");
  line.className = "url";
  line.textContent = `Página: ${truncateUrl(pageUrl)}`;
  line.title = pageUrl;
  return line;
}

function buildChip(text, extraClass = "") {
  if (!text) {
    return null;
  }

  const chip = document.createElement("span");
  chip.className = `chip secondary ${extraClass}`.trim();
  chip.textContent = text;
  return chip;
}

function buildInfoLine(label, value, title) {
  const line = document.createElement("p");
  line.className = "info-line";
  line.title = title || value;

  const key = document.createElement("span");
  key.className = "info-key";
  key.textContent = `${label}:`;

  const content = document.createElement("span");
  content.className = "info-value";
  content.textContent = value;

  line.append(key, content);
  return line;
}

function buildActionMenu(group) {
  const entry = group.activeEntry;
  const menu = document.createElement("details");
  menu.className = "action-menu";

  const trigger = document.createElement("summary");
  trigger.className = "menu-trigger";
  trigger.setAttribute("aria-label", "Abrir acciones");
  trigger.textContent = "···";

  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.append(
    buildActionButton(primaryActionLabel(entry), "menu-item menu-item-primary", {
      download: "true",
      url: entry.url,
      filename: entry.suggestedFileName || "",
      mediatype: entry.type || "unknown",
    }),
    buildActionButton(shouldShowPageLink(group) ? "Copiar url" : "Copiar URL", "menu-item", {
      copy: entry.url,
      copytype: "url",
    }),
    buildActionButton(shouldShowPageLink(group) ? "Abrir url" : "Abrir URL", "menu-item", {
      open: entry.url,
      opentype: "url",
    }),
  );

  if (group.companion?.url) {
    panel.append(
      buildActionButton(group.companion.buttonLabel, "menu-item", {
        open: group.companion.url,
        opentype: group.companion.openType,
      }),
    );
  }

  if (shouldShowPageLink(group)) {
    panel.append(
      buildActionButton("Abrir página", "menu-item", {
        open: group.pageUrl,
        opentype: "page",
      }),
    );
  }

  menu.append(trigger, panel);
  return menu;
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
  const variantButton = event.target.closest("[data-variant-id]");
  const downloadButton = event.target.closest("[data-download]");
  const copyButton = event.target.closest("[data-copy]");
  const openButton = event.target.closest("[data-open]");

  if (variantButton) {
    closeVariantSelector(variantButton);
    state.selectedVariantByGroup[variantButton.dataset.groupKey] = variantButton.dataset.variantId;
    renderCurrentState();
    return;
  }

  if (downloadButton) {
    const { url, filename, mediatype } = downloadButton.dataset;
    closeActionMenu(downloadButton);
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
    closeActionMenu(copyButton);
    const copied = await copyToClipboard(copyButton.dataset.copy);
    const label = copyButton.dataset.copytype === "url" ? "Enlace url" : "URL";
    setStatus(copied ? `${label} copiado al portapapeles.` : `No se pudo copiar ${label.toLowerCase()}.`);
    return;
  }

  if (openButton) {
    closeActionMenu(openButton);
    chrome.tabs.create({ url: openButton.dataset.open });
    setStatus(openMessage(openButton.dataset.opentype));
  }
}

function closeActionMenu(element) {
  const menu = element.closest(".action-menu");
  if (menu) {
    menu.open = false;
  }
}

function closeVariantSelector(element) {
  const menu = element.closest(".selector-menu");
  if (menu) {
    menu.open = false;
  }
}

function openMessage(openType) {
  switch (openType) {
    case "page":
      return "Página abierta en una nueva pestaña.";
    case "audio":
      return "Enlace de audio abierto en una nueva pestaña.";
    case "video":
      return "Enlace de video abierto en una nueva pestaña.";
    default:
      return "Enlace url abierto en una nueva pestaña.";
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

function streamRoleLabel(entry) {
  switch (entry.streamRole) {
    case "muxed":
      return "Audio + video";
    case "video_only":
      return "Solo video";
    case "audio_only":
      return "Solo audio";
    default:
      return null;
  }
}

function streamRoleShortLabel(entry) {
  switch (entry.streamRole) {
    case "muxed":
      return "AV";
    case "video_only":
      return "Video";
    case "audio_only":
      return "Audio";
    default:
      return "";
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

function groupPlatformLabel(group) {
  const platform = (
    group.activeEntry.platform
    || group.entries.find((entry) => entry.platform)?.platform
    || inferPlatformFromUrl(group.pageUrl || group.activeEntry.pageUrl || group.activeEntry.url)
    || ""
  ).toLowerCase();

  switch (platform) {
    case "youtube":
      return "YouTube";
    case "twitch":
      return "Twitch";
    case "kick":
      return "Kick";
    case "instagram":
      return "Instagram";
    case "x":
    case "twitter":
      return "X";
    case "web":
    case "":
      return "Web";
    default:
      return platform.charAt(0).toUpperCase() + platform.slice(1);
  }
}

function inferPlatformFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (hostname.includes("youtube.com") || hostname === "youtu.be") {
      return "youtube";
    }
    if (hostname.includes("twitch.tv")) {
      return "twitch";
    }
    if (hostname.includes("kick.com")) {
      return "kick";
    }
    if (hostname.includes("instagram.com")) {
      return "instagram";
    }
    if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter.com")) {
      return "x";
    }
    return hostname || "web";
  } catch (error) {
    return "web";
  }
}

function cleanPageTitle(title) {
  return String(title || "").replace(/\s+-\s+YouTube$/i, "").trim();
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

function renderSummary(visibleGroups, allGroups) {
  const totalResources = allGroups.length;
  const totalVariants = allGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const visibleResources = visibleGroups.length;
  const visibleVariants = visibleGroups.reduce((sum, group) => sum + group.visibleEntries.length, 0);

  if (!totalResources) {
    summaryEl.hidden = true;
    summaryEl.textContent = "";
    return;
  }

  summaryEl.hidden = false;
  summaryEl.textContent = visibleResources === totalResources
    ? `${totalResources} recurso(s) y ${totalVariants} variante(s) detectadas en esta pestaña.`
    : `${visibleResources} de ${totalResources} recurso(s), ${visibleVariants} variante(s) visibles con los filtros actuales.`;
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
    state.selectedVariantByGroup = {};
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

function openSettingsPage() {
  chrome.runtime.openOptionsPage();
}

async function ensureAutoDetection(tabId) {
  const rescanWorked = await requestRescan(tabId);
  if (rescanWorked) {
    return true;
  }

  const injected = await injectContentScanner(tabId);
  if (!injected) {
    return false;
  }

  return requestRescan(tabId);
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

function injectContentScanner(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: ["src/content/contentScanner.js"],
      },
      () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      }
    );
  });
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    return "Host desconocido";
  }
}

function shouldShowPageLink(group) {
  if (!group?.pageUrl) {
    return false;
  }
  return group.pageUrl !== group.activeEntry?.url;
}

function inferContainerFromEntry(entry) {
  const mimeType = entry.mimeType || "";
  if (mimeType.includes("mp4")) {
    return "MP4";
  }
  if (mimeType.includes("webm")) {
    return "WEBM";
  }
  if (mimeType.includes("mpegurl") || /\.m3u8(?:[?#]|$)/i.test(entry.url || "")) {
    return "HLS";
  }
  if (mimeType.includes("dash") || /\.mpd(?:[?#]|$)/i.test(entry.url || "")) {
    return "DASH";
  }
  return "";
}

function buildReadableQuality(entry) {
  return entry.qualityLabel || inferQualityFromFileName(entry.suggestedFileName) || "Calidad auto";
}

function inferQualityFromFileName(fileName) {
  const value = String(fileName || "");
  const match = value.match(/(\d{3,4}p|Audio (?:ultrabajo|bajo|medio|alto))/i);
  return match?.[1] || "";
}

function variantLabel(entry) {
  const parts = [];
  const container = entry.container || inferContainerFromEntry(entry);
  const quality = buildReadableQuality(entry);
  const shortRole = streamRoleShortLabel(entry);

  if (container) {
    parts.push(container);
  }

  if (quality) {
    parts.push(quality);
  }

  if (shortRole && entry.streamRole !== "audio_only") {
    parts.push(shortRole);
  }

  if (!quality && entry.streamRole === "audio_only" && shortRole) {
    parts.push(shortRole);
  }

  return parts.join(" ").trim() || typeLabel(entry);
}

function variantKey(entry) {
  return [
    entry.streamRole || "",
    entry.container || inferContainerFromEntry(entry),
    buildReadableQuality(entry),
  ].join("::");
}

function primaryActionLabel(entry) {
  switch (entry.streamRole) {
    case "muxed":
      return "Descargar AV";
    case "video_only":
      return "Descargar video";
    case "audio_only":
      return "Descargar audio";
    default:
      return "Descargar";
  }
}

function getGroupKey(entry) {
  return entry.groupId || entry.pageUrl || `${entry.pageTitle || ""}::${hostLabel(entry.url)}`;
}

function deriveTitle(url) {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get("v");
    if (videoId) {
      return videoId;
    }

    const pathname = parsed.pathname.split("/").filter(Boolean).pop();
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
  if (!entry || getEntryKind(entry) !== "video") {
    return false;
  }

  const url = entry.url || "";
  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) {
    return false;
  }

  const hasVideoMime = typeof entry.mimeType === "string" && entry.mimeType.startsWith("video/");
  if (entry.mimeType && !hasVideoMime) {
    return false;
  }

  if (hasVideoMime) {
    return true;
  }

  return /\.(mp4|webm|ogv|ogg|m4v|mov)(?:[?#]|$)/i.test(url) || !entry.mimeType;
}

function canAttemptMotionPreview(entry) {
  if (!entry) {
    return false;
  }

  if (canPreviewVideo(entry)) {
    return true;
  }

  const url = entry.url || "";
  const container = entry.container || inferContainerFromEntry(entry);
  const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "";
  const isPlaylistLike = entry.isPlaylist || entry.type === "playlist" || container === "HLS" || container === "DASH";

  if (!isPlaylistLike) {
    return false;
  }

  if (entry.streamRole === "audio_only" || getEntryKind(entry) === "audio") {
    return false;
  }

  if (/\.mpd(?:[?#]|$)/i.test(url) || container === "DASH" || mimeType.includes("dash+xml")) {
    return false;
  }

  return /\.m3u8(?:[?#]|$)/i.test(url)
    || container === "HLS"
    || mimeType.includes("mpegurl");
}
