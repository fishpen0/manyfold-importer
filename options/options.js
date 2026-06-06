const $ = (id) => document.getElementById(id);

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
  })
  .then((settings) => {
    for (const [key, el] of Object.entries(fields)) {
      el.value = settings[key] ?? "";
    }
  });

$("saveBtn").addEventListener("click", async () => {
  const values = Object.fromEntries(
    Object.entries(fields).map(([k, el]) => [k, el.value.trim()])
  );

  // Strip trailing slash from URL
  values.manyfoldUrl = values.manyfoldUrl.replace(/\/$/, "");

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
        scope: "public read write",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Authentication failed (${tokenRes.status}): ${text.slice(0, 200)}`);
    }

    const { access_token } = await tokenRes.json();

    // Test the token by fetching collections
    const collectionsRes = await fetch(`${url}/api/v1/collections?page[size]=100`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
      },
    });

    if (!collectionsRes.ok) {
      throw new Error(`Connected but API failed (${collectionsRes.status}). Check OAuth scopes.`);
    }

    const data = await collectionsRes.json();
    const collections = data?.data ?? [];

    showStatus(`Connected! Found ${collections.length} collection(s).`, "success");

    if (collections.length > 0) {
      const list = $("collectionsList");
      list.innerHTML = "";
      for (const c of collections) {
        const li = document.createElement("li");
        li.textContent = c.attributes?.name ?? c.id;
        const idChip = document.createElement("span");
        idChip.className = "collection-id";
        idChip.textContent = `ID: ${c.id}`;
        idChip.title = "Click to use as default collection";
        idChip.addEventListener("click", () => {
          fields.defaultCollectionId.value = c.id;
          idChip.textContent = `✓ ${c.id}`;
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
