import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractFragment,
  formatToc,
  fragmentOf,
  htmlToMarkdown,
  paginate,
  resolveDocPath,
  rewriteHref,
  stripFragment,
  tableOfContents,
} from "../src/render.js";

const html = readFileSync(
  fileURLToPath(new URL("./fixtures/page.html", import.meta.url)),
  "utf8",
);

describe("fragment extraction", () => {
  it("returns a heading section up to the next same-level heading", () => {
    const section = extractFragment(html, "config-intellisense")!;
    expect(section).toContain("Config Intellisense");
    expect(section).toContain("TypeScript hints"); // deeper heading stays
    expect(section).not.toContain("Async Config"); // next h2 stops it
    expect(section).not.toContain("Configuring Vite"); // earlier h1 excluded
  });

  it("starts at the heading that contains the anchor element", () => {
    const section = extractFragment(html, "async-config")!;
    expect(section).toContain("Async Config");
    expect(section).toContain("export an async function");
    expect(section).not.toContain("Conditional Config");
  });

  it("includes every following deeper section for a top-level heading", () => {
    const section = extractFragment(html, "configuring-vite")!;
    expect(section).toContain("Conditional Config");
  });

  it("returns null for an unknown id", () => {
    expect(extractFragment(html, "nope")).toBeNull();
  });

  it("splits paths into page and fragment", () => {
    expect(stripFragment("config/index#async-config")).toBe("config/index");
    expect(fragmentOf("config/index#async-config")).toBe("async-config");
    expect(fragmentOf("config/index")).toBeNull();
  });
});

describe("toc", () => {
  it("lists headings with levels and anchors, including anchors nested in a heading", () => {
    const lines = formatToc(tableOfContents(html)).split("\n");
    expect(lines).toEqual([
      "h1\tConfiguring Vite\t#configuring-vite",
      "h2\tConfig Intellisense\t#config-intellisense",
      "h3\tTypeScript hints\t#typescript-hints",
      "h2\tAsync Config\t#async-config",
      "h2\tConditional Config\t#conditional-config",
    ]);
  });
});

describe("html to markdown", () => {
  const md = htmlToMarkdown(html, "config/index");

  it("keeps headings, fenced code with a language, and tables", () => {
    expect(md).toContain("# Configuring Vite");
    expect(md).toContain("```javascript\nexport default {\n  // config options\n}\n```");
    expect(md).toContain("| Option | Type |");
    expect(md).toContain("| root | string |");
  });

  it("strips scripts and hidden LLM banners", () => {
    expect(md).not.toContain("should be stripped");
    expect(md).not.toContain("Are you an LLM?");
  });

  it("rewrites intra-docset links to readable paths and keeps external ones", () => {
    expect(md).toContain("[project root](guide/index#project-root)");
    expect(md).toContain("[jsdoc](config/index#async-config)");
    expect(md).toContain("(https://vite.dev/)");
  });
});

describe("link resolution", () => {
  it("resolves relative paths against the page directory", () => {
    expect(resolveDocPath("config/index", "../guide/index#root")).toBe(
      "guide/index#root",
    );
    expect(resolveDocPath("config/index", "shared-options")).toBe(
      "config/shared-options",
    );
    expect(resolveDocPath("index", "guide/build")).toBe("guide/build");
  });

  it("anchors same-page links to the current page and drops odd schemes", () => {
    expect(rewriteHref("#async-config", "config/index#x")).toBe(
      "config/index#async-config",
    );
    expect(rewriteHref("https://vite.dev/", "config/index")).toBe("https://vite.dev/");
    expect(rewriteHref("mailto:a@b.c", "config/index")).toBeNull();
  });
});

describe("pagination", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join(
    "\n",
  );

  it("returns everything when it fits", () => {
    const page = paginate(text, 0, 10_000);
    expect(page.text).toBe(text);
    expect(page.nextOffset).toBeNull();
    expect(page.total).toBe(text.length);
  });

  it("cuts on a line boundary and resumes exactly where it stopped", () => {
    const first = paginate(text, 0, 100);
    expect(first.nextOffset).not.toBeNull();
    expect(first.text.endsWith("\n")).toBe(false);
    expect(text.startsWith(first.text)).toBe(true);
    expect(text[first.nextOffset!]).toBe("\n");

    const second = paginate(text, first.nextOffset!, 10_000);
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBeNull();
  });

  it("hard-cuts when there is no line break in range", () => {
    const blob = "y".repeat(500);
    const page = paginate(blob, 0, 100);
    expect(page.text).toHaveLength(100);
    expect(page.nextOffset).toBe(100);
  });

  it("clamps an offset past the end to an empty tail", () => {
    const page = paginate(text, text.length + 50, 100);
    expect(page.text).toBe("");
    expect(page.nextOffset).toBeNull();
  });
});
