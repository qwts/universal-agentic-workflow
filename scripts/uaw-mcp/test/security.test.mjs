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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_PATTERNS } from "../../hooks/secret-patterns.mjs";
import { assertAllowedPath, lookupRunById, registerRunIndex, writeRunMeta } from "../paths.mjs";
import { createMcpHandler, MCP_PROTOCOL_VERSION } from "../protocol.mjs";
import { isOriginAllowed, startHttpServer } from "../server.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

  // 6. Symlinked run-meta / SQLite / runner-routing.json must be rejected with exit_code 2
  const symDirMeta = join(safeRepo, "sym-meta-run");
  mkdirSync(symDirMeta, { recursive: true });
  symlinkSync("/etc/hosts", join(symDirMeta, "run-meta.json"));
  const symMetaRes = await handler.callTool("uaw_read_state", { data_dir: symDirMeta });
  assert.equal(symMetaRes.isError, true);
  assert.equal(symMetaRes.structuredContent.exit_code, 2);

  const symDirDb = join(safeRepo, "sym-db-run");
  mkdirSync(symDirDb, { recursive: true });
  symlinkSync("/etc/hosts", join(symDirDb, "uwf-state.db"));
  const symDbRes = await handler.callTool("uaw_read_state", { data_dir: symDirDb });
  assert.equal(symDbRes.isError, true);
  assert.equal(symDbRes.structuredContent.exit_code, 2);

  const symDirRouting = join(safeRepo, "sym-routing-run");
  mkdirSync(symDirRouting, { recursive: true });
  symlinkSync("/etc/hosts", join(symDirRouting, "runner-routing.json"));
  const symRoutingRes = await handler.callTool("uaw_read_stages", { data_dir: symDirRouting });
  assert.equal(symRoutingRes.isError, true);
  assert.equal(symRoutingRes.structuredContent.exit_code, 2);

  // 7. uaw_run supplying existing run_id with a different data_dir must preserve existing index mapping
  const hijackDir = join(safeRepo, "hijack-dir");
  mkdirSync(hijackDir, { recursive: true });
  const hijackRes = await handler.callTool("uaw_run", {
    run_id: runId,
    workflow: "sw_dev",
    goal: "Try to hijack run_id mapping",
    adapter: "fake",
    data_dir: hijackDir,
    repo_root: safeRepo,
  });
  assert.equal(hijackRes.isError, true);
  assert.equal(hijackRes.structuredContent.exit_code, 2);
  assert.equal(lookupRunById(stateDir, runId)?.data_dir, dataDir);

  // Planted run-meta.json carrying existing runId in another data_dir (even when caller omits run_id) must be rejected
  const plantedDir = join(safeRepo, "planted-hijack-dir");
  writeRunMeta(plantedDir, { run_id: runId, workflow: "sw_dev", data_dir: plantedDir });
  const plantedRes = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "Planted run-meta hijack",
    adapter: "fake",
    data_dir: plantedDir,
    repo_root: safeRepo,
  });
  assert.equal(plantedRes.isError, true);
  assert.equal(plantedRes.structuredContent.exit_code, 2);
  assert.equal(lookupRunById(stateDir, runId)?.data_dir, dataDir);

  // 8. uaw_stage_transition enforces cross-run output_path ownership & preserves run_id across calls
  const trackerAbs = join(REPO_ROOT, ".github", "skills", "uwf-orchestration-engine", "stage-tracker.mjs");
  const wfDir = join(safeRepo, ".github", "skills", "uwf-sw_dev");
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(join(safeRepo, ".github", "agents"), { recursive: true });
  writeFileSync(join(safeRepo, ".github", "agents", "sec-agent.agent.md"), "---\nname: sec-agent\ntools: [read]\n---\nRun stage.\n");
  writeFileSync(
    join(wfDir, "stages.yaml"),
    [
      "workflow: sw_dev",
      "stages:",
      "  - name: intake",
      "    agent: sec-agent",
      "    advances_phase_to: intake",
      "    outputs:",
      "      - '{{output_path}}/out.md'",
      "    gate:",
      "      checks:",
      "        - type: require_non_empty",
      "          path: '{{output_path}}/out.md'",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(wfDir, "run.mjs"),
    [
      'import { spawnSync } from "node:child_process";',
      `const tracker = ${JSON.stringify(trackerAbs)};`,
      "const raw = process.argv.slice(2);",
      "const out = [];",
      "for (let i = 0; i < raw.length; i++) {",
      '  if (raw[i] === "--list-stages") { out.push("list-stages"); continue; }',
      '  if (raw[i] === "--check-gate") { out.push("check-gate", "--stage", raw[++i]); continue; }',
      "  out.push(raw[i]);",
      "}",
      'if (!out.includes("--workflow")) out.push("--workflow", "sw_dev");',
      'const r = spawnSync(process.execPath, [tracker, ...out], { stdio: "inherit", env: process.env });',
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
    "utf8",
  );

  const transDataA = join(safeRepo, "trans-a");
  const transOutA = join(safeRepo, "trans-out-a");
  const t1 = await handler.callTool("uaw_stage_transition", {
    target: "stage",
    action: "init",
    workflow: "sw_dev",
    data_dir: transDataA,
    output_path: transOutA,
    repo_root: safeRepo,
  });
  assert.equal(t1.isError, false, t1.structuredContent?.error ?? "");
  assert.equal(t1.structuredContent.ok, true);
  const t2 = await handler.callTool("uaw_stage_transition", {
    target: "stage",
    action: "stage-start",
    workflow: "sw_dev",
    stage: "intake",
    data_dir: transDataA,
    repo_root: safeRepo,
  });
  assert.equal(t2.isError, false, t2.structuredContent?.error ?? "");
  assert.equal(t2.structuredContent.run_id, t1.structuredContent.run_id);

  const transConflict = await handler.callTool("uaw_stage_transition", {
    target: "stage",
    action: "init",
    workflow: "sw_dev",
    data_dir: join(safeRepo, "trans-b"),
    output_path: transOutA,
    repo_root: safeRepo,
  });
  assert.equal(transConflict.isError, true);
  assert.equal(transConflict.structuredContent.exit_code, 2);

  // 9. uaw_run schema omits unsupported monolith adapter, avoids top-level anyOf, and allows goal_file without goal
  const toolsList = await handler.handleJsonRpc({ jsonrpc: "2.0", id: 100, method: "tools/list" });
  const uawRunTool = toolsList.result.tools.find((t) => t.name === "uaw_run");
  assert.equal(uawRunTool.inputSchema.properties.adapter.enum.includes("monolith"), false);
  assert.deepEqual(uawRunTool.inputSchema.required, ["workflow"]);
  assert.equal("anyOf" in uawRunTool.inputSchema, false);
  assert.equal("oneOf" in uawRunTool.inputSchema, false);

  // uaw_resume validation error must NOT leave an output-path lock behind
  const badResume = await handler.callTool("uaw_resume", {
    data_dir: transDataA,
    model: "--evil-flag",
    repo_root: safeRepo,
  });
  assert.equal(badResume.isError, true);
  assert.equal(badResume.structuredContent.exit_code, 2);
  const afterBadResume = await handler.callTool("uaw_stage_transition", {
    target: "stage",
    action: "stage-session",
    workflow: "sw_dev",
    stage: "intake",
    session_id: "sess-after-bad-resume",
    data_dir: transDataA,
    repo_root: safeRepo,
  });
  assert.equal(afterBadResume.isError, false, afterBadResume.structuredContent?.error ?? "");

  const validGoalFile = join(safeRepo, "goal-input.md");
  writeFileSync(validGoalFile, "Build verified feature via goal_file\n", "utf8");
  const fxDir = join(safeRepo, "fx-dry");
  mkdirSync(fxDir, { recursive: true });
  const goalFileDryRun = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal_file: validGoalFile,
    adapter: "fake",
    fake_fixture_dir: fxDir,
    dry_run: true,
    data_dir: join(safeRepo, "run-goalfile"),
    repo_root: safeRepo,
  });
  assert.equal(goalFileDryRun.structuredContent.exit_code, 0, goalFileDryRun.structuredContent?.stderr ?? "");

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
