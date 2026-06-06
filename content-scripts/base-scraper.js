/**
 * Shared utilities for all site scrapers.
 * Exposed as globals since content scripts don't support ES modules.
 */

window.ManyfoldScraper = {
  /**
   * Read Next.js __NEXT_DATA__ embedded JSON from the page.
   * Returns the parsed object or null if not present.
   */
  readNextData() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  },

  /**
   * Safely resolve a nested path in an object.
   * e.g. get(obj, ["a", "b", "c"]) === obj?.a?.b?.c
   */
  get(obj, path) {
    return path.reduce((acc, key) => acc?.[key], obj);
  },

  /**
   * Normalize a license string to something Manyfold understands.
   * Falls back to passing through the raw value.
   */
  normalizeLicense(raw) {
    if (!raw) return null;
    const map = {
      "CC BY": "CC-BY-4.0",
      "CC BY-SA": "CC-BY-SA-4.0",
      "CC BY-NC": "CC-BY-NC-4.0",
      "CC BY-NC-SA": "CC-BY-NC-SA-4.0",
      "CC BY-ND": "CC-BY-ND-4.0",
      "CC BY-NC-ND": "CC-BY-NC-ND-4.0",
      "CC0": "CC0-1.0",
      "MIT": "MIT",
    };
    for (const [key, spdx] of Object.entries(map)) {
      if (raw.includes(key)) return spdx;
    }
    return raw;
  },

  /**
   * Send scraped model data to the background service worker.
   */
  reportModelData(modelData) {
    browser.runtime.sendMessage({ type: "SCRAPE_RESULT", modelData });
  },
};
