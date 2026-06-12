#!/usr/bin/env bun
// `github` — an agent-ergonomics CLI for GitHub, backed by the GitHub MCP.
// Opinionated by design; edit this file to change behavior (it's meant to be
// edited — good local edits are probably good PRs). See SKILL.md and
// docs/design/github.md in the repo.

import { McpClient, configFromEnv } from "./lib/mcp.ts";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── plumbing ───────────────────────────────────────────────────────────────

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

function indent(s: string): string {
  return s.replace(/\n/g, "\n    ");
}

/** Created-entity reporter tolerant of REST/wrapped/GraphQL result shapes. */
function reportCreated(kind: string, res: any): void {
  const obj = res?.number !== undefined ? res : res?.issue ?? res?.pull_request ?? res ?? {};
  const n = obj.number !== undefined ? `#${obj.number}` : "";
  const url = obj.html_url ?? obj.url ?? "";
  console.log(`created ${kind} ${n} ${url}`.replace(/\s+/g, " ").trim());
}

function asArray(x: any, ...keys: string[]): any[] {
  if (Array.isArray(x)) return x;
  for (const k of keys) if (Array.isArray(x?.[k])) return x[k];
  return [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── context ────────────────────────────────────────────────────────────────

interface Ctx {
  mcp: McpClient;
  owner: string;
  repo: string;
  flags: Map<string, string | true>;
  pos: string[];
}

function makeCtx(flags: Map<string, string | true>, pos: string[]): Ctx {
  const fromFlag = (flags.get("R") as string) ?? "";
  let owner: string, repo: string;
  const m = fromFlag.match(/^([^/]+)\/([^/]+)$/);
  if (m) [, owner, repo] = m;
  else {
    const url = git("remote get-url origin");
    const gm = url?.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!gm)
      die(
        "Cannot determine repository: not in a git checkout with a GitHub origin.\n" +
          "Pass -R owner/repo explicitly.",
      );
    [, owner, repo] = gm;
  }
  const cfg = configFromEnv("github");
  // The GitHub-hosted remote MCP gates the actions toolset behind a header.
  const extraHeaders = cfg.url.includes("githubcopilot.com")
    ? { "X-MCP-Toolsets": "all" }
    : undefined;
  return { mcp: new McpClient(cfg, extraHeaders), owner, repo, flags, pos };
}

async function resolvePrNumber(ctx: Ctx, arg?: string): Promise<number> {
  if (arg && /^\d+$/.test(arg)) return Number(arg);
  const branch = git("branch --show-current");
  if (!branch) die("No PR number given and not on a git branch.");
  const prs = asArray(
    await ctx.mcp.call("list_pull_requests", {
      owner: ctx.owner, repo: ctx.repo, state: "open", head: `${ctx.owner}:${branch}`,
    }),
  );
  if (prs.length === 0)
    die(`No open PR found for branch '${branch}'. Pass a PR number: github pr <n>`);
  return prs[0].number;
}

function bodyFlag(ctx: Ctx, required = true): string | undefined {
  const file = ctx.flags.get("body-file");
  if (typeof file === "string") return readFileSync(file, "utf8");
  const body = ctx.flags.get("body");
  if (typeof body === "string") return body;
  if (required) die("Missing --body <text> (or --body-file <path>).");
  return undefined;
}

// ── pr digest (+ --since / --wait) ─────────────────────────────────────────

interface PrData {
  pr: any; checks: any; reviews: any[]; threads: any[]; comments: any[];
}

async function fetchPrData(ctx: Ctx, pullNumber: number): Promise<PrData> {
  const base = { owner: ctx.owner, repo: ctx.repo, pullNumber };
  const read = (method: string) =>
    ctx.mcp.call("pull_request_read", { method, ...base }).catch((e: Error) => e);
  const [pr, checks, reviews, threads, comments] = await Promise.all([
    ctx.mcp.call("pull_request_read", { method: "get", ...base }),
    read("get_check_runs"), read("get_reviews"), read("get_review_comments"), read("get_comments"),
  ]);
  return {
    pr,
    checks,
    reviews: reviews instanceof Error ? [] : asArray(reviews, "reviews"),
    threads: threads instanceof Error ? [] : asArray(threads, "review_threads"),
    comments: comments instanceof Error ? [] : asArray(comments),
  };
}

function threadComments(t: any): any[] {
  return asArray(t.comments?.nodes ?? t.comments);
}

// thread-comment field accessors: remote returns lowercase keys and a plain
// string author; self-hosted builds have returned Author{Login}/Body/Path.
const cAuthor = (c: any): string =>
  typeof c.author === "string" ? c.author : c.author?.login ?? c.Author?.Login ?? c.user?.login ?? "?";
const cBody = (c: any): string => c.body ?? c.Body ?? "";
const cPath = (c: any): string | undefined => c.path ?? c.Path;
const cLine = (c: any): number | undefined => c.line ?? c.Line;
const cCreated = (c: any): string | undefined => c.created_at ?? c.CreatedAt;
const cUpdated = (c: any): string | undefined => c.updated_at ?? c.UpdatedAt;
const cId = (c: any): string => String(c.id ?? c.ID ?? c.html_url ?? cCreated(c));

async function resolveSinceAnchor(ctx: Ctx): Promise<number | undefined> {
  const ref = ctx.flags.get("since");
  if (typeof ref !== "string") return undefined;
  const commit = await ctx.mcp.call("get_commit", { owner: ctx.owner, repo: ctx.repo, sha: ref });
  const date = commit?.commit?.committer?.date ?? commit?.commit?.author?.date;
  if (!date) die(`--since: cannot resolve '${ref}' to a commit in ${ctx.owner}/${ctx.repo}.`);
  return new Date(date).getTime();
}

/** Items (comments/reviews/thread-comments) active after the anchor. */
function activitySince(d: PrData, t: number) {
  const after = (iso?: string) => !!iso && new Date(iso).getTime() > t;
  const mark = (x: any, created?: string, updated?: string) => ({
    ...x, _edited: !after(created) && after(updated),
  });
  return {
    comments: d.comments
      .filter((c) => after(c.created_at) || after(c.updated_at))
      .map((c) => mark(c, c.created_at, c.updated_at)),
    reviews: d.reviews.filter((r) => after(r.submitted_at)),
    threadComments: d.threads.flatMap((th) =>
      threadComments(th)
        .filter((c) => after(cCreated(c)) || after(cUpdated(c)))
        .map((c) => ({ ...mark(c, cCreated(c), cUpdated(c)), _path: cPath(c) })),
    ),
  };
}

function checkStats(checks: any) {
  const runs = checks instanceof Error ? [] : asArray(checks, "check_runs");
  const bad = runs.filter((r) => r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion));
  const pending = runs.filter((r) => r.status !== "completed");
  return { runs, bad, pending, ok: runs.length - bad.length - pending.length };
}

function renderDigest(ctx: Ctx, pullNumber: number, d: PrData, sinceT?: number): string {
  const full = ctx.flags.has("full");
  const out: string[] = [];
  const { pr } = d;
  const state = pr.merged ? "MERGED" : pr.draft ? "DRAFT" : pr.state.toUpperCase();
  out.push(
    `#${pr.number} ${pr.title} [${state}] ${pr.user?.login} → ${pr.base?.ref} ` +
      `(+${pr.additions} −${pr.deletions}, ${pr.changed_files} files)`,
  );
  out.push(`branch: ${pr.head?.ref} · created ${ago(pr.created_at)} · updated ${ago(pr.updated_at)}`);

  const { runs, bad, pending, ok } = checkStats(d.checks);
  const checksLine =
    d.checks instanceof Error
      ? `checks: unavailable (${d.checks.message})`
      : runs.length === 0
        ? "checks: none"
        : `checks: ${bad.length} failing, ${pending.length} pending, ${ok} ok`;

  const latest = new Map<string, any>();
  for (const r of d.reviews) if (r.user?.login) latest.set(r.user.login, r);
  const states = [...latest.values()].map((r) => r.state);
  const decision = states.includes("CHANGES_REQUESTED")
    ? "CHANGES_REQUESTED"
    : states.includes("APPROVED") ? "APPROVED"
    : states.length ? "COMMENTED" : "no reviews";
  const unresolved = d.threads.filter((t) => !(t.isResolved ?? t.IsResolved)).length;
  const reviewLine =
    `review: ${decision}` +
    (d.threads.length ? ` · ${unresolved} unresolved threads (github pr threads ${pullNumber})` : "");

  if (sinceT !== undefined) {
    // delta digest: only activity after the anchor
    const act = activitySince(d, sinceT);
    const n = act.comments.length + act.reviews.length + act.threadComments.length;
    out.push("", `activity since anchor (${new Date(sinceT).toISOString()}): ` +
      (n === 0 ? "none" : `${act.reviews.length} reviews, ${act.threadComments.length} thread comments, ${act.comments.length} comments`));
    for (const r of act.reviews)
      out.push(`  review ${r.user?.login} [${r.state}] ${ago(r.submitted_at)}: ${indent(truncate(r.body ?? "", full ? Infinity : 5))}`);
    for (const c of act.threadComments)
      out.push(`  thread ${cAuthor(c)} ${c._path ?? ""}${c._edited ? " (edited)" : ""}: ${indent(truncate(cBody(c), full ? Infinity : 5))}`);
    for (const c of act.comments)
      out.push(`  comment ${c.user?.login} ${ago(c.created_at)}${c._edited ? " (edited)" : ""}: ${indent(truncate(c.body ?? "", full ? Infinity : 5))}`);
    out.push(checksLine);
    for (const r of bad) out.push(`  ✗ ${r.name}  run ${r.id}  ${r.output?.title ?? r.conclusion}`);
    out.push(reviewLine);
    return out.join("\n");
  }

  out.push("");
  if (pr.body) out.push(truncate(pr.body, full ? Infinity : 20), "");
  out.push(checksLine);
  for (const r of full ? runs : bad)
    out.push(`  ${r.conclusion === "success" ? "✓" : "✗"} ${r.name}  run ${r.id}  ${r.output?.title ?? r.conclusion ?? r.status}`);
  out.push(reviewLine);
  if (d.comments.length) {
    const shown = full ? d.comments : d.comments.slice(-3);
    out.push(`comments (${full ? d.comments.length : `last ${shown.length} of ${d.comments.length}`}):`);
    for (const c of shown)
      out.push(`  ${c.user?.login} ${ago(c.created_at)}: ${indent(truncate(c.body ?? "", full ? Infinity : 3))}`);
  }
  return out.join("\n");
}

const WAIT_POLL_MS = 30_000;
const EDIT_WAKE_MIN_DELTA = 20;

async function prWait(ctx: Ctx, pullNumber: number, anchorT: number): Promise<void> {
  const timeoutMin = Number(ctx.flags.get("timeout") ?? 8);
  const deadline = Date.now() + timeoutMin * 60_000;
  // body snapshots to measure edit deltas between polls (key: item id)
  let bodies = new Map<string, string>();
  let first = true;

  for (;;) {
    const d = await fetchPrData(ctx, pullNumber);
    const act = activitySince(d, anchorT);
    const items = [
      ...act.comments.map((c) => ({ id: `c${c.id}`, body: c.body ?? "", edited: c._edited })),
      ...act.reviews.map((r) => ({ id: `r${r.id}`, body: r.body ?? "", edited: false })),
      ...act.threadComments.map((c) => ({ id: `t${cId(c)}`, body: cBody(c), edited: c._edited })),
    ];

    let reason: string | undefined;
    for (const it of items) {
      const prev = bodies.get(it.id);
      if (prev === undefined) {
        // new-to-us item. On the first poll, edited items with unknown deltas
        // wake conservatively; genuinely new items always wake.
        if (!it.edited || first) { reason = "new activity"; break; }
      } else if (prev !== it.body) {
        if (Math.abs(prev.length - it.body.length) >= EDIT_WAKE_MIN_DELTA ||
            levenshteinish(prev, it.body) >= EDIT_WAKE_MIN_DELTA) { reason = "comment edited"; break; }
      }
    }
    const { runs, bad, pending } = checkStats(d.checks);
    if (!reason && bad.length > 0) reason = "check failure";
    if (!reason && runs.length > 0 && pending.length === 0 && bad.length === 0) reason = "all checks green";

    if (reason) {
      console.log(`woke: ${reason}\n`);
      console.log(renderDigest(ctx, pullNumber, d, anchorT));
      return;
    }

    for (const it of items) bodies.set(it.id, it.body);
    first = false;

    if (Date.now() + WAIT_POLL_MS > deadline) {
      console.log(`nothing new after ${timeoutMin}m — re-run the same command to keep waiting.`);
      process.exit(4);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** cheap edit-distance proxy: chars not shared at common prefix+suffix */
function levenshteinish(a: string, b: string): number {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return Math.max(a.length, b.length) - p - s;
}

async function cmdPr(ctx: Ctx): Promise<void> {
  const sub = ctx.pos[0];
  const subs: Record<string, (ctx: Ctx) => Promise<void>> = {
    create: prCreate, edit: prEdit, comment: prComment, merge: prMerge,
    close: prClose, checks: prChecks, threads: prThreads,
    resolve: prResolve, unresolve: prResolve,
  };
  if (sub && subs[sub]) {
    ctx.pos.shift();
    return subs[sub](ctx);
  }

  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const anchorT = (await resolveSinceAnchor(ctx)) ?? (ctx.flags.has("wait") ? Date.now() : undefined);

  if (ctx.flags.has("wait")) return prWait(ctx, pullNumber, anchorT!);

  const d = await fetchPrData(ctx, pullNumber);
  if (ctx.flags.has("json"))
    return console.log(JSON.stringify(d, null, 1));
  console.log(renderDigest(ctx, pullNumber, d, anchorT));
}

// ── pr write commands ──────────────────────────────────────────────────────

async function prCreate(ctx: Ctx): Promise<void> {
  const title = ctx.flags.get("title");
  if (typeof title !== "string") die("Missing --title <text>.");
  const head = git("branch --show-current");
  if (!head) die("Not on a git branch; cannot determine head.");
  const res = await ctx.mcp.call("create_pull_request", {
    owner: ctx.owner, repo: ctx.repo, title,
    body: bodyFlag(ctx, false) ?? "",
    head, base: (ctx.flags.get("base") as string) ?? "main",
    draft: ctx.flags.has("draft"),
  });
  reportCreated("PR", res);
}

async function prEdit(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const args: Record<string, unknown> = { owner: ctx.owner, repo: ctx.repo, pullNumber };
  for (const k of ["title", "base"]) if (typeof ctx.flags.get(k) === "string") args[k] = ctx.flags.get(k);
  const body = bodyFlag(ctx, false);
  if (body !== undefined) args.body = body;
  if (ctx.flags.has("ready")) args.draft = false;
  if (Object.keys(args).length === 3) die("Nothing to change. Flags: --title --body[-file] --base --ready");
  await ctx.mcp.call("update_pull_request", args);
  console.log(`updated #${pullNumber}`);
}

async function prComment(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  await ctx.mcp.call("add_issue_comment", {
    owner: ctx.owner, repo: ctx.repo, issue_number: pullNumber, body: bodyFlag(ctx)!,
  });
  console.log(`commented on #${pullNumber}`);
}

async function prMerge(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const method = ctx.flags.has("rebase") ? "rebase" : ctx.flags.has("merge") ? "merge" : "squash";
  const res = await ctx.mcp.call("merge_pull_request", {
    owner: ctx.owner, repo: ctx.repo, pullNumber, merge_method: method,
  });
  console.log(res?.merged === false ? `NOT merged: ${res.message}` : `merged #${pullNumber} (${method})`);
}

async function prClose(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  await ctx.mcp.call("update_pull_request", { owner: ctx.owner, repo: ctx.repo, pullNumber, state: "closed" });
  console.log(`closed #${pullNumber}`);
}

async function prChecks(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const checks = await ctx.mcp.call("pull_request_read", {
    method: "get_check_runs", owner: ctx.owner, repo: ctx.repo, pullNumber,
  });
  const { runs, bad, pending, ok } = checkStats(checks);
  if (runs.length === 0) return console.log("no checks");
  console.log(`${bad.length} failing, ${pending.length} pending, ${ok} ok`);
  const order = [...bad, ...pending, ...runs.filter((r) => !bad.includes(r) && !pending.includes(r))];
  for (const r of order) {
    const glyph = r.status !== "completed" ? "○" : r.conclusion === "success" ? "✓" : ["neutral", "skipped"].includes(r.conclusion) ? "·" : "✗";
    console.log(`${glyph} ${r.name}  run ${r.id}  ${r.output?.title ?? r.conclusion ?? r.status}`);
  }
}

async function prThreads(ctx: Ctx): Promise<void> {
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const res = await ctx.mcp.call("pull_request_read", {
    method: "get_review_comments", owner: ctx.owner, repo: ctx.repo, pullNumber,
  });
  const threads = asArray(res, "review_threads");
  if (threads.length === 0) return console.log("no review threads");
  const full = ctx.flags.has("full");
  const unresolved = threads.filter((t) => !(t.isResolved ?? t.IsResolved));
  console.log(`${threads.length} threads, ${unresolved.length} unresolved` + (full ? "" : " (resolved hidden, --full to show)"));
  for (const t of full ? threads : unresolved) {
    const resolved = t.isResolved ?? t.IsResolved;
    const cs = threadComments(t);
    const head = cs[0] ?? {};
    console.log(`\n[${resolved ? "resolved" : "UNRESOLVED"}] ${cPath(head) ?? "?"}:${cLine(head) ?? "?"}  id=${t.ID ?? t.id}`);
    for (const c of cs)
      console.log(`  ${cAuthor(c)}: ${indent(truncate(cBody(c), full ? Infinity : 6))}`);
  }
  if (unresolved.length)
    console.log(`\nresolve with: github pr resolve <n> <thread-id> [--body <reply>]`);
}

async function prResolve(ctx: Ctx): Promise<void> {
  const resolve = !process.argv.includes("unresolve");
  const pullNumber = await resolvePrNumber(ctx, ctx.pos[0]);
  const threadId = ctx.pos[1];
  if (!threadId) die(`Usage: github pr ${resolve ? "resolve" : "unresolve"} <pr-number> <thread-id>  (ids from: github pr threads <n>)`);
  await ctx.mcp.call("pull_request_review_write", {
    method: resolve ? "resolve_thread" : "unresolve_thread",
    owner: ctx.owner, repo: ctx.repo, pullNumber, threadId,
  });
  console.log(`${resolve ? "resolved" : "unresolved"} ${threadId}`);
}

async function cmdPrs(ctx: Ctx): Promise<void> {
  const res = await ctx.mcp.call("list_pull_requests", {
    owner: ctx.owner, repo: ctx.repo,
    state: (ctx.flags.get("state") as string) ?? "open",
    perPage: Number(ctx.flags.get("limit") ?? 20),
  });
  const prs = asArray(res).slice(0, Number(ctx.flags.get("limit") ?? 20));
  if (ctx.flags.has("json")) return console.log(JSON.stringify(prs, null, 1));
  if (prs.length === 0) return console.log("no PRs");
  for (const p of prs)
    console.log(`#${p.number}\t[${p.draft ? "draft" : p.state}]\t${p.user?.login}\t${p.title}  (${ago(p.updated_at)})`);
}

// ── issues ─────────────────────────────────────────────────────────────────

async function cmdIssue(ctx: Ctx): Promise<void> {
  const sub = ctx.pos[0];
  const subs: Record<string, () => Promise<void>> = {
    create: async () => {
      const title = ctx.flags.get("title");
      if (typeof title !== "string") die("Missing --title <text>.");
      const labels = typeof ctx.flags.get("label") === "string" ? (ctx.flags.get("label") as string).split(",") : undefined;
      const res = await ctx.mcp.call("issue_write", {
        method: "create", owner: ctx.owner, repo: ctx.repo, title,
        body: bodyFlag(ctx, false), labels,
      });
      reportCreated("issue", res);
    },
    comment: async () => {
      const n = Number(ctx.pos[1] ?? die("Usage: github issue comment <n> --body <text>"));
      await ctx.mcp.call("add_issue_comment", { owner: ctx.owner, repo: ctx.repo, issue_number: n, body: bodyFlag(ctx)! });
      console.log(`commented on #${n}`);
    },
    edit: async () => {
      const n = Number(ctx.pos[1] ?? die("Usage: github issue edit <n> [--title --body[-file]]"));
      const args: Record<string, unknown> = { method: "update", owner: ctx.owner, repo: ctx.repo, issue_number: n };
      if (typeof ctx.flags.get("title") === "string") args.title = ctx.flags.get("title");
      const body = bodyFlag(ctx, false);
      if (body !== undefined) args.body = body;
      await ctx.mcp.call("issue_write", args);
      console.log(`updated #${n}`);
    },
    close: async () => {
      const n = Number(ctx.pos[1] ?? die("Usage: github issue close <n>"));
      await ctx.mcp.call("issue_write", { method: "update", owner: ctx.owner, repo: ctx.repo, issue_number: n, state: "closed" });
      console.log(`closed #${n}`);
    },
  };
  if (sub && subs[sub]) return subs[sub]();

  const n = Number(sub ?? die("Usage: github issue <n> | create | comment | edit | close"));
  const base = { owner: ctx.owner, repo: ctx.repo, issue_number: n };
  const [issue, comments] = await Promise.all([
    ctx.mcp.call("issue_read", { method: "get", ...base }),
    ctx.mcp.call("issue_read", { method: "get_comments", ...base }).catch(() => []),
  ]);
  if (ctx.flags.has("json")) return console.log(JSON.stringify({ issue, comments }, null, 1));
  const full = ctx.flags.has("full");
  const labels = asArray(issue.labels).map((l: any) => l.name ?? l).join(",");
  console.log(`#${issue.number} ${issue.title} [${issue.state.toUpperCase()}] ${issue.user?.login}` + (labels ? ` (${labels})` : ""));
  console.log(`created ${ago(issue.created_at)} · updated ${ago(issue.updated_at)}\n`);
  if (issue.body) console.log(truncate(issue.body, full ? Infinity : 20) + "\n");
  const clist = asArray(comments);
  if (clist.length) {
    console.log(`comments (${clist.length}):`);
    for (const c of full ? clist : clist.slice(-5))
      console.log(`  ${c.user?.login} ${ago(c.created_at)}: ${indent(truncate(c.body ?? "", full ? Infinity : 5))}`);
  }
}

async function cmdIssues(ctx: Ctx): Promise<void> {
  const labels = typeof ctx.flags.get("label") === "string" ? (ctx.flags.get("label") as string).split(",") : undefined;
  const res = await ctx.mcp.call("list_issues", {
    owner: ctx.owner, repo: ctx.repo,
    state: ((ctx.flags.get("state") as string) ?? "open").toUpperCase(),
    perPage: Number(ctx.flags.get("limit") ?? 20), labels,
  });
  const issues = asArray(res, "issues").slice(0, Number(ctx.flags.get("limit") ?? 20));
  if (ctx.flags.has("json")) return console.log(JSON.stringify(issues, null, 1));
  if (issues.length === 0) return console.log("no issues");
  for (const i of issues)
    console.log(`#${i.number}\t[${i.state.toLowerCase()}]\t${i.user?.login ?? i.author?.login}\t${i.title}  (${ago(i.updated_at ?? i.updatedAt)})`);
}

// ── runs ───────────────────────────────────────────────────────────────────

async function runDigest(ctx: Ctx, runId: number): Promise<{ done: boolean; ok: boolean; text: string }> {
  const [run, jobsRes] = await Promise.all([
    ctx.mcp.call("actions_get", { method: "get_workflow_run", owner: ctx.owner, repo: ctx.repo, resource_id: String(runId) }),
    ctx.mcp.call("actions_list", { method: "list_workflow_jobs", owner: ctx.owner, repo: ctx.repo, resource_id: String(runId) }).catch(() => undefined),
  ]);
  const jobs = asArray(jobsRes, "jobs");
  const out: string[] = [];
  out.push(`run ${run.id} ${run.name ?? run.display_title} [${run.status}${run.conclusion ? `/${run.conclusion}` : ""}] branch=${run.head_branch} ${ago(run.created_at)}`);
  const failed = jobs.filter((j) => j.conclusion && !["success", "neutral", "skipped"].includes(j.conclusion));
  for (const j of jobs) {
    const glyph = j.status !== "completed" ? "○" : j.conclusion === "success" ? "✓" : ["neutral", "skipped"].includes(j.conclusion) ? "·" : "✗";
    out.push(`  ${glyph} ${j.name}`);
    for (const s of asArray(j.steps).filter((s: any) => s.conclusion === "failure"))
      out.push(`      failed step: ${s.name}`);
  }
  if (failed.length > 0) {
    const logs = await ctx.mcp
      .call("get_job_logs", { owner: ctx.owner, repo: ctx.repo, run_id: runId, failed_only: true, return_content: true, tail_lines: Number(ctx.flags.get("log-lines") ?? 40) })
      .catch((e: Error) => e);
    if (logs instanceof Error) out.push(`(logs unavailable: ${logs.message})`);
    else
      for (const l of asArray(logs, "logs")) {
        out.push(`\n── log tail: ${l.job_name ?? l.job_id} ──`);
        out.push(String(l.logs_content ?? l.content ?? "").trimEnd());
      }
  }
  return { done: run.status === "completed", ok: run.conclusion === "success", text: out.join("\n") };
}

async function cmdRun(ctx: Ctx): Promise<void> {
  const sub = ctx.pos[0];
  if (sub === "watch") {
    const id = Number(ctx.pos[1] ?? die("Usage: github run watch <run-id>"));
    const deadline = Date.now() + Number(ctx.flags.get("timeout") ?? 8) * 60_000;
    for (;;) {
      const d = await runDigest(ctx, id);
      if (d.done) {
        console.log(d.text);
        process.exit(d.ok ? 0 : 1);
      }
      if (Date.now() + WAIT_POLL_MS > deadline) {
        console.log(`still running after timeout — re-run the same command to keep waiting.`);
        process.exit(4);
      }
      await sleep(WAIT_POLL_MS);
    }
  }
  if (sub === "rerun") {
    const id = Number(ctx.pos[1] ?? die("Usage: github run rerun <run-id> [--failed]"));
    await ctx.mcp.call("actions_run_trigger", {
      method: ctx.flags.has("failed") ? "rerun_failed_jobs" : "rerun_workflow_run",
      owner: ctx.owner, repo: ctx.repo, run_id: id,
    });
    return console.log(`rerun triggered for ${id} — github run watch ${id}`);
  }
  const id = Number(sub ?? die("Usage: github run <run-id> | watch <id> | rerun <id>"));
  console.log((await runDigest(ctx, id)).text);
}

async function cmdRuns(ctx: Ctx): Promise<void> {
  const filter: Record<string, unknown> = {};
  if (typeof ctx.flags.get("branch") === "string") filter.branch = ctx.flags.get("branch");
  const res = await ctx.mcp.call("actions_list", {
    method: "list_workflow_runs", owner: ctx.owner, repo: ctx.repo,
    per_page: Number(ctx.flags.get("limit") ?? 15),
    ...(Object.keys(filter).length ? { workflow_runs_filter: filter } : {}),
  });
  const runs = asArray(res, "workflow_runs").slice(0, Number(ctx.flags.get("limit") ?? 15));
  if (ctx.flags.has("json")) return console.log(JSON.stringify(runs, null, 1));
  if (runs.length === 0) return console.log("no runs");
  for (const r of runs) {
    const glyph = r.status !== "completed" ? "○" : r.conclusion === "success" ? "✓" : ["skipped", "neutral"].includes(r.conclusion) ? "·" : "✗";
    console.log(`${glyph} ${r.id}\t${r.name}\t${r.head_branch}\t${r.conclusion ?? r.status}  (${ago(r.created_at)})`);
  }
}

// ── misc ───────────────────────────────────────────────────────────────────

async function cmdWhoami(): Promise<void> {
  // no repo resolution needed — works outside any checkout
  const cfg = configFromEnv("github");
  const extraHeaders = cfg.url.includes("githubcopilot.com") ? { "X-MCP-Toolsets": "all" } : undefined;
  const me = await new McpClient(cfg, extraHeaders).call("get_me", {});
  const url = process.env.GITHUB_MCP_URL ?? process.env.MCP_GATEWAY_URL;
  console.log(`authenticated as ${me.login} via MCP endpoint ${url}`);
}

// ── command table & fail-loud ──────────────────────────────────────────────

const HELP = `github — GitHub for agents, via MCP. Opinionated; see SKILL.md.

pull requests
  github pr [n]                          digest: meta, checks, review state, comments
    --full | --json | -R owner/repo
    --since <commit-ish>                 only activity after that commit was pushed
    --wait [--timeout <min>=8]          block until: comment/review/thread activity,
                                         check failure, or all checks green
  github prs [--state --limit]           list
  github pr create --title T [--body B|--body-file F] [--base main] [--draft]
  github pr edit [n] [--title --body[-file] --base --ready]
  github pr comment [n] --body B
  github pr merge [n] [--rebase|--merge]   (default: squash)
  github pr close [n]
  github pr checks [n]
  github pr threads [n] [--full]         review threads with ids; unresolved first
  github pr resolve <n> <thread-id>      (also: unresolve)

issues
  github issue <n> [--full]              view incl. comments
  github issues [--state --label --limit]
  github issue create --title T [--body B|--body-file F] [--label a,b]
  github issue comment <n> --body B
  github issue edit <n> [--title --body[-file]]   · github issue close <n>

ci runs
  github runs [--branch --limit]
  github run <id> [--log-lines 40]       digest; failed-step log tails inline
  github run watch <id> [--timeout 8]    exit 0 green / 1 red / 4 timeout
  github run rerun <id> [--failed]

misc
  github whoami

[n] omitted = PR of the current branch. Exit codes: 2 unsupported, 3 unconfigured, 4 wait timeout.`;

const REDIRECT =
  "Browsing repository contents remotely is not supported on purpose.\n" +
  "It is faster and cheaper to work locally:\n" +
  "  git clone --depth=50 <url>   (or use your existing checkout)\n" +
  "then use rg / git log / git show.";

const BOOL_FLAGS = new Set([
  "full", "json", "wait", "draft", "failed", "ready", "rebase", "merge", "squash", "bots", "help",
]);

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return console.log(HELP);
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOL_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else flags.set(name, true);
    } else if (a.startsWith("-") && a.length === 2) {
      flags.set(a.slice(1), argv[++i] ?? true);
    } else pos.push(a);
  }

  const [cmd, ...rest] = pos;
  const make = () => makeCtx(flags, rest);
  switch (cmd) {
    case "pr": return cmdPr(make());
    case "prs": return cmdPrs(make());
    case "issue": return cmdIssue(make());
    case "issues": return cmdIssues(make());
    case "run": return cmdRun(make());
    case "runs": return cmdRuns(make());
    case "whoami": return cmdWhoami();
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
