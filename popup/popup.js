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
async function renderReady(modelData) {
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

  // Load profile selection preference
  const { profileSelection } = await browser.storage.sync.get({ profileSelection: "first" });

  // Files — rendered as checkboxes
  const fileListEl = $("fileList");
  fileListEl.innerHTML = "";
  const files = modelData.files ?? [];

  if (files.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No profiles found";
    li.style.color = "var(--error)";
    fileListEl.appendChild(li);
    $("noFilesWarning").classList.remove("hidden");
    $("profileControls").classList.add("hidden");
  } else {
    $("noFilesWarning").classList.add("hidden");
    if (files.length > 1) {
      $("profileControls").classList.remove("hidden");
    }

    files.forEach((file, i) => {
      const checked = profileSelection === "all"
        ? true
        : profileSelection === "designer"
          ? file.isDesigner
          : i === 0; // "first" — default

      const li = document.createElement("li");
      const label = document.createElement("label");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `file-check-${i}`;
      checkbox.checked = checked;
      checkbox.addEventListener("change", updateUploadBtn);

      const badge = document.createElement("span");
      badge.className = `file-badge badge-${file.fileExt === "3mf" ? "3mf" : "stl"}`;
      badge.textContent = file.fileExt;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = file.name;

      label.appendChild(checkbox);
      label.appendChild(badge);
      label.appendChild(nameSpan);
      li.appendChild(label);
      fileListEl.appendChild(li);
    });
  }

  updateUploadBtn();
  showView("ready");
}

function updateUploadBtn() {
  const files = currentModelData?.files ?? [];
  const anyChecked = files.some((_, i) => $(`file-check-${i}`)?.checked);
  $("uploadBtn").disabled = !anyChecked;
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
  $("selectAllBtn").addEventListener("click", () => {
    (currentModelData?.files ?? []).forEach((_, i) => {
      const cb = $(`file-check-${i}`);
      if (cb) cb.checked = true;
    });
    updateUploadBtn();
  });
  $("selectNoneBtn").addEventListener("click", () => {
    (currentModelData?.files ?? []).forEach((_, i) => {
      const cb = $(`file-check-${i}`);
      if (cb) cb.checked = false;
    });
    updateUploadBtn();
  });
  // Retry: re-upload if we have model data; otherwise re-scan the page
  $("retryBtn").addEventListener("click", () => currentModelData ? startUpload() : rescanPage());
  $("reloadBtn").addEventListener("click", async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) browser.tabs.reload(tab.id);
    showView("loading");
  });

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

async function applyState(state) {
  if (!state || state.status === "idle") {
    showView("idle");
    return;
  }

  switch (state.status) {
    case "ready":
      await renderReady(state.modelData);
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

    case "needs_reload":
      showView("needs-reload");
      break;

    case "error":
      $("errorMessage").textContent = state.error ?? "Unknown error.";
      showView("error");
      break;

    default:
      showView("idle");
  }
}

async function rescanPage() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  showView("loading");
  await browser.runtime.sendMessage({ type: "RESCAN_TAB", tabId: tab.id });
}

async function startUpload() {
  if (!currentModelData) return;

  // Build modelData with only the user-selected profiles
  const selectedFiles = (currentModelData.files ?? []).filter((_, i) => $(`file-check-${i}`)?.checked);
  if (selectedFiles.length === 0) return;

  showView("uploading");
  $("progressText").textContent = "Starting…";

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = await browser.runtime.sendMessage({
    type: "START_UPLOAD",
    modelData: { ...currentModelData, files: selectedFiles },
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
  // currentModelData.files is already the user's selected subset from the original startUpload call
  showView("uploading");
  $("progressText").textContent = "Starting…";
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const result = await browser.runtime.sendMessage({
    type: "START_UPLOAD",
    modelData: { ...currentModelData, _skipDuplicateCheck: true },
    tabId: tab?.id,
  });
  if (result?.success) {
    $("newModelLink").href = result.modelUrl;
    showView("done");
  } else if (result && !result.success) {
    $("errorMessage").textContent = result.error ?? "Upload failed.";
    showView("error");
  }
}

init().catch((e) => {
  $("errorMessage").textContent = e.message;
  showView("error");
});
