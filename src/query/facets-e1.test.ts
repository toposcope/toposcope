import { describe, expect, test } from "bun:test";

// #260: the slice's fingerprint chips ride on the sidebar's read, so they cost no second request.
describe("GET /api/facets answers e1", () => {
  test("facetsRoute reads through facetsWithFingerprints", async () => {
    const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(src).toMatch(/c\.json\(await facetsWithFingerprints\(searchFiltersFrom\(c\)/);
    expect(src).toMatch(/attrFacets\(filters, \["e1"\], 10, false\)/);
  });
});
