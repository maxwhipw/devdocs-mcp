import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCORE,
  formatHits,
  nearestPaths,
  scoreName,
  searchEntries,
  type IndexEntry,
} from "../src/search.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/index.json", import.meta.url)), "utf8"),
) as { entries: IndexEntry[] };

const docsets = [{ slug: "vite", entries: fixture.entries }];

describe("scoreName tiers", () => {
  it("ranks exact above prefix above word-boundary above substring", () => {
    expect(scoreName("Config", "config")).toBe(SCORE.exact);
    expect(scoreName("Config Intellisense", "config")).toBe(SCORE.prefix);
    expect(scoreName("Build Options: Config", "config")).toBe(SCORE.wordBoundary);
    expect(scoreName("defineConfig", "config")).toBe(SCORE.substring);
  });

  it("matches all whitespace-separated tokens out of order", () => {
    expect(scoreName("Configuring Vite: Config Intellisense", "intellisense config")).toBe(
      SCORE.allTokens,
    );
  });

  it("falls back to subsequence and prefers tighter matches", () => {
    const tight = scoreName("defineConfig", "dconf");
    const loose = scoreName("defaults and configuration", "dconf");
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeLessThanOrEqual(SCORE.subsequenceMax);
    expect(tight).toBeGreaterThan(loose);
  });

  it("returns 0 when characters are missing or the query is blank", () => {
    expect(scoreName("Config", "zzz")).toBe(0);
    expect(scoreName("Config", "   ")).toBe(0);
  });
});

describe("searchEntries", () => {
  it("puts the exact-name entry first", () => {
    const hits = searchEntries(docsets, "defineConfig", 5);
    expect(hits[0]!.entry.name).toBe("defineConfig");
    expect(hits[0]!.entry.path).toBe("config/index#defineconfig");
  });

  it("respects the limit", () => {
    expect(searchEntries(docsets, "config", 2)).toHaveLength(2);
  });

  it("matches on the path when the name alone does not (camelCase query)", () => {
    const pathOnly = [
      {
        slug: "vite",
        entries: [{ name: "Shared Options: define", path: "config/shared-options#define", type: "Shared Options" }],
      },
    ];
    const hits = searchEntries(pathOnly, "defineConfig", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeLessThan(SCORE.allTokens);
  });

  it("breaks score ties on the shorter name", () => {
    const hits = searchEntries(docsets, "config", 10);
    const names = hits.map((h) => h.entry.name);
    expect(names[0]).toBe("Config");
    expect(names.indexOf("Config Intellisense")).toBeLessThan(
      names.indexOf("Build Options: Config"),
    );
  });

  it("drops non-matching entries", () => {
    const names = searchEntries(docsets, "config", 10).map((h) => h.entry.name);
    expect(names).not.toContain("Unrelated topic");
  });

  it("deduplicates identical rows coming from several docsets", () => {
    const dup = [
      { slug: "vite", entries: fixture.entries },
      { slug: "vite", entries: fixture.entries },
    ];
    const hits = searchEntries(dup, "defineConfig", 20);
    expect(new Set(hits.map((h) => `${h.slug}${h.entry.path}${h.entry.name}`)).size).toBe(
      hits.length,
    );
  });

  it("formats compact tab-separated rows", () => {
    const rows = formatHits(searchEntries(docsets, "defineConfig", 1)).split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe("vite\tConfig\tdefineConfig\tconfig/index#defineconfig");
  });
});

describe("nearestPaths", () => {
  it("suggests the closest known paths for a typo", () => {
    const paths = ["config/index", "config/build-options", "guide/index"];
    expect(nearestPaths(paths, "config/indx", 2)).toContain("config/index");
  });

  it("falls back to the first paths when nothing matches", () => {
    const paths = ["config/index", "guide/index"];
    expect(nearestPaths(paths, "zzzzz", 1)).toEqual(["config/index"]);
  });
});
