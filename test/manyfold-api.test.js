import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManyfoldAPI } from "../background/manyfold-api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fetch mock that returns responses in sequence. */
function mockFetch(...responses) {
  return vi.fn().mockImplementation(() => {
    const r = responses.shift();
    return Promise.resolve(r);
  });
}

/** Minimal OK fetch response with a JSON body. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const json = JSON.stringify(body);
  return {
    ok: true,
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: () => Promise.resolve(json),
    json: () => Promise.resolve(body),
  };
}

/** Minimal OK response with no body (e.g. 202 Accepted). */
function emptyResponse({ status = 202, headers = {} } = {}) {
  return {
    ok: true,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(""),
    json: () => Promise.resolve(null),
  };
}

/** Non-OK error response. */
function errorResponse(status = 500, body = "Internal Server Error") {
  return {
    ok: false,
    status,
    headers: new Headers({ "content-type": "text/plain" }),
    text: () => Promise.resolve(body),
  };
}

/** Return an API instance that is already authenticated (bypasses real auth). */
function authenticatedApi(baseUrl = "https://manyfold.example.com") {
  const api = new ManyfoldAPI(baseUrl, "client-id", "client-secret");
  api.token = "test-token";
  api.tokenExpiry = Date.now() + 3_600_000; // 1 h from now
  return api;
}

// ---------------------------------------------------------------------------
// authenticate()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.authenticate()", () => {
  it("stores the token and expiry on success", async () => {
    const api = new ManyfoldAPI("https://example.com", "id", "secret");
    global.fetch = mockFetch(
      jsonResponse({ access_token: "tok123", expires_in: 3600 })
    );

    await api.authenticate();

    expect(api.token).toBe("tok123");
    expect(api.tokenExpiry).toBeGreaterThan(Date.now());
  });

  it("sends credentials as form-encoded body", async () => {
    const api = new ManyfoldAPI("https://example.com", "my-id", "my-secret");
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "t", expires_in: 60 })
    );

    await api.authenticate();

    const [, init] = global.fetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body.toString()).toContain("client_id=my-id");
    expect(init.body.toString()).toContain("client_secret=my-secret");
  });

  it("strips a trailing slash from the base URL", async () => {
    const api = new ManyfoldAPI("https://example.com/", "id", "secret");
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "t", expires_in: 60 })
    );

    await api.authenticate();

    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe("https://example.com/oauth/token");
  });

  it("throws with status on non-ok response", async () => {
    const api = new ManyfoldAPI("https://example.com", "id", "secret");
    global.fetch = mockFetch(errorResponse(401, "Unauthorized"));

    await expect(api.authenticate()).rejects.toThrow("OAuth failed (401)");
  });
});

// ---------------------------------------------------------------------------
// ensureAuth()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.ensureAuth()", () => {
  it("calls authenticate() when no token exists", async () => {
    const api = new ManyfoldAPI("https://example.com", "id", "secret");
    global.fetch = mockFetch(jsonResponse({ access_token: "new", expires_in: 3600 }));

    await api.ensureAuth();

    expect(api.token).toBe("new");
  });

  it("skips authenticate() when token is still valid", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn();

    await api.ensureAuth();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("re-authenticates when the token is expired", async () => {
    const api = new ManyfoldAPI("https://example.com", "id", "secret");
    api.token = "old-token";
    api.tokenExpiry = Date.now() - 1; // already expired
    global.fetch = mockFetch(jsonResponse({ access_token: "fresh", expires_in: 3600 }));

    await api.ensureAuth();

    expect(api.token).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// request()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.request()", () => {
  it("sends Authorization and Accept headers", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ member: [] })
    );

    await api.request("GET", "/models");

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.headers.Accept).toBe("application/vnd.manyfold.v0+json");
  });

  it("returns parsed JSON when content-type includes json", async () => {
    const api = authenticatedApi();
    const payload = { member: [{ name: "Cube" }] };
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(payload));

    const result = await api.request("GET", "/models");

    expect(result).toEqual(payload);
  });

  it("returns null for a non-JSON response", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => Promise.resolve(""),
    });

    const result = await api.request("POST", "/models", {});

    expect(result).toBeNull();
  });

  it("returns null for an empty JSON body (202 Accepted)", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve(""),
    });

    const result = await api.request("POST", "/models", {});

    expect(result).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(errorResponse(404, "Not Found"));

    await expect(api.request("GET", "/missing")).rejects.toThrow("GET /missing failed (404)");
  });
});

// ---------------------------------------------------------------------------
// tusUpload()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.tusUpload()", () => {
  const blob = new Blob(["abc"], { type: "application/octet-stream" });

  it("POSTs to /upload then PATCHes the returned location", async () => {
    const api = authenticatedApi();
    global.fetch = mockFetch(
      // TUS create
      {
        ok: true,
        status: 201,
        headers: new Headers({ Location: "/upload/abc123" }),
        text: () => Promise.resolve(""),
      },
      // TUS PATCH
      { ok: true, status: 204, headers: new Headers({}), text: () => Promise.resolve("") }
    );

    const url = await api.tusUpload(blob, "model.3mf");

    const [createUrl, createInit] = global.fetch.mock.calls[0];
    expect(createUrl).toBe("https://manyfold.example.com/upload");
    expect(createInit.method).toBe("POST");
    expect(createInit.headers["Tus-Resumable"]).toBe("1.0.0");

    const [patchUrl, patchInit] = global.fetch.mock.calls[1];
    expect(patchUrl).toBe("https://manyfold.example.com/upload/abc123");
    expect(patchInit.method).toBe("PATCH");
    expect(patchInit.headers["Upload-Offset"]).toBe("0");
    expect(url).toBe("https://manyfold.example.com/upload/abc123");
  });

  it("uses an absolute Location header as-is", async () => {
    const api = authenticatedApi();
    global.fetch = mockFetch(
      {
        ok: true,
        status: 201,
        headers: new Headers({ Location: "https://cdn.example.com/upload/xyz" }),
        text: () => Promise.resolve(""),
      },
      { ok: true, status: 204, headers: new Headers({}), text: () => Promise.resolve("") }
    );

    const url = await api.tusUpload(blob, "model.stl");

    expect(url).toBe("https://cdn.example.com/upload/xyz");
  });

  it("throws when TUS create returns no Location header", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({}), // no Location
      text: () => Promise.resolve(""),
    });

    await expect(api.tusUpload(blob, "model.3mf")).rejects.toThrow(
      "TUS create returned no Location header"
    );
  });

  it("throws when TUS create fails", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(errorResponse(500, "Server error"));

    await expect(api.tusUpload(blob, "model.3mf")).rejects.toThrow("TUS create failed (500)");
  });

  it("throws when TUS PATCH fails", async () => {
    const api = authenticatedApi();
    global.fetch = mockFetch(
      {
        ok: true,
        status: 201,
        headers: new Headers({ Location: "/upload/abc" }),
        text: () => Promise.resolve(""),
      },
      errorResponse(423, "Locked")
    );

    await expect(api.tusUpload(blob, "model.3mf")).rejects.toThrow("TUS upload failed (423)");
  });
});

// ---------------------------------------------------------------------------
// importModel()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.importModel()", () => {
  function setupTusAndModel(api, numFiles = 1) {
    // Each file needs: POST /upload + PATCH; then POST /models
    const tusResponses = Array.from({ length: numFiles }, (_, i) => [
      {
        ok: true,
        status: 201,
        headers: new Headers({ Location: `/upload/file${i}` }),
        text: () => Promise.resolve(""),
      },
      { ok: true, status: 204, headers: new Headers({}), text: () => Promise.resolve("") },
    ]).flat();

    const modelCreate = emptyResponse();

    global.fetch = mockFetch(...tusResponses, modelCreate);
  }

  it("builds correct payload with license and collectionId", async () => {
    const api = authenticatedApi();
    setupTusAndModel(api);

    const file = { blob: new Blob(["x"]), name: "model.3mf" };
    await api.importModel(
      {
        title: "Cool Model",
        description: "Great model",
        sourceUrl: "https://makerworld.com/models/1",
        license: "CC-BY-4.0",
        tags: ["tag1", "tag2"],
        collectionId: "/collections/5",
      },
      [file]
    );

    // Last fetch call is the POST /models
    const lastCall = global.fetch.mock.calls.at(-1);
    const body = JSON.parse(lastCall[1].body);

    expect(body.name).toBe("Cool Model");
    expect(body["spdx:license"]).toEqual({ licenseId: "CC-BY-4.0" });
    expect(body.isPartOf).toEqual([{ "@id": "/collections/5" }]);
    expect(body.keywords).toEqual(["tag1", "tag2"]);
    expect(body.description).toContain("Source: https://makerworld.com/models/1");
  });

  it("omits spdx:license and isPartOf when not provided", async () => {
    const api = authenticatedApi();
    setupTusAndModel(api);

    await api.importModel(
      { title: "Bare Model", description: "", sourceUrl: null, license: null, tags: [], collectionId: null },
      [{ blob: new Blob(["x"]), name: "model.stl" }]
    );

    const lastCall = global.fetch.mock.calls.at(-1);
    const body = JSON.parse(lastCall[1].body);

    expect(body).not.toHaveProperty("spdx:license");
    expect(body).not.toHaveProperty("isPartOf");
  });
});

// ---------------------------------------------------------------------------
// createCollection()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.createCollection()", () => {
  it("builds correct payload with all fields and returns @id", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ "@id": "/collections/new123", name: "My Collection" }, { status: 201 })
    );

    const id = await api.createCollection({
      name: "My Collection",
      caption: "by Alice",
      description: "A nice collection\n\nSource: https://example.com",
      parentId: "/collections/parent456",
    });

    expect(id).toBe("/collections/new123");
    const [, init] = global.fetch.mock.calls.at(-1);
    const body = JSON.parse(init.body);
    expect(body.name).toBe("My Collection");
    expect(body.caption).toBe("by Alice");
    expect(body.description).toBe("A nice collection\n\nSource: https://example.com");
    expect(body.isPartOf).toEqual({ "@id": "/collections/parent456" });
  });

  it("omits isPartOf when no parentId is provided", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ "@id": "/collections/abc" }, { status: 201 })
    );

    await api.createCollection({ name: "Solo Collection" });

    const [, init] = global.fetch.mock.calls.at(-1);
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("isPartOf");
  });

  it("omits optional fields when not provided", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ "@id": "/collections/bare" }, { status: 201 })
    );

    await api.createCollection({ name: "Bare" });

    const [, init] = global.fetch.mock.calls.at(-1);
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("caption");
    expect(body).not.toHaveProperty("description");
  });

  it("POSTs to /collections with the Manyfold MIME type", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ "@id": "/collections/x" }, { status: 201 })
    );

    await api.createCollection({ name: "Test" });

    const [url, init] = global.fetch.mock.calls.at(-1);
    expect(url).toBe("https://manyfold.example.com/collections");
    expect(init.headers["Content-Type"]).toBe("application/vnd.manyfold.v0+json");
  });
});

// ---------------------------------------------------------------------------
// findCollectionByName()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.findCollectionByName()", () => {
  it("returns the matching collection", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        member: [
          { "@id": "/collections/1", name: "Vehicles" },
          { "@id": "/collections/2", name: "Buildings" },
        ],
      })
    );

    const result = await api.findCollectionByName("Buildings");
    expect(result?.["@id"]).toBe("/collections/2");
  });

  it("returns null when no collection matches", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ member: [{ "@id": "/collections/1", name: "Vehicles" }] })
    );

    const result = await api.findCollectionByName("Spaceships");
    expect(result).toBeNull();
  });

  it("returns null when the list is empty", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ member: [] }));

    const result = await api.findCollectionByName("Anything");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listCollections()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.listCollections()", () => {
  it("returns the member array from the response", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ member: [{ "@id": "/collections/1", name: "Prints" }] })
    );

    const result = await api.listCollections();

    expect(result).toEqual([{ "@id": "/collections/1", name: "Prints" }]);
  });

  it("returns an empty array when member is absent", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

    const result = await api.listCollections();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findModelByTitle()
// ---------------------------------------------------------------------------

describe("ManyfoldAPI.findModelByTitle()", () => {
  it("returns the matching model", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ member: [{ name: "Cube" }, { name: "Sphere" }] })
    );

    const result = await api.findModelByTitle("Sphere");

    expect(result?.name).toBe("Sphere");
  });

  it("returns null when no model matches the title", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ member: [{ name: "Cube" }] })
    );

    const result = await api.findModelByTitle("Octahedron");

    expect(result).toBeNull();
  });

  it("returns null (does not throw) when the request fails", async () => {
    const api = authenticatedApi();
    global.fetch = vi.fn().mockResolvedValue(errorResponse(500));

    const result = await api.findModelByTitle("Anything");

    expect(result).toBeNull();
  });
});
