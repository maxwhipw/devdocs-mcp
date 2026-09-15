// HTML -> markdown rendering, #fragment extraction, table of contents and
// pagination. Pure functions over HTML strings: no cache or network access, so
// everything here is unit testable with small fixtures.
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** Max markdown characters returned by a single `read` call. */
export const PAGE_CHARS = 8000;

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.use(gfm);

// DevDocs code blocks are `<pre class="language-js">` without a nested <code>,
// which turndown's built-in fenced rule does not cover.
turndown.addRule("devdocsPre", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node) => {
    const el = node as unknown as {
      textContent: string | null;
      getAttribute(name: string): string | null;
      parentElement: { getAttribute(name: string): string | null } | null;
    };
    const text = (el.textContent ?? "").replace(/\n+$/, "");
    const lang =
      el.getAttribute("data-language") ??
      langFromClass(el.getAttribute("class")) ??
      langFromClass(el.parentElement?.getAttribute("class") ?? null) ??
      "";
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
  },
});

function langFromClass(cls: string | null): string | null {
  const m = cls?.match(/(?:language|lang)-([\w+-]+)/);
  return m ? m[1]! : null;
}

/**
 * Convert a DevDocs page (or a fragment of one) to markdown.
 * `pagePath` is used to rewrite relative links into `path#fragment` hints that
 * an agent can feed straight back into the `read` tool.
 */
export function htmlToMarkdown(html: string, pagePath = ""): string {
  const $ = cheerio.load(html, null, false);
  $("script, style, [hidden]").remove();
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const rewritten = rewriteHref(href, pagePath);
    if (rewritten === null) $(el).removeAttr("href");
    else $(el).attr("href", rewritten);
  });
  const md = turndown.turndown($.html());
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Relative doc links become docset-relative paths; same-page `#anchor` links
 * become `pagePath#anchor`; external links are kept; anything else (mailto:,
 * javascript:) loses its href.
 */
export function rewriteHref(href: string, pagePath: string): string | null {
  if (/^(https?:)?\/\//i.test(href)) return href;
  if (href.startsWith("#")) {
    return pagePath ? `${stripFragment(pagePath)}${href}` : href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return resolveDocPath(stripFragment(pagePath), href);
}

/** Resolve a relative DevDocs path against the current page path. */
export function resolveDocPath(pagePath: string, href: string): string {
  const [rel, ...fragParts] = href.split("#");
  const frag = fragParts.length > 0 ? `#${fragParts.join("#")}` : "";
  const base = pagePath.includes("/")
    ? pagePath.slice(0, pagePath.lastIndexOf("/")).split("/")
    : [];
  const segments = rel!.startsWith("/") ? [] : base.slice();
  for (const part of rel!.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `${segments.join("/")}${frag}`;
}

export function stripFragment(path: string): string {
  const i = path.indexOf("#");
  return i === -1 ? path : path.slice(0, i);
}

export function fragmentOf(path: string): string | null {
  const i = path.indexOf("#");
  return i === -1 ? null : path.slice(i + 1);
}

/**
 * Extract the section of `html` identified by `id`: the element with that id
 * (or its enclosing heading) up to the next heading of the same or higher
 * level. Returns null when the id is not present.
 */
export function extractFragment(html: string, id: string): string | null {
  const $ = cheerio.load(html, null, false);
  const target = $(`[id=${JSON.stringify(id)}]`).first();
  if (target.length === 0) return null;

  const heading = headingLevel(tagOf(target.get(0)))
    ? target
    : target.closest("h1, h2, h3, h4, h5, h6");
  const start = heading.length > 0 ? heading : target;
  const level = headingLevel(tagOf(start.get(0)));
  if (level === null) return $.html(start);

  const parts = [$.html(start)];
  let node = start.next();
  while (node.length > 0) {
    const lvl = headingLevel(tagOf(node.get(0)));
    if (lvl !== null && lvl <= level) break;
    parts.push($.html(node));
    node = node.next();
  }
  return parts.join("\n");
}

function tagOf(node: unknown): string | undefined {
  return (node as { tagName?: string } | undefined)?.tagName;
}

function headingLevel(tagName: string | undefined): number | null {
  const m = tagName?.toLowerCase().match(/^h([1-6])$/);
  return m ? Number(m[1]) : null;
}

export interface TocEntry {
  level: number;
  title: string;
  anchor: string | null;
}

export function tableOfContents(html: string): TocEntry[] {
  const $ = cheerio.load(html, null, false);
  $("script, style, [hidden]").remove();
  const out: TocEntry[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_i, el) => {
    const node = $(el);
    const level = headingLevel(el.tagName) ?? 1;
    const title = node.text().replace(/\s+/g, " ").trim();
    if (title === "") return;
    const anchor = node.attr("id") ?? node.find("[id]").first().attr("id") ?? null;
    out.push({ level, title, anchor });
  });
  return out;
}

/** Compact one-line rows: `h2  Heading Title  #anchor`. */
export function formatToc(entries: TocEntry[]): string {
  return entries
    .map((e) => `h${e.level}\t${e.title}\t${e.anchor ? `#${e.anchor}` : "-"}`)
    .join("\n");
}

export interface Page {
  text: string;
  nextOffset: number | null;
  total: number;
}

/**
 * Slice `markdown` starting at `offset`, capped at PAGE_CHARS and cut on a line
 * boundary where possible. `nextOffset` is null when the tail was returned.
 */
export function paginate(markdown: string, offset: number, limit = PAGE_CHARS): Page {
  const total = markdown.length;
  const start = Math.min(Math.max(0, Math.trunc(offset)), total);
  const rest = markdown.slice(start);
  if (rest.length <= limit) {
    return { text: rest, nextOffset: null, total };
  }
  let cut = rest.lastIndexOf("\n", limit);
  if (cut < limit / 2) cut = limit;
  return { text: rest.slice(0, cut), nextOffset: start + cut, total };
}
