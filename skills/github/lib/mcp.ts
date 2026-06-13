// Minimal MCP streamable-HTTP client. Zero dependencies, bun/node portable.
// Speaks only the slice we need: initialize + tools/call. (ADR 0002)

export interface McpConfig {
  url: string;
  token: string;
}

export function configFromEnv(tool: string): McpConfig {
  const T = tool.toUpperCase();
  const url = process.env[`${T}_MCP_URL`] ?? process.env.MCP_GATEWAY_URL;
  const token = process.env[`${T}_MCP_TOKEN`] ?? process.env.MCP_GATEWAY_TOKEN;
  if (!url || !token) {
    console.error(
      `Not configured. The human operator must set environment variables:\n` +
        `  ${T}_MCP_URL   (or MCP_GATEWAY_URL)   — MCP endpoint, e.g. an MCP gateway\n` +
        `  ${T}_MCP_TOKEN (or MCP_GATEWAY_TOKEN) — bearer token for that endpoint\n` +
        `Agent: report this to the user; do not try to work around it.`,
    );
    process.exit(3);
  }
  return { url, token };
}

interface RpcResponse {
  result?: any;
  error?: { code: number; message: string };
}

export class McpClient {
  #sessionId: string | undefined;
  #initialized = false;
  private cfg: McpConfig;
  private extraHeaders: Record<string, string>;

  // note: no TS "parameter properties" — node's strip-only mode rejects them
  constructor(cfg: McpConfig, extraHeaders?: Record<string, string>) {
    this.cfg = cfg;
    this.extraHeaders = extraHeaders ?? {};
  }

  async #post(body: object): Promise<RpcResponse | undefined> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.cfg.token}`,
      ...this.extraHeaders,
    };
    if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;

    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.#sessionId = sid;

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `MCP endpoint denied access (HTTP ${res.status}). The token may be ` +
          `expired or lacks permission. Agent: report this to the user.`,
      );
    }
    if (!res.ok) {
      throw new Error(`MCP endpoint error: HTTP ${res.status} ${await res.text()}`);
    }
    if (res.status === 202) return undefined; // accepted notification

    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      // take the last `data:` line (single-response SSE)
      const datas = text.split("\n").filter((l) => l.startsWith("data:"));
      if (datas.length === 0) throw new Error("Empty SSE response from MCP endpoint");
      return JSON.parse(datas[datas.length - 1].slice(5));
    }
    return text ? JSON.parse(text) : undefined;
  }

  async #init(): Promise<void> {
    if (this.#initialized) return;
    const res = await this.#post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcpeel", version: "0.1" },
      },
    });
    if (res?.error) throw new Error(`MCP initialize failed: ${res.error.message}`);
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.#initialized = true;
  }

  /** Call a tool; returns the parsed JSON of the text content (or raw text). */
  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    await this.#init();
    const res = await this.#post({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    if (res?.error) throw new Error(`${tool}: ${res.error.message}`);
    const content = res?.result?.content?.[0];
    const text: string = content?.text ?? "";
    if (res?.result?.isError) throw new Error(`${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
