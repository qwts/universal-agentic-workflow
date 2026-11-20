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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../../hooks/secret-patterns.mjs";
import { assertAllowedPath, registerRunIndex, writeRunMeta } from "../paths.mjs";
import { createMcpHandler, MCP_PROTOCOL_VERSION } from "../protocol.mjs";
import { isOriginAllowed, startHttpServer } from "../server.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "uaw-mcp-sec-")));
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
    () => startHttpServer({ host: "0.0.0.0", port: 0, authToken: "", allowedRoots: [root] }),
    /Refusing to bind HTTP server to non-loopback host/,
  );
  assert.throws(
    () => startHttpServer({ host: "0.0.0.0", port: 0, authToken: "tok", allowedRoots: [] }),
    /without --allowed-roots or UAW_MCP_ALLOWED_ROOTS/,
  );

  // 5. Goal file path confinement, omitted repo_root under allowedRoots, dangling symlinks, transcript symlinks, flags, and protocol version
  const safeRepo = join(root, "ws-repo");
  mkdirSync(safeRepo, { recursive: true });
  const outsideGoal = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "/etc/hosts",
    adapter: "fake",
    data_dir: join(safeRepo, "run1"),
    repo_root: safeRepo,
  });
  assert.equal(outsideGoal.isError, true);
  assert.equal(outsideGoal.structuredContent.exit_code, 2);
  assert.match(outsideGoal.structuredContent.error, /outside the configured workspace root allowlist/);

  const relTraversalGoal = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "../../outside-secret.md",
    adapter: "fake",
    data_dir: join(safeRepo, "run1b"),
    repo_root: safeRepo,
  });
  assert.equal(relTraversalGoal.isError, true);
  assert.equal(relTraversalGoal.structuredContent.exit_code, 2);

  symlinkSync("/etc/hosts", join(safeRepo, "goal-link.md"));
  const symlinkGoal = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "goal-link.md",
    adapter: "fake",
    data_dir: join(safeRepo, "run1c"),
    repo_root: safeRepo,
  });
  assert.equal(symlinkGoal.isError, true);
  assert.equal(symlinkGoal.structuredContent.exit_code, 2);

  const missingRepoRoot = await handler.callTool("uaw_gates", {
    workflow: "sw_dev",
  });
  assert.equal(missingRepoRoot.isError, true);
  assert.equal(missingRepoRoot.structuredContent.exit_code, 2);
  assert.match(missingRepoRoot.structuredContent.error, /repo_root is required/);

  // Dangling symlink pointing outside allowedRoots must be rejected
  symlinkSync("/etc/nonexistent-uaw-target", join(root, "dangling-escape"));
  assert.throws(
    () => assertAllowedPath(join(root, "dangling-escape", "nested"), [root], "data_dir"),
    /outside the configured workspace root allowlist/,
  );

  // Chained relative dangling symlink inside an escaped directory must be rejected
  const extDir = realpathSync(mkdtempSync(join(tmpdir(), "uaw-mcp-ext-")));
  try {
    symlinkSync(extDir, join(root, "ext-link"));
    symlinkSync("../outside-nonexistent", join(extDir, "rel-dangling"));
    assert.throws(
      () => assertAllowedPath(join(root, "ext-link", "rel-dangling", "leaf"), [root], "data_dir"),
      /outside the configured workspace root allowlist/,
    );
  } finally {
    rmSync(extDir, { recursive: true, force: true });
  }

  // Transcript symlink inside transcripts/ pointing outside must be rejected
  symlinkSync("/etc/hosts", join(transcriptsDir, "symlink-leak.json"));
  const symlinkTranscript = await handler.callTool("uaw_read_transcript", {
    run_id: runId,
    transcript_id: "symlink-leak",
  });
  assert.equal(symlinkTranscript.isError, true);
  assert.equal(symlinkTranscript.structuredContent.exit_code, 2);

  // Active run.lock prevents uaw_run from clobbering run-meta.json before runner starts
  const lockedMetaBefore = readFileSync(join(dataDir, "run-meta.json"), "utf8");
  writeFileSync(join(dataDir, "run.lock"), JSON.stringify({ runId, pid: process.pid }), "utf8");
  try {
    const lockedForce = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Should not overwrite metadata",
      adapter: "fake",
      data_dir: dataDir,
      output_path: join(safeRepo, "alt-out"),
      repo_root: safeRepo,
      force: true,
    });
    assert.equal(lockedForce.isError, true);
    assert.equal(lockedForce.structuredContent.exit_code, 2);
    assert.equal(readFileSync(join(dataDir, "run-meta.json"), "utf8"), lockedMetaBefore);
  } finally {
    rmSync(join(dataDir, "run.lock"), { force: true });
  }

  // Workflow traversal and leading-dash flag injection must be rejected
  const badWf = await handler.callTool("uaw_run", {
    workflow: "../bad",
    goal: "ok",
    adapter: "fake",
    data_dir: join(safeRepo, "run-badwf"),
    repo_root: safeRepo,
  });
  assert.equal(badWf.isError, true);
  assert.equal(badWf.structuredContent.exit_code, 2);

  const badFlag = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "ok",
    adapter: "fake",
    model: "--evil-flag",
    data_dir: join(safeRepo, "run-badflag"),
    repo_root: safeRepo,
  });
  assert.equal(badFlag.isError, true);
  assert.equal(badFlag.structuredContent.exit_code, 2);

  // Origin wildcard suffix spoofing rejection while keeping valid scheme/port patterns
  assert.equal(isOriginAllowed("https://app.example.com.evil.tld", ["https://app.example.com*"]), false);
  assert.equal(isOriginAllowed("https://sub.example.com", ["https://*.example.com"]), true);
  assert.equal(isOriginAllowed("chrome-extension://abcdef", ["chrome-extension://*"]), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:54321", ["http://127.0.0.1:*"]), true);

  // initialize must negotiate server's supported MCP protocolVersion rather than echoing client strings
  const initMismatch = await handler.handleJsonRpc({
    jsonrpc: "2.0",
    id: 99,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(initMismatch.result.protocolVersion, MCP_PROTOCOL_VERSION);

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
