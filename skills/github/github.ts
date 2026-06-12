#!/usr/bin/env bun
// `github` — an agent-ergonomics CLI for GitHub, backed by the GitHub MCP.
// Opinionated by design; edit this file to change behavior (it's meant to be
// edited — good local edits are probably good PRs). See SKILL.md and
// docs/design/github.md in the repo.

import { McpClient, configFromEnv } from "./lib/mcp.ts";
import { execSync } from "node:child_process";

// ── helpers ────────────────────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function git(cmd: string): string | undefined {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function resolveRepo(flag?: string): { owner: string; repo: string } {
  const fromFlag = flag ?? "";
  const m = fromFlag.match(/^([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  const url = git("remote get-url origin");
  const gm = url?.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (gm) return { owner: gm[1], repo: gm[2] };
  die(
    "Cannot determine repository: not in a git checkout with a GitHub origin.\n" +
      "Pass -R owner/repo explicitly.",
  );
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function truncate(body: string, lines: number): string {
  const all = (body ?? "").trim().split("\n");
  if (all.length <= lines) return all.join("\n");
  return all.slice(0, lines).join("\n") + `\n(… ${all.length - lines} more lines, --full for all)`;
}

function asArray(x: any, ...keys: string[]): any[] {
  if (Array.isArray(x)) return x;
  for (const k of keys) if (Array.isArray(x?.[k])) return x[k];
  return [];
}

// ── pr digest ──────────────────────────────────────────────────────────────

async function prDigest(args: string[], flags: Map<string, string | true>) {
  const { owner, repo } = resolveRepo(flags.get("R") as string | undefined);
  let pullNumber = args[0] ? Number(args[0]) : undefined;
  const mcp = new McpClient(configFromEnv("github"));

  if (!pullNumber) {
    const branch = git("branch --show-current");
    if (!branch) die("No PR number given and not on a git branch.");
    const prs = await mcp.call("list_pull_requests", {
      owner, repo, state: "open", head: `${owner}:${branch}`,
    });
    const list = asArray(prs);
    if (list.length === 0)
      die(`No open PR found for branch '${branch}'. Pass a PR number: github pr <n>`);
    pullNumber = list[0].number;
  }

  const base = { owner, repo, pullNumber };
  const [pr, checks, reviews, threads, comments] = await Promise.all([
    mcp.call("pull_request_read", { method: "get", ...base }),
    mcp.call("pull_request_read", { method: "get_check_runs", ...base }).catch((e) => e),
    mcp.call("pull_request_read", { method: "get_reviews", ...base }).catch((e) => e),
    mcp.call("pull_request_read", { method: "get_review_comments", ...base }).catch((e) => e),
    mcp.call("pull_request_read", { method: "get_comments", ...base }).catch((e) => e),
  ]);

  if (flags.has("json")) {
    console.log(JSON.stringify({ pr, checks, reviews, threads, comments }, null, 1));
    return;
  }

  const full = flags.has("full");
  const out: string[] = [];

  // header
  const state = pr.merged ? "MERGED" : pr.draft ? "DRAFT" : pr.state.toUpperCase();
  out.push(
    `#${pr.number} ${pr.title} [${state}] ${pr.user?.login} → ${pr.base?.ref} ` +
      `(+${pr.additions} −${pr.deletions}, ${pr.changed_files} files)`,
  );
  out.push(`branch: ${pr.head?.ref} · created ${ago(pr.created_at)} · updated ${ago(pr.updated_at)}`);
  out.push("");
  if (pr.body) out.push(truncate(pr.body, full ? Infinity : 20), "");

  // checks — failures first
  const runs = checks instanceof Error ? [] : asArray(checks, "check_runs");
  if (checks instanceof Error) {
    out.push(`checks: unavailable (${checks.message})`);
  } else if (runs.length === 0) {
    out.push("checks: none");
  } else {
    const bad = runs.filter((r) => r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion));
    const pending = runs.filter((r) => r.status !== "completed");
    const ok = runs.length - bad.length - pending.length;
    out.push(`checks: ${bad.length} failing, ${pending.length} pending, ${ok} ok`);
    for (const r of full ? runs : bad)
      out.push(`  ✗ ${r.name}  run ${r.id}  ${r.output?.title ?? r.conclusion}`);
  }

  // reviews → decision (latest review per user wins)
  const revs = reviews instanceof Error ? [] : asArray(revs0(reviews));
  const latest = new Map<string, any>();
  for (const r of revs) if (r.user?.login) latest.set(r.user.login, r);
  const states = [...latest.values()].map((r) => r.state);
  const decision = states.includes("CHANGES_REQUESTED")
    ? "CHANGES_REQUESTED"
    : states.includes("APPROVED")
      ? "APPROVED"
      : states.length
        ? "COMMENTED"
        : "no reviews";

  // threads
  const tlist = threads instanceof Error ? [] : asArray(threads, "review_threads");
  const unresolved = tlist.filter((t) => !t.isResolved && !t.IsResolved).length;
  out.push(
    `review: ${decision}` +
      (tlist.length ? ` · ${unresolved} unresolved threads (github pr threads ${pullNumber})` : ""),
  );

  // comments — last 3 unless --full; all authors equal
  const clist = comments instanceof Error ? [] : asArray(comments);
  if (clist.length) {
    const shown = full ? clist : clist.slice(-3);
    out.push(`comments (${full ? clist.length : `last ${shown.length} of ${clist.length}`}):`);
    for (const c of shown) {
      const body = truncate(c.body ?? "", full ? Infinity : 3).replace(/\n/g, "\n    ");
      out.push(`  ${c.user?.login} ${ago(c.created_at)}: ${body}`);
    }
  }

  console.log(out.join("\n"));
}

function revs0(reviews: any): any[] {
  return asArray(reviews, "reviews");
}

// ── command table & fail-loud ──────────────────────────────────────────────

const HELP = `github — GitHub for agents, via MCP. Opinionated; see SKILL.md.

usage:
  github pr [n] [--full] [--json] [-R owner/repo]   PR digest: meta, checks, review state, comments
  github --help

More commands (prs, pr create/edit/comment/merge/close/checks/threads/resolve,
issues, runs, whoami, --since/--wait) are designed but not yet implemented —
see docs/design/github.md. If you hit a wall, tell the user.`;

const REDIRECT =
  "Browsing repository contents remotely is not supported on purpose.\n" +
  "It is faster and cheaper to work locally:\n" +
  "  git clone --depth=50 <url>   (or use your existing checkout)\n" +
  "then use rg / git log / git show.";

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return console.log(HELP);
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { flags.set(a.slice(2), next); i++; }
      else flags.set(a.slice(2), true);
    } else if (a.startsWith("-") && a.length === 2) {
      flags.set(a.slice(1), argv[++i] ?? true);
    } else pos.push(a);
  }

  const [cmd, ...rest] = pos;
  switch (cmd) {
    case "pr":
      return prDigest(rest, flags);
    case "browse": case "clone": case "files": case "contents": case "code":
      return die(REDIRECT, 2);
    case undefined:
      return console.log(HELP);
    default:
      return die(
        `Unknown command '${cmd}'. This is not the official gh CLI — it is a\n` +
          `deliberately minimal, MCP-backed tool. Run 'github --help' for what\n` +
          `exists. Do not retry variations; if a capability is missing, tell the user.`,
        2,
      );
  }
}

main().catch((e) => die(String(e?.message ?? e)));
