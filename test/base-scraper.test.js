/**
 * Tests for content-scripts/base-scraper.js
 *
 * base-scraper is a classic content script — it assigns to window.ManyfoldScraper
 * rather than using ES module exports. We load it by evaling the file text inside
 * Vitest's happy-dom environment (where window exists), which is exactly what the
 * browser would do when injecting the script into a page.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, "../content-scripts/base-scraper.js"),
  "utf8"
);

// Execute the script once — sets window.ManyfoldScraper
// eslint-disable-next-line no-eval
eval(src);

const { normalizeLicense, get, readNextData } = window.ManyfoldScraper;

// ---------------------------------------------------------------------------
// normalizeLicense()
// ---------------------------------------------------------------------------

describe("normalizeLicense()", () => {
  it("returns null for null / falsy input", () => {
    expect(normalizeLicense(null)).toBeNull();
    expect(normalizeLicense("")).toBeNull();
    expect(normalizeLicense(undefined)).toBeNull();
  });

  it("returns null for unrecognised license strings", () => {
    expect(normalizeLicense("GPL-3.0")).toBeNull();
    expect(normalizeLicense("proprietary")).toBeNull();
  });

  // Full "CC BY-*" forms
  it.each([
    ["CC BY-NC-SA", "CC-BY-NC-SA-4.0"],
    ["CC BY-NC-ND", "CC-BY-NC-ND-4.0"],
    ["CC BY-NC", "CC-BY-NC-4.0"],
    ["CC BY-SA", "CC-BY-SA-4.0"],
    ["CC BY-ND", "CC-BY-ND-4.0"],
    ["CC BY", "CC-BY-4.0"],
    ["CC0", "CC0-1.0"],
  ])('maps full form "%s" → "%s"', (input, expected) => {
    expect(normalizeLicense(input)).toBe(expected);
  });

  // Short forms MakerWorld actually uses (no "CC" prefix)
  it.each([
    ["BY-NC-SA", "CC-BY-NC-SA-4.0"],
    ["BY-NC-ND", "CC-BY-NC-ND-4.0"],
    ["BY-NC", "CC-BY-NC-4.0"],
    ["BY-SA", "CC-BY-SA-4.0"],
    ["BY-ND", "CC-BY-ND-4.0"],
    ["BY", "CC-BY-4.0"],
    ["MIT", "MIT"],
  ])('maps short form "%s" → "%s"', (input, expected) => {
    expect(normalizeLicense(input)).toBe(expected);
  });

  it("matches when the license string is embedded in longer text", () => {
    // MakerWorld sometimes returns "CC BY-NC-SA 4.0" as a string
    expect(normalizeLicense("CC BY-NC-SA 4.0")).toBe("CC-BY-NC-SA-4.0");
  });

  it("prefers the most specific match (BY-NC-SA before BY-NC)", () => {
    // "BY-NC-SA" contains "BY-NC", but map iteration finds "BY-NC-SA" first
    // because it appears earlier in the object literal.
    expect(normalizeLicense("BY-NC-SA")).toBe("CC-BY-NC-SA-4.0");
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("get()", () => {
  it("resolves a simple nested path", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(get(obj, ["a", "b", "c"])).toBe(42);
  });

  it("returns the object itself for an empty path", () => {
    const obj = { x: 1 };
    expect(get(obj, [])).toBe(obj);
  });

  it("returns undefined when an intermediate key is missing", () => {
    expect(get({ a: {} }, ["a", "b", "c"])).toBeUndefined();
  });

  it("returns undefined when the root is null", () => {
    expect(get(null, ["a"])).toBeUndefined();
  });

  it("returns undefined when the root is undefined", () => {
    expect(get(undefined, ["a", "b"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readNextData()
// ---------------------------------------------------------------------------

describe("readNextData()", () => {
  it("returns null when __NEXT_DATA__ is absent", () => {
    expect(readNextData()).toBeNull();
  });

  it("parses valid __NEXT_DATA__ JSON", () => {
    const el = document.createElement("script");
    el.id = "__NEXT_DATA__";
    el.type = "application/json";
    el.textContent = JSON.stringify({ props: { pageProps: { design: { id: 1 } } } });
    document.body.appendChild(el);

    const result = readNextData();
    expect(result?.props?.pageProps?.design?.id).toBe(1);

    document.body.removeChild(el);
  });

  it("returns null when __NEXT_DATA__ contains invalid JSON", () => {
    const el = document.createElement("script");
    el.id = "__NEXT_DATA__";
    el.type = "application/json"; // prevent happy-dom from executing the script
    el.textContent = "not-json{{{";
    document.body.appendChild(el);

    expect(readNextData()).toBeNull();

    document.body.removeChild(el);
  });
});
