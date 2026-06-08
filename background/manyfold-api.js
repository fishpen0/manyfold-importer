const MIME = "application/vnd.manyfold.v0+json";

export class ManyfoldAPI {
  constructor(baseUrl, clientId, clientSecret) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpiry = null;
  }

  async authenticate() {
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: "public read write upload",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  async ensureAuth() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
  }

  async request(method, path, body = null, contentType = null) {
    await this.ensureAuth();
    const headers = { Authorization: `Bearer ${this.token}`, Accept: MIME };
    if (contentType) headers["Content-Type"] = contentType;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : null,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // TUS resumable upload — creates the upload slot then streams bytes in one PATCH.
  async tusUpload(blob, filename) {
    await this.ensureAuth();

    const createRes = await fetch(`${this.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(blob.size),
        "Upload-Metadata": `filename ${btoa(unescape(encodeURIComponent(filename)))}`,
      },
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`TUS create failed (${createRes.status}): ${text}`);
    }
    const location = createRes.headers.get("Location");
    if (!location) throw new Error("TUS create returned no Location header");
    const uploadUrl = location.startsWith("http") ? location : `${this.baseUrl}${location}`;

    const patchRes = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(blob.size),
      },
      body: await blob.arrayBuffer(),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(`TUS upload failed (${patchRes.status}): ${text}`);
    }
    return uploadUrl;
  }

  // Upload all files via TUS, then create the model in one POST /models request.
  // Returns void — POST /models responds 202 Accepted with no body.
  async importModel({ title, description, sourceUrl, license, tags, collectionId }, files) {
    const uploadedFiles = [];
    for (const file of files) {
      const uploadUrl = await this.tusUpload(file.blob, file.name);
      uploadedFiles.push({ id: uploadUrl, name: file.name });
    }

    const payload = {
      name: title,
      description: [description, sourceUrl ? `Source: ${sourceUrl}` : ""].filter(Boolean).join("\n\n"),
      keywords: tags ?? [],
      files: uploadedFiles,
    };
    if (license) payload["spdx:license"] = { licenseId: license };
    payload.isPartOf = collectionId ? [{ "@id": collectionId }] : [];

    await this.request("POST", "/models", payload, MIME);
  }

  async listCollections() {
    const data = await this.request("GET", "/collections");
    return data?.member ?? [];
  }

  async createCollection({ name, caption, description, parentId } = {}) {
    const payload = { name };
    if (caption) payload.caption = caption;
    if (description) payload.description = description;
    if (parentId) payload.isPartOf = { "@id": parentId };
    const data = await this.request("POST", "/collections", payload, MIME);
    return data["@id"];
  }

  async findCollectionByName(name) {
    const list = await this.listCollections();
    return list.find((c) => c.name === name) ?? null;
  }

  // Best-effort duplicate check by model name against the first page of results.
  async findModelByTitle(title) {
    try {
      const data = await this.request("GET", "/models");
      return (data?.member ?? []).find((m) => m.name === title) ?? null;
    } catch {
      return null;
    }
  }
}
