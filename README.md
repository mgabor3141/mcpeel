# mcpeel

Porcelain for MCP plumbing: hand-built, token-frugal CLIs for agents.

A thin, hand-cut layer over the raw MCP tool surface. Unlike runtime CLI
generators (e.g. `mcp2cli`), every command here is hand-written and
opinionated — shaped from real agent session data, not mechanically
mirrored from tool schemas.

Each skill in `skills/` ships a small, opinionated CLI that talks to an MCP
endpoint (ideally an MCP gateway like ContextForge, so auth, filtering, and
audit live server-side). The CLIs are **not** clones of existing tools —
they are designed from real agent session data for agent ergonomics:

- the most common question is the shortest command (`github pr 123` returns
  metadata + checks + review state + comments in one ~250-token digest)
- errors teach the correct next action instead of just failing
- operations better done locally (browsing repo contents) are refused with
  a redirect to `git clone`
- `--since <commit>` / `--wait` turn "push and poll for feedback" into a
  single blocking call

```sh
git push && github pr --since $(git rev-parse --short HEAD) --wait
```

## Status

Early. The full `github` vocabulary is implemented and verified against the
GitHub remote MCP on bun and node: pr digest with `--since`/`--wait`,
prs/issues/runs (failed-job log tails inline), threads/resolve, writes
(create/edit/comment/merge/close), whoami. Design:
[docs/design/github.md](docs/design/github.md).

## Install

Point your agent at `skills/mcpeel/SKILL.md` — setup is agent-driven.
Requirements: bun (or node ≥22.18) and env vars for your MCP endpoint
(`MCP_GATEWAY_URL`, `MCP_GATEWAY_TOKEN`).

Primarily built for skill-aware agent harnesses; the CLIs also work as
plain scripts anywhere.

## Design

Decisions: [docs/adr/](docs/adr/) · Evidence: [docs/research/](docs/research/)

Contributions must show their work: the observed agent problem (ideally a
session excerpt) and verification of the improvement. The metric is
tokens-per-task and turns-to-success.

## License

Apache-2.0
