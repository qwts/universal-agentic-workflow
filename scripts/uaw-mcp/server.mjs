#!/usr/bin/env node
/**
 * server.mjs — Standalone `uaw-mcp/v1` MCP server supporting both `stdio` and
 * Streamable HTTP / SSE transports (ADR-0008).
 *
 * Usage:
 *   node scripts/uaw-mcp/server.mjs --transport stdio [--allowed-roots dir1,dir2] [--state-dir dir]
 *   node scripts/uaw-mcp/server.mjs --transport http [--host 127.0.0.1] [--port 8787]
 *     [--auth-token <token>] [--allowed-origins <o1,o2>] [--allowed-roots <dir1,dir2>] [--state-dir <dir>]
 *
 * Security invariants:
 *   - HTTP binds to `127.0.0.1` by default; binding to any non-loopback address
 *     without `--auth-token` / `UAW_MCP_AUTH_TOKEN` is refused.
 *   - Bearer token comparison uses `crypto.timingSafeEqual`.
 *   - `Origin` header is validated on all HTTP requests when present (rejects
 *     disallowed origins with HTTP 403).
 *   - `repo_root`, `data_dir`, `output_path`, and `skills_root` are constrained
 *     to `--allowed-roots` / `UAW_MCP_ALLOWED_ROOTS` when configured.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, createMcpHandler } from "./protocol.mjs";

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function verifyBearerToken(authHeader, expectedToken) {
  if (!expectedToken) return true;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authHeader.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

const ORIGIN_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:?#\s]+)(?::(\d+))?$/;

function parseOriginTuple(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(ORIGIN_RE);
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: m[2].toLowerCase(),
    port: m[3] ?? "",
  };
}

function matchOriginPattern(origin, pattern) {
  if (pattern === "*") return true;
  const parsedOrigin = parseOriginTuple(origin);
  if (!parsedOrigin) return false;

  // Scheme wildcard: <scheme>://* (e.g., chrome-extension://*)
  const schemeWild = pattern.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/\*$/);
  if (schemeWild) {
    return parsedOrigin.scheme === schemeWild[1].toLowerCase();
  }

  // Port wildcard: <scheme>://<host>:* (e.g., http://127.0.0.1:*)
  const portWild = pattern.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:?#\s*]+):\*$/);
  if (portWild) {
    return (
      parsedOrigin.scheme === portWild[1].toLowerCase() &&
      parsedOrigin.host === portWild[2].toLowerCase()
    );
  }

  // Subdomain wildcard: <scheme>://*.<domain>[:<port>]
  const subWild = pattern.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/\*\.([^/:?#\s*]+)(?::(\d+))?$/);
  if (subWild) {
    const domain = subWild[2].toLowerCase();
    return (
      parsedOrigin.scheme === subWild[1].toLowerCase() &&
      parsedOrigin.host.endsWith(`.${domain}`) &&
      parsedOrigin.host.length > domain.length + 1 &&
      (!subWild[3] || parsedOrigin.port === subWild[3])
    );
  }

  // Exact origin only (rejects unsafe host-prefix wildcards like https://example.com*)
  const parsedPattern = parseOriginTuple(pattern);
  if (!parsedPattern) return false;
  return (
    parsedOrigin.scheme === parsedPattern.scheme &&
    parsedOrigin.host === parsedPattern.host &&
    parsedOrigin.port === parsedPattern.port
  );
}

export function isOriginAllowed(origin, allowedOrigins = []) {
  if (!origin) return true;
  if (allowedOrigins.length > 0) {
    return allowedOrigins.some((pattern) => matchOriginPattern(origin, pattern));
  }
  // Default policy when Origin header is present: allow only loopback origins.
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
}

/**
 * Start the `stdio` JSON-RPC 2.0 transport over `input`/`output` streams.
 */
export function startStdioServer({
  allowedRoots = [],
  stateDir,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const handler = createMcpHandler({ allowedRoots, stateDir });
  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      const errResp = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      output.write(JSON.stringify(errResp) + "\n");
      return;
    }
    handler.handleJsonRpc(msg).then((resp) => {
      if (resp !== null) {
        output.write(JSON.stringify(resp) + "\n");
      }
    });
  });

  return { close: () => rl.close() };
}

/**
 * Create and start the Streamable HTTP + SSE MCP server.
 */
export function startHttpServer({
  host = "127.0.0.1",
  port = 8787,
  authToken = process.env.UAW_MCP_AUTH_TOKEN || "",
  allowedOrigins = [],
  allowedRoots = [],
  stateDir,
} = {}) {
  if (!LOOPBACK_HOSTS.has(host) && !authToken) {
    throw new Error(
      `Refusing to bind HTTP server to non-loopback host "${host}" without --auth-token or UAW_MCP_AUTH_TOKEN`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host) && (!Array.isArray(allowedRoots) || allowedRoots.length === 0)) {
    throw new Error(
      `Refusing to bind HTTP server to non-loopback host "${host}" without --allowed-roots or UAW_MCP_ALLOWED_ROOTS`,
    );
  }

  const handler = createMcpHandler({ allowedRoots, stateDir });
  const sessions = new Map(); // sessionId -> Set<http.ServerResponse>

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const origin = req.headers.origin;

    // 1. Origin validation (protects against cross-site / DNS-rebinding calls)
    if (!isOriginAllowed(origin, allowedOrigins)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }

    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint (loopback/monitoring)
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, contract: CONTRACT_VERSION }));
      return;
    }

    // 2. Constant-time bearer authentication
    if (!verifyBearerToken(req.headers.authorization, authToken)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="uaw-mcp"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Streamable HTTP SSE channel: GET /mcp
    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] || randomUUID();
      if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Mcp-Session-Id": sessionId,
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ session_id: sessionId, contract: CONTRACT_VERSION })}\n\n`);
      const clients = sessions.get(sessionId);
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
        if (clients.size === 0) sessions.delete(sessionId);
      });
      return;
    }

    // Session teardown: DELETE /mcp
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId && sessions.has(sessionId)) {
        for (const client of sessions.get(sessionId)) {
          try { client.end(); } catch { /* ignore */ }
        }
        sessions.delete(sessionId);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // JSON-RPC 2.0 POST /mcp (returns application/json or text/event-stream)
    if (req.method === "POST") {
      const chunks = [];
      let totalBytes = 0;
      let tooLarge = false;

      req.on("data", (chunk) => {
        if (tooLarge) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_HTTP_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
            res.end(JSON.stringify({ error: "Payload too large" }), () => req.destroy());
          } else {
            req.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", async () => {
        if (tooLarge || res.writableEnded) return;

        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
          return;
        }

        const sessionId = req.headers["mcp-session-id"] || randomUUID();
        const response = await handler.handleJsonRpc(body);
        if (response === null) {
          res.writeHead(202, { "Mcp-Session-Id": sessionId });
          res.end();
          return;
        }

        const accept = String(req.headers.accept ?? "");
        if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Mcp-Session-Id": sessionId,
          });
          res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          res.end();
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        });
        res.end(JSON.stringify(response));
      });
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      const addr = server.address();
      resolvePromise({
        server,
        host: typeof addr === "object" && addr ? addr.address : host,
        port: typeof addr === "object" && addr ? addr.port : port,
        close: () =>
          new Promise((resClose) => {
            for (const clients of sessions.values()) {
              for (const c of clients) {
                try { c.end(); } catch { /* ignore */ }
              }
            }
            sessions.clear();
            server.close(() => resClose());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

function parseCliArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function splitCsv(val) {
  if (!val || typeof val !== "string") return [];
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));
  const transport = String(flags.transport ?? process.env.UAW_MCP_TRANSPORT ?? "stdio");
  const allowedRoots = splitCsv(flags["allowed-roots"] ?? process.env.UAW_MCP_ALLOWED_ROOTS ?? "");
  const stateDir = typeof flags["state-dir"] === "string" ? flags["state-dir"] : undefined;

  if (transport === "stdio") {
    startStdioServer({ allowedRoots, stateDir });
    return;
  }

  if (transport === "http") {
    const host = String(flags.host ?? process.env.UAW_MCP_HOST ?? "127.0.0.1");
    const port = Number(flags.port ?? process.env.UAW_MCP_PORT ?? 8787);
    const authToken = String(flags["auth-token"] ?? process.env.UAW_MCP_AUTH_TOKEN ?? "");
    const allowedOrigins = splitCsv(
      flags["allowed-origins"] ?? process.env.UAW_MCP_ALLOWED_ORIGINS ?? "",
    );
    const started = await startHttpServer({
      host,
      port,
      authToken,
      allowedOrigins,
      allowedRoots,
      stateDir,
    });
    process.stderr.write(
      `[uaw-mcp] listening on http://${started.host}:${started.port}/mcp (${CONTRACT_VERSION})\n`,
    );
    return;
  }

  process.stderr.write(`[uaw-mcp] unknown transport "${transport}" (expected stdio or http)\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[uaw-mcp] fatal: ${err.message}\n`);
    process.exit(2);
  });
}
