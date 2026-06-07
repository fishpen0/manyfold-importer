const $ = (id) => document.getElementById(id);
const profileRadios = () => document.querySelectorAll('input[name="profileSelection"]');

const fields = {
  manyfoldUrl: $("manyfoldUrl"),
  oauthClientId: $("oauthClientId"),
  oauthClientSecret: $("oauthClientSecret"),
  defaultCollectionId: $("defaultCollectionId"),
};

// Load saved settings on open
browser.storage.sync
  .get({
    manyfoldUrl: "",
    oauthClientId: "",
    oauthClientSecret: "",
    defaultCollectionId: "",
    profileSelection: "first",
  })
  .then((settings) => {
    for (const [key, el] of Object.entries(fields)) {
      el.value = settings[key] ?? "";
    }
    for (const radio of profileRadios()) {
      radio.checked = radio.value === settings.profileSelection;
    }
  });

$("saveBtn").addEventListener("click", async () => {
  const values = Object.fromEntries(
    Object.entries(fields).map(([k, el]) => [k, el.value.trim()])
  );

  // Strip trailing slash from URL
  values.manyfoldUrl = values.manyfoldUrl.replace(/\/$/, "");

  // Profile selection radio
  const selectedRadio = document.querySelector('input[name="profileSelection"]:checked');
  values.profileSelection = selectedRadio?.value ?? "first";

  await browser.storage.sync.set(values);
  showStatus("Settings saved.", "success");
});

$("testBtn").addEventListener("click", async () => {
  const btn = $("testBtn");
  btn.disabled = true;
  btn.textContent = "Testing…";
  hideStatus();
  $("collectionsWrap").classList.add("hidden");

  const url = fields.manyfoldUrl.value.trim().replace(/\/$/, "");
  const id = fields.oauthClientId.value.trim();
  const secret = fields.oauthClientSecret.value.trim();

  if (!url || !id || !secret) {
    showStatus("Please fill in the instance URL, Client ID, and Client Secret first.", "error");
    btn.disabled = false;
    btn.textContent = "Test Connection";
    return;
  }

  try {
    // Inline auth + test — mirrors ManyfoldAPI but without importing the module
    const tokenRes = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
        scope: "public read write upload",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Authentication failed (${tokenRes.status}): ${text.slice(0, 200)}`);
    }

    const { access_token } = await tokenRes.json();

    const apiHeaders = {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/vnd.manyfold.v0+json",
    };

    // Verify the API is reachable
    const modelsRes = await fetch(`${url}/models`, { headers: apiHeaders });
    if (!modelsRes.ok) {
      throw new Error(`Authenticated but API unreachable (${modelsRes.status}). Check OAuth scopes.`);
    }

    // Fetch collections
    let collections = [];
    const collectionsRes = await fetch(`${url}/collections`, { headers: apiHeaders });
    if (collectionsRes.ok) {
      const data = await collectionsRes.json();
      collections = data?.member ?? [];
    }

    showStatus(`Connected! Found ${collections.length} collection(s).`, "success");

    if (collections.length > 0) {
      const list = $("collectionsList");
      list.innerHTML = "";
      for (const c of collections) {
        const collectionId = c["@id"];
        const li = document.createElement("li");
        li.textContent = c.name ?? collectionId;
        const idChip = document.createElement("span");
        idChip.className = "collection-id";
        idChip.textContent = collectionId;
        idChip.title = "Click to use as default collection";
        idChip.addEventListener("click", () => {
          fields.defaultCollectionId.value = collectionId;
          idChip.textContent = `✓ ${collectionId}`;
        });
        li.appendChild(idChip);
        list.appendChild(li);
      }
      $("collectionsWrap").classList.remove("hidden");
    }
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
});

function showStatus(message, type) {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${type}`;
}

function hideStatus() {
  $("status").className = "status hidden";
}
