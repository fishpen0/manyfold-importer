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

// In-memory cache for the current service worker lifetime.
// Backed by storage.session so state survives worker restarts (Firefox 115+, Chrome 102+).
const tabState = new Map();

async function getTabState(tabId) {
  if (tabState.has(tabId)) return tabState.get(tabId);
  const key = `tabState_${tabId}`;
  const result = await browser.storage.session.get(key);
  if (result[key]) {
    tabState.set(tabId, result[key]);
    return result[key];
  }
  return null;
}

async function setTabState(tabId, state) {
  tabState.set(tabId, state);
  await browser.storage.session.set({ [`tabState_${tabId}`]: stripBlobs(state) });
}

async function clearTabState(tabId) {
  tabState.delete(tabId);
  await browser.storage.session.remove(`tabState_${tabId}`);
}

function stripBlobs(state) {
  if (!state.downloadedFiles) return state;
  return {
    ...state,
    downloadedFiles: state.downloadedFiles.map(({ blob, ...rest }) => rest),
  };
}

async function handleGetPageState(tabId) {
  return (await getTabState(tabId)) ?? { status: "idle" };
}

async function handleScrapeResult(modelData, tabId, error, needsReload = false) {
  if (!modelData) {
    if (needsReload) {
      const state = { status: "needs_reload" };
      await setTabState(tabId, state);
      notifyPopup(tabId, state);
      await browser.action.setBadgeText({ text: "↺", tabId });
      await browser.action.setBadgeBackgroundColor({ color: "#f59e0b", tabId });
    } else {
      const state = { status: "error", error: error ?? "Scraper returned no data." };
      await setTabState(tabId, state);
      notifyPopup(tabId, state);
      await browser.action.setBadgeText({ text: "!", tabId });
      await browser.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    }
    return;
  }
  const state = { status: "ready", modelData };
  await setTabState(tabId, state);
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

// Resolves a single file's presigned download URL from MakerWorld.
// Attaches `hard: true` to errors that should abort the entire upload (rate-limit, CAPTCHA).
async function resolveDownloadUrl(file) {
  if (file.downloadUrl) return { ...file };
  const endpoint = file.fileExt === "3mf" ? "f3mf" : "stl";
  let res;
  try {
    res = await fetch(
      `https://makerworld.com/api/v1/design-service/instance/${file.instanceId}/${endpoint}`,
      { credentials: "include", headers: { Accept: "application/json" } }
    );
  } catch (e) {
    throw Object.assign(new Error(`Network error fetching download URL: ${e.message}`), { hard: false });
  }
  if (res.status === 429) {
    throw Object.assign(
      new Error("MakerWorld rate-limited the request. Wait a moment and retry."),
      { hard: true }
    );
  }
  if (res.status === 418) {
    throw Object.assign(
      new Error("MakerWorld is showing a CAPTCHA. Go to the MakerWorld tab, complete it, then retry."),
      { hard: true }
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Could not get download URL for "${file.name}" (HTTP ${res.status}). Make sure you are logged in to MakerWorld.`),
      { hard: false }
    );
  }
  const { name, url } = await res.json();
  if (!url) {
    throw Object.assign(
      new Error(`No download URL returned for "${file.name}". Make sure you are logged in to MakerWorld.`),
      { hard: false }
    );
  }
  return { ...file, name: name || file.name, downloadUrl: url };
}

async function handleStartUpload(modelData, tabId) {
  const settings = await getSettings();
  if (!settings.manyfoldUrl || !settings.oauthClientId || !settings.oauthClientSecret) {
    return { success: false, error: "Manyfold is not configured. Open extension options." };
  }

  await setTabState(tabId, { status: "uploading", progress: "Authenticating…", modelData });
  notifyPopup(tabId, { status: "uploading", progress: "Authenticating…" });

  const api = new ManyfoldAPI(settings.manyfoldUrl, settings.oauthClientId, settings.oauthClientSecret);

  try {
    await api.authenticate();
  } catch (e) {
    return setErrorState(tabId, `Authentication failed: ${e.message}`);
  }

  // Collection mode when the setting is "collection" AND (>1 file OR single-profile-collection = "collection")
  const useCollection =
    settings.multiModelMode === "collection" &&
    (modelData.files.length > 1 || settings.singleProfileCollection === "collection");

  if (useCollection) {
    return performCollectionUpload(api, modelData, settings, tabId);
  }

  // --- Single-model mode ---
  notifyPopup(tabId, { status: "uploading", progress: "Resolving download URLs…" });

  const resolvedFiles = [];
  for (const file of modelData.files) {
    try {
      resolvedFiles.push(await resolveDownloadUrl(file));
    } catch (e) {
      return setErrorState(tabId, e.message);
    }
  }

  notifyPopup(tabId, { status: "uploading", progress: "Downloading files…" });

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

  // Best-effort duplicate check by title (skipped when user explicitly chooses "Import Anyway")
  if (!modelData._skipDuplicateCheck) {
    try {
      const existing = await api.findModelByTitle(modelData.title);
      if (existing) {
        const state = {
          status: "duplicate",
          existingUrl: manyfoldUrl(existing["@id"], settings.manyfoldUrl),
          modelData,
          downloadedFiles,
        };
        await setTabState(tabId, state);
        notifyPopup(tabId, state);
        return state;
      }
    } catch (e) {
      console.warn("[Manyfold] Duplicate check failed:", e.message);
    }
  }

  return performUpload(api, modelData, downloadedFiles, settings, tabId);
}

async function performCollectionUpload(api, modelData, settings, tabId) {
  notifyPopup(tabId, { status: "uploading", progress: "Creating collection…" });

  let collectionId;
  try {
    const existing = await api.findCollectionByName(modelData.title);
    if (existing) {
      collectionId = existing["@id"];
    } else {
      collectionId = await api.createCollection({
        name: modelData.title,
        caption: modelData.creator?.name ? `by ${modelData.creator.name}` : null,
        description: [
          modelData.description,
          modelData.sourceUrl ? `Source: ${modelData.sourceUrl}` : null,
        ].filter(Boolean).join("\n\n"),
        parentId: settings.defaultCollectionId || null,
      });
    }
  } catch (e) {
    return setErrorState(tabId, `Could not create collection: ${e.message}`);
  }

  const files = modelData.files;
  let imported = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    notifyPopup(tabId, {
      status: "uploading",
      progress: `Uploading profile ${i + 1} of ${files.length}…`,
    });

    try {
      let resolvedFile;
      try {
        resolvedFile = await resolveDownloadUrl(file);
      } catch (e) {
        if (e.hard) return setErrorState(tabId, e.message);
        throw e;
      }

      const modelBlob = await downloadFile(resolvedFile.downloadUrl, resolvedFile.name);
      const allFiles = [{ ...resolvedFile, blob: modelBlob }];

      const coverUrl = file.instanceCoverUrl;
      if (coverUrl) {
        try {
          const imgBlob = await downloadFile(coverUrl, "cover.jpg");
          allFiles.push({ name: "cover.jpg", blob: imgBlob });
        } catch (e) {
          console.warn("[Manyfold] Cover download failed:", e.message);
        }
      }

      const modelName = file.name; // profile title (inst.title), not the 3MF filename

      const descParts = [file.instanceDescription];
      if (file.contributor?.name) descParts.push(`Profile by ${file.contributor.name}`);

      await api.importModel(
        {
          title: modelName,
          description: descParts.filter(Boolean).join("\n\n"),
          sourceUrl: modelData.sourceUrl,
          license: modelData.license,
          tags: modelData.tags,
          collectionId,
        },
        allFiles
      );

      imported++;
    } catch (e) {
      console.warn(`[Manyfold] Failed to import profile "${file.name}":`, e.message);
      failed++;
    }

    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (imported === 0) {
    return setErrorState(tabId, "No profiles could be imported into the collection.");
  }

  const collectionUrl = manyfoldUrl(collectionId, settings.manyfoldUrl);
  const state =
    failed > 0
      ? { status: "partial", imported, total: files.length, failed, collectionUrl }
      : { status: "done", modelUrl: collectionUrl };

  await setTabState(tabId, state);
  notifyPopup(tabId, state);

  await browser.action.setBadgeText({ text: failed > 0 ? "~" : "✓", tabId });
  await browser.action.setBadgeBackgroundColor({
    color: failed > 0 ? "#f59e0b" : "#22c55e",
    tabId,
  });

  return { success: true, ...state };
}

async function performUpload(api, modelData, downloadedFiles, settings, tabId) {
  // Collect all files including cover image before TUS-uploading
  const allFiles = [...downloadedFiles];
  if (modelData.coverImageUrl) {
    try {
      const imgBlob = await downloadFile(modelData.coverImageUrl, "cover.jpg");
      allFiles.push({ name: "cover.jpg", blob: imgBlob });
    } catch (e) {
      console.warn("[Manyfold] Cover image download failed:", e.message);
    }
  }

  notifyPopup(tabId, { status: "uploading", progress: `Uploading ${allFiles.length} file(s)…` });

  try {
    await api.importModel(
      {
        title: modelData.title,
        description: modelData.description,
        sourceUrl: modelData.sourceUrl,
        license: modelData.license,
        tags: modelData.tags,
        collectionId: settings.defaultCollectionId || null,
      },
      allFiles
    );
  } catch (e) {
    return setErrorState(tabId, `Import failed: ${e.message}`);
  }

  // POST /models returns 202 Accepted with no body — link to models list
  const modelUrl = `${settings.manyfoldUrl}/models`;
  const state = { status: "done", modelUrl };
  await setTabState(tabId, state);
  notifyPopup(tabId, state);

  await browser.action.setBadgeText({ text: "✓", tabId });
  await browser.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });

  return { success: true, modelUrl };
}

async function setErrorState(tabId, error) {
  const state = { status: "error", error };
  await setTabState(tabId, state);
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
    multiModelMode: "single",
    singleProfileCollection: "model",
  });
}

// Rebase a Manyfold @id onto the user's configured URL.
// The server's JSON-LD @id reflects its internal URL (e.g. localhost:3214),
// which differs from the external URL the user accesses. Strip the origin and
// reattach the user-configured base.
function manyfoldUrl(id, baseUrl) {
  try {
    return `${baseUrl}${new URL(id).pathname}`;
  } catch {
    return `${baseUrl}${id}`;
  }
}

// Track pending SPA-navigation checks: tabId → timer id
const pendingSpaCheck = new Map();

// Clear badge when navigating away; re-inject on SPA navigation to model pages.
// SPA navigation fires changeInfo.url but NOT changeInfo.status: "loading" (no page reload).
// We schedule a re-injection after 500ms and cancel it if a real page load starts first.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await clearTabState(tabId);
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
