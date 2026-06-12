# `github` — design (first pass)

Backed by the GitHub MCP. Designed from the agent-usage histogram
(see research log). Excluded on principle: anything better served by a
local clone (file contents, commit/ref browsing, in-repo code search —
together ~40% of historical `gh api` traffic gets *redirected*, not mapped).

## Principles

1. **The most common question is the shortest command.** `github pr 123`
   — no `view` verb. 436 `pr view` calls earn the prime spot.
2. **One call answers the real question.** Histogram shows `pr view` is
   almost always followed by `pr checks` and a comments fetch. So `pr`
   returns a *digest*: metadata + checks rollup + review state + unresolved
   threads + recent comments. Turns-to-success > purity.
3. **Default output is compact text** — line-oriented, greppable, stable.
   `--json [fields]` everywhere for programmatic use. Failures sort first
   (failed checks before passed, unresolved threads before resolved).
4. **Repo from cwd** git remote; `-R owner/repo` to override. PR number
   from current branch when omitted.
5. **Errors teach.** Unknown command → nearest match + skill pointer.
   Redirected domains → "clone and inspect locally" with a concrete
   command suggestion.

## Vocabulary

### Pull requests
| Command | Notes |
|---|---|
| `github pr [n]` | Digest: head/meta/body, checks rollup, review decision, unresolved thread count, last comments. `--full` = everything |
| `github pr [n] --since <commit-ish>` | Digest filtered to activity after that commit was pushed: new/edited comments (`(edited)` markers via `created_at ≤ t < updated_at`), reviews, thread activity. Empty delta = one line |
| `github pr [n] --wait` | Block until wake condition, print `woke: <reason>` + delta digest. `--timeout` (default 8m, distinct exit code, "re-run to keep waiting"); poll 30s fixed. Composes with `--since` = the whole push-and-await-feedback turn |

#### `--wait` semantics (settled)

```
wake on:  any comment · any review · any review-thread activity
          (all authors equal — no bot/human distinction; review bots like
          greptile are signal too)
          any check fails (immediate) · all checks complete green
edits:    only wake if the body changed by ≥ ~20 chars (typo fixes don't
          wake; substantive rewrites do). Possible because --wait polls and
          keeps previous bodies in memory. Stateless --since output just
          marks items "(edited)".
anchor:   --since commit if given, else invocation time. Every poll
          (including the first) evaluates activity-after-anchor, so events
          landing between push and wait start are caught — race-free by
          construction; --wait never observes from "now".
```

Residual escape hatch for noisy repos: edit the shim (ADR 0003) — e.g. an
ignore-list array at the top of `github.ts`. No config.
| `github prs` | List; `--state --author --label --limit` (default open, 20) |
| `github pr create` | `--title --body[-file] --base --draft`; prints URL |
| `github pr edit n` | `--title --body --base --add-label ...` |
| `github pr comment n --body` | |
| `github pr merge n` | `--squash` (default) `--rebase --merge --delete-branch` |
| `github pr close n` | |
| `github pr checks n` | Full check list, failed first, with run IDs |
| `github pr threads n` | Review threads incl. resolution state, thread IDs, file:line (the gh gap; 40 api calls) |
| `github pr resolve <thread-id>` | + `unresolve` |

### CI runs
| Command | Notes |
|---|---|
| `github runs` | `--branch --workflow --limit`; status glyphs |
| `github run <id>` | Digest: jobs, failed steps, **tail of failed-step logs inline** (the real question behind 88 `run view` calls) |
| `github run watch <id>` | Poll until done, then digest; exit code mirrors conclusion. May fold away: `pr --wait` covers the PR case |
| `github run rerun <id>` | `--failed` to rerun failed jobs only |

### Issues
| Command | Notes |
|---|---|
| `github issue [n]` | View incl. comments |
| `github issues` | `--state --label --author --limit` |
| `github issue create` | `--title --body[-file] --label` |
| `github issue comment n --body` | |
| `github issue edit n` / `close n` | |

### Misc
| Command | Notes |
|---|---|
| `github whoami` | Synthetic: authenticated user + gateway URL (replaces `auth status`) |
| `github <anything-else>` | Fail loud: nearest-match suggestion, or redirect message for clone-able asks |

## Redirects (not commands)

Attempts that historically went to `gh api` get a tailored refusal:

- File contents / commits / refs / code search →
  `This is faster locally: git clone --depth=50 <url> (or use your existing checkout). Then rg/git log.`
- Anything else unmapped → `Not supported. Available: github --help. For raw API access ask the user.`

## Output sketch — `github pr 123`

```
#123 Fix flaky retry logic in client [OPEN] mg → main (+142 −38, 6 files)
branch: fix/retry · created 2d ago · updated 3h ago

Retries now use exponential backoff with jitter. Fixes #98. (…body, truncated at 20 lines, --full for all)

checks: 1 failing, 7 ok
  ✗ test (ubuntu, 3.12)  run 9182736  "assert_eq failed: expected 3 retries"
review: CHANGES_REQUESTED · 2 unresolved threads (github pr threads 123)
comments (last 3 of 7):  [--full for all]
  alice 5h: Can we bound the jitter?
  mg 4h: Done in a3f9c2.
  bot 3h: Coverage 91.2% (−0.3%)
```

Everything an agent needs to decide the next action in one call, ~250
tokens. The `--json` form selects fields: `--json checks,reviewDecision`.

## Open questions for iteration

- `pr create`: auto-fill title/body from commits like gh does? (Probably
  yes — agents pass explicit `--title --body` anyway, 292/292 calls did.)
- Does `run watch` need `--interval`? Default 10s.
- `--wait` exit codes: 0 for any wake incl. CI-red (digest carries verdict);
  nonzero reserved for timeout/errors. Confirm this reads well to agents.
- Skill should advise setting generous harness bash timeouts for `--wait`.
- Pagination: `--limit` only, no cursors, until evidence demands it.
- Labels/milestones/projects: omitted until histogram says otherwise.
```
