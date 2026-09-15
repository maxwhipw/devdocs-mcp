// Docset cache management: install/remove/list, plus lazy loading of index.json
// and db.json with a small in-memory LRU so repeated reads stay cheap.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { docsetUrl, fetchJson, type ManifestEntry } from "./manifest.js";
import { cacheDir, docsetDir } from "./paths.js";
import type { IndexEntry } from "./search.js";

export interface DocsetMeta {
  slug: string;
  name: string;
  release?: string;
  mtime: number;
  installedAt: string;
}

export interface DocsetIndex {
  entries: IndexEntry[];
  types: { name: string; count: number; slug: string }[];
}

export type DocsetDb = Record<string, string>;

const LRU_LIMIT = 3;
const indexCache = new Map<string, DocsetIndex>();
const dbCache = new Map<string, DocsetDb>();

/** Slugs are used as directory names — keep them to the shape DevDocs uses. */
export function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9._~+-]*$/i.test(slug)) {
    throw new Error(`Invalid docset slug: ${JSON.stringify(slug)}`);
  }
}

export async function listInstalled(): Promise<DocsetMeta[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(cacheDir(), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const metas: DocsetMeta[] = [];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(docsetDir(dir), "meta.json"), "utf8");
      metas.push(JSON.parse(raw) as DocsetMeta);
    } catch {
      // Not a docset directory (or a half-written install) — skip it.
    }
  }
  return metas.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readMeta(slug: string): Promise<DocsetMeta | null> {
  try {
    const raw = await readFile(join(docsetDir(slug), "meta.json"), "utf8");
    return JSON.parse(raw) as DocsetMeta;
  } catch {
    return null;
  }
}

export interface InstallResult {
  status: "installed" | "updated" | "up-to-date";
  meta: DocsetMeta;
  entries: number;
  pages: number;
}

export async function installDocset(entry: ManifestEntry): Promise<InstallResult> {
  assertSafeSlug(entry.slug);
  const existing = await readMeta(entry.slug);
  if (existing && existing.mtime >= entry.mtime) {
    const index = await loadIndex(entry.slug);
    const db = await loadDb(entry.slug);
    return {
      status: "up-to-date",
      meta: existing,
      entries: index.entries.length,
      pages: Object.keys(db).length,
    };
  }

  const dir = docsetDir(entry.slug);
  await mkdir(dir, { recursive: true });
  const index = (await fetchJson(docsetUrl(entry.slug, "index.json"))) as DocsetIndex;
  if (!Array.isArray(index?.entries)) {
    throw new Error(`Malformed index.json for ${entry.slug}`);
  }
  const db = (await fetchJson(docsetUrl(entry.slug, "db.json"))) as DocsetDb;
  if (!db || typeof db !== "object" || Array.isArray(db)) {
    throw new Error(`Malformed db.json for ${entry.slug}`);
  }

  const meta: DocsetMeta = {
    slug: entry.slug,
    name: entry.name,
    release: entry.release,
    mtime: entry.mtime,
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "index.json"), JSON.stringify(index), "utf8");
  await writeFile(join(dir, "db.json"), JSON.stringify(db), "utf8");
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  indexCache.set(entry.slug, index);
  dbCache.delete(entry.slug);

  return {
    status: existing ? "updated" : "installed",
    meta,
    entries: index.entries.length,
    pages: Object.keys(db).length,
  };
}

export async function removeDocset(slug: string): Promise<boolean> {
  assertSafeSlug(slug);
  const meta = await readMeta(slug);
  if (!meta) return false;
  await rm(docsetDir(slug), { recursive: true, force: true });
  indexCache.delete(slug);
  dbCache.delete(slug);
  return true;
}

export async function loadIndex(slug: string): Promise<DocsetIndex> {
  assertSafeSlug(slug);
  const cached = touch(indexCache, slug);
  if (cached) return cached;
  const raw = await readFile(join(docsetDir(slug), "index.json"), "utf8");
  const index = JSON.parse(raw) as DocsetIndex;
  put(indexCache, slug, index);
  return index;
}

export async function loadDb(slug: string): Promise<DocsetDb> {
  assertSafeSlug(slug);
  const cached = touch(dbCache, slug);
  if (cached) return cached;
  const raw = await readFile(join(docsetDir(slug), "db.json"), "utf8");
  const db = JSON.parse(raw) as DocsetDb;
  put(dbCache, slug, db);
  return db;
}

function touch<T>(cache: Map<string, T>, slug: string): T | undefined {
  const value = cache.get(slug);
  if (value !== undefined) {
    cache.delete(slug);
    cache.set(slug, value);
  }
  return value;
}

function put<T>(cache: Map<string, T>, slug: string, value: T): void {
  cache.set(slug, value);
  while (cache.size > LRU_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
