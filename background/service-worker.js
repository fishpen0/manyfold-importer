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
      return handleScrapeResult(message.modelData, tabId, message.error, message.needsReload);
    case "RESCAN_TAB":
      return handleRescanTab(tabId);
    default:
      console.warn("[Manyfold] Unknown message type:", message.type);
  }
});

// Track per-tab state: what was scraped, upload progress, etc.
const tabState = new Map();

async function handleGetPageState(tabId) {
  return tabState.get(tabId) ?? { status: "idle" };
}

async function handleScrapeResult(modelData, tabId, error, needsReload = false) {
  if (!modelData) {
    if (needsReload) {
      const state = { status: "needs_reload" };
      tabState.set(tabId, state);
      notifyPopup(tabId, state);
      await browser.action.setBadgeText({ text: "↺", tabId });
      await browser.action.setBadgeBackgroundColor({ color: "#f59e0b", tabId });
    } else {
      const state = { status: "error", error: error ?? "Scraper returned no data." };
      tabState.set(tabId, state);
      notifyPopup(tabId, state);
      await browser.action.setBadgeText({ text: "!", tabId });
      await browser.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    }
    return;
  }
  const state = { status: "ready", modelData };
  tabState.set(tabId, state);
  notifyPopup(tabId, state);
  await browser.action.setBadgeText({ text: "↑", tabId });
  await browser.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });
}

async function handleRescanTab(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/base-scraper.js", "content-scripts/makerworld.js"],
    });
  } catch (e) {
    setErrorState(tabId, `Could not scan page: ${e.message}`);
  }
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

  notifyPopup(tabId, { status: "uploading", progress: "Resolving download URLs…" });

  // Resolve download URLs for selected profiles (deferred from scrape time to avoid rate limiting)
  const resolvedFiles = [];
  for (const file of modelData.files) {
    if (file.downloadUrl) {
      resolvedFiles.push(file);
      continue;
    }
    const endpoint = file.fileExt === "3mf" ? "f3mf" : "stl";
    let urlRes;
    try {
      urlRes = await fetch(`https://makerworld.com/api/v1/design-service/instance/${file.instanceId}/${endpoint}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch (e) {
      return setErrorState(tabId, `Network error fetching download URL: ${e.message}`);
    }
    if (urlRes.status === 429) {
      return setErrorState(tabId, "MakerWorld rate-limited the request. Wait a moment and retry.");
    }
    if (urlRes.status === 418) {
      return setErrorState(tabId, "MakerWorld is showing a CAPTCHA. Go to the MakerWorld tab, complete it, then retry.");
    }
    if (!urlRes.ok) {
      return setErrorState(tabId, `Could not get download URL for "${file.name}" (HTTP ${urlRes.status}). Make sure you are logged in to MakerWorld.`);
    }
    const { name, url } = await urlRes.json();
    if (!url) {
      return setErrorState(tabId, `No download URL returned for "${file.name}". Make sure you are logged in to MakerWorld.`);
    }
    resolvedFiles.push({ ...file, name: name || file.name, downloadUrl: url });
  }

  notifyPopup(tabId, { status: "uploading", progress: "Downloading files…" });

  // Download all model files
  const downloadedFiles = [];
  for (const file of resolvedFiles) {
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
    profileSelection: "first",
  });
}

// Track pending SPA-navigation checks: tabId → timer id
const pendingSpaCheck = new Map();

// Clear badge when navigating away; re-inject on SPA navigation to model pages.
// SPA navigation fires changeInfo.url but NOT changeInfo.status: "loading" (no page reload).
// We schedule a re-injection after 500ms and cancel it if a real page load starts first.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    tabState.delete(tabId);
    browser.action.setBadgeText({ text: "", tabId });

    if (/https:\/\/makerworld\.com\/.*\/models\/\d+/.test(changeInfo.url)) {
      const existing = pendingSpaCheck.get(tabId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        pendingSpaCheck.delete(tabId);
        if (tabState.has(tabId)) return; // Manifest injection already ran
        try {
          await browser.scripting.executeScript({
            target: { tabId },
            files: ["content-scripts/base-scraper.js", "content-scripts/makerworld.js"],
          });
        } catch (e) {
          console.warn("[Manyfold] SPA re-injection failed:", e.message);
        }
      }, 500);
      pendingSpaCheck.set(tabId, timer);
    }
  }

  if (changeInfo.status === "loading") {
    // Real page load — content scripts will be injected by the manifest; cancel SPA check
    const timer = pendingSpaCheck.get(tabId);
    if (timer) {
      clearTimeout(timer);
      pendingSpaCheck.delete(tabId);
    }
  }
});
