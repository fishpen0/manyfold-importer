(async () => {
  const { readNextData, get, normalizeLicense, reportModelData } = window.ManyfoldScraper;

  const match = location.pathname.match(/\/models\/(\d+)/);
  if (!match) return;
  const designId = match[1];

  // ── Step 1: Read model data from __NEXT_DATA__ ────────────────────────────
  // Next.js embeds all SSR data here on initial page load only. Field names are
  // camelCase on Makerworld. SPA navigation does NOT update this element, so we
  // validate the design ID against the URL to detect that case.
  const nextData = readNextData();
  let design = get(nextData, ["props", "pageProps", "design"]);

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

  // If __NEXT_DATA__ belongs to a different model (SPA navigation), fetch the
  // current URL's HTML to get fresh SSR data rather than asking for a reload.
  if (design.id?.toString() !== designId) {
    console.warn("[Manyfold] SPA navigation detected — fetching fresh page data for design", designId);
    try {
      const res = await fetch(location.href, { credentials: "include" });
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (m) {
        const freshData = JSON.parse(m[1]);
        const freshDesign = get(freshData, ["props", "pageProps", "design"]);
        if (freshDesign?.id?.toString() === designId) {
          design = freshDesign;
        }
      }
    } catch (e) {
      console.warn("[Manyfold] Fresh fetch failed:", e.message);
    }

    // If we still have the wrong design, fall back to the reload prompt
    if (design.id?.toString() !== designId) {
      browser.runtime.sendMessage({ type: "SCRAPE_RESULT", modelData: null, needsReload: true });
      return;
    }
  }

  // ── Step 2: Build profile list from instance metadata ────────────────────
  // Download URLs are NOT fetched here — firing N parallel requests triggers
  // MakerWorld's rate limiter (429) when a model has many profiles. URLs are
  // fetched individually at upload time for only the profiles the user selects.
  const modelFiles = design.designExtension?.model_files ?? [];
  const has3mf = modelFiles.some(f => f.modelType === "3mf");
  const fileExt = has3mf ? "3mf" : "stl";

  const instances = design.instances ?? [];
  const designerUid = design.designCreator?.uid ?? null;
  const defaultInstanceId = design.defaultInstanceId ?? null;

  const files = instances.map(inst => {
    const creator = inst.instanceCreator ?? null;
    const contributor = creator
      ? {
          name: creator.name ?? creator.handle ?? null,
          profileUrl: creator.handle ? `https://makerworld.com/@${creator.handle}` : null,
        }
      : null;

    return {
      instanceId: inst.id,
      name: inst.title || `Profile ${inst.id}`,
      type: "model",
      fileExt,
      downloadUrl: null,
      isDesigner: designerUid !== null && creator?.uid === designerUid,
      isDefault: inst.id === defaultInstanceId,
      contributor,
      instanceDescription: inst.summary ?? null,
      instanceCoverUrl: inst.cover ?? null,
    };
  });

  // Fall back: if no instance matches defaultInstanceId, mark first as default
  if (files.length > 0 && !files.some(f => f.isDefault)) {
    files[0].isDefault = true;
  }

  console.log("[Manyfold] Profiles found:", files.length, "| has3mf:", has3mf);

  // ── Step 3: Build the normalized model object ─────────────────────────────
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
  };

  console.log("[Manyfold] Model ready:", modelData.title, "| profiles:", files.length);
  reportModelData(modelData);
})();
