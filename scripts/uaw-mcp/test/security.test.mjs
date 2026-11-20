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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECRET_PATTERNS } from "../../hooks/secret-patterns.mjs";
import { materializePrompt, validateWorkflowStageInputs } from "../../uwf-runner/prompt.mjs";
import { execNodeAsync } from "../commands.mjs";
import { claimDataDirLock, pidAlive } from "../ownership.mjs";
import { assertAllowedPath, canonicalPathKey, listRegisteredRuns, lookupRunById, readRunMeta, registerRunIndex, writeRunMeta } from "../paths.mjs";
import { createMcpHandler, MCP_PROTOCOL_VERSION } from "../protocol.mjs";
import { isOriginAllowed, startHttpServer } from "../server.mjs";
import { createFixtureWorkspace } from "./helpers.mjs";

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
      nested: {
        note: `leaked ${SYNTHETIC_SECRETS[1].raw}`,
        [SYNTHETIC_SECRETS[2].raw]: "secret-key-val-1",
        [`prefix-${SYNTHETIC_SECRETS[3].raw}`]: "secret-key-val-2",
        collision: {
          [SYNTHETIC_SECRETS[2].raw]: "secret-first",
          "[redacted:openai-key]": "literal-second",
        },
        reverseCollision: {
          "[redacted:github-token]": "literal-first",
          [SYNTHETIC_SECRETS[3].raw]: "secret-second",
        },
      },
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
  const parsedToolNested = toolResp.structuredContent.transcript.nested;
  assert.equal(parsedToolNested["[redacted:openai-key]"], "secret-key-val-1");
  assert.equal(parsedToolNested["prefix-[redacted:github-token]"], "secret-key-val-2");
  assert.equal(parsedToolNested.collision["[redacted:openai-key]"], "secret-first");
  assert.equal(parsedToolNested.collision["[redacted:openai-key]#2"], "literal-second");
  assert.equal(parsedToolNested.reverseCollision["[redacted:github-token]"], "literal-first");
  assert.equal(parsedToolNested.reverseCollision["[redacted:github-token]#2"], "secret-second");

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
  assert.throws(
    () => startHttpServer({ host: "127.0.0.1", port: 0, authToken: "", allowedRoots: [root] }),
    /without --auth-token or UAW_MCP_AUTH_TOKEN/,
  );
  assert.throws(
    () => startHttpServer({ host: "127.0.0.1", port: 0, authToken: "tok", allowedRoots: [] }),
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

  // Transcript symlink inside transcripts/ pointing outside must be rejected on read AND resume
  const symTranscriptPath = join(transcriptsDir, "symlink-leak.json");
  symlinkSync("/etc/hosts", symTranscriptPath);
  try {
    const symlinkTranscript = await handler.callTool("uaw_read_transcript", {
      run_id: runId,
      transcript_id: "symlink-leak",
    });
    assert.equal(symlinkTranscript.isError, true);
    assert.equal(symlinkTranscript.structuredContent.exit_code, 2);

    const symlinkResume = await handler.callTool("uaw_resume", {
      run_id: runId,
    });
    assert.equal(symlinkResume.isError, true);
    assert.equal(symlinkResume.structuredContent.exit_code, 2);
    assert.match(symlinkResume.structuredContent.error, /symlink|regular file/i);
  } finally {
    rmSync(symTranscriptPath, { force: true });
  }

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

  // 10. uaw_gates validates persisted meta.output_path against allowedRoots
  const escapedMetaDir = join(safeRepo, "escaped-gates-meta");
  writeRunMeta(escapedMetaDir, {
    run_id: "uaw-escaped-gates",
    workflow: "sw_dev",
    data_dir: escapedMetaDir,
    output_path: "/etc",
    repo_root: safeRepo,
  });
  const escapedGates = await handler.callTool("uaw_gates", {
    workflow: "sw_dev",
    mode: "check",
    stage: "intake",
    data_dir: escapedMetaDir,
    repo_root: safeRepo,
  });
  assert.equal(escapedGates.isError, true);
  assert.equal(escapedGates.structuredContent.exit_code, 2);

  // 11. uaw_resume rejects mismatched output_path overrides against persisted run-meta.json
  const mismatchResume = await handler.callTool("uaw_resume", {
    data_dir: transDataA,
    output_path: join(safeRepo, "different-out"),
    adapter: "fake",
    fake_fixture_dir: fxDir,
    repo_root: safeRepo,
  });
  assert.equal(mismatchResume.isError, true);
  assert.equal(mismatchResume.structuredContent.exit_code, 2);
  assert.equal(readRunMeta(transDataA)?.output_path, transOutA);

  // 12. uaw_question_resolve mutating actions (answer/skip) respect active dataDir serialization lock
  const heldDataLock = claimDataDirLock({ dataDir: transDataA, runId: "holder", stateDir });
  try {
    const blockedSkip = await handler.callTool("uaw_question_resolve", {
      action: "skip",
      id: 1,
      data_dir: transDataA,
    });
    assert.equal(blockedSkip.isError, true);
    assert.equal(blockedSkip.structuredContent.exit_code, 2);
  } finally {
    heldDataLock.release();
  }
  const allowedList = await handler.callTool("uaw_question_resolve", {
    action: "list",
    data_dir: transDataA,
  });
  assert.equal(allowedList.isError, false, allowedList.structuredContent?.error ?? "");

  // 13. uaw_cost skips transcript symlinks escaping root and non-regular FIFOs during costReport
  const costSecDir = join(safeRepo, "cost-sec-dir");
  mkdirSync(join(costSecDir, "transcripts"), { recursive: true });
  writeRunMeta(costSecDir, {
    run_id: "uaw-cost-sec",
    workflow: "sw_dev",
    data_dir: costSecDir,
    output_path: transOutA,
    repo_root: safeRepo,
  });
  writeFileSync(
    join(costSecDir, "transcripts", "0001-intake.json"),
    JSON.stringify({
      prompt: "Run the intake stage for the test fixture.",
      stdout: JSON.stringify({
        num_turns: 2,
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 20,
          output_tokens: 30,
        },
      }),
    }),
    "utf8",
  );
  symlinkSync("/etc/hosts", join(costSecDir, "transcripts", "evil-link.json"));
  try {
    execFileSync("mkfifo", [join(costSecDir, "transcripts", "hang-pipe.json")], { stdio: "ignore" });
  } catch {
    /* mkfifo unavailable on platform; symlink test still exercises lstat/realpath */
  }
  const costSecRes = await handler.callTool("uaw_cost", {
    data_dir: costSecDir,
    workflow: "sw_dev",
    repo_root: safeRepo,
    skills_root: safeRepo,
  });
  assert.equal(costSecRes.isError, false, costSecRes.structuredContent?.error ?? "");
  assert.equal(costSecRes.structuredContent.ok, true);
  assert.equal(costSecRes.structuredContent.stages.length, 1);
  assert.equal(typeof costSecRes.structuredContent.report, "string");
  assert.match(costSecRes.structuredContent.report, /intake/);
  // Test #13 preservation: uaw_cost still rejects symlinked uwf-state.db or symlinked transcripts/ directory
  symlinkSync("/etc/hosts", join(costSecDir, "uwf-state.db"));
  const costSymDb = await handler.callTool("uaw_cost", {
    data_dir: costSecDir,
    workflow: "sw_dev",
    repo_root: safeRepo,
    skills_root: safeRepo,
  });
  assert.equal(costSymDb.isError, true);
  assert.equal(costSymDb.structuredContent.exit_code, 2);
  assert.match(costSymDb.structuredContent.error, /symlink|regular file/i);
  rmSync(join(costSecDir, "uwf-state.db"));

  // 14. uaw_run force=true generating a new run_id retires the superseded <stateDir>/runs index entry
  const forceDataDir = join(safeRepo, "force-retire-data");
  const forceOutDir = join(safeRepo, "force-out-sub");
  const forceFxDir = join(safeRepo, "fx-force");
  mkdirSync(forceFxDir, { recursive: true });
  writeFileSync(
    join(forceFxDir, "intake.json"),
    JSON.stringify({
      files: { "force-out-sub/out.md": "# Forced output\n" },
      transcript: "ok",
      sessionId: "sess-force-retire",
    }),
    "utf8",
  );
  const run1 = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "Initial run before force rotation",
    adapter: "fake",
    fake_fixture_dir: forceFxDir,
    data_dir: forceDataDir,
    output_path: forceOutDir,
    repo_root: safeRepo,
    skills_root: safeRepo,
  });
  assert.equal(run1.structuredContent.exit_code, 0, run1.structuredContent.stderr);
  const firstRunId = run1.structuredContent.run_id;
  assert.ok(listRegisteredRuns(stateDir).some((r) => r.run_id === firstRunId));

  const run2 = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    goal: "Forced replacement run",
    adapter: "fake",
    fake_fixture_dir: forceFxDir,
    data_dir: forceDataDir,
    output_path: forceOutDir,
    repo_root: safeRepo,
    skills_root: safeRepo,
    force: true,
  });
  assert.equal(run2.structuredContent.exit_code, 0, run2.structuredContent.stderr);
  const secondRunId = run2.structuredContent.run_id;
  assert.notEqual(secondRunId, firstRunId);
  assert.equal(lookupRunById(stateDir, firstRunId), null, "superseded run_id index entry must be deleted");
  assert.equal(lookupRunById(stateDir, secondRunId)?.data_dir, forceDataDir);
  const listedAfterForce = await handler.handleJsonRpc({ jsonrpc: "2.0", id: 98, method: "resources/list", params: {} });
  const listedUris = listedAfterForce.result.resources.map((r) => r.uri);
  assert.equal(listedUris.some((u) => u.includes(firstRunId)), false, "stale run_id URI must not appear in resources/list");
  assert.ok(listedUris.includes(`uaw://${secondRunId}/state`), "new run_id state URI must appear in resources/list");
  const readNewState = await handler.handleJsonRpc({
    jsonrpc: "2.0",
    id: 99,
    method: "resources/read",
    params: { uri: `uaw://${secondRunId}/state` },
  });
  assert.equal(readNewState.error, undefined);

  // 15. Path traversal run_id ("..", "."), malformed URI percent-encoding, and unknown run_id in uaw_question_resolve
  for (const badId of ["..", ".", "a/../b"]) {
    const badRun = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      run_id: badId,
      goal: "Reject traversal run_id",
      adapter: "fake",
      fake_fixture_dir: forceFxDir,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(badRun.isError, true, `run_id="${badId}" must be rejected`);
    assert.equal(badRun.structuredContent.exit_code, 2);
  }

  const malformedUriRes = await handler.handleJsonRpc({
    jsonrpc: "2.0",
    id: 100,
    method: "resources/read",
    params: { uri: "uaw://bad%ZZescape/state" },
  });
  assert.equal(malformedUriRes.error?.code, -32602, "malformed percent-encoding must map to Invalid params (-32602)");

  const ghostRunId = "nonexistent-question-run-xyz";
  const ghostQ = await handler.callTool("uaw_question_resolve", {
    run_id: ghostRunId,
    action: "list",
  });
  assert.equal(ghostQ.isError, true);
  assert.equal(ghostQ.structuredContent.exit_code, 2);
  assert.equal(existsSync(join(root, ".uaw-runs", ghostRunId)), false, "unknown run_id must not create run directory or DB");

  // 16. claimOutputPath serializes before linking ownership record and cleans up on output conflict
  const rollbackOut = join(safeRepo, "rollback-out");
  mkdirSync(rollbackOut, { recursive: true });
  const rollbackFxDir = join(safeRepo, "fx-rollback");
  mkdirSync(rollbackFxDir, { recursive: true });
  writeFileSync(
    join(rollbackFxDir, "intake.json"),
    JSON.stringify({
      files: { "rollback-out/out.md": "# Rollback test output\n" },
      transcript: "ok",
      sessionId: "sess-rollback",
    }),
    "utf8",
  );
  const legitOwnerData = join(safeRepo, "legit-owner-data");
  const attackerData = join(safeRepo, "attacker-data");
  const legitRun = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    run_id: "legit-owner-run",
    goal: "Own rollback-out",
    adapter: "fake",
    fake_fixture_dir: rollbackFxDir,
    data_dir: legitOwnerData,
    output_path: rollbackOut,
    repo_root: safeRepo,
    skills_root: safeRepo,
  });
  assert.equal(legitRun.structuredContent.exit_code, 0);
  const attackerRun = await handler.callTool("uaw_run", {
    workflow: "sw_dev",
    run_id: "attacker-rollback-run",
    goal: "Fail on occupied output_path",
    adapter: "fake",
    fake_fixture_dir: rollbackFxDir,
    data_dir: attackerData,
    output_path: rollbackOut,
    repo_root: safeRepo,
    skills_root: safeRepo,
  });
  assert.equal(attackerRun.isError, true);
  assert.equal(attackerRun.structuredContent.exit_code, 2);
  assert.equal(lookupRunById(stateDir, "attacker-rollback-run"), null, "rejected run must roll back run_id index");
  assert.equal(lookupRunById(stateDir, "legit-owner-run")?.data_dir, legitOwnerData);
  assert.equal(assertAllowedPath(join(safeRepo, "..cache"), [safeRepo]), join(safeRepo, "..cache"));

  // 17. Reject live and dangling fixed-name database & sidecar symlinks before mutating/reading/gating, without recursing into workflow-artifacts
  const outsideTargetDir = realpathSync(mkdtempSync(join(tmpdir(), "uaw-mcp-outside-db-")));
  try {
    const victimBytes = Buffer.from("ORIGINAL_VICTIM_CONTENT_DO_NOT_OVERWRITE\n", "utf8");
    const victimDb = join(outsideTargetDir, "victim.db");
    writeFileSync(victimDb, victimBytes);

    const symLiveData = join(safeRepo, "sym-live-db-data");
    mkdirSync(symLiveData, { recursive: true });
    symlinkSync(victimDb, join(symLiveData, "uwf-state.db"));

    for (const dryFlag of [false, true]) {
      const resRun = await handler.callTool("uaw_run", {
        workflow: "sw_dev",
        goal: "Reject symlinked state db",
        adapter: "fake",
        fake_fixture_dir: rollbackFxDir,
        data_dir: symLiveData,
        repo_root: safeRepo,
        skills_root: safeRepo,
        dry_run: dryFlag,
      });
      assert.equal(resRun.isError, true, `uaw_run dry_run=${dryFlag} must reject symlinked uwf-state.db`);
      assert.equal(resRun.structuredContent.exit_code, 2);
      assert.match(resRun.structuredContent.error, /symlink|regular file/i);
    }

    writeRunMeta(symLiveData, {
      run_id: "sym-live-resume-run",
      workflow: "sw_dev",
      data_dir: symLiveData,
      output_path: join(symLiveData, "workflow-artifacts"),
      repo_root: safeRepo,
    });
    const resResume = await handler.callTool("uaw_resume", {
      data_dir: symLiveData,
      workflow: "sw_dev",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resResume.isError, true, "uaw_resume must reject symlinked uwf-state.db");
    assert.equal(resResume.structuredContent.exit_code, 2);
    assert.match(resResume.structuredContent.error, /symlink|regular file/i);

    const resGatesSym = await handler.callTool("uaw_gates", {
      data_dir: symLiveData,
      workflow: "sw_dev",
      stage: "intake",
      mode: "check",
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resGatesSym.isError, true, "uaw_gates must reject symlinked uwf-state.db");
    assert.equal(resGatesSym.structuredContent.exit_code, 2);
    assert.match(resGatesSym.structuredContent.error, /symlink|regular file/i);

    const resTrans = await handler.callTool("uaw_stage_transition", {
      data_dir: symLiveData,
      target: "state",
      action: "note",
      note: "should-not-write",
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resTrans.isError, true, "uaw_stage_transition must reject symlinked uwf-state.db");
    assert.equal(resTrans.structuredContent.exit_code, 2);
    assert.match(resTrans.structuredContent.error, /symlink|regular file/i);

    const readSymState = await handler.callTool("uaw_read_state", { data_dir: symLiveData });
    assert.equal(readSymState.isError, true, "uaw_read_state must reject symlinked uwf-state.db");
    assert.equal(readSymState.structuredContent.exit_code, 2);
    assert.match(readSymState.structuredContent.error, /symlink|regular file/i);
    assert.deepEqual(readFileSync(victimDb), victimBytes, "outside victim.db must remain byte-for-byte untouched");

    // Live and dangling -wal, -shm, and -journal sidecar symlinks must all be rejected
    const sidecarTestDir = join(safeRepo, "sidecar-sym-data");
    mkdirSync(sidecarTestDir, { recursive: true });
    writeFileSync(join(sidecarTestDir, "uwf-stages.db"), "");
    const sidecarCases = [
      { file: "uwf-stages.db-shm", target: victimDb, label: "live -shm" },
      { file: "uwf-stages.db-journal", target: victimDb, label: "live -journal" },
      { file: "uwf-stages.db-wal", target: victimDb, label: "live -wal" },
      { file: "uwf-stages.db-shm", target: join(outsideTargetDir, "dangling-shm"), label: "dangling -shm" },
      { file: "uwf-stages.db-journal", target: join(outsideTargetDir, "dangling-jrn"), label: "dangling -journal" },
    ];
    for (const sc of sidecarCases) {
      const linkPath = join(sidecarTestDir, sc.file);
      symlinkSync(sc.target, linkPath);
      const rRead = await handler.callTool("uaw_read_stages", { data_dir: sidecarTestDir });
      assert.equal(rRead.isError, true, `uaw_read_stages must reject ${sc.label}`);
      assert.equal(rRead.structuredContent.exit_code, 2);
      assert.match(rRead.structuredContent.error, /symlink|regular file/i);
      const rTrans = await handler.callTool("uaw_stage_transition", {
        data_dir: sidecarTestDir,
        target: "stage",
        action: "init",
        workflow: "sw_dev",
        repo_root: safeRepo,
        skills_root: safeRepo,
      });
      assert.equal(rTrans.isError, true, `uaw_stage_transition must reject ${sc.label}`);
      assert.equal(rTrans.structuredContent.exit_code, 2);
      assert.match(rTrans.structuredContent.error, /symlink|regular file/i);
      rmSync(linkPath, { force: true });
    }
    assert.deepEqual(readFileSync(victimDb), victimBytes);

    // Dangling DB & sidecar symlinks must be rejected without creating targets outside allowedRoots
    const danglingDbTarget = join(outsideTargetDir, "created-via-dangling.db");
    const symDanglingData = join(safeRepo, "sym-dangling-db-data");
    mkdirSync(symDanglingData, { recursive: true });
    symlinkSync(danglingDbTarget, join(symDanglingData, "uwf-stages.db"));

    const resDanglingRun = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reject dangling stages db symlink",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: symDanglingData,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resDanglingRun.isError, true);
    assert.equal(resDanglingRun.structuredContent.exit_code, 2);
    assert.match(resDanglingRun.structuredContent.error, /symlink|regular file/i);

    const resDanglingStage = await handler.callTool("uaw_stage_transition", {
      data_dir: symDanglingData,
      target: "stage",
      action: "init",
      workflow: "sw_dev",
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resDanglingStage.isError, true);
    assert.equal(resDanglingStage.structuredContent.exit_code, 2);
    assert.match(resDanglingStage.structuredContent.error, /symlink|regular file/i);
    assert.equal(existsSync(danglingDbTarget), false, "dangling uwf-stages.db symlink target must never be created");

    const danglingWalTarget = join(outsideTargetDir, "q-wal-target");
    const symSidecarData = join(safeRepo, "sym-sidecar-q-data");
    mkdirSync(symSidecarData, { recursive: true });
    writeRunMeta(symSidecarData, {
      run_id: "sym-sidecar-q-run",
      workflow: "sw_dev",
      data_dir: symSidecarData,
      output_path: join(symSidecarData, "workflow-artifacts"),
      repo_root: safeRepo,
    });
    symlinkSync(danglingWalTarget, join(symSidecarData, "uwf-questions.db-wal"));

    for (const act of ["list", "answer"]) {
      const resQ = await handler.callTool("uaw_question_resolve", {
        data_dir: symSidecarData,
        action: act,
        ...(act === "answer" ? { id: 1, answer: "nope" } : {}),
      });
      assert.equal(resQ.isError, true, `uaw_question_resolve action=${act} must reject dangling sidecar symlink`);
      assert.equal(resQ.structuredContent.exit_code, 2);
      assert.match(resQ.structuredContent.error, /symlink|regular file/i);
    }
    assert.equal(existsSync(danglingWalTarget), false);

    // Non-existent data_dir must be rejected by uaw_question_resolve answer/skip without creating directories
    const missingQData = join(safeRepo, "never-created-q-data");
    const resMissingQ = await handler.callTool("uaw_question_resolve", {
      data_dir: missingQData,
      action: "answer",
      id: 1,
      answer: "yes",
    });
    assert.equal(resMissingQ.isError, true);
    assert.equal(resMissingQ.structuredContent.exit_code, 2);
    assert.equal(existsSync(missingQData), false);

    // assertSafeSkillDbs rejects symlinked DBs under .github/skills/<skill>/
    const evilSkillsRepo = join(safeRepo, "repo-symlinked-skill-db");
    mkdirSync(join(evilSkillsRepo, ".github", "skills", "uwf-state-manager"), { recursive: true });
    symlinkSync(victimDb, join(evilSkillsRepo, ".github", "skills", "uwf-state-manager", "uwf-state.db"));
    const resSkillSym = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reject symlinked skill DB",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(safeRepo, "clean-skill-check-data"),
      repo_root: evilSkillsRepo,
      skills_root: evilSkillsRepo,
    });
    assert.equal(resSkillSym.isError, true);
    assert.equal(resSkillSym.structuredContent.exit_code, 2);
    assert.match(resSkillSym.structuredContent.error, /symlink|regular file/i);

    // Symlinks legitimately left inside <data-dir>/workflow-artifacts/ (e.g. node_modules/.bin) must NOT block uaw_gates/uaw_resume/uaw_cost
    const binDir = join(legitOwnerData, "workflow-artifacts", "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(binDir, "..", "pkg", "cli.js"), join(binDir, "tool-link"));
    const resGatesWithArtifactSym = await handler.callTool("uaw_gates", {
      data_dir: legitOwnerData,
      workflow: "sw_dev",
      mode: "list",
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resGatesWithArtifactSym.isError, false, resGatesWithArtifactSym.structuredContent?.error ?? "");

    // execNodeAsync must strip UAW_MCP_AUTH_TOKEN so child processes never inherit MCP server credentials
    const prevAuthEnv = process.env.UAW_MCP_AUTH_TOKEN;
    process.env.UAW_MCP_AUTH_TOKEN = "secret-mcp-token-must-not-leak";
    try {
      const checkEnvRun = await handler.callTool("uaw_run", {
        workflow: "sw_dev",
        goal: "Check child env isolation",
        adapter: "fake",
        fake_fixture_dir: rollbackFxDir,
        data_dir: join(safeRepo, "env-strip-data"),
        repo_root: safeRepo,
        skills_root: safeRepo,
      });
      assert.equal(checkEnvRun.isError, false, checkEnvRun.structuredContent?.stderr ?? "");
    } finally {
      if (prevAuthEnv === undefined) delete process.env.UAW_MCP_AUTH_TOKEN;
      else process.env.UAW_MCP_AUTH_TOKEN = prevAuthEnv;
    }

    // resources/list must omit runs registered outside allowedRoots
    const outsideRunData = join(outsideTargetDir, "outside-run-data");
    mkdirSync(outsideRunData, { recursive: true });
    writeRunMeta(outsideRunData, {
      run_id: "outside-hidden-run",
      workflow: "sw_dev",
      data_dir: outsideRunData,
      output_path: join(outsideRunData, "workflow-artifacts"),
      repo_root: outsideTargetDir,
    });
    registerRunIndex(stateDir, {
      run_id: "outside-hidden-run",
      workflow: "sw_dev",
      data_dir: outsideRunData,
      output_path: join(outsideRunData, "workflow-artifacts"),
      repo_root: outsideTargetDir,
    });
    const listFiltered = await handler.handleJsonRpc({ jsonrpc: "2.0", id: 101, method: "resources/list", params: {} });
    assert.equal(
      listFiltered.result.resources.some((r) => r.uri.includes("outside-hidden-run")),
      false,
      "resources/list must exclude runs outside allowedRoots",
    );

    // server.mjs CLI must fail closed on missing values, empty --allowed-roots, unknown flags, and invalid --port
    for (const cliArgs of [
      ["--allowed-roots", "--transport", "stdio"],
      ["--allowed-roots=", "--transport", "stdio"],
      ["--allowed-roots", ",", "--transport", "stdio"],
      ["--allowed-root", safeRepo, "--transport", "stdio"],
      ["--transport", "http", "--allowed-roots", safeRepo, "--auth-token="],
      ["--transport", "http", "--allowed-roots", safeRepo, "--auth-token", "tok", "--port=abc"],
    ]) {
      let cliFlagErrCode = 0;
      try {
        execFileSync(
          process.execPath,
          [join(REPO_ROOT, "scripts", "uaw-mcp", "server.mjs"), ...cliArgs],
          { encoding: "utf8", stdio: "pipe" },
        );
      } catch (err) {
        cliFlagErrCode = err.status;
      }
      assert.equal(cliFlagErrCode, 2, `CLI args ${JSON.stringify(cliArgs)} must exit 2`);
    }

    // Missing data_dir on uaw_resume and non-init uaw_stage_transition must fail closed without creating dirs/locks
    const neverResumeDir = join(safeRepo, "never-resume-dir");
    const resMissingResume = await handler.callTool("uaw_resume", {
      data_dir: neverResumeDir,
      workflow: "sw_dev",
      repo_root: safeRepo,
    });
    assert.equal(resMissingResume.isError, true);
    assert.equal(resMissingResume.structuredContent.exit_code, 2);
    assert.equal(existsSync(neverResumeDir), false, "uaw_resume must not create missing data_dir");

    const neverTransDir = join(safeRepo, "never-trans-dir");
    const resMissingTrans = await handler.callTool("uaw_stage_transition", {
      target: "stage",
      action: "stage-start",
      workflow: "sw_dev",
      stage: "intake",
      data_dir: neverTransDir,
      repo_root: safeRepo,
    });
    assert.equal(resMissingTrans.isError, true);
    assert.equal(resMissingTrans.structuredContent.exit_code, 2);
    assert.equal(existsSync(neverTransDir), false, "non-init uaw_stage_transition must not create missing data_dir");

    // Workflow mismatch rejected across uaw_run (!force), uaw_gates, uaw_cost, and uaw_stage_transition
    for (const toolCall of [
      () =>
        handler.callTool("uaw_run", {
          workflow: "other_wf",
          goal: "Mismatched wf",
          adapter: "fake",
          fake_fixture_dir: rollbackFxDir,
          data_dir: transDataA,
          repo_root: safeRepo,
        }),
      () =>
        handler.callTool("uaw_gates", {
          data_dir: transDataA,
          workflow: "other_wf",
          mode: "list",
          repo_root: safeRepo,
        }),
      () =>
        handler.callTool("uaw_cost", {
          data_dir: transDataA,
          workflow: "other_wf",
          repo_root: safeRepo,
        }),
      () =>
        handler.callTool("uaw_stage_transition", {
          target: "stage",
          action: "stage-session",
          workflow: "other_wf",
          stage: "intake",
          session_id: "s-bad",
          data_dir: transDataA,
          repo_root: safeRepo,
        }),
    ]) {
      const wfMismatchRes = await toolCall();
      assert.equal(wfMismatchRes.isError, true);
      assert.equal(wfMismatchRes.structuredContent.exit_code, 2);
      assert.match(wfMismatchRes.structuredContent.error, /workflow.*does not match/i);
    }

    // Overlapping output_path: equal/ancestor of data_dir, inside stateDir, or parent/child of another run's output_path
    const overlapSelfData = join(safeRepo, "overlap-self-data");
    const resOutEqData = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Out equals dataDir",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: overlapSelfData,
      output_path: overlapSelfData,
      repo_root: safeRepo,
    });
    assert.equal(resOutEqData.isError, true);
    assert.equal(resOutEqData.structuredContent.exit_code, 2);
    assert.match(resOutEqData.structuredContent.error, /cannot equal or contain data_dir/i);

    const resOutChildConflict = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Nested output collision",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(safeRepo, "overlap-child-data"),
      output_path: join(transOutA, "nested-child"),
      repo_root: safeRepo,
    });
    assert.equal(resOutChildConflict.isError, true);
    assert.equal(resOutChildConflict.structuredContent.exit_code, 2);
    assert.match(resOutChildConflict.structuredContent.error, /overlaps/i);

    // output_path inside data_dir other than <data_dir>/workflow-artifacts must be refused
    const resOutTranscripts = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Out inside transcripts",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: overlapSelfData,
      output_path: join(overlapSelfData, "transcripts"),
      repo_root: safeRepo,
    });
    assert.equal(resOutTranscripts.isError, true);
    assert.equal(resOutTranscripts.structuredContent.exit_code, 2);
    assert.match(resOutTranscripts.structuredContent.error, /must be under/i);

    // Cross-run output_path vs other run's data_dir overlap must be refused
    const resDataInsideOtherOut = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Data dir nested inside transOutA",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(transOutA, "nested-data-dir"),
      output_path: join(safeRepo, "distinct-out-dir"),
      repo_root: safeRepo,
    });
    assert.equal(resDataInsideOtherOut.isError, true);
    assert.equal(resDataInsideOtherOut.structuredContent.exit_code, 2);
    assert.match(resDataInsideOtherOut.structuredContent.error, /overlaps/i);

    // Embedded NUL bytes in goal or model rejected cleanly with no persisted state
    const nulDataDir = join(safeRepo, "nul-byte-data");
    const resNulGoal = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "bad\0goal",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: nulDataDir,
      repo_root: safeRepo,
    });
    assert.equal(resNulGoal.isError, true);
    assert.equal(resNulGoal.structuredContent.exit_code, 2);
    assert.equal(existsSync(nulDataDir), false, "NUL-byte goal must fail before creating data_dir");

    const resNulModel = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Check NUL model",
      model: "claude\0sonnet",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: nulDataDir,
      repo_root: safeRepo,
    });
    assert.equal(resNulModel.isError, true);
    assert.equal(resNulModel.structuredContent.exit_code, 2);
    assert.equal(existsSync(nulDataDir), false, "NUL-byte model must fail before creating data_dir");

    // Concurrent overlapping claimOutputPath calls (parent vs child across processes) admit only one winner
    const concOverlapState = join(safeRepo, "conc-overlap-state");
    const concOutParent = join(safeRepo, "conc-overlap");
    const concOutChild = join(concOutParent, "child");
    const concDataA = join(safeRepo, "conc-overlap-data-a");
    const concDataB = join(safeRepo, "conc-overlap-data-b");
    mkdirSync(concOverlapState, { recursive: true });
    const ownershipUrl = pathToFileURL(join(REPO_ROOT, "scripts", "uaw-mcp", "ownership.mjs")).href;
    const spawnOverlapClaim = (outPath, runId, dataDirArg) =>
      new Promise((resolveChild) => {
        const script = [
          `import { claimOutputPath } from ${JSON.stringify(ownershipUrl)};`,
          `try {`,
          `  const c = claimOutputPath({ outputPath: ${JSON.stringify(outPath)}, runId: ${JSON.stringify(runId)}, dataDir: ${JSON.stringify(dataDirArg)}, stateDir: ${JSON.stringify(concOverlapState)} });`,
          `  setTimeout(() => { c.release(); process.stdout.write("WON\\n"); process.exit(0); }, 150);`,
          `} catch (e) {`,
          `  process.stderr.write(e.message + "\\n");`,
          `  process.exit(e.exitCode ?? 2);`,
          `}`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (code) => resolveChild({ code, stdout, stderr }));
      });
    const [raceA, raceB] = await Promise.all([
      spawnOverlapClaim(concOutParent, "conc-run-a", concDataA),
      spawnOverlapClaim(concOutChild, "conc-run-b", concDataB),
    ]);
    const winners = [raceA, raceB].filter((r) => r.code === 0);
    const losers = [raceA, raceB].filter((r) => r.code !== 0);
    assert.equal(winners.length, 1, `Expected 1 winner on concurrent overlapping claimOutputPath: ${JSON.stringify([raceA, raceB])}`);
    assert.equal(losers.length, 1);
    assert.match(losers[0].stderr, /overlaps/i);

    // writeRunMeta rollback deletes newly created run-meta.json and restores pre-existing run-meta.json
    const rbMetaDir = join(safeRepo, "rollback-run-meta-dir");
    const firstWrite = writeRunMeta(rbMetaDir, { run_id: "rb-1", workflow: "sw_dev" });
    assert.equal(existsSync(join(rbMetaDir, "run-meta.json")), true);
    firstWrite.rollback();
    assert.equal(existsSync(join(rbMetaDir, "run-meta.json")), false, "rollback must delete newly created run-meta.json");

    writeRunMeta(rbMetaDir, { run_id: "rb-orig", workflow: "sw_dev" });
    const overwriteWrite = writeRunMeta(rbMetaDir, { run_id: "rb-new", workflow: "other_wf" });
    assert.equal(readRunMeta(rbMetaDir)?.run_id, "rb-new");
    overwriteWrite.rollback();
    assert.equal(readRunMeta(rbMetaDir)?.run_id, "rb-orig", "rollback must restore previous run-meta.json");

    // data_dir overlapping stateDir must be refused cleanly
    const resDataInState = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reject data_dir in stateDir",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(stateDir, "runs"),
      repo_root: safeRepo,
    });
    assert.equal(resDataInState.isError, true);
    assert.equal(resDataInState.structuredContent.exit_code, 2);

    // uaw_run with only run_id and no allowedRoots must place data_dir outside stateDir and succeed
    const isolatedStateParent = join(safeRepo, "no-roots-parent");
    const isolatedStateDir = join(isolatedStateParent, "state");
    mkdirSync(isolatedStateDir, { recursive: true });
    const noRootsHandler = createMcpHandler({ allowedRoots: [], stateDir: isolatedStateDir });
    const resOnlyRunId = await noRootsHandler.callTool("uaw_run", {
      workflow: "sw_dev",
      run_id: "only-run-id-stdio",
      goal: "Run with run_id alone and no allowedRoots",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resOnlyRunId.isError, false, resOnlyRunId.structuredContent?.stderr ?? resOnlyRunId.structuredContent?.error ?? "");
    assert.equal(resOnlyRunId.structuredContent.run_id, "only-run-id-stdio");
    assert.equal(resOnlyRunId.structuredContent.data_dir.startsWith(isolatedStateDir), false);

    // Non-existent case-variant paths AND created case-variant paths produce identical keys on case-insensitive FS
    const realNative = realpathSync.native ?? realpathSync;
    let isCaseInsensitiveFs = false;
    try {
      isCaseInsensitiveFs = realNative(safeRepo.toUpperCase()) === realNative(safeRepo);
    } catch {
      isCaseInsensitiveFs = false;
    }
    if (isCaseInsensitiveFs) {
      assert.equal(
        canonicalPathKey(join(safeRepo, "UncreatedCaseOut")),
        canonicalPathKey(join(safeRepo, "uncreatedcaseout")),
      );
      assert.equal(
        canonicalPathKey(join(safeRepo, "Caf\u00e9Out")),
        canonicalPathKey(join(safeRepo, "cafe\u0301out")),
      );
      const caseOutUpper = join(safeRepo, "CaseMixOut");
      const caseOutLower = join(safeRepo, "casemixout");
      const caseRunA = await handler.callTool("uaw_run", {
        workflow: "sw_dev",
        goal: "Claim upper before mkdir",
        adapter: "fake",
        fake_fixture_dir: rollbackFxDir,
        data_dir: join(safeRepo, "case-mix-data-a"),
        output_path: caseOutUpper,
        repo_root: safeRepo,
        skills_root: safeRepo,
      });
      assert.equal(caseRunA.isError, false, caseRunA.structuredContent?.stderr ?? "");
      mkdirSync(caseOutUpper, { recursive: true });
      assert.equal(canonicalPathKey(caseOutUpper), canonicalPathKey(caseOutLower));
      const caseRunB = await handler.callTool("uaw_run", {
        workflow: "sw_dev",
        goal: "Lowercase collision after mkdir",
        adapter: "fake",
        fake_fixture_dir: rollbackFxDir,
        data_dir: join(safeRepo, "case-mix-data-b"),
        output_path: caseOutLower,
        repo_root: safeRepo,
        skills_root: safeRepo,
      });
      assert.equal(caseRunB.isError, true);
      assert.equal(caseRunB.structuredContent.exit_code, 2);
      assert.match(caseRunB.structuredContent.error, /already owned|overlaps/i);
    } else {
      assert.notEqual(
        canonicalPathKey(join(safeRepo, "UncreatedCaseOut")),
        canonicalPathKey(join(safeRepo, "uncreatedcaseout")),
        "canonicalPathKey must preserve distinct case on case-sensitive filesystems",
      );
    }

    // uaw_gates mode=check requires run_id or data_dir and never inherits ambient UWF_DATA_DIR
    const prevAmbientData = process.env.UWF_DATA_DIR;
    process.env.UWF_DATA_DIR = outsideTargetDir;
    try {
      const resCheckNoData = await handler.callTool("uaw_gates", {
        mode: "check",
        workflow: "sw_dev",
        stage: "intake",
        repo_root: safeRepo,
        skills_root: safeRepo,
      });
      assert.equal(resCheckNoData.isError, true);
      assert.equal(resCheckNoData.structuredContent.exit_code, 2);
      assert.match(resCheckNoData.structuredContent.error, /run_id or data_dir is required/i);

      // Other tools must also ignore ambient UWF_DATA_DIR when run_id and data_dir are omitted
      const resReadNoTarget = await handler.callTool("uaw_read_state", {});
      assert.equal(resReadNoTarget.isError, true);
      assert.equal(resReadNoTarget.structuredContent.exit_code, 2);
      assert.match(resReadNoTarget.structuredContent.error, /Either run_id or data_dir is required/i);
    } finally {
      if (prevAmbientData === undefined) delete process.env.UWF_DATA_DIR;
      else process.env.UWF_DATA_DIR = prevAmbientData;
    }

    // uaw_gates mode=check rejects missing data_dir or uninitialized empty dirs cleanly with exit 2
    const neverGatesDir = join(safeRepo, "never-created-gates-dir");
    const resMissingGates = await handler.callTool("uaw_gates", {
      mode: "check",
      workflow: "sw_dev",
      stage: "intake",
      data_dir: neverGatesDir,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resMissingGates.isError, true);
    assert.equal(resMissingGates.structuredContent.exit_code, 2);
    assert.equal(existsSync(neverGatesDir), false, "uaw_gates mode=check must not create missing data_dir");

    const emptyGatesDir = join(safeRepo, "empty-uninit-gates-dir");
    mkdirSync(emptyGatesDir, { recursive: true });
    const resEmptyGates = await handler.callTool("uaw_gates", {
      mode: "check",
      workflow: "sw_dev",
      stage: "intake",
      data_dir: emptyGatesDir,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(resEmptyGates.isError, true);
    assert.equal(resEmptyGates.structuredContent.exit_code, 2);
    assert.match(resEmptyGates.structuredContent.error, /No initialized run/i);

    // Query readers reject non-string optional filters with UsageError (exit 2), not internal_error (70)
    const resBadReqFilter = await handler.callTool("uaw_read_requirements", {
      data_dir: transDataA,
      status: { bad: 1 },
    });
    assert.equal(resBadReqFilter.isError, true);
    assert.equal(resBadReqFilter.structuredContent.exit_code, 2);
    assert.equal(resBadReqFilter.structuredContent.status, "usage_error");

    // Symlink + .. traversal in literal goal string (evil/../secret) must fail closed
    const outsideSecretSub = join(outsideTargetDir, "sub");
    mkdirSync(outsideSecretSub, { recursive: true });
    writeFileSync(join(outsideTargetDir, "secret.md"), "TOP_SECRET\n");
    const symEscapeDir = join(safeRepo, "sym-escape");
    symlinkSync(outsideSecretSub, symEscapeDir);
    const resSymDotDotGoal = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "sym-escape/../secret.md",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(safeRepo, "sym-dotdot-goal-data"),
      repo_root: safeRepo,
    });
    assert.equal(resSymDotDotGoal.isError, true);
    assert.equal(resSymDotDotGoal.structuredContent.exit_code, 2);

    // Failed uaw_stage_transition init rolls back run-meta, index, and output ownership
    const failInitData = join(safeRepo, "fail-init-data");
    const failInitOut = join(safeRepo, "fail-init-out");
    const failInitRes = await handler.callTool("uaw_stage_transition", {
      target: "stage",
      action: "init",
      workflow: "nonexistent_workflow_xyz",
      data_dir: failInitData,
      output_path: failInitOut,
      repo_root: safeRepo,
    });
    assert.equal(failInitRes.structuredContent.ok, false);
    assert.equal(failInitRes.structuredContent.exit_code, 2);
    assert.equal(readRunMeta(failInitData), null, "failed init must roll back run-meta.json");
    assert.equal(
      lookupRunById(stateDir, failInitRes.structuredContent.run_id),
      null,
      "failed init must roll back run index entry",
    );
    assert.equal(
      existsSync(join(failInitData, "uwf-stages.db")),
      false,
      "failed init must clean up newly created empty uwf-stages.db",
    );

    // Pre-DB uaw_run usage failure rolls back meta/ownership & single-dash goal "-x" is rejected
    const singleDashGoalRes = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "-x",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: join(safeRepo, "single-dash-goal-data"),
      repo_root: safeRepo,
    });
    assert.equal(singleDashGoalRes.isError, true);
    assert.equal(singleDashGoalRes.structuredContent.exit_code, 2);

    const badStageRun = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Fail early pre-DB",
      from_stage: "no_such_stage_xyz",
      adapter: "fake",
      fake_fixture_dir: rollbackFxDir,
      data_dir: failInitData,
      output_path: failInitOut,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(badStageRun.structuredContent.ok, false);
    assert.equal(badStageRun.structuredContent.exit_code, 2);
    assert.equal(readRunMeta(failInitData), null, "pre-DB exit 2 uaw_run must roll back run-meta.json");

    // Reusing failInitData + failInitOut with valid sw_dev now succeeds (proves ownership rollback too)
    const reuseFxDir = join(safeRepo, "fx-reuse-after-fail");
    mkdirSync(reuseFxDir, { recursive: true });
    writeFileSync(
      join(reuseFxDir, "intake.json"),
      JSON.stringify({
        files: { "fail-init-out/out.md": "# Reuse output\n" },
        transcript: "ok",
        sessionId: "sess-reuse",
      }),
      "utf8",
    );
    const reuseAfterFailRun = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reuse after failed init/run rollback",
      adapter: "fake",
      fake_fixture_dir: reuseFxDir,
      data_dir: failInitData,
      output_path: failInitOut,
      repo_root: safeRepo,
      skills_root: safeRepo,
    });
    assert.equal(reuseAfterFailRun.isError, false, reuseAfterFailRun.structuredContent?.stderr ?? "");
    assert.equal(reuseAfterFailRun.structuredContent.exit_code, 0);
    assert.equal(reuseAfterFailRun.structuredContent.ok, true);

    // execNodeAsync timeout terminates grandchild process group as well as direct child (POSIX)
    if (process.platform !== "win32") {
      const childScript = join(safeRepo, "spawn-grandchild.mjs");
      const gcPidFile = join(safeRepo, "grandchild.pid");
      writeFileSync(
        childScript,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(gcPidFile)}, String(gc.pid));
setTimeout(() => {}, 30000);
`,
      );
      const execRes = await execNodeAsync(childScript, [], { cwd: safeRepo, timeoutMs: 600 });
      assert.equal(execRes.code, 70);
      assert.match(execRes.stderr, /timed out/);
      const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
      assert.ok(Number.isInteger(gcPid) && gcPid > 0);
      const deadline = Date.now() + 1_000;
      while (pidAlive(gcPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(pidAlive(gcPid), false, `grandchild pid ${gcPid} must be terminated on execNodeAsync timeout`);
    }
  } finally {
    rmSync(outsideTargetDir, { recursive: true, force: true });
  }

  // Non-DB skill/agent resource symlinks must be rejected before spawning child CLIs
  const symlinkResRepo = join(safeRepo, "repo-symlinked-non-db");
  mkdirSync(join(symlinkResRepo, ".github", "skills", "uwf-evil"), { recursive: true });
  mkdirSync(join(symlinkResRepo, ".github", "agents"), { recursive: true });
  const evilStagesSym = join(symlinkResRepo, ".github", "skills", "uwf-evil", "stages.yaml");
  symlinkSync("/etc/hosts", evilStagesSym);
  try {
    const resSymStagesRun = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reject symlinked stages.yaml",
      adapter: "fake",
      fake_fixture_dir: join(safeRepo, "missing-fx"),
      data_dir: join(safeRepo, "sym-stages-data"),
      repo_root: symlinkResRepo,
      skills_root: symlinkResRepo,
    });
    assert.equal(resSymStagesRun.isError, true);
    assert.equal(resSymStagesRun.structuredContent.exit_code, 2);
    assert.match(resSymStagesRun.structuredContent.error, /symlink|regular file/i);
  } finally {
    rmSync(evilStagesSym, { force: true });
  }
  const evilAgentSym = join(symlinkResRepo, ".github", "agents", "evil.agent.md");
  symlinkSync("/etc/hosts", evilAgentSym);
  try {
    const resSymAgentTrans = await handler.callTool("uaw_stage_transition", {
      target: "stage",
      action: "init",
      workflow: "sw_dev",
      data_dir: join(safeRepo, "sym-agent-data"),
      repo_root: symlinkResRepo,
      skills_root: symlinkResRepo,
    });
    assert.equal(resSymAgentTrans.isError, true);
    assert.equal(resSymAgentTrans.structuredContent.exit_code, 2);
    assert.match(resSymAgentTrans.structuredContent.error, /symlink|regular file/i);
  } finally {
    rmSync(evilAgentSym, { force: true });
  }

  // Out-of-bounds or non-positive timeout_ms must fail closed with exit_code 2
  for (const badTimeout of [0, 0.5, -100, 999_999_999_999]) {
    const badTimeoutRes = await handler.callTool("uaw_run", {
      workflow: "sw_dev",
      goal: "Reject unbounded timeout_ms",
      adapter: "fake",
      data_dir: join(safeRepo, "bad-timeout-data"),
      repo_root: safeRepo,
      timeout_ms: badTimeout,
    });
    assert.equal(badTimeoutRes.isError, true, `timeout_ms=${badTimeout} must be rejected`);
    assert.equal(badTimeoutRes.structuredContent.exit_code, 2);
    assert.match(badTimeoutRes.structuredContent.error, /timeout_ms/i);
  }

  // Forced uaw_stage_transition workflow mismatch rejection + forced overlapping output_path transfer & resume
  const regWs = createFixtureWorkspace({ withQuestions: true, withRoundTrip: false, prefix: "uaw-mcp-reg-" });
  try {
    const regHandler = createMcpHandler({ allowedRoots: [regWs.root], stateDir: regWs.stateDir });
    const overlapData = join(regWs.repoRoot, "overlap-transfer-data");
    const childOut = join(regWs.repoRoot, "out-overlap", "child");
    const parentOut = join(regWs.repoRoot, "out-overlap");
    const childFx = regWs.writeFixturesForOutput(childOut);
    const parentFx = regWs.writeFixturesForOutput(parentOut);

    const initOverlapRun = await regHandler.callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Initial child output_path run",
      adapter: "fake",
      fake_fixture_dir: childFx,
      data_dir: overlapData,
      output_path: childOut,
      repo_root: regWs.repoRoot,
      skills_root: regWs.skillsRoot,
    });
    assert.equal(initOverlapRun.structuredContent.exit_code, 3, initOverlapRun.structuredContent.stderr);
    const metaBeforeTrans = readFileSync(join(overlapData, "run-meta.json"), "utf8");

    const forcedMismatchTrans = await regHandler.callTool("uaw_stage_transition", {
      data_dir: overlapData,
      target: "stage",
      action: "init",
      force: true,
      workflow: "other_workflow",
      repo_root: regWs.repoRoot,
      skills_root: regWs.skillsRoot,
    });
    assert.equal(forcedMismatchTrans.isError, true);
    assert.equal(forcedMismatchTrans.structuredContent.exit_code, 2);
    assert.match(forcedMismatchTrans.structuredContent.error, /does not match persisted workflow/i);
    assert.equal(readFileSync(join(overlapData, "run-meta.json"), "utf8"), metaBeforeTrans);

    const forcedOverlapRun = await regHandler.callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Forced transfer to overlapping parent output_path",
      adapter: "fake",
      fake_fixture_dir: parentFx,
      data_dir: overlapData,
      output_path: parentOut,
      repo_root: regWs.repoRoot,
      skills_root: regWs.skillsRoot,
      force: true,
    });
    assert.equal(forcedOverlapRun.structuredContent.exit_code, 3, forcedOverlapRun.structuredContent.stderr);
    const transferredRunId = forcedOverlapRun.structuredContent.run_id;
    assert.notEqual(transferredRunId, initOverlapRun.structuredContent.run_id);

    const pendingQ = forcedOverlapRun.structuredContent.pending_questions?.[0];
    assert.ok(pendingQ?.id, "transferred run must pause with pending question");
    const ansRes = await regHandler.callTool("uaw_question_resolve", {
      run_id: transferredRunId,
      action: "answer",
      id: pendingQ.id,
      answer: "node",
    });
    assert.equal(ansRes.isError, false, ansRes.structuredContent?.error ?? "");

    const resumedTransferred = await regHandler.callTool("uaw_resume", {
      run_id: transferredRunId,
      adapter: "fake",
      fake_fixture_dir: parentFx,
      repo_root: regWs.repoRoot,
      skills_root: regWs.skillsRoot,
    });
    assert.equal(resumedTransferred.isError, false, resumedTransferred.structuredContent?.stderr ?? resumedTransferred.structuredContent?.error ?? "");
    assert.equal(resumedTransferred.structuredContent.exit_code, 0);

    // Adapter state symlinks in data_dir (fake-attempts.json, fake-sessions.json, grokbot/) must fail closed
    for (const adapterSymRel of ["fake-attempts.json", "fake-sessions.json", join("grokbot", "requests", "0001.json")]) {
      const symTargetPath = join(overlapData, adapterSymRel);
      const hadOrig = existsSync(symTargetPath);
      const origBytes = hadOrig ? readFileSync(symTargetPath) : null;
      mkdirSync(dirname(symTargetPath), { recursive: true });
      rmSync(symTargetPath, { force: true });
      symlinkSync("/etc/hosts", symTargetPath);
      try {
        const symRun = await regHandler.callTool("uaw_run", {
          workflow: "mcp_fixture",
          goal: `Reject symlinked adapter state ${adapterSymRel}`,
          adapter: "fake",
          fake_fixture_dir: parentFx,
          data_dir: overlapData,
          output_path: parentOut,
          repo_root: regWs.repoRoot,
          skills_root: regWs.skillsRoot,
          force: true,
        });
        assert.equal(symRun.isError, true, `uaw_run must reject ${adapterSymRel} symlink`);
        assert.equal(symRun.structuredContent.exit_code, 2);
        assert.match(symRun.structuredContent.error, /symlink/i);

        const symResume = await regHandler.callTool("uaw_resume", {
          data_dir: overlapData,
          adapter: "fake",
          fake_fixture_dir: parentFx,
          repo_root: regWs.repoRoot,
          skills_root: regWs.skillsRoot,
        });
        assert.equal(symResume.isError, true, `uaw_resume must reject ${adapterSymRel} symlink`);
        assert.equal(symResume.structuredContent.exit_code, 2);
        assert.match(symResume.structuredContent.error, /symlink/i);
      } finally {
        rmSync(symTargetPath, { force: true });
        if (hadOrig) {
          writeFileSync(symTargetPath, origBytes);
        } else if (adapterSymRel.startsWith("grokbot")) {
          rmSync(join(overlapData, "grokbot"), { recursive: true, force: true });
        }
      }
    }

    // Stage input symlinks (output_path literal & repo_root glob) must fail closed before prompt materialization
    const stageOut = join(regWs.repoRoot, "stage-input-sym-out");
    const stageFx = regWs.writeFixturesForOutput(stageOut);
    mkdirSync(stageOut, { recursive: true });
    symlinkSync("/etc/hosts", join(stageOut, "plan.md"));
    try {
      const symStageInputRun = await regHandler.callTool("uaw_run", {
        workflow: "mcp_fixture",
        goal: "Reject symlinked stage input plan.md",
        adapter: "fake",
        fake_fixture_dir: stageFx,
        data_dir: join(regWs.repoRoot, "stage-input-sym-data"),
        output_path: stageOut,
        repo_root: regWs.repoRoot,
        skills_root: regWs.skillsRoot,
      });
      assert.equal(symStageInputRun.isError, true);
      assert.equal(symStageInputRun.structuredContent.exit_code, 2);
      assert.match(symStageInputRun.structuredContent.error, /symlink/i);
    } finally {
      rmSync(join(stageOut, "plan.md"), { force: true });
    }

    const adrDir = join(regWs.repoRoot, "docs", "adr");
    mkdirSync(adrDir, { recursive: true });
    const adrSym = join(adrDir, "ADR-0001.md");
    symlinkSync("/etc/hosts", adrSym);
    try {
      const symGlobInputRun = await regHandler.callTool("uaw_run", {
        workflow: "sw_dev",
        goal: "Reject symlinked ADR glob input",
        adapter: "fake",
        fake_fixture_dir: stageFx,
        data_dir: join(regWs.repoRoot, "stage-glob-sym-data"),
        output_path: join(regWs.repoRoot, "stage-glob-sym-out"),
        repo_root: regWs.repoRoot,
      });
      assert.equal(symGlobInputRun.isError, true);
      assert.equal(symGlobInputRun.structuredContent.exit_code, 2);
      assert.match(symGlobInputRun.structuredContent.error, /symlink/i);
    } finally {
      rmSync(adrSym, { force: true });
    }

    // node_modules/.bin symlinks must NOT falsely fail stage-input validation, and {a,b} brace globs must enforce symlink checks
    const nmBinDir = join(regWs.repoRoot, "node_modules", ".bin");
    const nmPkgDir = join(regWs.repoRoot, "node_modules", "sample-tool");
    mkdirSync(nmBinDir, { recursive: true });
    mkdirSync(nmPkgDir, { recursive: true });
    writeFileSync(join(nmPkgDir, "cli.js"), "#!/usr/bin/env node\n");
    symlinkSync("../sample-tool/cli.js", join(nmBinDir, "tool"));

    const braceSkills = join(regWs.root, "brace-skills");
    const braceSkillDir = join(braceSkills, ".github", "skills", "uwf-brace");
    mkdirSync(join(braceSkillDir), { recursive: true });
    mkdirSync(join(braceSkills, ".github", "agents"), { recursive: true });
    writeFileSync(
      join(braceSkills, ".github", "agents", "brace.agent.md"),
      "---\nname: brace\ndescription: test agent\ntools: []\n---\nWork in {{cwd}} writing to {{output_path}}.\n",
    );
    writeFileSync(
      join(braceSkillDir, "stages.yaml"),
      [
        "stages:",
        "  - name: check",
        "    agent: brace",
        "    inputs:",
        '      - "**/*.md"',
        '      - "docs/{adr,rfcs}/*.md"',
        "    outputs: []",
        "",
      ].join("\n"),
    );
    const rfcsDir = join(regWs.repoRoot, "docs", "rfcs");
    mkdirSync(rfcsDir, { recursive: true });
    writeFileSync(join(rfcsDir, "RFC-0001.md"), "# RFC 1\nValid input\n");

    // Clean regular brace-glob + recursive-glob inputs alongside node_modules/.bin symlink succeed
    validateWorkflowStageInputs({
      workflow: "brace",
      repoRoot: regWs.repoRoot,
      skillsRoot: braceSkills,
      outputPath: stageOut,
    });
    const bracePrompt = await materializePrompt({
      workflow: "brace",
      stage: "check",
      repoRoot: regWs.repoRoot,
      skillsRoot: braceSkills,
      outputPath: stageOut,
    });
    assert.deepEqual(bracePrompt.inputsMissing, []);
    assert.match(bracePrompt.prompt, /Valid input/);

    // Symlinked file matched via {a,b} brace glob must fail closed
    const braceFileSym = join(rfcsDir, "sym.md");
    symlinkSync("/etc/hosts", braceFileSym);
    try {
      assert.throws(
        () => validateWorkflowStageInputs({ workflow: "brace", repoRoot: regWs.repoRoot, skillsRoot: braceSkills, outputPath: stageOut }),
        /symlink/i,
      );
      await assert.rejects(
        () => materializePrompt({ workflow: "brace", stage: "check", repoRoot: regWs.repoRoot, skillsRoot: braceSkills, outputPath: stageOut }),
        /symlink/i,
      );
    } finally {
      rmSync(braceFileSym, { force: true });
    }

    // Symlinked directory targeted via {a,b} brace glob must fail closed even when empty
    const emptyOutside = mkdtempSync(join(regWs.root, "outside-empty-"));
    rmSync(adrDir, { recursive: true, force: true });
    symlinkSync(emptyOutside, adrDir);
    try {
      assert.throws(
        () => validateWorkflowStageInputs({ workflow: "brace", repoRoot: regWs.repoRoot, skillsRoot: braceSkills, outputPath: stageOut }),
        /symlink/i,
      );
      await assert.rejects(
        () => materializePrompt({ workflow: "brace", stage: "check", repoRoot: regWs.repoRoot, skillsRoot: braceSkills, outputPath: stageOut }),
        /symlink/i,
      );
    } finally {
      rmSync(adrDir, { force: true });
    }

    // Repo root path containing glob metacharacters (e.g. "repo[1]") must not break glob input matching
    const bracketRepo = join(regWs.root, "repo[1]");
    const bracketRfcs = join(bracketRepo, "docs", "rfcs");
    const bracketOut = join(bracketRepo, "stage-out");
    mkdirSync(bracketRfcs, { recursive: true });
    mkdirSync(bracketOut, { recursive: true });
    writeFileSync(join(bracketRfcs, "RFC-0001.md"), "# Bracket RFC\nWorks inside [1] path\n");
    validateWorkflowStageInputs({
      workflow: "brace",
      repoRoot: bracketRepo,
      skillsRoot: braceSkills,
      outputPath: bracketOut,
    });
    const bracketPrompt = await materializePrompt({
      workflow: "brace",
      stage: "check",
      repoRoot: bracketRepo,
      skillsRoot: braceSkills,
      outputPath: bracketOut,
    });
    assert.deepEqual(bracketPrompt.inputsMissing, []);
    assert.match(bracketPrompt.prompt, /Works inside \[1\] path/);
  } finally {
    rmSync(regWs.root, { recursive: true, force: true });
  }

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

    // Malformed & spoofed Host headers -> 403 Forbidden host without crashing server
    for (const badHostHeader of ["[invalid host", "evil.rebind.attacker.com"]) {
      const badHostRes = await new Promise((resolveReq, rejectReq) => {
        const r = httpRequest(
          { host: srv.host, port: srv.port, path: "/healthz", method: "GET", headers: { Host: badHostHeader } },
          (resp) => {
            let body = "";
            resp.setEncoding("utf8");
            resp.on("data", (chunk) => { body += chunk; });
            resp.on("end", () => resolveReq({ status: resp.statusCode, body }));
          },
        );
        r.on("error", rejectReq);
        r.end();
      });
      assert.equal(badHostRes.status, 403, `Host=${badHostHeader} must be rejected with 403`);
      assert.match(badHostRes.body, /Forbidden host/);
    }

    // Valid /healthz after malformed requests proves server remained alive
    const healthRes = await fetch(`http://${srv.host}:${srv.port}/healthz`);
    assert.equal(healthRes.status, 200);

    // Protocol-relative / scheme-relative target -> 400 Bad request target without crashing
    const badTargetRes = await new Promise((resolveReq, rejectReq) => {
      const r = httpRequest(
        { host: srv.host, port: srv.port, path: "//evil.example.com/mcp", method: "POST" },
        (resp) => {
          let body = "";
          resp.setEncoding("utf8");
          resp.on("data", (chunk) => { body += chunk; });
          resp.on("end", () => resolveReq({ status: resp.statusCode, body }));
        },
      );
      r.on("error", rejectReq);
      r.end();
    });
    assert.equal(badTargetRes.status, 400);
    assert.match(badTargetRes.body, /Bad request target/);

    // Malformed Mcp-Session-Id -> 400 on GET and POST
    for (const method of ["GET", "POST"]) {
      const badSess = await fetch(url, {
        method,
        headers: {
          Authorization: "Bearer expected-bearer-secret",
          Origin: "chrome-extension://allowed-ext",
          "Mcp-Session-Id": "bad session id!",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) } : {}),
      });
      assert.equal(badSess.status, 400, `${method} malformed Mcp-Session-Id must return 400`);
    }
  } finally {
    await srv.close();
  }

  console.log("uaw-mcp security, secret-redaction, auth, and Origin tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
