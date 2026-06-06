(async () => {
  const { readNextData, get, normalizeLicense, reportModelData } = window.ManyfoldScraper;

  const match = location.pathname.match(/\/models\/(\d+)/);
  if (!match) return;
  const designId = match[1];

  // ── Step 1: Read model data from __NEXT_DATA__ ────────────────────────────
  // Next.js embeds all SSR data here. Field names are camelCase on Makerworld.
  const nextData = readNextData();
  const design = get(nextData, ["props", "pageProps", "design"]);

  if (!design) {
    console.error("[Manyfold] Could not find design in __NEXT_DATA__. pageProps keys:",
      Object.keys(get(nextData, ["props", "pageProps"]) ?? {}));
    browser.runtime.sendMessage({
      type: "SCRAPE_RESULT",
      modelData: null,
      error: "Could not read model data from page. Make sure you are fully logged in to Makerworld.",
    });
    return;
  }

  // ── Step 2: Determine which files to download ─────────────────────────────
  // model_files lives at design.designExtension.model_files (top-level, not per-instance)
  const modelFiles = design.designExtension?.model_files ?? [];
  const has3mf = modelFiles.some(f => f.modelType === "3mf");
  console.log("[Manyfold] model_files:", modelFiles.map(f => `${f.modelName || f.modelType} (${f.modelType})`));

  // ── Step 3: Fetch presigned download URLs ─────────────────────────────────
  // Endpoint: /api/v1/design-service/instance/{instance.id}/f3mf  → { name, url }
  // Endpoint: /api/v1/design-service/instance/{instance.id}/stl   → { name, url } (guessed)
  // Uses session cookies automatically — no auth token needed.
  const instances = design.instances ?? [];
  const files = [];

  for (const inst of instances) {
    const instId = inst.id;

    if (has3mf) {
      try {
        const res = await fetch(`/api/v1/design-service/instance/${instId}/f3mf`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const { name, url } = await res.json();
          if (url) {
            files.push({ name: name || `model_${instId}.3mf`, type: "model", fileExt: "3mf", downloadUrl: url });
          }
        } else {
          console.warn("[Manyfold] /f3mf returned", res.status, "for instance", instId);
        }
      } catch (e) {
        console.warn("[Manyfold] /f3mf fetch failed:", e.message);
      }
    } else {
      // No 3MF — fall back to STL endpoint
      try {
        const res = await fetch(`/api/v1/design-service/instance/${instId}/stl`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const data = await res.json();
          // Response may be { name, url } or an array of files
          const entries = Array.isArray(data) ? data : (data.files ?? [data]);
          for (const entry of entries) {
            if (entry.url) {
              files.push({ name: entry.name || `model_${instId}.stl`, type: "model", fileExt: "stl", downloadUrl: entry.url });
            }
          }
        } else {
          console.warn("[Manyfold] /stl returned", res.status, "for instance", instId);
        }
      } catch (e) {
        console.warn("[Manyfold] /stl fetch failed:", e.message);
      }
    }
  }

  console.log("[Manyfold] Resolved files:", files.map(f => f.name));

  // ── Step 4: Build the normalized model object ─────────────────────────────
  const creator = design.designCreator ?? {};
  const tags = (design.tags ?? design.tagsOriginal ?? [])
    .map(t => (typeof t === "string" ? t : t?.name ?? t?.value))
    .filter(Boolean);

  const modelData = {
    title: design.title ?? document.title,
    description: design.summary ?? "",
    sourceUrl: location.origin + location.pathname,
    creator: {
      name: creator.name ?? creator.handle ?? null,
      profileUrl: creator.handle ? `https://makerworld.com/@${creator.handle}` : null,
    },
    license: normalizeLicense(design.license),
    tags,
    coverImageUrl: design.coverUrl ?? design.coverLandscape ?? null,
    files,
    _hasToken: true, // session cookie auth, always available when logged in
  };

  console.log("[Manyfold] Model ready:", modelData.title, "| files:", files.length);
  reportModelData(modelData);
})();
