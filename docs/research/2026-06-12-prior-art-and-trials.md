# Research log: prior art, usage mining, MCPShim trial

Date: 2026-06-12. Evidence behind ADRs 0001–0004.

## Prior art

Crowded: generic "MCP tools as shell commands" bridges (MCPShim,
philschmid/mcp-cli, f/mcptools, ThomasRohde/mcp-cli) and the inverse
(CLIs wrapped as MCP servers). **Empty**: nobody builds CLIs designed for
agent ergonomics backed by MCP; nobody mimics existing CLI interfaces either.

## Agent `gh` usage histogram (185 local pi session folders)

Top: `pr view` 436, **`api` 418**, `pr create` 292, `pr edit` 220,
`pr checks` 143, `run view` 88, `pr merge` 67, `run list` 66, `pr list` 62,
`pr comment` 44, `issue create/view/list` ~82, `run watch` 24, `pr close` 19,
`auth status` 15. Long tail thereafter; `pr checkout` once.

The ~17 high-traffic commands are the design target.

### `gh api` breakdown (~418 calls)

- 166 (~40%): **remote repo browsing** (file contents, commits, tags, refs) —
  undesirable pattern; should be redirected to local clone.
- 40: **PR inline review comments** — a real gh gap (cli/cli#5788, #11477:
  no subcommand returns them). GitHub MCP covers it better:
  `pull_request_read --method get_review_comments` returns *threaded*
  comments with `isResolved`/`isOutdated`; `resolve_review_thread` exists
  for writes (no gh equivalent at all).
- Rest: issues/PR CRUD (mappable), repo meta/stats, graphql, misc.

## MCPShim trial (against GitHub's official remote MCP)

Setup: `mcpshimd` + GitHub remote MCP at `https://api.githubcopilot.com/mcp/`
with a PAT (`gh auth token`). Worked in ~10 min; 44 tools; full PR workflow
incl. review threads; bash-composable.

Frictions (inherent to the stack, not MCPShim bugs):
1. MCP content envelope leaks: every result needs
   `jq -r '.result.content[0].text | fromjson'`.
2. Raw API-sized payloads; no output curation → high token cost per call.
3. One-time discovery cost (~44 tool schemas) without a skill file.

Rejected MCPShim itself: very new (v0.0.1, 61 stars), **no license**,
daemon+SQLite felt heavy for the need. But the trial proved the
direct-MCP-from-bash model works, and sharpened what's missing: ergonomics.

## ContextForge auth capabilities (verified in IBM/mcp-context-forge)

Two separate layers: client→gateway JWT/API tokens with RBAC scoping;
gateway→upstream per-user OAuth (auth-code + PKCE, DCR, tokens encrypted per
`(gateway, app_user_email)`, auto-refresh). Gaps noted upstream: no admin
UI for token revocation, cleanup not scheduled.

## Runtime CLI generators vs. hand-built porcelain (naming context)

`knowsuchagency/mcp2cli` and similar (`mcp-cli`, `mcpli`) generate a CLI
surface mechanically from a server's tool schemas at runtime. That inherits
the raw tool surface wholesale — exactly the payload/ergonomics problem the
MCPShim trial exposed above. `mcpeel` is the opposite stance: every command
is hand-cut from session data, curated for tokens-per-task. This is the
crisp README differentiator ("not a runtime generator"). Name chosen:
**mcpeel** ("MCP peel" — a thin hand-cut layer; porcelain for MCP plumbing).
Faint MCPE (Minecraft Pocket Edition) misread risk noted and accepted.
