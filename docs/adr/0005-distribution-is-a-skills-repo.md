# ADR 0005: The project is a skills repository

Date: 2026-06-12 · Status: accepted

## Context

Earlier plans included an installer and a meta-binary (`mcly`) for setup,
doctor, and updates. The shipping unit per tool was already "one CLI file +
one skill file". Bundling executable scripts inside skills is a first-class,
common convention (10/18 official Anthropic skills do it; skill-creator spec
defines `scripts/`; "black-box scripts" guidance matches our philosophy).

## Decision

The repo *is* a skills collection:

- Per tool: one skill folder — `SKILL.md` (vocabulary basics; the rest via
  `--help`) plus the CLI script (e.g. `github.ts`).
- One **meta-skill** replaces installer and meta-binary: it guides the agent
  through setup (runtime check, auth wiring, updates, contributing).
- **Invocation**: for global installs the meta-skill prefers putting the CLI
  on PATH (symlink into `~/.local/bin` or adding the dir to PATH, per user
  setup); project-local installs may use the standard skill-relative path
  convention. Per-tool SKILL.md uses the bare command name.
- **Auth**: env vars (ADR 0003). If env wiring is awkward in a given setup,
  the agent may write a gitignored env-style file next to the skill (URL +
  token together). Tokens should not be hardcoded in SKILL.md itself —
  skill folders get committed to (often public) dotfiles.

## Consequences

- No installer, no `mcly`, no update mechanism to build — `git pull` and the
  meta-skill cover it.
- Presumes a skill-aware harness as the primary audience; folders still work
  as plain scripts elsewhere (README notes this).
- Contribution bar (from the design methodology): PRs should show evidence —
  ideally session excerpts — of the agent problem and the verified
  improvement. PR-template guidance, not a hard CI gate.
