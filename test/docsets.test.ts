// Cache-layer tests: real filesystem in a temp dir, no network.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeSlug,
  listInstalled,
  loadDb,
  loadIndex,
  readMeta,
  removeDocset,
} from "../src/docsets.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "devdocs-mcp-test-"));
  process.env.DEVDOCS_CACHE_DIR = dir;

  await mkdir(join(dir, "vite"), { recursive: true });
  await writeFile(
    join(dir, "vite", "meta.json"),
    JSON.stringify({
      slug: "vite",
      name: "Vite",
      release: "8.3.0",
      mtime: 1,
      installedAt: "2026-09-14T00:00:00Z",
    }),
  );
  await writeFile(
    join(dir, "vite", "index.json"),
    JSON.stringify({ entries: [{ name: "Config", path: "config/index", type: "Config" }], types: [] }),
  );
  await writeFile(
    join(dir, "vite", "db.json"),
    JSON.stringify({ "config/index": "<h1 id=\"c\">Config</h1>" }),
  );

  // A stray directory without meta.json must be ignored, not crash listing.
  await mkdir(join(dir, "not-a-docset"), { recursive: true });
});

afterAll(async () => {
  delete process.env.DEVDOCS_CACHE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("cache listing and loading", () => {
  it("lists only directories that carry a meta.json", async () => {
    const metas = await listInstalled();
    expect(metas.map((m) => m.slug)).toEqual(["vite"]);
    expect(metas[0]!.release).toBe("8.3.0");
  });

  it("loads index.json and db.json from the cache", async () => {
    expect((await loadIndex("vite")).entries[0]!.name).toBe("Config");
    expect(Object.keys(await loadDb("vite"))).toEqual(["config/index"]);
  });

  it("reports an uninstalled docset as missing rather than throwing", async () => {
    expect(await readMeta("nope")).toBeNull();
    expect(await removeDocset("nope")).toBe(false);
  });

  it("removes an installed docset once", async () => {
    expect(await removeDocset("vite")).toBe(true);
    expect(await removeDocset("vite")).toBe(false);
    expect(await listInstalled()).toEqual([]);
  });
});

describe("slug validation", () => {
  it("rejects slugs that could escape the cache directory", () => {
    for (const bad of ["../etc", "a/b", "", "/abs", ".hidden"]) {
      expect(() => assertSafeSlug(bad)).toThrow();
    }
  });

  it("accepts real DevDocs slugs", () => {
    for (const good of ["vite", "python~3.13", "node", "c++"]) {
      expect(() => assertSafeSlug(good)).not.toThrow();
    }
  });
});
