# ADR 0004: Gateway owns OAuth; shims hold one gateway credential

Date: 2026-06-12 · Status: accepted

## Context

Target deployments: (a) personal — agent in a devcontainer with one API key
to a self-hosted gateway; (b) company — shared gateway, per-user upstream
OAuth. Upstream tokens must never enter the agent container, or the agent can
bypass gateway filtering.

Verified: IBM ContextForge natively supports this split — gateway-issued
JWT/API tokens for clients (RBAC-scoped), and per-user upstream OAuth
(auth-code + PKCE, DCR, encrypted per `(gateway, user)` storage, auto-refresh).
The OAuth consent flow happens in a browser against the gateway, outside the
container.

## Decision

- Shims speak MCP to a URL with a static-ish bearer token sourced from an env
  var or a command. Nothing else.
- No OAuth flows in the shims (agent containers have no browser anyway).
- Token injection for gateways without token exchange, and container egress
  lockdown, are explicitly out of scope — a future companion project
  (host-side auth-injecting sidecar + ready-to-go containerized setup).

## Consequences

- Both target deployments work with core config alone when the gateway is
  ContextForge (or equivalent).
- Direct-to-upstream MCP without a gateway is supported but gets no
  credential-hiding guarantees.
