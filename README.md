# mcpeel

Porcelain for MCP plumbing: hand-built, token-frugal CLIs for agents.

The MCP ecosystem is exploding — there's now a server for almost everything,
and MCP gateways (like ContextForge) put auth, per-user OAuth, permissions,
and audit in one place, server-side. That's a huge amount of capability an
agent could safely reach.

The catch: raw MCP tools are built for *machines wiring systems together*,
not for an agent working a task. Their schemas are sprawling, their payloads
are API-sized, and a single question often takes several calls — so they
burn context fast and add turns. Pointing an agent straight at a big tool
surface is expensive and error-prone.

`mcpeel` is the thin, hand-cut layer in between. Each CLI talks to an MCP
endpoint (ideally a gateway, so credentials never enter the agent's
environment) and exposes a small, opinionated command surface designed from
real agent session data — so the agent gets the ecosystem's reach **safely**
(auth and permissions stay server-side) and **context-efficiently** (the
common question is one short command and a ~250-token answer).

Unlike runtime CLI generators (e.g. `mcp2cli`) that mechanically mirror tool
schemas — inheriting all the bloat — every command here is hand-written and
curated for tokens-per-task and turns-to-success.

What that looks like in practice:

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
