# ADR 0003: Opinionated by design; config is env vars only

Date: 2026-06-12 · Status: accepted (amended same day: env vars replace config file)

## Context

An agent-ergonomics CLI is opinionated by nature (vocabulary, output shape,
redirect messages). Making opinions configurable explodes scope: config
schema, docs, and a combinatorial test matrix.

## Decision

- Total config surface per CLI: MCP **endpoint** + **auth token**, read from
  env vars only — `<TOOL>_MCP_URL`/`<TOOL>_MCP_TOKEN`, falling back to
  `MCP_GATEWAY_URL`/`MCP_GATEWAY_TOKEN`. No config file: the target audience
  already manages env (direnv, devcontainers, agent shellCommandPrefix), and
  a config file means owning precedence, parsing, and discovery docs.
- **No tool filtering in the shims** — filtering is the MCP gateway's job
  (ContextForge et al.); duplicating it client-side undermines the
  architecture. A gateway denial surfaces as a relayed, legible error.
- **No message/behavior config.** Customization mechanism = the editable
  TypeScript source (ADR 0002). Fork or edit in place; local edits are the
  contribution funnel.

## Consequences

- README sentence instead of a config chapter: "These tools are opinionated.
  Fork them — they're designed to be forked."
- Orgs with different policies maintain small forks of individual shim files.
