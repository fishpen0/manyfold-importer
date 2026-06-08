import { describe, it, expect } from "vitest";
import { manyfoldUrl, shouldUseCollection } from "../background/utils.js";

// ---------------------------------------------------------------------------
// manyfoldUrl()
// ---------------------------------------------------------------------------

describe("manyfoldUrl()", () => {
  it("replaces the origin of an absolute URL with the configured base", () => {
    expect(manyfoldUrl("http://localhost:3214/collections/abc", "https://manyfold.example.com"))
      .toBe("https://manyfold.example.com/collections/abc");
  });

  it("works when the server reports a different external origin", () => {
    expect(manyfoldUrl("https://internal.corp/models/xyz", "https://manyfold.example.com"))
      .toBe("https://manyfold.example.com/models/xyz");
  });

  it("prepends baseUrl when @id is already a relative path", () => {
    expect(manyfoldUrl("/collections/abc", "https://manyfold.example.com"))
      .toBe("https://manyfold.example.com/collections/abc");
  });

  it("preserves path depth and trailing segments", () => {
    expect(manyfoldUrl("http://localhost:3214/collections/a1b2/models/c3d4", "https://manyfold.example.com"))
      .toBe("https://manyfold.example.com/collections/a1b2/models/c3d4");
  });
});

// ---------------------------------------------------------------------------
// shouldUseCollection()
// ---------------------------------------------------------------------------

describe("shouldUseCollection()", () => {
  const base = { multiModelMode: "single", singleProfileCollection: "model" };

  it("returns false when multiModelMode is 'single'", () => {
    expect(shouldUseCollection(3, { ...base, multiModelMode: "single" })).toBe(false);
  });

  it("returns true when multiModelMode is 'collection' and multiple files", () => {
    expect(shouldUseCollection(2, { ...base, multiModelMode: "collection" })).toBe(true);
    expect(shouldUseCollection(5, { ...base, multiModelMode: "collection" })).toBe(true);
  });

  it("returns false for one file when singleProfileCollection is 'model'", () => {
    expect(shouldUseCollection(1, { multiModelMode: "collection", singleProfileCollection: "model" }))
      .toBe(false);
  });

  it("returns true for one file when singleProfileCollection is 'collection'", () => {
    expect(shouldUseCollection(1, { multiModelMode: "collection", singleProfileCollection: "collection" }))
      .toBe(true);
  });
});
