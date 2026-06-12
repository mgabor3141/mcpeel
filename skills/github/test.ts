// Contract tests: run the CLI against a local mock MCP server and assert on
// output and exit codes. Runs under both bun and node:  bun test.ts / node test.ts
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "github.ts");
const RUNTIME = process.argv[0];

// ── canned MCP responses ───────────────────────────────────────────────────

const PR = {
  number: 7, title: "Add retry logic", state: "open", draft: false, merged: false,
  user: { login: "alice" }, base: { ref: "main" }, head: { ref: "retry", sha: "abc1234" },
  additions: 10, deletions: 2, changed_files: 1, body: "Adds retries.\nFixes #5.",
  created_at: new Date(Date.now() - 7200_000).toISOString(),
  updated_at: new Date(Date.now() - 600_000).toISOString(),
};
const TOOLS: Record<string, (args: any) => unknown> = {
  pull_request_read: (a) =>
    ({
      get: PR,
      get_check_runs: { check_runs: [
        { id: 1, name: "test", status: "completed", conclusion: "failure", output: { title: "2 tests failed" } },
        { id: 2, name: "lint", status: "completed", conclusion: "success" },
      ] },
      get_reviews: [{ id: 9, user: { login: "bob" }, state: "CHANGES_REQUESTED", submitted_at: PR.updated_at, body: "fix it" }],
      get_review_comments: { review_threads: [
        { id: "T1", isResolved: false, comments: [{ author: "bob", body: "typo here", path: "a.ts", line: 3, created_at: PR.updated_at, updated_at: PR.updated_at }] },
      ] },
      get_comments: [{ id: 5, user: { login: "carol" }, body: "LGTM soon", created_at: PR.updated_at, updated_at: PR.updated_at }],
    })[a.method as string],
  get_me: () => ({ login: "test-user" }),
};

const server = createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const msg = JSON.parse(buf || "{}");
    const reply = (result: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Mcp-Session-Id", "test-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "initialize")
      return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock" } });
    if (msg.method === "notifications/initialized") return void res.writeHead(202).end();
    if (msg.method === "tools/call") {
      const fn = TOOLS[msg.params.name];
      if (!fn) return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${msg.params.name}` }] });
      return reply({ content: [{ type: "text", text: JSON.stringify(fn(msg.params.arguments)) }] });
    }
    reply({});
  });
});

// ── tiny test harness ──────────────────────────────────────────────────────

let failures = 0;
// async spawn: spawnSync would block the event loop and deadlock the
// in-process mock server.
function run(args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(RUNTIME, [CLI, ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}${cond || !detail ? "" : `\n  ${detail}`}`);
  if (!cond) failures++;
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as any).port;
  const env = {
    GITHUB_MCP_URL: `http://127.0.0.1:${port}/`,
    GITHUB_MCP_TOKEN: "test-token",
    MCP_GATEWAY_URL: undefined, MCP_GATEWAY_TOKEN: undefined,
  };

  {
    const r = await run(["pr", "7", "-R", "o/r"], env);
    check("pr digest exits 0", r.status === 0, r.stderr);
    check("digest header", r.stdout.includes("#7 Add retry logic [OPEN] alice → main (+10 −2, 1 files)"), r.stdout);
    check("digest checks failures first", r.stdout.includes("checks: 1 failing, 0 pending, 1 ok") && r.stdout.includes("✗ test  run 1  2 tests failed"), r.stdout);
    check("digest review decision", r.stdout.includes("review: CHANGES_REQUESTED · 1 unresolved threads"), r.stdout);
    check("digest comments", r.stdout.includes("carol") && r.stdout.includes("LGTM soon"), r.stdout);
  }
  {
    const r = await run(["pr", "threads", "7", "-R", "o/r"], env);
    check("threads lists unresolved with id", r.stdout.includes("[UNRESOLVED] a.ts:3  id=T1") && r.stdout.includes("bob: typo here"), r.stdout + r.stderr);
  }
  {
    const r = await run(["whoami"], env);
    check("whoami", r.stdout.includes("authenticated as test-user"), r.stdout + r.stderr);
  }
  {
    const r = await run(["api", "repos/x/y"], env);
    check("unknown command exits 2", r.status === 2, String(r.status));
    check("unknown command teaches", r.stderr.includes("Do not retry variations"), r.stderr);
  }
  {
    const r = await run(["files"], env);
    check("redirect exits 2 and suggests clone", r.status === 2 && r.stderr.includes("git clone"), r.stderr);
  }
  {
    const r = await run(["pr", "7", "-R", "o/r"], { ...env, GITHUB_MCP_URL: undefined, GITHUB_MCP_TOKEN: undefined });
    check("unconfigured exits 3 with instructions", r.status === 3 && r.stderr.includes("GITHUB_MCP_URL"), `${r.status} ${r.stderr}`);
  }

  server.close();
  console.log(failures === 0 ? "\nall tests passed" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
});
