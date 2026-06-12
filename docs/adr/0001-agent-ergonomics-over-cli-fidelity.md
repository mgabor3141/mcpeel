# ADR 0001: Agent-ergonomics CLIs, not faithful CLI clones

Date: 2026-06-12 · Status: accepted

## Context

The original concept was a drop-in `gh` replacement that calls the GitHub MCP
instead of the API — transparent to agents, while gaining MCP-gateway auth and
filtering. Research (see [research log](../research/2026-06-12-prior-art-and-trials.md))
killed this premise:

- Real session data shows ~20% of agent `gh` usage is `gh api` — agents route
  *around* gh's interface because it has gaps (e.g. inline review comments are
  not retrievable via any gh subcommand; cli/cli#5788, #11477).
- The GitHub MCP fills those gaps but returns huge raw payloads in a
  double-encoded envelope — hostile to context budgets.
- Faithful mimicry inherits gh's weaknesses; the most valuable design moments
  all *broke* fidelity.

## Decision

Each shim is a CLI that calls an MCP, **designed for agent ergonomics**, not
for fidelity to any existing CLI or to the MCP tool surface:

- Own name and vocabulary (no PATH-shadowing of real CLIs).
- Curated, token-economical output; field selection by default.
- Errors are agent-facing prompt engineering: they teach the correct next
  action (e.g. "clone the repo and inspect locally" instead of remote browsing).
- Command set driven by measured agent usage, not upstream's command tree.
- Each CLI ships with a short skill file; that replaces trained familiarity.

Success metric: tokens-per-task and turns-to-success.

## Consequences

- We own an interface design per CLI; no upstream to defer to.
- Session mining (usage histograms) becomes the standard design input.
- Unmappable/redirected operations need argv-aware handlers with curated
  messages.
