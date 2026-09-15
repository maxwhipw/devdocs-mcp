// Cache directory resolution. Default ~/.cache/devdocs-mcp, override with
// DEVDOCS_CACHE_DIR. Read fresh from env each call so tests can point it at a
// temp dir.
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(): string {
  const override = process.env.DEVDOCS_CACHE_DIR;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".cache", "devdocs-mcp");
}

export function manifestPath(): string {
  return join(cacheDir(), "docs.json");
}

export function docsetDir(slug: string): string {
  return join(cacheDir(), slug);
}
