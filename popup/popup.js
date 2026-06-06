const $ = (id) => document.getElementById(id);

let currentModelData = null;
let currentDownloadedFiles = null;

// Show only the specified view
function showView(name) {
  for (const el of document.querySelectorAll(".view")) {
    el.classList.remove("active");
    el.classList.add("hidden");
  }
  const target = $(`view-${name}`);
  if (target) {
    target.classList.remove("hidden");
    target.classList.add("active");
  }
}

// Render the model preview
function renderReady(modelData) {
  currentModelData = modelData;

  // Cover image
  const img = $("coverImage");
  if (modelData.coverImageUrl) {
    img.src = modelData.coverImageUrl;
    img.classList.remove("hidden");
    img.onerror = () => img.classList.add("hidden");
  } else {
    img.classList.add("hidden");
  }

  $("modelTitle").textContent = modelData.title || "Untitled";
  $("modelCreator").textContent = modelData.creator?.name
    ? `by ${modelData.creator.name}`
    : "Unknown creator";
  $("modelLicense").textContent = modelData.license || "Not specified";

  // Tags
  const tagsEl = $("modelTags");
  tagsEl.innerHTML = "";
  const tags = modelData.tags ?? [];
  if (tags.length === 0) {
    tagsEl.textContent = "None";
    tagsEl.style.color = "var(--muted)";
  } else {
    for (const tag of tags.slice(0, 12)) {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
    if (tags.length > 12) {
      const more = document.createElement("span");
      more.className = "tag";
      more.textContent = `+${tags.length - 12} more`;
      tagsEl.appendChild(more);
    }
  }

  // Files
  const fileListEl = $("fileList");
  fileListEl.innerHTML = "";
  const files = modelData.files ?? [];
  if (files.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No files detected";
    li.style.color = "var(--error)";
    fileListEl.appendChild(li);
  } else {
    for (const file of files) {
      const li = document.createElement("li");
      const ext = (file.name ?? "").split(".").pop().toLowerCase();
      const badge = document.createElement("span");
      badge.className = `file-badge badge-${ext === "3mf" ? "3mf" : ext === "stl" ? "stl" : "img"}`;
      badge.textContent = ext;
      li.appendChild(badge);

      const name = document.createElement("span");
      name.textContent = file.name;
      li.appendChild(name);

      if (!file.downloadUrl) {
        const warn = document.createElement("span");
        warn.className = "file-nourl";
        warn.textContent = "(URL unavailable)";
        li.appendChild(warn);
      }

      fileListEl.appendChild(li);
    }
  }

  // Warn if no files resolved
  if ((modelData.files ?? []).filter(f => f.downloadUrl).length === 0) {
    $("noFilesWarning").classList.remove("hidden");
  } else {
    $("noFilesWarning").classList.add("hidden");
  }

  showView("ready");
}

// Entry point
async function init() {
  showView("loading");

  // Wire up static buttons
  const openOptions = (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); };
  $("openSettings").addEventListener("click", openOptions);
  $("openOptions").addEventListener("click", openOptions);
  $("openOptionsError").addEventListener("click", openOptions);
  $("uploadBtn").addEventListener("click", startUpload);
  $("uploadAnywayBtn").addEventListener("click", forceUpload);
  $("retryBtn").addEventListener("click", startUpload);

  // Get the active tab's state from the background worker
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showView("idle");
    return;
  }

  // Listen for state updates from the background (while popup is open)
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "STATE_UPDATE" && message.tabId === tab.id) {
      applyState(message.state);
    }
  });

  const state = await browser.runtime.sendMessage({ type: "GET_PAGE_STATE", tabId: tab.id });
  applyState(state);
}

function applyState(state) {
  if (!state || state.status === "idle") {
    showView("idle");
    return;
  }

  switch (state.status) {
    case "ready":
      renderReady(state.modelData);
      break;

    case "uploading":
      $("progressText").textContent = state.progress ?? "Working…";
      showView("uploading");
      break;

    case "duplicate":
      currentModelData = state.modelData;
      currentDownloadedFiles = state.downloadedFiles;
      $("existingModelLink").href = state.existingUrl;
      showView("duplicate");
      break;

    case "done":
      $("newModelLink").href = state.modelUrl;
      showView("done");
      break;

    case "error":
      $("errorMessage").textContent = state.error ?? "Unknown error.";
      showView("error");
      break;

    default:
      showView("idle");
  }
}

async function startUpload() {
  if (!currentModelData) return;
  showView("uploading");
  $("progressText").textContent = "Starting…";

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = await browser.runtime.sendMessage({
    type: "START_UPLOAD",
    modelData: currentModelData,
    tabId: tab?.id,
  });

  // State updates come via the message listener; this handles the case
  // where the popup re-opens after a completed upload
  if (result?.success) {
    $("newModelLink").href = result.modelUrl;
    showView("done");
  } else if (result && !result.success) {
    $("errorMessage").textContent = result.error ?? "Upload failed.";
    showView("error");
  }
}

async function forceUpload() {
  if (!currentModelData) return;
  // Re-trigger upload — background will skip duplicate check on second pass
  // by the time this runs, the duplicate state has already stored downloaded files
  currentModelData._skipDuplicateCheck = true;
  await startUpload();
}

init().catch((e) => {
  $("errorMessage").textContent = e.message;
  showView("error");
});
