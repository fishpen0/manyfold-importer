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
        scope: "public read write",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    this.token = data.access_token;
    // Expire 60s early to avoid edge cases
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  async ensureAuth() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
  }

  async request(method, path, body = null, isFormData = false) {
    await this.ensureAuth();

    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body && !isFormData) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : null,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    return contentType.includes("json") ? res.json() : res.text();
  }

  async testConnection() {
    await this.authenticate();
    return this.request("GET", "/api/v1/models?page[size]=1");
  }

  async findModelBySourceUrl(sourceUrl) {
    // Manyfold doesn't have a direct source URL search, so search by title won't work perfectly.
    // We store the source URL in the notes/description field and use list + filter as a best-effort check.
    // A future Manyfold release may expose a proper source URL field.
    try {
      const data = await this.request("GET", "/api/v1/models?page[size]=50");
      const models = data?.data ?? [];
      return models.find((m) => m.attributes?.notes?.includes(sourceUrl)) ?? null;
    } catch {
      return null;
    }
  }

  async createModel({ title, description, sourceUrl, license, tags, collectionId, creatorName }) {
    const attributes = {
      name: title,
      notes: [description, sourceUrl ? `Source: ${sourceUrl}` : ""].filter(Boolean).join("\n\n"),
      license,
      tag_list: tags?.join(", ") ?? "",
    };

    const relationships = {};
    if (collectionId) {
      relationships.collection = {
        data: { type: "collections", id: String(collectionId) },
      };
    }

    const payload = {
      data: {
        type: "models",
        attributes,
        ...(Object.keys(relationships).length ? { relationships } : {}),
      },
    };

    const res = await this.request("POST", "/api/v1/models", payload);
    return res.data;
  }

  async uploadFile(modelId, blob, filename, kind = "model") {
    const form = new FormData();
    form.append("model_file[file]", blob, filename);
    form.append("model_file[kind]", kind);

    return this.request("POST", `/api/v1/models/${modelId}/model_files`, form, true);
  }

  async listCollections() {
    const data = await this.request("GET", "/api/v1/collections?page[size]=100");
    return data?.data ?? [];
  }
}
