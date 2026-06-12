# ADR 0002: Shims are portable TypeScript; runtime is the agent's problem

Date: 2026-06-12 · Status: accepted (amended same day: was "pinned Bun,
shipped by installer" — superseded along with the installer, see ADR 0005)

## Context

Shim logic is mostly mapping tables plus genuinely procedural edge cases. A
declarative DSL with escape hatches was considered and rejected — one
consistent code layer beats two layers. Contribution friction is existential:
users must be able to edit a shim in place and re-run it with no build step.

Originally we planned to ship a pinned Bun via an installer for determinism.
With distribution as a skills repo (ADR 0005), the executor is an agent:
"runtime missing" is a recoverable in-session event, not a support ticket.

## Decision

- Shims are plain `.ts` files executed directly; a shared helper module
  provides command definition, flag parsing, and the error taxonomy, so a
  shim reads mostly like a table.
- **No shipped runtime.** The meta-skill suggests bun (preferred) or node
  with native type-stripping; startup failures must be loud and tell the
  agent/user the fix.
- **Portable by construction**: no Bun-only APIs, and **zero npm
  dependencies** — MCP-over-streamable-HTTP is a small hand-rolled
  `fetch` + JSON-RPC client, so no install step exists at all.
- CI tests on both bun and node.

## Consequences

- Edit → re-run → PR loop with zero toolchain beyond a TS-capable runtime.
- We forgo the official MCP SDK; the client speaks only the slice of the
  protocol the shims need (initialize, tools/call).
