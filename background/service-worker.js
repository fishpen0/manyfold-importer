import { ManyfoldAPI } from "./manyfold-api.js";
import { downloadFile } from "./file-downloader.js";

// Message router — all cross-component communication goes through here
browser.runtime.onMessage.addListener((message, sender) => {
  // Content scripts carry their tabId via sender.tab; popup passes it explicitly
  const tabId = sender.tab?.id ?? message.tabId;

  switch (message.type) {
    case "GET_PAGE_STATE":
      return handleGetPageState(tabId);
    case "START_UPLOAD":
      return handleStartUpload(message.modelData, tabId);
    case "SCRAPE_RESULT":
      return handleScrapeResult(message.modelData, tabId, message.error);
    default:
      console.warn("[Manyfold] Unknown message type:", message.type);
  }
});

// Track per-tab state: what was scraped, upload progress, etc.
const tabState = new Map();

async function handleGetPageState(tabId) {
  return tabState.get(tabId) ?? { status: "idle" };
}

async function handleScrapeResult(modelData, tabId, error) {
  if (!modelData) {
    tabState.set(tabId, { status: "error", error: error ?? "Scraper returned no data." });
    await browser.action.setBadgeText({ text: "!", tabId });
    await browser.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    return;
  }
  tabState.set(tabId, { status: "ready", modelData });
  await browser.action.setBadgeText({ text: "↑", tabId });
  await browser.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });
}

async function handleStartUpload(modelData, tabId) {
  const settings = await getSettings();
  if (!settings.manyfoldUrl || !settings.oauthClientId || !settings.oauthClientSecret) {
    return { success: false, error: "Manyfold is not configured. Open extension options." };
  }

  tabState.set(tabId, { status: "uploading", progress: "Authenticating…", modelData });
  notifyPopup(tabId, { status: "uploading", progress: "Authenticating…" });

  const api = new ManyfoldAPI(settings.manyfoldUrl, settings.oauthClientId, settings.oauthClientSecret);

  try {
    await api.authenticate();
  } catch (e) {
    return setErrorState(tabId, `Authentication failed: ${e.message}`);
  }

  notifyPopup(tabId, { status: "uploading", progress: "Downloading files…" });

  // Download all model files
  const downloadedFiles = [];
  for (const file of modelData.files) {
    try {
      const blob = await downloadFile(file.downloadUrl, file.name);
      downloadedFiles.push({ ...file, blob });
    } catch (e) {
      console.warn(`[Manyfold] Failed to download ${file.name}:`, e.message);
    }
  }

  if (downloadedFiles.length === 0) {
    return setErrorState(tabId, "No files could be downloaded.");
  }

  notifyPopup(tabId, { status: "uploading", progress: "Creating model…" });

  // Check for duplicate (skipped when user explicitly chooses "Import Anyway")
  if (!modelData._skipDuplicateCheck) {
    try {
      const existing = await api.findModelBySourceUrl(modelData.sourceUrl);
      if (existing) {
        const state = {
          status: "duplicate",
          existingUrl: `${settings.manyfoldUrl}/models/${existing.id}`,
          modelData,
          downloadedFiles,
        };
        tabState.set(tabId, state);
        notifyPopup(tabId, state);
        return state;
      }
    } catch (e) {
      // Non-fatal — proceed with upload
      console.warn("[Manyfold] Duplicate check failed:", e.message);
    }
  }

  return performUpload(api, modelData, downloadedFiles, settings, tabId);
}

async function performUpload(api, modelData, downloadedFiles, settings, tabId) {
  let createdModel;
  try {
    createdModel = await api.createModel({
      title: modelData.title,
      description: modelData.description,
      sourceUrl: modelData.sourceUrl,
      license: modelData.license,
      tags: modelData.tags,
      collectionId: settings.defaultCollectionId || null,
      creatorName: modelData.creator?.name,
    });
  } catch (e) {
    return setErrorState(tabId, `Failed to create model: ${e.message}`);
  }

  notifyPopup(tabId, { status: "uploading", progress: `Uploading ${downloadedFiles.length} file(s)…` });

  for (const file of downloadedFiles) {
    try {
      await api.uploadFile(createdModel.id, file.blob, file.name);
    } catch (e) {
      console.warn(`[Manyfold] Failed to upload ${file.name}:`, e.message);
    }
  }

  // Upload cover image if present
  if (modelData.coverImageUrl) {
    try {
      const imgBlob = await downloadFile(modelData.coverImageUrl, "cover.jpg");
      await api.uploadFile(createdModel.id, imgBlob, "cover.jpg", "image");
    } catch (e) {
      console.warn("[Manyfold] Cover image upload failed:", e.message);
    }
  }

  const modelUrl = `${(await getSettings()).manyfoldUrl}/models/${createdModel.id}`;
  const state = { status: "done", modelUrl };
  tabState.set(tabId, state);
  notifyPopup(tabId, state);

  await browser.action.setBadgeText({ text: "✓", tabId });
  await browser.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });

  return { success: true, modelUrl };
}

function setErrorState(tabId, error) {
  const state = { status: "error", error };
  tabState.set(tabId, state);
  notifyPopup(tabId, state);
  browser.action.setBadgeText({ text: "!", tabId });
  browser.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
  return { success: false, error };
}

function notifyPopup(tabId, state) {
  browser.runtime.sendMessage({ type: "STATE_UPDATE", tabId, state }).catch(() => {
    // Popup may not be open — ignore
  });
}

async function getSettings() {
  return browser.storage.sync.get({
    manyfoldUrl: "",
    oauthClientId: "",
    oauthClientSecret: "",
    defaultCollectionId: "",
  });
}

// Clear badge when navigating away
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabState.delete(tabId);
    browser.action.setBadgeText({ text: "", tabId });
  }
});
