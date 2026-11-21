import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as readline from "node:readline";
import { ResolvedServerConfig } from "./McpServerConfig";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_STDERR_BYTES = 8192;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

export class McpToolError extends Error {
  readonly code?: number;
  readonly exitCode?: number;
  readonly toolName?: string;

  constructor(
    message: string,
    opts: { code?: number; exitCode?: number; toolName?: string } = {},
  ) {
    super(message);
    this.name = "McpToolError";
    this.code = opts.code;
    this.exitCode = opts.exitCode;
    this.toolName = opts.toolName;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
  data?: { exit_code?: number };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

function sanitizeSecret(text: string, secret?: string): string {
  if (!secret || !text) return text;
  return text.split(secret).join("[redacted-token]");
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function validateJsonRpcResponse(raw: unknown, expectedId: number): JsonRpcResponse {
  if (!isPlainObject(raw)) {
    throw new McpToolError("Invalid JSON-RPC 2.0 response: expected JSON object");
  }
  if (raw.jsonrpc !== "2.0") {
    throw new McpToolError(
      `Invalid JSON-RPC version "${String(raw.jsonrpc ?? "missing")}" (expected "2.0")`,
    );
  }
  if ("method" in raw) {
    throw new McpToolError("Unexpected JSON-RPC request/notification frame received as response");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "id") || raw.id !== expectedId) {
    throw new McpToolError(
      `JSON-RPC response id mismatch (expected ${expectedId}, got ${String(raw.id)})`,
    );
  }
  const hasResult = Object.prototype.hasOwnProperty.call(raw, "result") && raw.result !== undefined;
  const hasError = Object.prototype.hasOwnProperty.call(raw, "error") && raw.error !== undefined;
  if (hasResult === hasError) {
    throw new McpToolError(
      "Invalid JSON-RPC 2.0 response: expected exactly one of result or error",
    );
  }
  if (hasError && !isPlainObject(raw.error)) {
    throw new McpToolError("Invalid JSON-RPC 2.0 error payload");
  }
  return raw as unknown as JsonRpcResponse;
}

function tryExtractRpcError(raw: unknown, expectedId: number): JsonRpcErrorPayload | null {
  if (!isPlainObject(raw) || raw.jsonrpc !== "2.0" || "method" in raw) return null;
  const idMatches =
    Object.prototype.hasOwnProperty.call(raw, "id") &&
    (raw.id === expectedId || raw.id === null);
  if (!idMatches || !isPlainObject(raw.error)) return null;
  return raw.error as JsonRpcErrorPayload;
}

function parseSseJsonRpc(bodyText: string, expectedId: number): unknown {
  const blocks = bodyText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n").trim();
    if (!rawData) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      continue;
    }
    if (isPlainObject(parsed) && !("method" in parsed) && parsed.id === expectedId) {
      return parsed;
    }
  }
  return null;
}

async function readBoundedResponseText(resp: Response, maxBytes: number): Promise<string> {
  const lenHeader = resp.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await resp.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new McpToolError(
        `MCP HTTP response Content-Length (${declared} bytes) exceeds ${maxBytes}-byte limit`,
      );
    }
  }

  if (!resp.body) {
    const text = await resp.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new McpToolError(`MCP HTTP response exceeds ${maxBytes}-byte limit`);
    }
    return text;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new McpToolError(`MCP HTTP response exceeds ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export class UawMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private stderrTail = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private httpSessionId: string | null = null;
  private negotiatedProtocolVersion: string | null = null;
  private activeControllers = new Set<AbortController>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly config: ResolvedServerConfig,
    private readonly options: {
      clientVersion?: string;
      requestTimeoutMs?: number;
      maxHttpResponseBytes?: number;
    } = {},
  ) {}

  get transport(): ResolvedServerConfig["transport"] {
    return this.config.transport;
  }

  private get maxHttpResponseBytes(): number {
    return this.options.maxHttpResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
  }

  private get timeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private rejectAllPending(reason: string): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, waiter] of entries) {
      clearTimeout(waiter.timer);
      waiter.reject(new McpToolError(reason));
    }
  }

  private terminateChild(proc: ChildProcessWithoutNullStreams): void {
    void this.terminateChildAndWait(proc);
  }

  private terminateChildAndWait(
    proc: ChildProcessWithoutNullStreams,
    graceMs = 1500,
  ): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveExit) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let safetyTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
        proc.removeListener("close", finish);
        proc.removeListener("exit", finish);
        resolveExit();
      };

      proc.once("close", finish);
      proc.once("exit", finish);

      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
        }
      } catch {
        /* ignore */
      }

      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }

      // Ref'd escalation timer ensures SIGKILL runs before extension host shutdown completes.
      killTimer = setTimeout(() => {
        if (settled || proc.exitCode !== null || proc.signalCode !== null) {
          finish();
          return;
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        safetyTimer = setTimeout(finish, 500);
      }, graceMs);
    });
  }

  private resetStdioHandle(): void {
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    this.rl = null;
    this.child = null;
    this.initialized = false;
    this.initPromise = null;
  }

  private ensureStdioProcess(): ChildProcessWithoutNullStreams {
    if (this.disposed) {
      throw new McpToolError("UawMcpClient has been disposed");
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    if (this.child) {
      this.terminateChild(this.child);
      this.resetStdioHandle();
    }
    if (this.config.transport !== "stdio") {
      throw new McpToolError("ensureStdioProcess called on non-stdio config");
    }

    this.stderrTail = "";
    const spawned = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    spawned.stderr.on("data", (chunk: Buffer | string) => {
      if (this.child !== spawned) return;
      const next = this.stderrTail + chunk.toString();
      this.stderrTail =
        next.length > MAX_STDERR_BYTES ? next.slice(next.length - MAX_STDERR_BYTES) : next;
    });

    const rl = readline.createInterface({ input: spawned.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (this.child !== spawned) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isPlainObject(parsed) || "method" in parsed || typeof parsed.id !== "number") {
        return;
      }
      const waiter = this.pending.get(parsed.id);
      if (!waiter) return;
      this.pending.delete(parsed.id);
      clearTimeout(waiter.timer);
      let validated: JsonRpcResponse;
      try {
        validated = validateJsonRpcResponse(parsed, parsed.id);
      } catch (err) {
        waiter.reject(err instanceof Error ? err : new McpToolError(String(err)));
        return;
      }
      if (validated.error) {
        waiter.reject(
          new McpToolError(
            validated.error.message ?? `MCP JSON-RPC error (${validated.error.code ?? -32000})`,
            {
              code: validated.error.code,
              exitCode: validated.error.data?.exit_code,
            },
          ),
        );
      } else {
        waiter.resolve(validated.result);
      }
    });

    spawned.stdin.on("error", (err) => {
      if (this.child !== spawned) return;
      this.rejectAllPending(`MCP server stdin error: ${err.message}`);
      this.terminateChild(spawned);
      this.resetStdioHandle();
    });

    spawned.stdout.on("error", (err) => {
      if (this.child !== spawned) return;
      this.rejectAllPending(`MCP server stdout error: ${err.message}`);
      this.terminateChild(spawned);
      this.resetStdioHandle();
    });

    spawned.once("error", (err) => {
      if (this.child !== spawned) return;
      this.rejectAllPending(`MCP server spawn error: ${err.message}`);
      this.terminateChild(spawned);
      this.resetStdioHandle();
    });

    spawned.once("close", (code, signal) => {
      if (this.child !== spawned) return;
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.rejectAllPending(
        `MCP server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})${suffix}`,
      );
      this.resetStdioHandle();
    });

    this.child = spawned;
    this.rl = rl;
    return spawned;
  }

  private sendStdioRaw(method: string, params: Record<string, unknown>, id?: number): Promise<unknown> {
    const child = this.ensureStdioProcess();
    const payload = JSON.stringify(
      id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params },
    );

    if (id === undefined) {
      return new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(`${payload}\n`, (err) => {
          if (err) rejectWrite(new McpToolError(`Failed writing MCP notification: ${err.message}`));
          else resolveWrite();
        });
      });
    }

    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new McpToolError(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      child.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          rejectReq(new McpToolError(`Failed writing MCP request "${method}": ${err.message}`));
        }
      });
    });
  }

  private async sendHttpRaw(
    method: string,
    params: Record<string, unknown>,
    id?: number,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new McpToolError("UawMcpClient has been disposed");
    }
    if (this.config.transport !== "http") {
      throw new McpToolError("sendHttpRaw called on non-http config");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (method !== "initialize" && this.negotiatedProtocolVersion) {
      headers["MCP-Protocol-Version"] = this.negotiatedProtocolVersion;
    }
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }
    if (this.httpSessionId) {
      headers["Mcp-Session-Id"] = this.httpSessionId;
    }

    const body = JSON.stringify(
      id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params },
    );
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(this.config.url, {
        method: "POST",
        redirect: "error",
        headers,
        body,
        signal: controller.signal,
      });

      const returnedSession = resp.headers.get("mcp-session-id");
      if (returnedSession) {
        this.httpSessionId = returnedSession;
      }
      if (resp.status === 404 && this.httpSessionId) {
        this.httpSessionId = null;
        this.initialized = false;
        this.negotiatedProtocolVersion = null;
      }

      if (id === undefined) {
        if (!resp.ok && resp.status !== 202) {
          const text = sanitizeSecret(
            await readBoundedResponseText(resp, this.maxHttpResponseBytes),
            this.config.authToken,
          );
          throw new McpToolError(`MCP HTTP notification "${method}" failed (${resp.status}): ${text}`);
        }
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        return undefined;
      }

      const rawText = await readBoundedResponseText(resp, this.maxHttpResponseBytes);
      const text = sanitizeSecret(rawText, this.config.authToken);
      const contentType = resp.headers.get("content-type") ?? "";
      let rawRpc: unknown = null;
      if (contentType.includes("text/event-stream")) {
        rawRpc = parseSseJsonRpc(text, id);
      } else if (text.trim()) {
        try {
          rawRpc = JSON.parse(text) as unknown;
        } catch {
          rawRpc = null;
        }
      }

      if (!resp.ok) {
        const rpcErr = tryExtractRpcError(rawRpc, id);
        if (rpcErr) {
          throw new McpToolError(
            sanitizeSecret(
              rpcErr.message ?? `MCP error (${rpcErr.code ?? -32000})`,
              this.config.authToken,
            ),
            {
              code: rpcErr.code,
              exitCode: rpcErr.data?.exit_code,
            },
          );
        }
        throw new McpToolError(
          `MCP HTTP request "${method}" failed with status ${resp.status}${text ? `: ${text}` : ""}`,
        );
      }

      if (rawRpc === null) {
        throw new McpToolError(
          `MCP HTTP request "${method}" returned no matching JSON-RPC 2.0 response for id ${id}`,
        );
      }
      const validated = validateJsonRpcResponse(rawRpc, id);
      if (validated.error) {
        throw new McpToolError(
          sanitizeSecret(
            validated.error.message ?? `MCP error (${validated.error.code ?? -32000})`,
            this.config.authToken,
          ),
          {
            code: validated.error.code,
            exitCode: validated.error.data?.exit_code,
          },
        );
      }
      return validated.result;
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpToolError(
        `MCP HTTP transport error during "${method}": ${sanitizeSecret(msg, this.config.authToken)}`,
      );
    } finally {
      this.activeControllers.delete(controller);
      clearTimeout(timer);
    }
  }

  private sendRaw(method: string, params: Record<string, unknown>, id?: number): Promise<unknown> {
    if (this.config.transport === "http") {
      return this.sendHttpRaw(method, params, id);
    }
    return this.sendStdioRaw(method, params, id);
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new McpToolError("UawMcpClient has been disposed");
    }
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        const initId = this.nextId++;
        const initRes = (await this.sendRaw(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "uwf-companion",
              version: this.options.clientVersion ?? "0.1.0",
            },
          },
          initId,
        )) as { protocolVersion?: unknown } | null | undefined;

        const serverVersion = initRes?.protocolVersion;
        if (serverVersion !== undefined && serverVersion !== null) {
          if (typeof serverVersion !== "string") {
            throw new McpToolError("Invalid MCP protocolVersion from server");
          }
          const trimmedVer = serverVersion.trim();
          if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(trimmedVer) || /[\r\n]/.test(trimmedVer)) {
            throw new McpToolError(`Unsupported MCP protocolVersion from server: "${trimmedVer}"`);
          }
          this.negotiatedProtocolVersion = trimmedVer;
        } else {
          this.negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;
        }

        await this.sendRaw("notifications/initialized", {});
        this.initialized = true;
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  private async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();
    const id = this.nextId++;
    return (await this.sendRaw(method, params, id)) as T;
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const res = await this.request<{ tools?: Array<{ name: string; description?: string }> }>(
      "tools/list",
    );
    return res.tools ?? [];
  }

  async listResources(): Promise<Array<{ uri: string; name?: string; mimeType?: string }>> {
    const res = await this.request<{
      resources?: Array<{ uri: string; name?: string; mimeType?: string }>;
    }>("resources/list");
    return res.resources ?? [];
  }

  async callTool<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await this.request<{
      structuredContent?: T;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    }>("tools/call", { name, arguments: args });

    let payload: T | undefined = res.structuredContent;
    if (payload === undefined) {
      const text = res.content?.[0]?.text;
      if (typeof text === "string" && text.trim()) {
        try {
          payload = JSON.parse(text) as T;
        } catch {
          throw new McpToolError(`Tool "${name}" returned non-JSON content: ${text}`, {
            toolName: name,
          });
        }
      }
    }

    if (res.isError) {
      const rec = (payload ?? {}) as { error?: string; exit_code?: number };
      throw new McpToolError(rec.error || `Tool "${name}" failed`, {
        exitCode: typeof rec.exit_code === "number" ? rec.exit_code : undefined,
        toolName: name,
      });
    }

    return (payload ?? {}) as T;
  }

  async readResource<T = Record<string, unknown>>(uri: string): Promise<T> {
    const res = await this.request<{
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>;
    }>("resources/read", { uri });
    const rawText = res.contents?.[0]?.text;
    if (typeof rawText !== "string") {
      throw new McpToolError(`Resource "${uri}" returned no text payload`);
    }
    return JSON.parse(rawText) as T;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.disposed = true;
      this.initialized = false;
      this.initPromise = null;
      const protoVer = this.negotiatedProtocolVersion;
      this.negotiatedProtocolVersion = null;
      for (const ctrl of this.activeControllers) {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }
      this.activeControllers.clear();
      this.rejectAllPending("UawMcpClient disposed");

      if (this.config.transport === "stdio") {
        const proc = this.child;
        this.resetStdioHandle();
        if (proc) {
          await this.terminateChildAndWait(proc);
        }
        return;
      }

      if (this.config.transport === "http" && this.httpSessionId) {
        const sid = this.httpSessionId;
        this.httpSessionId = null;
        const headers: Record<string, string> = { "Mcp-Session-Id": sid };
        if (protoVer) {
          headers["MCP-Protocol-Version"] = protoVer;
        }
        if (this.config.authToken) {
          headers.Authorization = `Bearer ${this.config.authToken}`;
        }
        try {
          await fetch(this.config.url, {
            method: "DELETE",
            redirect: "error",
            headers,
            signal: AbortSignal.timeout(3_000),
          });
        } catch {
          /* best-effort session teardown */
        }
      }
    })();
    return this.disposePromise;
  }
}
