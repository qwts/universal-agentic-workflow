import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import {
  buildSinkEnvelope,
  canonicalizeJcs,
  computeIdempotencyKey,
  dispatchToContextHub,
  signWebhookPayload,
  validateSinkUrl,
} from "../context-hub-sink.mjs";

// Synthetic tokens assembled at runtime so no secret literal sits in the repo.
const FAKE_OPENAI = "sk-" + "Qw3Er4Ty5Ui6Op7As8Df9Gh0Jk1Lz2Xc";
const FAKE_BEARER = "Bearer " + "eyJhbGciOiJIUzI1NiJ9.payload-part.sig_part-1234";
const HUB_SECRET = "uaw-test-hmac-secret-key";

// ---------------------------------------------------------------------------
// 1. URL Policy: HTTPS required except http://127.0.0.1 loopback
// ---------------------------------------------------------------------------
assert.equal(validateSinkUrl("https://hub.example.com/ingest"), "https://hub.example.com/ingest");
assert.equal(validateSinkUrl("http://127.0.0.1:9999/hook"), "http://127.0.0.1:9999/hook");
assert.throws(() => validateSinkUrl("http://example.com/hook"), /https:\/\/ is required/);
assert.throws(() => validateSinkUrl("http://localhost:9999/hook"), /https:\/\/ is required/);
assert.throws(() => validateSinkUrl("file:///etc/passwd"), /https:\/\/ is required/);
assert.throws(() => validateSinkUrl(""), /required/);

// ---------------------------------------------------------------------------
// 2. Zero-overhead no-op when UAW_CONTEXT_HUB_SINK is unset or "none"
// ---------------------------------------------------------------------------
const baseEnvelope = buildSinkEnvelope({
  event: "run.finalized",
  runId: "run-abc-123",
  workflow: "sw_dev",
  stage: "seal",
  sha256: "f".repeat(64),
  deliverableKey: "qwts/uaw@deadbeef",
  payload: {
    note: `Leak test: ${FAKE_OPENAI} and ${FAKE_BEARER}`,
    adr: "ADR-0009",
  },
});

const envelopeJson = canonicalizeJcs(baseEnvelope);
assert.ok(!envelopeJson.includes(FAKE_OPENAI), "OpenAI key leaked into envelope");
assert.ok(!envelopeJson.includes(FAKE_BEARER.slice(7)), "Bearer token leaked into envelope");
assert.ok(envelopeJson.includes("[redacted:openai-key]"));
assert.ok(envelopeJson.includes("[redacted:bearer-token]"));

const forbidFetch = async () => { throw new Error("Network I/O must not happen when sink is disabled"); };
{
  const r1 = await dispatchToContextHub(baseEnvelope, { env: {}, fetchImpl: forbidFetch });
  assert.equal(r1.ok, true);
  assert.equal(r1.status, "disabled");
  assert.equal(r1.attempts, 0);
  assert.equal(r1.exitCode, 0);

  const r2 = await dispatchToContextHub(baseEnvelope, { env: { UAW_CONTEXT_HUB_SINK: "none" }, fetchImpl: forbidFetch });
  assert.equal(r2.ok, true);
  assert.equal(r2.status, "disabled");
  assert.equal(r2.attempts, 0);
}

// ---------------------------------------------------------------------------
// 3. Deterministic Idempotency Key + Live Loopback Webhook (HMAC-SHA256 + Dedup + Retry)
// ---------------------------------------------------------------------------
{
  const expectedKey = computeIdempotencyKey("run-abc-123", "seal", "f".repeat(64));
  assert.equal(baseEnvelope.idempotency_key, expectedKey);
  assert.deepEqual(baseEnvelope.dedup_tuple, {
    run_id: "run-abc-123",
    stage: "seal",
    sha256: "f".repeat(64),
  });

  const received = [];
  const dedupStore = new Map();
  let failOnce = true;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/webhook-flaky" && failOnce) {
        failOnce = false;
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("temporary unavailable");
        return;
      }
      if (req.url === "/fail-500") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error");
        return;
      }
      if (req.url === "/mcp-rpc-error") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32603, message: "hub down" } }));
        return;
      }
      if (req.url === "/mcp-is-error") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { isError: true, content: [{ type: "text", text: "rejected manifest" }] },
        }));
        return;
      }
      if (req.url === "/mcp-bad-json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not-json");
        return;
      }
      if (req.url === "/mcp-no-result") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ unrelated: 1 }));
        return;
      }
      if (req.url === "/redirect-http") {
        res.writeHead(302, { Location: "http://example.com/hook" });
        res.end();
        return;
      }
      const key = req.headers["idempotency-key"];
      const sig = req.headers["x-uaw-signature-256"];
      received.push({
        url: req.url,
        key,
        sig,
        auth: req.headers["authorization"],
        accept: req.headers["accept"],
        sessionId: req.headers["mcp-session-id"] ?? null,
        body,
      });
      if (key && !dedupStore.has(key)) {
        dedupStore.set(key, body);
      }
      if (req.url === "/mcp-session") {
        const accept = String(req.headers["accept"] ?? "");
        if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
          res.writeHead(406, { "Content-Type": "text/plain" });
          res.end("Not Acceptable: must accept application/json and text/event-stream");
          return;
        }
        const rpcReq = JSON.parse(body);
        if (rpcReq.method === "initialize") {
          dedupStore.set("mcp-session:hub-sess-42", { initialized: false });
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "hub-sess-42" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: rpcReq.id,
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "session-hub", version: "1.0.0" } },
          }));
          return;
        }
        const sid = req.headers["mcp-session-id"];
        const sessState = dedupStore.get(`mcp-session:${sid}`);
        if (!sessState) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing or unknown Mcp-Session-Id");
          return;
        }
        if (rpcReq.method === "notifications/initialized" && !Object.hasOwn(rpcReq, "id")) {
          sessState.initialized = true;
          res.writeHead(202, { "Mcp-Session-Id": sid });
          res.end();
          return;
        }
        if (!sessState.initialized) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("MCP session not initialized");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id, result: { ok: true, session: sid } }));
        return;
      }
      if (req.url === "/mcp") {
        const rpcReq = JSON.parse(body);
        if (!Object.hasOwn(rpcReq, "id")) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        const result = rpcReq.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock-hub", version: "1.0.0" } }
          : { ok: true, deduplicated: dedupStore.size };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id, result }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deduplicated: dedupStore.size }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res1 = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook-flaky`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "strict",
      },
      baseDelayMs: 10,
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.status, "delivered");
    assert.equal(res1.attempts, 2, "Should retry once after 503");
    assert.equal(res1.exitCode, 0);

    const res2 = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook-flaky`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "strict",
      },
      baseDelayMs: 10,
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.idempotency_key, res1.idempotency_key);
    assert.equal(dedupStore.size, 1, "Idempotent replay must not create duplicate records");

    const wire = received[0];
    const expectedSig = "sha256=" + createHmac("sha256", HUB_SECRET).update(wire.body, "utf8").digest("hex");
    assert.equal(wire.sig, expectedSig);
    assert.equal(wire.sig, signWebhookPayload(wire.body, HUB_SECRET));
    assert.ok(!wire.body.includes(FAKE_OPENAI));
    assert.ok(!wire.body.includes(FAKE_BEARER.slice(7)));

    const logs = [];
    const bestEffortFail = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/fail-500`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "best_effort",
      },
      maxAttempts: 2,
      baseDelayMs: 5,
      log: (m) => logs.push(m),
    });
    assert.equal(bestEffortFail.ok, false);
    assert.equal(bestEffortFail.status, "failed");
    assert.equal(bestEffortFail.attempts, 2);
    assert.equal(bestEffortFail.exitCode, 0, "best_effort must not fail the run");
    assert.ok(logs.length > 0 && !logs.join("\n").includes(HUB_SECRET));

    const strictFail = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/fail-500`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "strict",
      },
      maxAttempts: 2,
      baseDelayMs: 5,
      log: () => {},
    });
    assert.equal(strictFail.ok, false);
    assert.equal(strictFail.status, "failed");
    assert.equal(strictFail.attempts, 2);
    assert.equal(strictFail.exitCode, 1, "strict mode must return exit code 1 (GATE)");

    const mcpHttpRes = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "mcp",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/mcp`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
      },
      baseDelayMs: 5,
    });
    assert.equal(mcpHttpRes.ok, true);
    assert.equal(mcpHttpRes.status, "delivered");
    const mcpWires = received.filter((r) => r.url === "/mcp");
    assert.deepEqual(
      mcpWires.map((w) => JSON.parse(w.body).method),
      ["initialize", "notifications/initialized", "tools/call"],
      "HTTP MCP sink must perform initialize -> notifications/initialized -> tools/call handshake",
    );
    assert.equal(mcpWires[0].key, undefined, "initialize must not carry Idempotency-Key");
    assert.equal(mcpWires[1].key, undefined, "notifications/initialized must not carry Idempotency-Key");
    assert.equal(mcpWires[2].key, expectedKey);
    const parsedRpc = JSON.parse(mcpWires[2].body);
    assert.equal(parsedRpc.method, "tools/call");
    assert.equal(parsedRpc.params.name, "context_hub.ingest_manifest");
    assert.equal(parsedRpc.params.arguments.idempotency_key, expectedKey);
    assert.equal(mcpWires[2].auth, `Bearer ${HUB_SECRET}`);

    const mcpSessionRes = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "mcp",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/mcp-session`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "strict",
      },
      baseDelayMs: 5,
    });
    assert.equal(mcpSessionRes.ok, true, mcpSessionRes.error ?? "");
    assert.equal(mcpSessionRes.status, "delivered");
    assert.equal(mcpSessionRes.response?.session, "hub-sess-42");
    const sessWires = received.filter((r) => r.url === "/mcp-session");
    assert.deepEqual(
      sessWires.map((w) => [JSON.parse(w.body).method, w.sessionId]),
      [
        ["initialize", null],
        ["notifications/initialized", "hub-sess-42"],
        ["tools/call", "hub-sess-42"],
      ],
    );

    const mcpCalls = [];
    const mcpClientRes = await dispatchToContextHub(baseEnvelope, {
      env: { UAW_CONTEXT_HUB_SINK: "mcp" },
      mcpClient: {
        callTool: async (name, args) => {
          mcpCalls.push({ name, args });
          return { ingested: true };
        },
      },
    });
    assert.equal(mcpClientRes.ok, true);
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].name, "context_hub.ingest_manifest");
    assert.equal(mcpCalls[0].args.idempotency_key, expectedKey);

    // 4. Webhook without UAW_CONTEXT_HUB_TOKEN must fail closed without sending an unsigned payload
    const prevReceivedCount = received.length;
    const unsignedStrict = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook-flaky`,
        UAW_CONTEXT_HUB_MODE: "strict",
      },
      baseDelayMs: 5,
      log: () => {},
    });
    assert.equal(unsignedStrict.ok, false);
    assert.equal(unsignedStrict.status, "failed");
    assert.equal(unsignedStrict.exitCode, 1);
    assert.equal(unsignedStrict.attempts, 0);
    assert.match(unsignedStrict.error, /UAW_CONTEXT_HUB_TOKEN is required/);
    assert.equal(received.length, prevReceivedCount, "no unsigned webhook request may be transmitted");

    const unsignedBestEffort = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook-flaky`,
        UAW_CONTEXT_HUB_MODE: "best_effort",
      },
      baseDelayMs: 5,
      log: () => {},
    });
    assert.equal(unsignedBestEffort.ok, false);
    assert.equal(unsignedBestEffort.status, "failed");
    assert.equal(unsignedBestEffort.exitCode, 0);

    // 5. Invalid UAW_CONTEXT_HUB_MODE must fail closed
    const badMode = await dispatchToContextHub(baseEnvelope, {
      env: {
        UAW_CONTEXT_HUB_SINK: "webhook",
        UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook-flaky`,
        UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
        UAW_CONTEXT_HUB_MODE: "strict_typo",
      },
      log: () => {},
    });
    assert.equal(badMode.ok, false);
    assert.equal(badMode.exitCode, 1);
    assert.match(badMode.error, /Unknown UAW_CONTEXT_HUB_MODE/);

    // 6. MCP HTTP 200 JSON-RPC error, result.isError=true, missing result, invalid JSON, redirect, and mcpClient isError=true must fail closed
    for (const ep of ["/mcp-rpc-error", "/mcp-is-error", "/mcp-no-result", "/mcp-bad-json", "/redirect-http"]) {
      const rFail = await dispatchToContextHub(baseEnvelope, {
        env: {
          UAW_CONTEXT_HUB_SINK: ep === "/redirect-http" ? "webhook" : "mcp",
          UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}${ep}`,
          UAW_CONTEXT_HUB_TOKEN: HUB_SECRET,
          UAW_CONTEXT_HUB_MODE: "strict",
        },
        maxAttempts: 2,
        baseDelayMs: 5,
        log: () => {},
      });
      assert.equal(rFail.ok, false, `expected failure for ${ep}`);
      assert.equal(rFail.status, "failed");
      assert.equal(rFail.exitCode, 1);
    }

    const mcpClientIsError = await dispatchToContextHub(baseEnvelope, {
      env: { UAW_CONTEXT_HUB_SINK: "mcp", UAW_CONTEXT_HUB_MODE: "strict" },
      mcpClient: {
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "ingest rejected" }] }),
      },
      maxAttempts: 2,
      baseDelayMs: 5,
      log: () => {},
    });
    assert.equal(mcpClientIsError.ok, false);
    assert.equal(mcpClientIsError.status, "failed");
    assert.equal(mcpClientIsError.exitCode, 1);
    assert.match(mcpClientIsError.error, /isError=true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log("context-hub-sink tests passed");
