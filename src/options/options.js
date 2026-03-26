import {
  blockedHostsToText,
  DEFAULT_SETTINGS,
  normalizeBlockedHosts,
  normalizeSettings,
  SETTINGS_KEY,
} from "../shared/settings.js";

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const resetButton = document.getElementById("reset");
const enableDomDetectionEl = document.getElementById("enable-dom-detection");
const enableNetworkDetectionEl = document.getElementById("enable-network-detection");
const minAudioKbEl = document.getElementById("min-audio-kb");
const maxEntriesPerTabEl = document.getElementById("max-entries-per-tab");
const preferSaveAsEl = document.getElementById("prefer-save-as");
const blockedHostsEl = document.getElementById("blocked-hosts");

init();

async function init() {
  bindEvents();
  const settings = await loadSettings();
  applyToForm(settings);
}

function bindEvents() {
  form.addEventListener("submit", onSubmit);
  resetButton.addEventListener("click", onReset);
}

async function onSubmit(event) {
  event.preventDefault();

  const settings = normalizeSettings({
    enableDomDetection: enableDomDetectionEl.checked,
    enableNetworkDetection: enableNetworkDetectionEl.checked,
    minAudioBytes: Number.parseInt(minAudioKbEl.value || "0", 10) * 1024,
    maxEntriesPerTab: Number.parseInt(maxEntriesPerTabEl.value || "0", 10),
    preferSaveAs: preferSaveAsEl.checked,
    blockedHosts: normalizeBlockedHosts(blockedHostsEl.value),
  });

  try {
    await storageSet({ [SETTINGS_KEY]: settings });
    applyToForm(settings);
    setStatus("Ajustes guardados.", "success");
  } catch (error) {
    console.error(error);
    setStatus("No se pudieron guardar los ajustes.", "error");
  }
}

function onReset() {
  applyToForm(DEFAULT_SETTINGS);
  setStatus("Valores restablecidos. Guarda si quieres aplicarlos.");
}

async function loadSettings() {
  try {
    const stored = await storageGet(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch (error) {
    console.error(error);
    setStatus("No se pudo cargar la configuracion. Se usan valores por defecto.", "error");
    return { ...DEFAULT_SETTINGS };
  }
}

function applyToForm(settings) {
  enableDomDetectionEl.checked = settings.enableDomDetection;
  enableNetworkDetectionEl.checked = settings.enableNetworkDetection;
  minAudioKbEl.value = String(Math.round(settings.minAudioBytes / 1024));
  maxEntriesPerTabEl.value = String(settings.maxEntriesPerTab);
  preferSaveAsEl.checked = settings.preferSaveAs;
  blockedHostsEl.value = blockedHostsToText(settings.blockedHosts);
}

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.className = "status";
  if (tone) {
    statusEl.classList.add(`is-${tone}`);
  }
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
