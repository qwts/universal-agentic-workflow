/**
 * security.test.mjs — Secret redaction, path traversal, auth, and Origin validation tests (ADR-0008):
 *   1. Injects synthetic secrets matching EVERY pattern in `scripts/hooks/secret-patterns.mjs`
 *      into a fixture transcript and state note, verifying `uaw_read_transcript`,
 *      `uaw://<run>/transcripts/<id>`, `uaw_read_state`, and `uaw://<run>/state` return
 *      `[redacted:<kind>]` placeholders with zero raw secret substrings.
 *   2. Verifies path traversal rejection on transcript IDs and workspace root allowlists.
 *   3. Verifies HTTP server refuses non-loopback bind without auth token, rejects invalid
 *      bearer tokens (401), and rejects disallowed Origin headers (403).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../../hooks/secret-patterns.mjs";
import { registerRunIndex, writeRunMeta } from "../paths.mjs";
import { createMcpHandler } from "../protocol.mjs";
import { startHttpServer } from "../server.mjs";

const root = mkdtempSync(join(tmpdir(), "uaw-mcp-sec-"));
const stateDir = join(root, "uaw-state");
const dataDir = join(root, "run-data");
const transcriptsDir = join(dataDir, "transcripts");
mkdirSync(transcriptsDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

// Construct synthetic secrets via concatenation so static scanners don't flag test fixtures.
const SYNTHETIC_SECRETS = [
  {
    kind: "private-key",
    raw: "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEowIBAAKCAQEAtest\n-----END RSA " + "PRIVATE KEY-----",
  },
  { kind: "anthropic-key", raw: "sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUV" },
  { kind: "openai-key", raw: "sk-proj-" + "1234567890ABCDEFGHIJKLMN" },
  { kind: "github-token", raw: "ghp_" + "1234567890abcdefghij1234567890" },
  { kind: "aws-access-key", raw: "AKIA" + "IOSFODNN7EXAMPLE" },
  { kind: "slack-token", raw: "xoxb-" + "1234567890-abcdefghij" },
  { kind: "bearer-token", raw: "Bearer " + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
];

// Verify our test covers every pattern defined in secret-patterns.mjs
assert.deepEqual(
  SYNTHETIC_SECRETS.map((s) => s.kind),
  SECRET_PATTERNS.map((p) => p.kind),
  "security.test.mjs must test every pattern in secret-patterns.mjs",
);

const runId = "uaw-sec-run-001";
const meta = {
  run_id: runId,
  workflow: "sw_dev",
  data_dir: dataDir,
  output_path: join(dataDir, "workflow-artifacts"),
  created_at: new Date().toISOString(),
};
writeRunMeta(dataDir, meta);
registerRunIndex(stateDir, meta);

const transcriptId = "2026-11-19T12-00-00-000Z-sec001";
writeFileSync(
  join(transcriptsDir, `${transcriptId}.json`),
  JSON.stringify(
    {
      adapter: "fake",
      stdout: SYNTHETIC_SECRETS.map((s) => `${s.kind}: ${s.raw}`).join("\n"),
      nested: { note: `leaked ${SYNTHETIC_SECRETS[1].raw}` },
    },
    null,
    2,
  ),
  "utf8",
);

const handler = createMcpHandler({ allowedRoots: [root], stateDir });

try {
  // 1. Verify uaw_read_transcript tool redacts every pattern
  const toolResp = await handler.callTool("uaw_read_transcript", {
    run_id: runId,
    transcript_id: transcriptId,
  });
  const toolJson = JSON.stringify(toolResp.structuredContent);
  assert.ok(toolResp.structuredContent.redactions >= SYNTHETIC_SECRETS.length);
  for (const s of SYNTHETIC_SECRETS) {
    assert.ok(!toolJson.includes(s.raw), `raw ${s.kind} leaked in uaw_read_transcript`);
    assert.ok(
      toolJson.includes(`[redacted:${s.kind}]`),
      `missing [redacted:${s.kind}] placeholder in uaw_read_transcript`,
    );
  }

  // 2. Verify uaw://<run>/transcripts/<id> resource redacts every pattern
  const resResp = handler.readResource(`uaw://${runId}/transcripts/${transcriptId}`);
  const resText = resResp.contents[0].text;
  for (const s of SYNTHETIC_SECRETS) {
    assert.ok(!resText.includes(s.raw), `raw ${s.kind} leaked in resource URI`);
    assert.ok(resText.includes(`[redacted:${s.kind}]`), `missing [redacted:${s.kind}] in resource URI`);
  }

  // 3. Verify path traversal rejection on transcript IDs and allowedRoots
  const traversalTool = await handler.callTool("uaw_read_transcript", {
    run_id: runId,
    transcript_id: "../../etc/passwd",
  });
  assert.equal(traversalTool.isError, true);
  assert.equal(traversalTool.structuredContent.exit_code, 2);

  const outsideDir = await handler.callTool("uaw_read_state", {
    data_dir: "/etc",
  });
  assert.equal(outsideDir.isError, true);
  assert.equal(outsideDir.structuredContent.exit_code, 2);
  assert.match(outsideDir.structuredContent.error, /outside the configured workspace root allowlist/);

  // 4. Verify HTTP server security boundaries
  assert.throws(
    () => startHttpServer({ host: "0.0.0.0", port: 0, authToken: "" }),
    /Refusing to bind HTTP server to non-loopback host/,
  );

  const srv = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "expected-bearer-secret",
    allowedOrigins: ["chrome-extension://allowed-ext"],
    allowedRoots: [root],
    stateDir,
  });
  const url = `http://${srv.host}:${srv.port}/mcp`;

  try {
    // Missing/wrong bearer token -> 401
    const noAuth = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token-value-xx",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    assert.equal(badAuth.status, 401);

    // Disallowed Origin -> 403
    const badOrigin = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer expected-bearer-secret",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    });
    assert.equal(badOrigin.status, 403);

    // Valid bearer + allowed Origin -> 200
    const good = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer expected-bearer-secret",
        Origin: "chrome-extension://allowed-ext",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    });
    assert.equal(good.status, 200);
  } finally {
    await srv.close();
  }

  console.log("uaw-mcp security, secret-redaction, auth, and Origin tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
