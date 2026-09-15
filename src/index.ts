#!/usr/bin/env node
/**
 * devdocs-mcp — MCP (stdio) server exposing DevDocs docsets to agents.
 *
 * Data flow
 * ---------
 * devdocs.io/docs.json ──fetch (redirect + User-Agent)──> manifest.ts
 *        │                                                    │
 *        │  install_docset(slug)                              ├─> cache/docs.json
 *        ▼                                                    │
 * documents.devdocs.io/<slug>/{index.json,db.json} ──docsets.ts──> cache/<slug>/
 *                                                              (+ meta.json)
 *
 * Query side (all offline, reading the cache):
 *   search  -> docsets.loadIndex(slug) -> search.searchEntries -> `slug type name path` rows
 *   toc     -> docsets.loadDb(slug)    -> render.tableOfContents -> `h2 Title #anchor` rows
 *   read    -> docsets.loadDb(slug)    -> render.extractFragment (when path has #frag)
 *                                      -> render.htmlToMarkdown -> render.paginate -> markdown
 *
 * index.json/db.json stay in a 3-entry LRU in docsets.ts, so repeated
 * search/read calls in a session touch the disk once per docset.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  installDocset,
  listInstalled,
  loadDb,
  loadIndex,
  readMeta,
  removeDocset,
} from "./docsets.js";
import { findManifestEntry, getManifest, searchManifest } from "./manifest.js";
import { cacheDir } from "./paths.js";
import {
  extractFragment,
  formatToc,
  fragmentOf,
  htmlToMarkdown,
  paginate,
  stripFragment,
  tableOfContents,
} from "./render.js";
import { formatHits, nearestPaths, searchEntries } from "./search.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Turns thrown errors into MCP tool errors instead of crashing the server. */
function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

const server = new McpServer(
  { name: "devdocs-mcp", version: "0.1.0" },
  {
    instructions:
      "Offline-cached DevDocs documentation. Use list_docsets to see what is " +
      "cached, install_docset to add one, search to find entries, toc to see a " +
      "page outline, and read to get markdown (pass path#anchor to read one section).",
  },
);

server.registerTool(
  "list_docsets",
  {
    title: "List docsets",
    description:
      "List installed (cached) docsets, or search the DevDocs catalog for installable ones (installed=false requires filter).",
    inputSchema: {
      installed: z
        .boolean()
        .default(true)
        .describe("true: cached docsets. false: search the DevDocs catalog."),
      filter: z.string().optional().describe("Substring match on slug or name."),
    },
  },
  guard(async ({ installed, filter }) => {
    if (installed) {
      const metas = await listInstalled();
      const q = filter?.toLowerCase();
      const rows = metas
        .filter(
          (m) =>
            !q ||
            m.slug.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q),
        )
        .map((m) => `${m.slug}\t${m.name}\t${m.release ?? "-"}`);
      if (rows.length === 0) {
        return ok(
          `No installed docsets${q ? ` matching "${filter}"` : ""} in ${cacheDir()}. Use list_docsets with installed=false and a filter to find one, then install_docset.`,
        );
      }
      return ok(`slug\tname\trelease\n${rows.join("\n")}`);
    }

    if (!filter || filter.trim() === "") {
      return fail(
        "filter is required when installed=false (the catalog has 800+ docsets).",
      );
    }
    const manifest = await getManifest();
    const matches = searchManifest(manifest, filter.trim());
    if (matches.length === 0) return ok(`No catalog docsets match "${filter}".`);
    const rows = matches
      .slice(0, 30)
      .map((m) => `${m.slug}\t${m.name}\t${m.release ?? "-"}`);
    const more =
      matches.length > 30
        ? `\n[${matches.length - 30} more — use a narrower filter]`
        : "";
    return ok(`slug\tname\trelease\n${rows.join("\n")}${more}`);
  }),
);

server.registerTool(
  "install_docset",
  {
    title: "Install docset",
    description:
      "Download a DevDocs docset into the local cache (re-downloads only if upstream is newer).",
    inputSchema: { slug: z.string().describe("Docset slug, e.g. 'vite'.") },
  },
  guard(async ({ slug }) => {
    const manifest = await getManifest();
    const entry = findManifestEntry(manifest, slug);
    if (!entry) {
      const near = searchManifest(manifest, slug)
        .slice(0, 5)
        .map((m) => m.slug);
      return fail(
        `Unknown docset "${slug}".${near.length ? ` Did you mean: ${near.join(", ")}?` : " Use list_docsets with installed=false to search the catalog."}`,
      );
    }
    const result = await installDocset(entry);
    const what = `${result.meta.slug} (${result.meta.name} ${result.meta.release ?? ""})`.trim();
    const stats = `${result.entries} entries, ${result.pages} pages`;
    if (result.status === "up-to-date") {
      return ok(`${what} already up to date — ${stats}.`);
    }
    return ok(`${result.status} ${what} — ${stats}. Cache: ${cacheDir()}`);
  }),
);

server.registerTool(
  "remove_docset",
  {
    title: "Remove docset",
    description: "Delete a docset from the local cache.",
    inputSchema: { slug: z.string().describe("Docset slug, e.g. 'vite'.") },
  },
  guard(async ({ slug }) => {
    const removed = await removeDocset(slug);
    return removed
      ? ok(`Removed ${slug}.`)
      : fail(`${slug} is not installed — nothing removed.`);
  }),
);

server.registerTool(
  "search",
  {
    title: "Search docsets",
    description:
      "Fuzzy search entry names across installed docsets. Returns compact rows: slug, type, name, path. Feed a path to read/toc.",
    inputSchema: {
      query: z.string().describe("Entry name to look for, e.g. 'defineConfig'."),
      docsets: z
        .array(z.string())
        .optional()
        .describe("Limit to these slugs (default: all installed)."),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  guard(async ({ query, docsets, limit }) => {
    const installedSlugs = (await listInstalled()).map((m) => m.slug);
    if (installedSlugs.length === 0) {
      return fail(
        `No docsets installed in ${cacheDir()}. Install one first with install_docset.`,
      );
    }
    const wanted = docsets?.length ? docsets : installedSlugs;
    const missing = wanted.filter((s) => !installedSlugs.includes(s));
    if (missing.length > 0) {
      return fail(
        `Not installed: ${missing.join(", ")}. Installed: ${installedSlugs.join(", ")}.`,
      );
    }
    const loaded = [];
    for (const slug of wanted) {
      loaded.push({ slug, entries: (await loadIndex(slug)).entries });
    }
    const hits = searchEntries(loaded, query, limit);
    if (hits.length === 0) {
      return ok(
        `No matches for "${query}" in: ${wanted.join(", ")}. Try a shorter query or another docset.`,
      );
    }
    const more =
      hits.length === limit
        ? `\n[showing ${limit} — call search again with a higher limit for more]`
        : "";
    return ok(`slug\ttype\tname\tpath\n${formatHits(hits)}${more}`);
  }),
);

server.registerTool(
  "read",
  {
    title: "Read page",
    description:
      "Read a docset page as markdown. Append #anchor to the path to get just that section. Long pages paginate via offset.",
    inputSchema: {
      docset: z.string().describe("Docset slug, e.g. 'vite'."),
      path: z
        .string()
        .describe("Page path from search/toc, optionally with #anchor."),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Character offset into the markdown (from a truncation hint)."),
    },
  },
  guard(async ({ docset, path, offset }) => {
    const db = await requireDb(docset);
    if (typeof db === "string") return fail(db);
    const key = stripFragment(path);
    const html = db[key];
    if (html === undefined) {
      const near = nearestPaths(Object.keys(db), key);
      return fail(
        `Unknown path "${key}" in ${docset}. Nearest paths: ${near.join(", ")}. Use search to find a path.`,
      );
    }

    const fragment = fragmentOf(path);
    let source = html;
    if (fragment) {
      const section = extractFragment(html, fragment);
      if (section === null) {
        const anchors = tableOfContents(html)
          .map((e) => e.anchor)
          .filter((a): a is string => a !== null)
          .slice(0, 20);
        return fail(
          `No element with id "${fragment}" on ${docset}/${key}. Anchors: ${anchors.length ? anchors.map((a) => `#${a}`).join(" ") : "(none)"}. Call toc for the full outline.`,
        );
      }
      source = section;
    }

    const markdown = htmlToMarkdown(source, key);
    if (markdown.trim() === "") {
      return ok(`(empty page: ${docset}/${path})`);
    }
    const page = paginate(markdown, offset);
    if (page.text === "" ) {
      return fail(
        `offset ${offset} is past the end of ${docset}/${path} (${page.total} chars).`,
      );
    }
    const hint =
      page.nextOffset !== null
        ? `\n\n[truncated — call read again with offset=${page.nextOffset} for more (${page.total} chars total)]`
        : "";
    return ok(page.text + hint);
  }),
);

server.registerTool(
  "toc",
  {
    title: "Page outline",
    description:
      "Heading outline of a page: level, title, anchor. Pick a section and read path#anchor instead of paging the whole page.",
    inputSchema: {
      docset: z.string().describe("Docset slug, e.g. 'vite'."),
      path: z.string().describe("Page path (any #anchor is ignored)."),
    },
  },
  guard(async ({ docset, path }) => {
    const db = await requireDb(docset);
    if (typeof db === "string") return fail(db);
    const key = stripFragment(path);
    const html = db[key];
    if (html === undefined) {
      const near = nearestPaths(Object.keys(db), key);
      return fail(
        `Unknown path "${key}" in ${docset}. Nearest paths: ${near.join(", ")}.`,
      );
    }
    const entries = tableOfContents(html);
    if (entries.length === 0) {
      return ok(`No headings on ${docset}/${key} — read it directly.`);
    }
    return ok(
      `level\ttitle\tanchor (read "${key}#anchor" for one section)\n${formatToc(entries)}`,
    );
  }),
);

/** Returns the db, or an error message string when the docset is not installed. */
async function requireDb(slug: string): Promise<Record<string, string> | string> {
  const meta = await readMeta(slug);
  if (!meta) {
    const installed = (await listInstalled()).map((m) => m.slug);
    return `Docset "${slug}" is not installed. Installed: ${installed.length ? installed.join(", ") : "(none)"}. Use install_docset.`;
  }
  return loadDb(slug);
}

const transport = new StdioServerTransport();
await server.connect(transport);
