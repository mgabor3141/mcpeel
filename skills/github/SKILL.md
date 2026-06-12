---
name: github
description: >
  Interact with GitHub (PRs, issues, CI runs) via the `github` CLI — an
  MCP-backed, agent-optimized tool. Use whenever a task involves viewing or
  managing pull requests, issues, or workflow runs. Do NOT use it (or any
  remote API) to browse repository contents — clone and inspect locally.
---

# github

A deliberately minimal GitHub CLI backed by an MCP endpoint. It is **not**
the official `gh` — commands and flags differ. When unsure, run
`github --help`; do not guess gh-isms.

## Basics

```sh
github pr            # digest of the PR for the current branch
github pr 123        # digest: metadata, checks (failures first), review state, comments
github pr 123 --full # untruncated body and all comments
github pr 123 --json # raw data
github pr 123 -R owner/repo   # outside a checkout
```

The digest is designed to answer "what's the state and what should I do
next?" in one call. Prefer it over chaining multiple lookups.

## Rules

- Repository contents, commits, file history: **work locally** (clone if
  needed). The CLI refuses these on purpose.
- If a capability is missing, report it to the user — do not retry
  variations or fall back to raw API calls.
- Exit codes: 2 = unsupported/refused, 3 = not configured (user must set
  env vars; see error text).

## Setup (one-time, usually done already)

Requires `GITHUB_MCP_URL` + `GITHUB_MCP_TOKEN` (or `MCP_GATEWAY_URL` +
`MCP_GATEWAY_TOKEN`) in the environment, and bun or node ≥22.18 on PATH.
See the `mcp-cli-ify` skill for installation.
