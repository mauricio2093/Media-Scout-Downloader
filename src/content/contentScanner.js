// contentScanner.js: scans native media nodes, inspects supported player data and reports media sources.

(() => {
  const SCANNER_KEY = "__mediaScoutContentScanner";
  const existingScanner = globalThis[SCANNER_KEY];

  if (existingScanner?.initialized) {
    existingScanner.rescan?.({ resetSeenUrls: false });
    return;
  }

  const MEDIA_SELECTOR = "video, audio";
  const seenMediaUrls = new Set();
  const observedMediaElements = new WeakSet();
  let pendingYouTubeDirectScan = null;
  const scannerApi = {
    initialized: true,
    rescan,
  };

  globalThis[SCANNER_KEY] = scannerApi;

  rescan({ resetSeenUrls: false });
  observeDomChanges();
  observePageLifecycle();
  listenForCommands();

  function rescan({ resetSeenUrls = true } = {}) {
    if (resetSeenUrls) {
      seenMediaUrls.clear();
    }

    scanDocument();
    scanKnownPlayerData();
  }

  function scanDocument(root = document) {
    if (root instanceof Element && root.matches(MEDIA_SELECTOR)) {
      processMediaElement(root);
    }

    const mediaElements = root.querySelectorAll?.(MEDIA_SELECTOR) ?? document.querySelectorAll(MEDIA_SELECTOR);
    mediaElements.forEach(processMediaElement);
  }

  function observeDomChanges() {
    const observer = new MutationObserver((mutations) => {
      let shouldInspectPlayerData = false;

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }

          scanDocument(node);

          if (node.matches?.("source") && node.parentElement?.matches?.(MEDIA_SELECTOR)) {
            processMediaElement(node.parentElement);
          }

          if (node.matches?.("ytd-watch-flexy, ytd-player, script")) {
            shouldInspectPlayerData = true;
          }
        });

        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          const target = mutation.target;
          if (target.matches(`${MEDIA_SELECTOR}, source`)) {
            const hostMedia = target.matches("source") ? target.parentElement : target;
            if (hostMedia) {
              processMediaElement(hostMedia);
            }
          }

          if (target.matches("ytd-watch-flexy, ytd-player")) {
            shouldInspectPlayerData = true;
          }
        }
      }

      if (shouldInspectPlayerData) {
        scanKnownPlayerData();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "type", "poster"],
    });
  }

  function observePageLifecycle() {
    window.addEventListener("load", () => scanKnownPlayerData(), { once: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scanKnownPlayerData();
      }
    });

    document.addEventListener("yt-navigate-finish", () => {
      seenMediaUrls.clear();
      scanKnownPlayerData();
      scanDocument();
    });
  }

  function processMediaElement(element) {
    if (!(element instanceof HTMLMediaElement)) {
      return;
    }

    attachMediaListeners(element);

    const mediaType = element.tagName.toLowerCase() === "audio" ? "audio" : "video";
    const poster = getPoster(element);
    const duration = getDuration(element);
    const sources = collectSources(element);

    sources.forEach(({ url, mimeType }) => {
      notifyBackground({
        url,
        mediaType,
        mimeType,
        source: "dom",
        fileName: deriveFilename(url),
        pageTitle: document.title ?? "",
        pageUrl: window.location.href,
        platform: detectPlatform(),
        thumbnail: poster,
        duration,
      });
    });
  }

  function attachMediaListeners(element) {
    if (observedMediaElements.has(element)) {
      return;
    }

    observedMediaElements.add(element);
    const refresh = () => processMediaElement(element);

    element.addEventListener("loadedmetadata", refresh);
    element.addEventListener("loadeddata", refresh);
    element.addEventListener("play", refresh);
    element.addEventListener("canplay", refresh);
  }

  function collectSources(mediaElement) {
    const urls = [];

    const directSrc = mediaElement.currentSrc || mediaElement.getAttribute("src");
    if (directSrc) {
      const normalized = normalizeUrl(directSrc);
      if (normalized) {
        urls.push({ url: normalized, mimeType: mediaElement.getAttribute("type") || inferMimeFromUrl(normalized) });
      }
    }

    mediaElement.querySelectorAll("source").forEach((sourceEl) => {
      const sourceUrl = sourceEl.currentSrc || sourceEl.getAttribute("src");
      if (!sourceUrl) {
        return;
      }

      const normalized = normalizeUrl(sourceUrl);
      if (normalized) {
        urls.push({ url: normalized, mimeType: sourceEl.getAttribute("type") || inferMimeFromUrl(normalized) });
      }
    });

    return dedupeUrls(urls);
  }

  function dedupeUrls(urls) {
    const unique = [];
    const localSet = new Set();

    urls.forEach((item) => {
      if (!localSet.has(item.url)) {
        unique.push(item);
        localSet.add(item.url);
      }
    });

    return unique;
  }

  function scanKnownPlayerData() {
    const playerResponse = getPlayerResponse();
    const streamingData = playerResponse?.streamingData;
    if (!streamingData) {
      return;
    }

    const thumbnail = getPoster();
    const pageTitle = normalizeVideoTitle(playerResponse?.videoDetails?.title || document.title || "");
    const duration = parseDuration(playerResponse?.videoDetails?.lengthSeconds);
    const videoId = getVideoId(playerResponse);

    if (shouldPreferYouTubeDirectFormats(videoId)) {
      void resolveYouTubeDirectFormats({
        videoId,
        pageTitle,
        thumbnail,
        duration,
        fallbackResponse: playerResponse,
      });
      return;
    }

    reportPlayerFormats(streamingData, {
      pageTitle,
      thumbnail,
      duration,
      pageUrl: window.location.href,
    });
  }

  async function resolveYouTubeDirectFormats({ videoId, pageTitle, thumbnail, duration, fallbackResponse }) {
    if (pendingYouTubeDirectScan) {
      return pendingYouTubeDirectScan;
    }

    pendingYouTubeDirectScan = (async () => {
      try {
        const config = getYouTubeInnertubeConfig();
        if (!config?.apiKey || !videoId) {
          reportPlayerFormats(fallbackResponse?.streamingData, {
            pageTitle,
            thumbnail,
            duration,
            pageUrl: window.location.href,
          });
          return;
        }

        const directResponse = await fetchYouTubePlayerResponse({
          videoId,
          apiKey: config.apiKey,
          visitorData: config.visitorData,
          signatureTimestamp: config.signatureTimestamp,
        });

        const directStreamingData = directResponse?.streamingData;
        if (!directStreamingData) {
          reportPlayerFormats(fallbackResponse?.streamingData, {
            pageTitle,
            thumbnail,
            duration,
            pageUrl: window.location.href,
          });
          return;
        }

        reportPlayerFormats(directStreamingData, {
          pageTitle,
          thumbnail,
          duration,
          pageUrl: window.location.href,
        });
      } catch (error) {
        reportPlayerFormats(fallbackResponse?.streamingData, {
          pageTitle,
          thumbnail,
          duration,
          pageUrl: window.location.href,
        });
      } finally {
        pendingYouTubeDirectScan = null;
      }
    })();

    return pendingYouTubeDirectScan;
  }

  function reportPlayerFormats(streamingData, { pageTitle, thumbnail, duration, pageUrl }) {
    if (!streamingData) {
      return;
    }

    const formatEntries = [
      ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
      ...(Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : []),
    ];

    formatEntries.forEach((format) => {
      const mediaUrl = extractPlayerFormatUrl(format);
      const mimeType = normalizeMimeType(format?.mimeType);
      const mediaType = inferMediaTypeFromFormat(format, mimeType);

      if (!mediaUrl || !mimeType || !mediaType) {
        return;
      }

      notifyBackground({
        url: mediaUrl,
        mediaType,
        mimeType,
        source: "dom",
        fileName: buildPlayerFilename(pageTitle, mediaType, mimeType, format),
        pageTitle,
        pageUrl,
        platform: "youtube",
        groupId: videoIdFromPageUrl(pageUrl),
        container: inferContainerLabel(mimeType, mediaUrl),
        qualityLabel: normalizeFormatQualityLabel(format),
        streamRole: inferStreamRole(format, mimeType),
        itag: parseInteger(format?.itag),
        thumbnail,
        duration,
        contentLength: parseInteger(format?.contentLength),
      });
    });
  }

  function shouldPreferYouTubeDirectFormats(videoId) {
    if (!videoId) {
      return false;
    }

    if (!/youtube\.com$/i.test(window.location.hostname)) {
      return false;
    }

    if (!window.location.pathname.startsWith("/watch")) {
      return false;
    }

    return true;
  }

  function getVideoId(playerResponse) {
    if (typeof playerResponse?.videoDetails?.videoId === "string" && playerResponse.videoDetails.videoId) {
      return playerResponse.videoDetails.videoId;
    }

    try {
      return new URL(window.location.href).searchParams.get("v");
    } catch (error) {
      return null;
    }
  }

  function videoIdFromPageUrl(pageUrl) {
    try {
      const videoId = new URL(pageUrl).searchParams.get("v");
      return videoId ? `youtube:${videoId}` : null;
    } catch (error) {
      return null;
    }
  }

  function getYouTubeInnertubeConfig() {
    const scriptText = Array.from(document.scripts)
      .map((script) => script.textContent || "")
      .join("\n");

    return {
      apiKey: matchScriptValue(scriptText, /"INNERTUBE_API_KEY":"([^"]+)"/),
      visitorData: matchScriptValue(scriptText, /"VISITOR_DATA":"([^"]+)"/),
      signatureTimestamp: parseInteger(matchScriptValue(scriptText, /"STS":(\d+)/)),
    };
  }

  function matchScriptValue(scriptText, pattern) {
    const match = scriptText.match(pattern);
    return match?.[1] ?? null;
  }

  async function fetchYouTubePlayerResponse({ videoId, apiKey, visitorData, signatureTimestamp }) {
    const body = {
      context: {
        client: {
          clientName: "ANDROID_VR",
          clientVersion: "1.60.19",
          deviceMake: "Oculus",
          deviceModel: "Quest 3",
          userAgent: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12) gzip",
          hl: "en",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
          visitorData: visitorData || undefined,
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    if (signatureTimestamp) {
      body.playbackContext = {
        contentPlaybackContext: {
          signatureTimestamp,
        },
      };
    }

    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": "28",
        "x-youtube-client-version": "1.60.19",
        "user-agent": "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12) gzip",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`youtubei player respondió ${response.status}`);
    }

    return response.json();
  }

  function getPlayerResponse() {
    for (const script of Array.from(document.scripts)) {
      const content = script.textContent || "";
      if (!content.includes("ytInitialPlayerResponse")) {
        continue;
      }

      const parsed = extractAssignedJson(content, "ytInitialPlayerResponse");
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  function extractAssignedJson(scriptText, variableName) {
    const assignment = `${variableName} =`;
    const startIndex = scriptText.indexOf(assignment);
    if (startIndex === -1) {
      return null;
    }

    const objectStart = scriptText.indexOf("{", startIndex + assignment.length);
    if (objectStart === -1) {
      return null;
    }

    const jsonText = extractBalancedObject(scriptText, objectStart);
    if (!jsonText) {
      return null;
    }

    try {
      return JSON.parse(jsonText);
    } catch (error) {
      return null;
    }
  }

  function extractBalancedObject(sourceText, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < sourceText.length; index += 1) {
      const char = sourceText[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return sourceText.slice(startIndex, index + 1);
        }
      }
    }

    return null;
  }

  function extractPlayerFormatUrl(format) {
    if (!format || typeof format !== "object") {
      return null;
    }

    if (typeof format.url === "string") {
      return normalizeUrl(format.url);
    }

    const cipher = typeof format.signatureCipher === "string"
      ? format.signatureCipher
      : typeof format.cipher === "string"
        ? format.cipher
        : null;

    if (!cipher) {
      return null;
    }

    const params = new URLSearchParams(cipher);
    const rawUrl = params.get("url");
    if (!rawUrl) {
      return null;
    }

    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      return null;
    }

    const signature = params.get("sig") || params.get("signature");
    const signatureParam = params.get("sp") || "signature";
    if (!signature) {
      return normalized;
    }

    try {
      const resolved = new URL(normalized);
      resolved.searchParams.set(signatureParam, signature);
      return normalizeUrl(resolved.toString());
    } catch (error) {
      return normalized;
    }
  }

  function inferMediaTypeFromFormat(format, mimeType) {
    if (mimeType?.startsWith("audio/")) {
      return "audio";
    }
    if (mimeType?.startsWith("video/")) {
      return "video";
    }

    if (format?.audioQuality && !format?.qualityLabel) {
      return "audio";
    }

    if (format?.qualityLabel || format?.width || format?.height) {
      return "video";
    }

    return null;
  }

  function buildPlayerFilename(pageTitle, mediaType, mimeType, format) {
    const baseTitle = sanitizeFilenamePart(pageTitle) || `youtube-${mediaType}`;
    const detail = sanitizeFilenamePart(normalizeFormatQualityLabel(format));
    const ext = inferExtensionFromMime(mimeType, mediaType);
    return detail ? `${baseTitle} - ${detail}${ext}` : `${baseTitle}${ext}`;
  }

  function normalizeFormatQualityLabel(format) {
    const videoQuality = typeof format?.qualityLabel === "string" ? format.qualityLabel.trim() : "";
    if (videoQuality) {
      return videoQuality;
    }

    const audioQuality = typeof format?.audioQuality === "string" ? format.audioQuality.trim() : "";
    if (!audioQuality) {
      return "";
    }

    switch (audioQuality) {
      case "AUDIO_QUALITY_ULTRALOW":
        return "Audio ultrabajo";
      case "AUDIO_QUALITY_LOW":
        return "Audio bajo";
      case "AUDIO_QUALITY_MEDIUM":
        return "Audio medio";
      case "AUDIO_QUALITY_HIGH":
        return "Audio alto";
      default:
        return audioQuality.replace(/^AUDIO_QUALITY_/i, "Audio ").replace(/_/g, " ");
    }
  }

  function inferStreamRole(format, mimeType) {
    if (mimeType?.startsWith("audio/")) {
      return "audio_only";
    }

    if (mimeType?.startsWith("video/")) {
      return format?.audioQuality ? "muxed" : "video_only";
    }

    return "unknown";
  }

  function inferContainerLabel(mimeType, url) {
    if (mimeType === "application/vnd.apple.mpegurl" || /\.m3u8(?:[?#]|$)/i.test(url || "")) {
      return "HLS";
    }

    if (mimeType === "application/dash+xml" || /\.mpd(?:[?#]|$)/i.test(url || "")) {
      return "DASH";
    }

    if (mimeType?.includes("mp4")) {
      return "MP4";
    }

    if (mimeType?.includes("webm")) {
      return "WEBM";
    }

    if (mimeType?.includes("mpeg")) {
      return "MP3";
    }

    if (mimeType?.includes("ogg")) {
      return "OGG";
    }

    return "";
  }

  function normalizeUrl(url) {
    try {
      const absolute = new URL(url, window.location.href);
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
        return null;
      }
      absolute.hash = "";
      return absolute.toString();
    } catch (error) {
      return null;
    }
  }

  function deriveFilename(url) {
    try {
      const parsed = new URL(url);
      const rawName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
      if (rawName) {
        return rawName;
      }
    } catch (error) {
      // ignore parsing errors
    }
    return `media-${Date.now()}`;
  }

  function getPoster(element) {
    const posterAttr = element?.getAttribute?.("poster") || element?.poster;
    if (posterAttr && typeof posterAttr === "string") {
      try {
        const absolute = new URL(posterAttr, window.location.href);
        if (absolute.protocol === "http:" || absolute.protocol === "https:") {
          return absolute.toString();
        }
      } catch (error) {
        return null;
      }
    }

    const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
    if (og?.content) {
      try {
        const absolute = new URL(og.content, window.location.href);
        if (absolute.protocol === "http:" || absolute.protocol === "https:") {
          return absolute.toString();
        }
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  function getDuration(element) {
    const duration = element.duration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      return Math.round(duration);
    }
    return null;
  }

  function parseDuration(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return Math.round(parsed);
  }

  function parseInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeMimeType(value) {
    if (typeof value !== "string") {
      return null;
    }
    return value.split(";")[0].trim().toLowerCase() || null;
  }

  function inferMimeFromUrl(url) {
    try {
      const parsed = new URL(url);
      const mimeParam = parsed.searchParams.get("mime");
      if (mimeParam) {
        return normalizeMimeType(decodeURIComponent(mimeParam));
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  function inferExtensionFromMime(mimeType, mediaType) {
    if (mimeType === "video/mp4" || mimeType === "audio/mp4") {
      return ".mp4";
    }
    if (mimeType === "audio/webm" || mimeType === "video/webm") {
      return ".webm";
    }
    if (mimeType === "audio/mp3" || mimeType === "audio/mpeg") {
      return ".mp3";
    }
    return mediaType === "audio" ? ".mp3" : ".mp4";
  }

  function sanitizeFilenamePart(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeVideoTitle(value) {
    return String(value || "").replace(/\s+-\s+YouTube$/i, "").trim();
  }

  function detectPlatform() {
    const hostname = window.location.hostname.replace(/^www\./, "").toLowerCase();
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
  }

  function notifyBackground(payload) {
    if (!payload.url || seenMediaUrls.has(payload.url)) {
      return;
    }

    seenMediaUrls.add(payload.url);

    try {
      chrome.runtime.sendMessage({ type: "mediaFound", ...payload });
    } catch (error) {
      // If messaging fails (e.g., extension reloaded), drop silently.
    }
  }

  function listenForCommands() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "rescanMedia") {
        rescan();
        sendResponse?.({ ok: true });
        return true;
      }
      return false;
    });
  }
})();
