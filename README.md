# devdocs-mcp

An MCP (stdio) server that gives AI agents token-efficient access to
[DevDocs](https://devdocs.io) documentation. Docsets are fetched once as static
JSON from DevDocs' own endpoints, cached locally, and served offline as compact
rows and markdown — no DevDocs fork, no Docker, no browser.

## Install

```sh
pnpm install
pnpm build
```

Node 20+ required (uses global `fetch`).

## Register with your harness

All harnesses run the same thing: `node /absolute/path/to/devdocs-mcp/dist/index.js`
over stdio. Substitute your real absolute path below.

### Claude Code

```sh
claude mcp add devdocs -- node /absolute/path/to/devdocs-mcp/dist/index.js
```

Add `--scope user` to register it for all projects instead of the current one.

### Anything that reads an `mcpServers` JSON block

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`),
Cline, Windsurf, VS Code (`.vscode/mcp.json`, under `"servers"`), and most
other MCP clients:

```json
{
  "mcpServers": {
    "devdocs": {
      "command": "node",
      "args": ["/absolute/path/to/devdocs-mcp/dist/index.js"]
    }
  }
}
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.devdocs]
command = "node"
args = ["/absolute/path/to/devdocs-mcp/dist/index.js"]
```

### DeepSeek Harness (dsh)

dsh has no built-in MCP support — it comes from the official bridge plugin,
one plugin instance per MCP server, wired per profile (`headless`, `web`,
`tui`):

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-mcp-client@0.0.1-rc.1
```

(The `declares no dsh.bundle — installed as a plain dependency` warning is
normal; it means manual wiring is required.) Then add an **insert block** to
`$DSH_HOME/profiles/headless/cordis.patch.yml` — a bare `- id:` row would be
treated as an override of an existing entry and fail:

```yaml
- insert:
    - id: mcp-devdocs
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: devdocs
        transport: stdio
        command: node
        args: ["/absolute/path/to/devdocs-mcp/dist/index.js"]
        # failOnStartupError: true   # enable while debugging: loud failures
```

Verify with `dsh --profile headless --dump-config | grep -A6 mcp-devdocs`,
then a live probe (dsh startup failures are silent by default):

```sh
dsh --profile headless "use the devdocs list_docsets tool; if no devdocs tools are available say NO-TOOLS"
```

Tools appear to the model as `mcp__devdocs__<tool>` in dsh and Claude Code.

## Tools

| Tool | Arguments | What it returns |
|------|-----------|-----------------|
| `list_docsets` | `installed?=true`, `filter?` | Cached docsets (`slug name release`), or catalog matches when `installed=false` (requires `filter`, capped at 30) |
| `install_docset` | `slug` | Downloads `index.json` + `db.json` into the cache; re-downloads only when upstream is newer |
| `remove_docset` | `slug` | Deletes that docset from the cache |
| `search` | `query`, `docsets?`, `limit?=20` | Fuzzy entry-name matches as `slug<TAB>type<TAB>name<TAB>path` rows |
| `read` | `docset`, `path`, `offset?=0` | Page as markdown. `path#anchor` returns just that section. Output is capped at ~8000 chars with a `offset=<N>` continuation hint |
| `toc` | `docset`, `path` | Heading outline as `h2<TAB>Title<TAB>#anchor` rows — pick a section, then `read` `path#anchor` |

Typical flow: `list_docsets {installed:false, filter:"vite"}` →
`install_docset {slug:"vite"}` → `search {query:"defineConfig"}` →
`toc` / `read` with the path from the search rows.

## Teaching agents to use it (AGENTS.md / CLAUDE.md)

The tools are self-describing, but agents won't form the *habit* of checking
DevDocs on their own. Paste this into your project's `AGENTS.md` / `CLAUDE.md`
(or your global one), and edit the docset list for your stack:

```markdown
## Documentation lookup (devdocs MCP)

Before writing code against a library or API you haven't recently worked
with, check its documentation via the `devdocs` MCP tools — don't guess
from memory and don't reach for web search first. The docs are local,
offline, and current.

- One-time per docset: `install_docset` (find slugs with
  `list_docsets {installed: false, filter: "..."}`). This project uses:
  `typescript`, `react`, `vite`, `node`.
- Lookup flow: `search {query}` → pick a row → `toc {docset, path}` →
  `read {docset, path: "page#anchor"}` for just the section you need.
  Read whole pages only when short; follow `offset` hints to continue.
- If `search` misses, try a shorter query or the docset's own naming
  (e.g. "shared options" rather than "defineConfig options").
```

## Cache

`~/.cache/devdocs-mcp/` by default, overridable with `DEVDOCS_CACHE_DIR`:

```
docs.json          # DevDocs manifest, refreshed when older than 24h
<slug>/index.json  # entry list
<slug>/db.json     # page path -> HTML
<slug>/meta.json   # {slug, name, release, mtime, installedAt}
```

The cache is shared across sessions; delete a `<slug>/` directory (or call
`remove_docset`) to reclaim space.

## Development

```sh
pnpm test    # vitest, fully offline (fixtures only)
pnpm build   # tsc -> dist/
pnpm smoke   # live: spawns dist/index.js, installs vite, searches/reads/tocs
```

Unit tests cover the pure modules (`search`, `render`, path handling); the six
tool handlers are thin wiring over those and are exercised end-to-end by the
smoke script instead.

## Credits

Documentation content comes from [DevDocs](https://devdocs.io) (maintained by
freeCodeCamp), which aggregates and re-publishes the documentation of each
upstream project. This server only fetches and reformats it: all content
remains under the license and copyright of its respective upstream project, and
each docset's attribution is included in the DevDocs manifest.
