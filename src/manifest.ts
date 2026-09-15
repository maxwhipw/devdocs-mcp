// DevDocs manifest (docs.json) fetch + cache.
//
// https://devdocs.io/docs.json 302-redirects and requires a User-Agent header,
// so both are set explicitly here. The manifest is cached on disk and reused
// for MAX_AGE_MS; a stale cache is still returned if the network fetch fails.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cacheDir, manifestPath } from "./paths.js";

export const USER_AGENT = "devdocs-mcp/0.1";
const MANIFEST_URL = "https://devdocs.io/docs.json";
const DOCUMENTS_BASE = "https://documents.devdocs.io";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ManifestEntry {
  name: string;
  slug: string;
  type: string;
  version?: string;
  release?: string;
  mtime: number;
  db_size?: number;
  attribution?: string;
  alias?: string | null;
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function docsetUrl(slug: string, file: "index.json" | "db.json"): string {
  return `${DOCUMENTS_BASE}/${slug}/${file}`;
}

/** Cached manifest, refreshed when older than 24h (or when force=true). */
export async function getManifest(force = false): Promise<ManifestEntry[]> {
  const path = manifestPath();
  if (!force) {
    const cached = await readCachedManifest(path);
    if (cached) return cached;
  }
  try {
    const data = await fetchJson(MANIFEST_URL);
    if (!Array.isArray(data)) throw new Error("docs.json is not an array");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data), "utf8");
    return data as ManifestEntry[];
  } catch (err) {
    // Fall back to a stale cache rather than failing outright.
    const stale = await readCachedManifest(path, true);
    if (stale) return stale;
    throw new Error(
      `Could not fetch the DevDocs manifest (${MANIFEST_URL}) and no cached copy exists in ${cacheDir()}: ${String(err)}`,
    );
  }
}

async function readCachedManifest(
  path: string,
  allowStale = false,
): Promise<ManifestEntry[] | null> {
  try {
    const info = await stat(path);
    if (!allowStale && Date.now() - info.mtimeMs > MAX_AGE_MS) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : null;
  } catch {
    return null;
  }
}

export function findManifestEntry(
  manifest: ManifestEntry[],
  slug: string,
): ManifestEntry | undefined {
  return manifest.find((e) => e.slug === slug || e.alias === slug);
}

/** Slugs whose name/slug contains the (lowercased) filter, shortest first. */
export function searchManifest(
  manifest: ManifestEntry[],
  filter: string,
): ManifestEntry[] {
  const q = filter.toLowerCase();
  return manifest
    .filter(
      (e) =>
        e.slug.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
    )
    .sort((a, b) => a.slug.length - b.slug.length || a.slug.localeCompare(b.slug));
}
