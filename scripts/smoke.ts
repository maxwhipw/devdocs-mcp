/**
 * Live smoke test — hits the network and the real cache.
 *
 * Spawns the built server (dist/index.js) over stdio with the MCP SDK client,
 * so it exercises the full path: initialize -> tools/list -> tools/call.
 *
 *   pnpm build && pnpm smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
    .join("\n");
}

function section(title: string, body: string, maxChars = 1200): void {
  console.log(`\n===== ${title} =====`);
  console.log(body.length > maxChars ? `${body.slice(0, maxChars)}\n…[cut for smoke output]` : body);
}

const client = new Client({ name: "devdocs-mcp-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) {
    console.error(`\n!! tool ${name} returned an error:\n${textOf(res)}`);
  }
  return textOf(res);
};

try {
  const { tools } = await client.listTools();
  section("tools/list", tools.map((t) => t.name).join(", "));
  if (tools.length !== 6) throw new Error(`expected 6 tools, got ${tools.length}`);

  section("install_docset vite", await call("install_docset", { slug: "vite" }));
  section("list_docsets (installed)", await call("list_docsets", {}));
  section(
    "list_docsets (catalog, filter=vite)",
    await call("list_docsets", { installed: false, filter: "vite" }),
  );

  const hits = await call("search", { query: "defineConfig", docsets: ["vite"], limit: 10 });
  section("search defineConfig", hits);

  const firstPath = hits.split("\n")[1]?.split("\t")[3];
  if (!firstPath) throw new Error("search returned no usable path");

  const page = firstPath.split("#")[0]!;
  section(`read ${page}`, await call("read", { docset: "vite", path: page }), 1500);
  section(`toc ${page}`, await call("toc", { docset: "vite", path: page }));
  section(
    `read ${firstPath} (fragment)`,
    await call("read", { docset: "vite", path: firstPath }),
  );
  section(
    "read config/index#config-intellisense (fragment)",
    await call("read", { docset: "vite", path: "config/index#config-intellisense" }),
  );
  // Pagination: find a page long enough to be truncated, then follow the hint.
  let paged: { path: string; offset: number } | null = null;
  for (const candidate of [page, "guide/api-plugin", "config/server-options", "guide/features"]) {
    const first = await call("read", { docset: "vite", path: candidate });
    const next = first.match(/offset=(\d+)/);
    if (next) {
      paged = { path: candidate, offset: Number(next[1]) };
      section(`read ${candidate} — end of page 1`, first.slice(-300));
      break;
    }
  }
  if (paged) {
    section(
      `read ${paged.path} offset=${paged.offset} (page 2)`,
      await call("read", { docset: "vite", path: paged.path, offset: paged.offset }),
      500,
    );
  } else {
    console.log("\n[no vite page exceeded the pagination cap — pagination not exercised]");
  }
  section("read bad path (error)", await call("read", { docset: "vite", path: "no/such/page" }), 400);

  console.log("\nsmoke: OK");
} finally {
  await client.close();
}
