// background.js service worker: keeps the media catalog, enriches entries, applies settings and triggers downloads.

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  isBlockedHost,
  normalizeSettings,
} from "../shared/settings.js";

const mediaCatalog = new Map(); // tabId -> array of media entries
const mediaIndex = new Map(); // tabId -> Map(indexKey, entry)

const MEDIA_TYPES = new Set(["video", "audio", "playlist"]);
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".ogv"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".opus", ".weba"];
const PLAYLIST_EXTENSIONS = [".m3u8", ".mpd"];
const BADGE_COLOR = "#10b981";
const STORAGE_KEY = "mediaScout.catalog.v1";
const catalogStorageArea = chrome.storage?.session ?? chrome.storage?.local ?? null;
const settingsStorageArea = chrome.storage?.local ?? chrome.storage?.sync ?? null;
const UI_SOUND_PATTERNS = [
  "/s/search/audio/",
  "no_input.mp3",
  "failure.mp3",
  "success.mp3",
  "open.mp3",
  "click.mp3",
];

let currentSettings = { ...DEFAULT_SETTINGS };
let catalogReadyPromise = null;
let settingsReadyPromise = null;
let persistTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleRuntimeMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[SETTINGS_KEY]?.newValue) {
    currentSettings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    applySettingsToCatalogs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearMediaForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void clearMediaForTab(tabId);
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void handleHeadersReceived(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function handleRuntimeMessage(message, sender) {
  await Promise.all([ensureCatalogLoaded(), ensureSettingsLoaded()]);

  if (message?.type === "mediaFound" && sender.tab?.id !== undefined) {
    return {
      ok: true,
      ...registerMediaEntry(sender.tab.id, message, sender.tab),
    };
  }

  if (message?.type === "getMediaList") {
    const tabId = message.tabId ?? sender.tab?.id;
    return { ok: true, media: tabId !== undefined ? getMediaForTab(tabId) : [] };
  }

  if (message?.type === "downloadMedia" && message.url) {
    return handleDownloadRequest(message);
  }

  if (message?.type === "clearMediaForTab") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (tabId === undefined) {
      return { ok: false, error: "TabId no disponible" };
    }
    await clearMediaForTab(tabId);
    return { ok: true };
  }

  return { ok: false, error: "Mensaje no soportado" };
}

async function handleHeadersReceived(details) {
  await Promise.all([ensureCatalogLoaded(), ensureSettingsLoaded()]);

  const { tabId, url, responseHeaders } = details;
  if (!url || tabId === undefined || tabId < 0 || !responseHeaders) {
    return;
  }

  const normalizedUrl = normalizeMediaUrl(url);
  if (!normalizedUrl) {
    return;
  }

  const mimeType = extractMimeType(responseHeaders);
  let contentLength = null;

  for (const header of responseHeaders) {
    if (header.name && header.name.toLowerCase() === "content-length") {
      const parsedValue = parseInt(header.value || "", 10);
      if (!Number.isNaN(parsedValue)) {
        contentLength = parsedValue;
      }
      break;
    }
  }

  const classified = classifyMedia(normalizedUrl, mimeType);
  if (!classified || !shouldCatalog(details, classified, contentLength)) {
    return;
  }

  registerMediaEntry(tabId, {
    url: normalizedUrl,
    mediaType: classified.type,
    mimeType: classified.mimeType,
    source: "network",
    fileName: deriveFilename(normalizedUrl, classified.type),
    pageTitle: "",
    isPlaylist: classified.isPlaylist ?? false,
    contentLength,
  });
}

async function ensureCatalogLoaded() {
  if (!catalogStorageArea) {
    return;
  }

  if (!catalogReadyPromise) {
    catalogReadyPromise = hydrateCatalogFromStorage().catch((error) => {
      console.warn("No se pudo restaurar el catalogo persistido", error);
    });
  }

  await catalogReadyPromise;
}

async function ensureSettingsLoaded() {
  if (!settingsStorageArea) {
    return;
  }

  if (!settingsReadyPromise) {
    settingsReadyPromise = hydrateSettingsFromStorage().catch((error) => {
      console.warn("No se pudo restaurar la configuracion", error);
    });
  }

  await settingsReadyPromise;
}

async function hydrateCatalogFromStorage() {
  const stored = await catalogStorageGet(STORAGE_KEY);
  const snapshot = stored?.[STORAGE_KEY];
  if (!snapshot?.tabs || typeof snapshot.tabs !== "object") {
    return;
  }

  for (const [rawTabId, rawEntries] of Object.entries(snapshot.tabs)) {
    const tabId = Number.parseInt(rawTabId, 10);
    if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(rawEntries)) {
      continue;
    }

    const entries = rawEntries
      .map(sanitizeStoredEntry)
      .filter(Boolean)
      .slice(0, currentSettings.maxEntriesPerTab);

    if (!entries.length) {
      continue;
    }

    mediaCatalog.set(tabId, entries);
    mediaIndex.set(tabId, buildIndexMap(entries));
    updateBadge(tabId, entries.length);
  }
}

async function hydrateSettingsFromStorage() {
  const stored = await settingsStorageGet(SETTINGS_KEY);
  currentSettings = normalizeSettings(stored?.[SETTINGS_KEY]);
  applySettingsToCatalogs();
}

function sanitizeStoredEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const normalizedUrl = normalizeMediaUrl(entry.url);
  if (!normalizedUrl || isBlockedHost(normalizedUrl, currentSettings)) {
    return null;
  }

  const type = normalizeType(entry.type);
  return {
    id: typeof entry.id === "string" ? entry.id : createEntryId(0),
    url: normalizedUrl,
    type,
    isPlaylist: Boolean(entry.isPlaylist),
    source: normalizeSource(entry.source),
    suggestedFileName: sanitizeDownloadFilename(
      typeof entry.suggestedFileName === "string" ? entry.suggestedFileName : deriveFilename(normalizedUrl, type)
    ),
    mimeType: typeof entry.mimeType === "string" ? entry.mimeType : null,
    pageTitle: typeof entry.pageTitle === "string" ? entry.pageTitle : "",
    pageUrl: typeof entry.pageUrl === "string" ? entry.pageUrl : null,
    platform: typeof entry.platform === "string" ? entry.platform : null,
    groupId: typeof entry.groupId === "string" ? entry.groupId : null,
    container: typeof entry.container === "string" ? entry.container : null,
    qualityLabel: typeof entry.qualityLabel === "string" ? entry.qualityLabel : null,
    streamRole: typeof entry.streamRole === "string" ? entry.streamRole : null,
    itag: Number.isFinite(entry.itag) ? entry.itag : null,
    addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
    thumbnail: typeof entry.thumbnail === "string" ? entry.thumbnail : null,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    contentLength: Number.isFinite(entry.contentLength) ? entry.contentLength : null,
  };
}

function buildIndexMap(entries) {
  const index = new Map();
  for (const entry of entries) {
    index.set(getIndexKey(entry.url, entry.type), entry);
  }
  return index;
}

function registerMediaEntry(tabId, payload, tab) {
  const normalizedUrl = normalizeMediaUrl(payload.url);
  const source = normalizeSource(payload.source);

  if (!normalizedUrl || isBlockedBySettings(normalizedUrl, source)) {
    return { added: false, updated: false };
  }

  const catalog = ensureCatalog(tabId);
  const index = ensureIndex(tabId);
  const normalizedType = normalizeType(payload.mediaType);
  const key = getIndexKey(normalizedUrl, normalizedType);
  const pageTitle = tab?.title ?? payload.pageTitle ?? "";
  const pageUrl = tab?.url ?? payload.pageUrl ?? null;
  const platform = normalizePlatform(payload.platform, pageUrl ?? normalizedUrl);
  const existingEntry = index.get(key);

  if (existingEntry) {
    const updated = mergeMediaEntry(existingEntry, payload, pageTitle, pageUrl);
    if (updated) {
      schedulePersistCatalog();
    }
    return { added: false, updated };
  }

  const entry = {
    id: createEntryId(tabId),
    url: normalizedUrl,
    type: normalizedType,
    isPlaylist: payload.isPlaylist ?? false,
    source,
    suggestedFileName: sanitizeDownloadFilename(
      payload.fileName ?? buildSuggestedFileName(normalizedUrl, pageTitle, normalizedType)
    ),
    mimeType: payload.mimeType ?? null,
    pageTitle,
    pageUrl: normalizePageUrl(pageUrl),
    platform,
    groupId: typeof payload.groupId === "string" ? payload.groupId : null,
    container: typeof payload.container === "string" ? payload.container : null,
    qualityLabel: typeof payload.qualityLabel === "string" ? payload.qualityLabel : null,
    streamRole: typeof payload.streamRole === "string" ? payload.streamRole : null,
    itag: Number.isFinite(payload.itag) ? payload.itag : null,
    addedAt: Date.now(),
    thumbnail: payload.thumbnail ?? null,
    duration: payload.duration ?? null,
    contentLength: payload.contentLength ?? null,
  };

  catalog.unshift(entry);
  index.set(key, entry);
  trimCatalogForTab(catalog, index);
  updateBadge(tabId, catalog.length);
  schedulePersistCatalog();
  return { added: true, updated: false };
}

function mergeMediaEntry(entry, payload, pageTitle, pageUrl) {
  let changed = false;
  const nextType = normalizeType(payload.mediaType);
  const nextSource = mergeSources(entry.source, payload.source);
  const nextFileName = payload.fileName ? sanitizeDownloadFilename(payload.fileName) : null;
  const nextPageTitle = typeof pageTitle === "string" ? pageTitle.trim() : "";
  const nextPageUrl = normalizePageUrl(pageUrl ?? payload.pageUrl ?? null);
  const nextPlatform = normalizePlatform(payload.platform, nextPageUrl ?? entry.pageUrl ?? entry.url);

  if (entry.type === "unknown" && nextType !== "unknown") {
    entry.type = nextType;
    changed = true;
  }

  if (!entry.isPlaylist && payload.isPlaylist) {
    entry.isPlaylist = true;
    changed = true;
  }

  if (nextSource !== entry.source) {
    entry.source = nextSource;
    changed = true;
  }

  if (payload.mimeType && payload.mimeType !== entry.mimeType) {
    entry.mimeType = payload.mimeType;
    changed = true;
  }

  if (payload.thumbnail && payload.thumbnail !== entry.thumbnail) {
    entry.thumbnail = payload.thumbnail;
    changed = true;
  }

  if (Number.isFinite(payload.duration) && payload.duration > 0 && payload.duration !== entry.duration) {
    entry.duration = payload.duration;
    changed = true;
  }

  if (Number.isFinite(payload.contentLength) && payload.contentLength > 0 && payload.contentLength !== entry.contentLength) {
    entry.contentLength = payload.contentLength;
    changed = true;
  }

  if (nextPageTitle && nextPageTitle !== entry.pageTitle) {
    entry.pageTitle = nextPageTitle;
    changed = true;
  }

  if (nextPageUrl && nextPageUrl !== entry.pageUrl) {
    entry.pageUrl = nextPageUrl;
    changed = true;
  }

  if (nextPlatform && nextPlatform !== entry.platform) {
    entry.platform = nextPlatform;
    changed = true;
  }

  if (typeof payload.groupId === "string" && payload.groupId !== entry.groupId) {
    entry.groupId = payload.groupId;
    changed = true;
  }

  if (typeof payload.container === "string" && payload.container !== entry.container) {
    entry.container = payload.container;
    changed = true;
  }

  if (typeof payload.qualityLabel === "string" && payload.qualityLabel !== entry.qualityLabel) {
    entry.qualityLabel = payload.qualityLabel;
    changed = true;
  }

  if (typeof payload.streamRole === "string" && payload.streamRole !== entry.streamRole) {
    entry.streamRole = payload.streamRole;
    changed = true;
  }

  if (Number.isFinite(payload.itag) && payload.itag !== entry.itag) {
    entry.itag = payload.itag;
    changed = true;
  }

  if (nextFileName && nextFileName !== entry.suggestedFileName) {
    entry.suggestedFileName = nextFileName;
    changed = true;
  } else if (shouldRefreshSuggestedFileName(entry.suggestedFileName, entry.pageTitle)) {
    const rebuiltFileName = buildSuggestedFileName(entry.url, entry.pageTitle, entry.type);
    if (rebuiltFileName !== entry.suggestedFileName) {
      entry.suggestedFileName = rebuiltFileName;
      changed = true;
    }
  }

  return changed;
}

function normalizePlatform(platform, fallbackUrl) {
  if (typeof platform === "string" && platform.trim()) {
    return platform.trim().toLowerCase();
  }

  return inferPlatformFromUrl(fallbackUrl);
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

function shouldRefreshSuggestedFileName(fileName, pageTitle) {
  if (!fileName || !pageTitle) {
    return false;
  }

  const lowerName = fileName.toLowerCase();
  return (
    lowerName.startsWith("media-") ||
    lowerName.startsWith("video-") ||
    lowerName.startsWith("audio-") ||
    lowerName.startsWith("playlist-") ||
    lowerName.startsWith("unknown-")
  );
}

function trimCatalogForTab(catalog, index) {
  const maxEntries = currentSettings.maxEntriesPerTab;
  while (catalog.length > maxEntries) {
    const removedEntry = catalog.pop();
    if (removedEntry) {
      index.delete(getIndexKey(removedEntry.url, removedEntry.type));
    }
  }
}

function applySettingsToCatalogs() {
  for (const [tabId, catalog] of mediaCatalog.entries()) {
    const filteredCatalog = catalog.filter((entry) => !isBlockedHost(entry.url, currentSettings));
    const index = buildIndexMap(filteredCatalog);
    trimCatalogForTab(filteredCatalog, index);
    mediaCatalog.set(tabId, filteredCatalog);
    mediaIndex.set(tabId, index);
    updateBadge(tabId, filteredCatalog.length);
  }
  schedulePersistCatalog();
}

function getMediaForTab(tabId) {
  const entries = mediaCatalog.get(tabId) ?? [];
  return entries.map((entry) => ({ ...entry }));
}

async function handleDownloadRequest(message) {
  const normalizedUrl = normalizeMediaUrl(message.url);
  if (!normalizedUrl) {
    throw new Error("URL de descarga no valida.");
  }

  if (isBlockedHost(normalizedUrl, currentSettings)) {
    throw new Error("Ese host esta bloqueado por la configuracion actual.");
  }

  const filename = sanitizeDownloadFilename(
    message.fileName || buildSuggestedFileName(normalizedUrl, "", message.mediaType)
  );

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: normalizedUrl,
        filename,
        saveAs: currentSettings.preferSaveAs,
      },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(id);
      }
    );
  });

  return { ok: true, downloadId };
}

function ensureCatalog(tabId) {
  if (!mediaCatalog.has(tabId)) {
    mediaCatalog.set(tabId, []);
  }
  return mediaCatalog.get(tabId);
}

function ensureIndex(tabId) {
  if (!mediaIndex.has(tabId)) {
    mediaIndex.set(tabId, new Map());
  }
  return mediaIndex.get(tabId);
}

async function clearMediaForTab(tabId) {
  await ensureCatalogLoaded();
  mediaCatalog.delete(tabId);
  mediaIndex.delete(tabId);
  updateBadge(tabId, 0);
  schedulePersistCatalog();
}

function schedulePersistCatalog() {
  if (!catalogStorageArea) {
    return;
  }

  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistCatalogSnapshot().catch((error) => {
      console.warn("No se pudo persistir el catalogo", error);
    });
  }, 150);
}

async function persistCatalogSnapshot() {
  if (!catalogStorageArea) {
    return;
  }

  const tabs = {};
  for (const [tabId, entries] of mediaCatalog.entries()) {
    tabs[String(tabId)] = entries;
  }

  await catalogStorageSet({
    [STORAGE_KEY]: {
      savedAt: Date.now(),
      tabs,
    },
  });
}

function isBlockedBySettings(url, source) {
  if (isBlockedHost(url, currentSettings)) {
    return true;
  }
  if (source === "dom" && !currentSettings.enableDomDetection) {
    return true;
  }
  if (source === "network" && !currentSettings.enableNetworkDetection) {
    return true;
  }
  return false;
}

function createEntryId(tabId) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `tab-${tabId}-${Date.now()}-${randomPart}`;
}

function deriveFilename(url, mediaType) {
  try {
    const parsed = new URL(url);
    const rawName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
    if (rawName) {
      return rawName;
    }
  } catch (error) {
    // ignore parsing errors and fall back
  }

  const fallbackBase = mediaType && MEDIA_TYPES.has(mediaType) ? mediaType : "media";
  return `${fallbackBase}-${Date.now()}`;
}

function safeHostForName(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch (error) {
    return "";
  }
}

function buildSuggestedFileName(url, pageTitle, mediaType) {
  const raw = deriveFilename(url, mediaType);
  const dotIndex = raw.lastIndexOf(".");
  const ext = dotIndex !== -1 ? raw.slice(dotIndex) : defaultExtensionForType(mediaType);
  const baseFromUrl = dotIndex !== -1 ? raw.slice(0, dotIndex) : raw;

  let host = safeHostForName(url);
  let title = (pageTitle || "").trim();

  title = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

  if (!title) {
    title = baseFromUrl;
  }

  const parts = [];
  if (host) parts.push(host);
  if (title) parts.push(title);

  let base = parts.join(" - ");
  if (!base) {
    base = "media";
  }

  if (base.length > 120) {
    base = base.slice(0, 120).trim();
  }

  return sanitizeDownloadFilename(`${base}${ext}`);
}

function sanitizeDownloadFilename(fileName) {
  const cleaned = String(fileName || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");

  return cleaned || `media-${Date.now()}.bin`;
}

function defaultExtensionForType(type) {
  if (type === "audio") {
    return ".mp3";
  }
  if (type === "playlist") {
    return ".m3u8";
  }
  return ".mp4";
}

function normalizeType(type) {
  if (typeof type === "string" && MEDIA_TYPES.has(type)) {
    return type;
  }
  return "unknown";
}

function normalizeSource(source) {
  if (source === "network" || source === "dom" || source === "both") {
    return source;
  }
  return "dom";
}

function mergeSources(currentSource, incomingSource) {
  const normalizedCurrent = normalizeSource(currentSource);
  const normalizedIncoming = normalizeSource(incomingSource);

  if (normalizedCurrent === normalizedIncoming) {
    return normalizedCurrent;
  }
  return "both";
}

function normalizeMediaUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function normalizePageUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function extractMimeType(headers = []) {
  const header = headers.find((item) => item.name?.toLowerCase() === "content-type");
  if (!header?.value) {
    return null;
  }
  return header.value.split(";")[0].trim().toLowerCase();
}

function classifyMedia(url, mimeType) {
  const lowerUrl = url.toLowerCase();
  const extension = lowerUrl.split(/[?#]/)[0].split(".").pop();
  const dotExtension = extension ? `.${extension}` : "";

  if (isPlaylistMime(mimeType) || PLAYLIST_EXTENSIONS.includes(dotExtension)) {
    return {
      type: "playlist",
      isPlaylist: true,
      mimeType: mimeType || guessMimeFromExt(dotExtension) || "application/vnd.apple.mpegurl",
    };
  }

  if (isSegmentUrl(url, mimeType, dotExtension)) {
    return null;
  }

  if (isVideoMime(mimeType) || VIDEO_EXTENSIONS.includes(dotExtension)) {
    return {
      type: "video",
      mimeType: mimeType || guessMimeFromExt(dotExtension),
    };
  }

  if (isAudioMime(mimeType) || AUDIO_EXTENSIONS.includes(dotExtension)) {
    return {
      type: "audio",
      mimeType: mimeType || guessMimeFromExt(dotExtension),
    };
  }

  return null;
}

function getHeader(headers, name) {
  const header = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

function isUINotificationSound(url = "") {
  const lowerUrl = url.toLowerCase();
  return UI_SOUND_PATTERNS.some((pattern) => lowerUrl.includes(pattern));
}

function shouldCatalog(details, mediaInfo, contentLength) {
  if (!mediaInfo || !currentSettings.enableNetworkDetection || isBlockedHost(details.url || "", currentSettings)) {
    return false;
  }

  const url = details.url || "";
  const len = Number.isFinite(contentLength)
    ? contentLength
    : parseInt(getHeader(details.responseHeaders, "content-length") || "0", 10);

  if (mediaInfo.type === "audio") {
    if (len > 0 && len < currentSettings.minAudioBytes) {
      return false;
    }
    if (isUINotificationSound(url)) {
      return false;
    }
  }

  return true;
}

function isPlaylistMime(mimeType) {
  if (!mimeType) {
    return false;
  }
  return (
    mimeType.includes("application/vnd.apple.mpegurl") ||
    mimeType.includes("application/x-mpegurl") ||
    mimeType.includes("application/dash+xml")
  );
}

function isVideoMime(mimeType) {
  return Boolean(mimeType && mimeType.startsWith("video/"));
}

function isAudioMime(mimeType) {
  return Boolean(mimeType && mimeType.startsWith("audio/"));
}

function guessMimeFromExt(dotExtension) {
  if (VIDEO_EXTENSIONS.includes(dotExtension)) {
    return `video/${dotExtension.slice(1)}`;
  }
  if (AUDIO_EXTENSIONS.includes(dotExtension)) {
    return `audio/${dotExtension.slice(1)}`;
  }
  if (dotExtension === ".m3u8") {
    return "application/vnd.apple.mpegurl";
  }
  if (dotExtension === ".mpd") {
    return "application/dash+xml";
  }
  return undefined;
}

function isSegmentUrl(url, mimeType, dotExtension) {
  if (PLAYLIST_EXTENSIONS.includes(dotExtension)) {
    return false;
  }

  if (dotExtension === ".m4s" || dotExtension === ".ts") {
    return true;
  }

  if (mimeType && (mimeType.includes("mp2t") || mimeType.includes("iso.segment"))) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    const segmentRegex = /(seg|chunk|part|frag|range|segment)[-_]?\d{1,6}/;
    if (segmentRegex.test(path)) {
      return true;
    }
    if (/init[-_.]/.test(path)) {
      return true;
    }
    if (search.includes("byterange")) {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

function getIndexKey(url, mediaType) {
  return `${normalizeType(mediaType)}::${url}`;
}

function updateBadge(tabId, count) {
  if (typeof tabId !== "number" || tabId < 0) {
    return;
  }

  const text = count > 0 ? String(count) : "";

  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }, () => {});
  } catch (error) {
    // ignore
  }

  try {
    chrome.action.setBadgeText({ tabId, text }, () => {});
  } catch (error) {
    // ignore
  }
}

function catalogStorageGet(key) {
  return new Promise((resolve, reject) => {
    catalogStorageArea.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function catalogStorageSet(value) {
  return new Promise((resolve, reject) => {
    catalogStorageArea.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function settingsStorageGet(key) {
  return new Promise((resolve, reject) => {
    settingsStorageArea.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}
