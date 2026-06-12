---
name: mcp-cli-ify
description: >
  Install, update, and configure the mcp-cli-ify tool CLIs (agent-optimized
  CLIs backed by MCP endpoints, e.g. `github`). Use when setting up these
  tools, fixing their configuration, or contributing improvements.
---

# mcp-cli-ify (meta)

This repo is a collection of skills, each shipping a small CLI that talks to
an MCP endpoint (usually an MCP gateway). The CLIs are opinionated and
designed for agent ergonomics: minimal token cost, one call per question,
errors that say what to do instead.

## Install a tool (e.g. github)

1. Ensure a TS runtime: prefer `bun`; `node` ≥22.18 works too. If neither
   exists, suggest the user install bun.
2. Make the CLI invocable as a bare command — pick what fits the user's
   setup:
   - symlink: `ln -s <skill-dir>/github/github.ts ~/.local/bin/github`
     (for node users, a 2-line wrapper script instead: `node <path> "$@"`)
   - or add the skill dir to PATH
   - project-local installs may skip this and invoke by path
3. Wire auth — env vars, set wherever the user manages environment
   (direnv, devcontainer, agent shell config):
   - `MCP_GATEWAY_URL` + `MCP_GATEWAY_TOKEN` (shared default), or
     per-tool `GITHUB_MCP_URL` + `GITHUB_MCP_TOKEN`
   - If env wiring is awkward, a gitignored env file next to the skill is
     acceptable. Never hardcode tokens in SKILL.md or committed files.
4. Verify: `github pr 1 -R <some-repo>` or just `github --help`.

## Update

`git pull` in the repo. CLIs are plain TypeScript — no build step.

## Customize / contribute

These tools are opinionated; the customization mechanism is editing the
source (e.g. `github.ts`) directly. Keep local edits as a fork, or PR them
upstream. PRs should show evidence: the agent problem observed (ideally a
session excerpt) and how the improvement was verified. The metric is
tokens-per-task and turns-to-success.
