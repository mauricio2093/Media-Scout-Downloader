// contentScanner.js: scans <video>/<audio> nodes, watches dynamic changes and reports media sources.

const MEDIA_SELECTOR = "video, audio";
const seenMediaUrls = new Set();
const observedMediaElements = new WeakSet();

scanDocument();
observeDomChanges();
listenForCommands();

function scanDocument(root = document) {
  if (root instanceof Element && root.matches(MEDIA_SELECTOR)) {
    processMediaElement(root);
  }

  const mediaElements = root.querySelectorAll?.(MEDIA_SELECTOR) ?? document.querySelectorAll(MEDIA_SELECTOR);
  mediaElements.forEach(processMediaElement);
}

function observeDomChanges() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }
        scanDocument(node);
        if (node.matches?.("source") && node.parentElement?.matches?.(MEDIA_SELECTOR)) {
          processMediaElement(node.parentElement);
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
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "type", "poster"],
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
      urls.push({ url: normalized, mimeType: mediaElement.getAttribute("type") || null });
    }
  }

  mediaElement.querySelectorAll("source").forEach((sourceEl) => {
    const sourceUrl = sourceEl.currentSrc || sourceEl.getAttribute("src");
    if (!sourceUrl) {
      return;
    }
    const normalized = normalizeUrl(sourceUrl);
    if (normalized) {
      urls.push({ url: normalized, mimeType: sourceEl.getAttribute("type") || null });
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
  const posterAttr = element.getAttribute?.("poster") || element.poster;
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

function listenForCommands() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "rescanMedia") {
      seenMediaUrls.clear();
      scanDocument();
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });
}
