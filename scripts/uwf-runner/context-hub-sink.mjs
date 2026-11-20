/**
 * context-hub-sink.mjs — Optional, idempotent Context Hub Sink adapter (ADR-0009).
 *
 * Publishes secret-scrubbed provenance envelopes (`stage.completed` checkpoints or
 * `run.finalized` terminal manifests) to a configured global AI Context Hub via
 * `mcp` (`context_hub.ingest_manifest`) or `webhook` (HTTPS POST with HMAC-SHA256).
 *
 * Environment configuration:
 *   UAW_CONTEXT_HUB_SINK   none (default) | mcp | webhook
 *   UAW_CONTEXT_HUB_URL    endpoint URL (https:// required; http://127.0.0.1 allowed for loopback tests)
 *   UAW_CONTEXT_HUB_TOKEN  HMAC-SHA256 signing key (webhook) or Bearer token (mcp); never persisted
 *   UAW_CONTEXT_HUB_MODE   best_effort (default) | strict (exit 1 on delivery failure)
 */

import { createHash, createHmac } from "node:crypto";
import { redactSecrets } from "../hooks/secret-patterns.mjs";

const VALID_SINKS = new Set(["none", "mcp", "webhook"]);
const VALID_MODES = new Set(["best_effort", "strict"]);
const MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

// ---------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme (JCS) & Hashing
// ---------------------------------------------------------------------------

/** UTF-16 code-unit comparison per RFC 8785 §3.2.3 (never localeCompare). */
export function compareUtf16(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Serialize a JSON-compatible value per RFC 8785 JCS:
 * - Object keys sorted by UTF-16 code units
 * - IEEE 754 numbers (ECMAScript shortest round-trip; -0 -> 0; NaN/Infinity rejected)
 * - Verbatim Unicode code points with NO NFC/NFD normalization pass
 * - Zero insignificant whitespace
 */
export function canonicalizeJcs(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`RFC 8785 JCS cannot serialize non-finite number: ${value}`);
    }
    if (Object.is(value, -0) || value === 0) return "0";
    return JSON.stringify(value);
  }
  if (t === "string") {
    // JSON.stringify preserves Unicode code points verbatim without normalization.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        return "null";
      }
      return canonicalizeJcs(item);
    });
    return `[${items.join(",")}]`;
  }
  if (t === "object") {
    if (typeof value.toJSON === "function") {
      return canonicalizeJcs(value.toJSON());
    }
    const keys = Object.keys(value)
      .filter((k) => {
        const v = value[k];
        return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
      })
      .sort(compareUtf16);
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(value[k])}`);
    return `{${pairs.join(",")}}`;
  }
  throw new TypeError(`RFC 8785 JCS cannot serialize value of type ${t}`);
}

/** Lowercase hex SHA-256 over a Buffer or UTF-8 string. */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Recursively scrub every string leaf through redactSecrets(). */
export function scrubDeep(value) {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: scrubDeep(v),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Configuration, URL Policy & Idempotency
// ---------------------------------------------------------------------------

export function readSinkConfig(env = process.env) {
  const rawSink = String(env.UAW_CONTEXT_HUB_SINK ?? "none").trim().toLowerCase() || "none";
  const sink = VALID_SINKS.has(rawSink) ? rawSink : rawSink;
  const rawMode = String(env.UAW_CONTEXT_HUB_MODE ?? "best_effort").trim().toLowerCase() || "best_effort";
  return {
    sink,
    url: String(env.UAW_CONTEXT_HUB_URL ?? "").trim(),
    token: String(env.UAW_CONTEXT_HUB_TOKEN ?? ""),
    mode: rawMode,
  };
}

/**
 * Deterministic idempotency key: sha256("${run_id}:${stage}:${sha256}").
 */
export function computeIdempotencyKey(runId, stage, sha256) {
  if (!runId || !stage || !sha256) {
    throw new Error("computeIdempotencyKey requires non-empty runId, stage, and sha256");
  }
  return sha256Hex(`${runId}:${stage}:${sha256}`);
}

/**
 * Validate webhook/MCP HTTP endpoint URL.
 * Requires https:// except http://127.0.0.1 (loopback testing only).
 */
export function validateSinkUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") {
    throw new Error("UAW_CONTEXT_HUB_URL is required when UAW_CONTEXT_HUB_SINK is enabled");
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid UAW_CONTEXT_HUB_URL: ${urlStr}`);
  }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
    return parsed.toString();
  }
  throw new Error(
    `Unsafe UAW_CONTEXT_HUB_URL protocol/host (${parsed.protocol}//${parsed.hostname}): https:// is required (http://127.0.0.1 allowed for local loopback testing only)`
  );
}

/** HMAC-SHA256 signature header value for X-UAW-Signature-256. */
export function signWebhookPayload(canonicalBody, token) {
  const mac = createHmac("sha256", String(token)).update(canonicalBody, "utf8").digest("hex");
  return `sha256=${mac}`;
}

/**
 * Build a scrubbed, deterministic Context Hub Sink envelope.
 */
export function buildSinkEnvelope({ event, runId, workflow, stage, sha256, deliverableKey = null, payload }) {
  const idempotency_key = computeIdempotencyKey(runId, stage, sha256);
  const envelope = scrubDeep({
    schema_version: "1.0.0",
    event,
    run_id: runId,
    workflow,
    stage,
    deliverable_key: deliverableKey,
    dedup_tuple: {
      run_id: runId,
      stage,
      sha256,
    },
    idempotency_key,
    payload,
  });
  return envelope;
}

function sanitizeError(err, token) {
  let msg = String(err?.message ?? err ?? "unknown error");
  if (token && token.length > 0) {
    msg = msg.split(token).join("***");
  }
  return redactSecrets(msg).text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateMcpPayload(parsed, token, { requireJsonRpcResult = false } = {}) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("MCP sink returned non-object JSON payload");
  }
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    const err = new Error(sanitizeError(`MCP JSON-RPC error (${code}): ${msg}`, token));
    if (typeof code === "number" && code >= -32602 && code <= -32600) err.noRetry = true;
    throw err;
  }
  if (requireJsonRpcResult && (!Object.hasOwn(parsed, "result") || parsed.result === null || typeof parsed.result !== "object")) {
    throw new Error("MCP JSON-RPC response missing result object");
  }
  const toolResult = parsed.result !== undefined ? parsed.result : parsed;
  if (toolResult && typeof toolResult === "object") {
    if (toolResult.error) {
      const msg = toolResult.error.message ?? JSON.stringify(toolResult.error);
      throw new Error(sanitizeError(`MCP tool error: ${msg}`, token));
    }
    if (toolResult.isError === true) {
      const textPart = Array.isArray(toolResult.content)
        ? toolResult.content.map((c) => c?.text ?? "").filter(Boolean).join(" ")
        : "";
      const err = new Error(sanitizeError(`MCP tool returned isError=true${textPart ? `: ${textPart}` : ""}`, token));
      err.noRetry = true;
      throw err;
    }
    if (toolResult.ok === false) {
      throw new Error(sanitizeError(`MCP sink reported ok=false: ${toolResult.error ?? "rejected"}`, token));
    }
  }
  return toolResult;
}

async function parseMcpHttpResponse(res, token, { expectedId = null } = {}) {
  const contentType = String(res.headers?.get?.("content-type") ?? "").toLowerCase();
  let parsed;
  if (typeof res.text === "function") {
    const rawText = (await res.text()).trim();
    if (!rawText) {
      throw new Error("Empty response body from MCP sink");
    }
    if (contentType.includes("text/event-stream") || /^(?:event:|data:)/m.test(rawText)) {
      const dataLines = rawText
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) {
        throw new Error("Empty SSE stream response from MCP sink");
      }
      const parsedMessages = [];
      for (const line of dataLines) {
        try {
          parsedMessages.push(JSON.parse(line));
        } catch {
          throw new Error("Invalid JSON in MCP SSE response");
        }
      }
      parsed =
        (expectedId !== null
          ? parsedMessages.findLast((m) => m && typeof m === "object" && m.id === expectedId)
          : null) ?? parsedMessages[parsedMessages.length - 1];
    } else {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error("Invalid JSON response from MCP sink");
      }
    }
  } else if (typeof res.json === "function") {
    parsed = await res.json();
  } else {
    throw new Error("Unreadable response object from MCP sink");
  }
  const validated = validateMcpPayload(parsed, token, { requireJsonRpcResult: true });
  if (expectedId !== null && Object.hasOwn(parsed, "id") && parsed.id !== expectedId) {
    throw new Error(`MCP JSON-RPC response id mismatch (expected ${expectedId}, got ${parsed.id})`);
  }
  return validated;
}

function isRetryableClientStatus(status) {
  return status === 408 || status === 425 || status === 429;
}

function extractMcpSessionId(headers) {
  const raw =
    headers?.get?.("mcp-session-id") ??
    headers?.["mcp-session-id"] ??
    headers?.["Mcp-Session-Id"] ??
    null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

async function sendMcpHttpStep(
  fetchImpl,
  targetUrl,
  { headers, body, timeoutMs, token, expectJsonRpcResult, expectedId = null },
) {
  const res = await fetchImpl(targetUrl, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const sessionId = extractMcpSessionId(res.headers);
  if (!res.ok) {
    const respText = typeof res.text === "function" ? (await res.text()).slice(0, 200) : "";
    const err = new Error(sanitizeError(`HTTP ${res.status}${respText ? `: ${respText}` : ""}`, token));
    // Do not retry non-transient 4xx client errors.
    if (res.status >= 400 && res.status < 500 && !isRetryableClientStatus(res.status)) err.noRetry = true;
    throw err;
  }
  if (expectJsonRpcResult) {
    const payload = await parseMcpHttpResponse(res, token, { expectedId });
    return { res, payload, sessionId };
  }
  const contentType = String(res.headers?.get?.("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    await res.body?.cancel?.().catch(() => {});
  } else if (typeof res.text === "function") {
    const rawText = (await res.text()).trim();
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object" && parsed.error) {
          validateMcpPayload(parsed, token, { requireJsonRpcResult: false });
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) {
          throw err;
        }
      }
    }
  }
  return { res, payload: null, sessionId };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a provenance envelope to the configured Context Hub Sink.
 *
 * Returns:
 *   { ok, status: "disabled"|"delivered"|"failed", idempotency_key, attempts, strict, exitCode, error? }
 */
export async function dispatchToContextHub(
  envelope,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    mcpClient = null,
    maxAttempts = 3,
    baseDelayMs = 150,
    timeoutMs = 15_000,
    log = (msg) => process.stderr.write(msg + "\n"),
  } = {}
) {
  const cfg = readSinkConfig(env);
  const idempotencyKey = envelope.idempotency_key;

  if (!VALID_MODES.has(cfg.mode)) {
    const error = `Unknown UAW_CONTEXT_HUB_MODE "${cfg.mode}" (expected best_effort|strict)`;
    log(`[context-hub-sink] ${error}`);
    return {
      ok: false,
      status: "failed",
      idempotency_key: idempotencyKey,
      attempts: 0,
      strict: true,
      exitCode: 1,
      error,
    };
  }

  const strict = cfg.mode === "strict";

  // Zero-overhead no-op default: make zero network calls when unset or "none".
  if (cfg.sink === "none") {
    return {
      ok: true,
      status: "disabled",
      idempotency_key: idempotencyKey,
      attempts: 0,
      strict,
      exitCode: 0,
    };
  }

  if (!VALID_SINKS.has(cfg.sink)) {
    const error = `Unknown UAW_CONTEXT_HUB_SINK "${cfg.sink}" (expected none|mcp|webhook)`;
    log(`[context-hub-sink] ${error}`);
    return {
      ok: false,
      status: "failed",
      idempotency_key: idempotencyKey,
      attempts: 0,
      strict,
      exitCode: strict ? 1 : 0,
      error,
    };
  }

  // Always scrub before serialization and serialize deterministically per RFC 8785 JCS.
  const scrubbedEnvelope = scrubDeep(envelope);
  const canonicalBody = canonicalizeJcs(scrubbedEnvelope);

  let lastError = null;
  let attempts = 0;

  try {
    if (cfg.sink === "mcp" && mcpClient && typeof mcpClient.callTool === "function") {
      // Direct injectable MCP client (local or in-process transport).
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          const result = await mcpClient.callTool("context_hub.ingest_manifest", scrubbedEnvelope);
          if (result !== undefined && result !== null) {
            validateMcpPayload(result, cfg.token);
          }
          return {
            ok: true,
            status: "delivered",
            idempotency_key: idempotencyKey,
            attempts,
            strict,
            exitCode: 0,
            response: result ?? null,
          };
        } catch (err) {
          lastError = sanitizeError(err, cfg.token);
          if (err?.noRetry) break;
          if (attempt < maxAttempts) await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
      }
    } else {
      const targetUrl = validateSinkUrl(cfg.url);
      if (typeof fetchImpl !== "function") {
        throw new Error("Fetch API is unavailable in this Node runtime");
      }

      if (cfg.sink === "mcp") {
        const baseHeaders = {
          "Content-Type": "application/json",
          Accept: MCP_ACCEPT_HEADER,
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        };
        const initBody = canonicalizeJcs({
          jsonrpc: "2.0",
          id: `init-${idempotencyKey}`,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "uaw-context-hub-sink", version: "1.0.0" },
          },
        });
        const notifBody = canonicalizeJcs({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        const callBody = canonicalizeJcs({
          jsonrpc: "2.0",
          id: idempotencyKey,
          method: "tools/call",
          params: {
            name: "context_hub.ingest_manifest",
            arguments: scrubbedEnvelope,
          },
        });

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          attempts = attempt;
          try {
            const initId = `init-${idempotencyKey}`;
            const initStep = await sendMcpHttpStep(fetchImpl, targetUrl, {
              headers: baseHeaders,
              body: initBody,
              timeoutMs,
              token: cfg.token,
              expectJsonRpcResult: true,
              expectedId: initId,
            });
            const serverVersion = initStep.payload?.protocolVersion;
            if (typeof serverVersion === "string") {
              const trimmedVer = serverVersion.trim();
              if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(trimmedVer) || /[\r\n]/.test(trimmedVer)) {
                const err = new Error(`Unsupported MCP protocolVersion from sink: "${trimmedVer}"`);
                err.noRetry = true;
                throw err;
              }
            }
            const negotiatedVersion =
              typeof serverVersion === "string" ? serverVersion.trim() : MCP_PROTOCOL_VERSION;
            let sessionId = initStep.sessionId;

            const notifHeaders = {
              ...baseHeaders,
              "MCP-Protocol-Version": negotiatedVersion,
              ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            };
            const notifStep = await sendMcpHttpStep(fetchImpl, targetUrl, {
              headers: notifHeaders,
              body: notifBody,
              timeoutMs,
              token: cfg.token,
              expectJsonRpcResult: false,
            });
            sessionId = notifStep.sessionId ?? sessionId;

            const callHeaders = {
              ...baseHeaders,
              "MCP-Protocol-Version": negotiatedVersion,
              "Idempotency-Key": idempotencyKey,
              ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            };
            const callStep = await sendMcpHttpStep(fetchImpl, targetUrl, {
              headers: callHeaders,
              body: callBody,
              timeoutMs,
              token: cfg.token,
              expectJsonRpcResult: true,
              expectedId: idempotencyKey,
            });
            return {
              ok: true,
              status: "delivered",
              idempotency_key: idempotencyKey,
              attempts,
              strict,
              exitCode: 0,
              http_status: callStep.res.status,
              ...(callStep.payload !== null ? { response: callStep.payload } : {}),
            };
          } catch (err) {
            lastError = sanitizeError(err, cfg.token);
            if (err?.noRetry) break;
          }
          if (attempt < maxAttempts) await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
      } else {
        if (!cfg.token || !cfg.token.trim()) {
          throw new Error("UAW_CONTEXT_HUB_TOKEN is required when UAW_CONTEXT_HUB_SINK=webhook");
        }
        const headers = {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-UAW-Signature-256": signWebhookPayload(canonicalBody, cfg.token),
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          attempts = attempt;
          try {
            const res = await fetchImpl(targetUrl, {
              method: "POST",
              headers,
              body: canonicalBody,
              redirect: "error",
              ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });
            if (res.ok) {
              return {
                ok: true,
                status: "delivered",
                idempotency_key: idempotencyKey,
                attempts,
                strict,
                exitCode: 0,
                http_status: res.status,
              };
            }
            const respText = typeof res.text === "function" ? (await res.text()).slice(0, 200) : "";
            lastError = sanitizeError(`HTTP ${res.status}${respText ? `: ${respText}` : ""}`, cfg.token);
            // Do not retry non-transient 4xx client errors.
            if (res.status >= 400 && res.status < 500 && !isRetryableClientStatus(res.status)) break;
          } catch (err) {
            lastError = sanitizeError(err, cfg.token);
            if (err?.noRetry) break;
          }
          if (attempt < maxAttempts) await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
      }
    }
  } catch (err) {
    lastError = sanitizeError(err, cfg.token);
  }

  log(`[context-hub-sink] delivery failed (${cfg.sink}, mode=${cfg.mode}): ${lastError}`);
  return {
    ok: false,
    status: "failed",
    idempotency_key: idempotencyKey,
    attempts,
    strict,
    exitCode: strict ? 1 : 0,
    error: lastError,
  };
}
