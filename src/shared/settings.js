export const SETTINGS_KEY = "mediaScout.settings.v1";

export const DEFAULT_SETTINGS = {
  enableDomDetection: true,
  enableNetworkDetection: true,
  minAudioBytes: 50 * 1024,
  maxEntriesPerTab: 250,
  preferSaveAs: true,
  blockedHosts: [],
};

export function normalizeSettings(rawSettings = {}) {
  const source = rawSettings && typeof rawSettings === "object" ? rawSettings : {};

  return {
    enableDomDetection: source.enableDomDetection !== false,
    enableNetworkDetection: source.enableNetworkDetection !== false,
    minAudioBytes: normalizeInteger(source.minAudioBytes, DEFAULT_SETTINGS.minAudioBytes, 0, 25 * 1024 * 1024),
    maxEntriesPerTab: normalizeInteger(source.maxEntriesPerTab, DEFAULT_SETTINGS.maxEntriesPerTab, 25, 1000),
    preferSaveAs: source.preferSaveAs !== false,
    blockedHosts: normalizeBlockedHosts(source.blockedHosts),
  };
}

export function normalizeBlockedHosts(value) {
  const rawHosts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : [];

  return [...new Set(
    rawHosts
      .map((host) => String(host || "").trim().toLowerCase())
      .map((host) => host.replace(/^https?:\/\//, ""))
      .map((host) => host.replace(/\/.*$/, ""))
      .map((host) => host.replace(/^www\./, ""))
      .filter(Boolean)
  )];
}

export function blockedHostsToText(blockedHosts = []) {
  return normalizeBlockedHosts(blockedHosts).join("\n");
}

export function isBlockedHost(url, settings = DEFAULT_SETTINGS) {
  const blockedHosts = normalizeBlockedHosts(settings.blockedHosts);
  if (!blockedHosts.length) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return blockedHosts.some((blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`));
  } catch (error) {
    return false;
  }
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}
