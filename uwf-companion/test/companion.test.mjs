/**
 * companion.test.mjs — Real-module unit, security, VSIX hygiene, and live stdio/HTTP
 * uaw-mcp/v1 integration tests for UWF Companion.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  badge,
  Debouncer,
  deriveColumns,
  escHtml,
  formatCellValue,
  formatCsvReport,
  formatJsonReport,
  isQuestionRequired,
  pageShell,
  renderDynamicTable,
  resolveBundledPluginRoot,
  resolveServerConfig,
  secretKeyForRemoteUrl,
  UawDataService,
  UawMcpClient,
  validateAllowedRoots,
  validateRemoteUrl,
  writeReportFileSafe,
} from "../dist/test-exports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(COMPANION_ROOT, "..");
const SRC_ROOT = path.join(COMPANION_ROOT, "src");
const BUNDLED_MCP_BIN = path.join(
  COMPANION_ROOT,
  "dist",
  "uaw-plugin",
  "runtime",
  "bin",
  "uaw-mcp.mjs",
);

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// ── 1. Architectural & VSIX Packaging Hygiene ───────────────────────────────

test("uwf-companion/src contains zero node:sqlite or better-sqlite3 imports and no stale .github copy", () => {
  assert.equal(
    fs.existsSync(path.join(COMPANION_ROOT, ".github")),
    false,
    "Stale uwf-companion/.github copy must be deleted",
  );
  assert.equal(
    fs.existsSync(path.join(SRC_ROOT, "db")),
    false,
    "Direct SQLite src/db directory must be removed",
  );

  for (const file of walkFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, "utf8");
    assert.equal(
      /["']node:sqlite["']|["']better-sqlite3["']/.test(content),
      false,
      `Disallowed direct SQLite import in ${path.relative(COMPANION_ROOT, file)}`,
    );
  }
});

test("staged bundle and vsce ls satisfy AI contribution & VSIX hygiene checks", () => {
  const checkOut = execFileSync(
    process.execPath,
    [path.join(COMPANION_ROOT, "scripts", "stage-bundle.mjs"), "--check-manifest"],
    { cwd: COMPANION_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const checkSummary = JSON.parse(checkOut);
  assert.equal(checkSummary.ok, true);
  assert.ok(checkSummary.counts.chatAgents > 0);
  assert.ok(checkSummary.counts.chatSkills > 0);
  assert.ok(checkSummary.counts.chatPromptFiles > 0);
  assert.ok(checkSummary.counts.chatInstructions > 0);

  const pkg = JSON.parse(fs.readFileSync(path.join(COMPANION_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines?.vscode, "^1.109.0", "engines.vscode must require >=1.109.0 for chatSkills");
  assert.ok(Array.isArray(pkg.contributes?.mcpServerDefinitionProviders));
  assert.equal(pkg.contributes.mcpServerDefinitionProviders[0]?.id, "uwf.uaw-mcp");

  for (const agentEntry of pkg.contributes.chatAgents) {
    const absAgent = path.join(COMPANION_ROOT, agentEntry.path);
    const agentText = fs.readFileSync(absAgent, "utf8");
    assert.equal(
      /^\s*user-invokable\s*:/m.test(agentText),
      false,
      `Misspelled user-invokable frontmatter key in ${agentEntry.path}`,
    );
    if (!agentEntry.path.endsWith("/uwf-core-orchestrator.agent.md")) {
      assert.match(
        agentText,
        /^\s*user-invocable:\s*false\s*$/m,
        `Internal agent must declare user-invocable: false: ${agentEntry.path}`,
      );
    }
  }

  const vsceBin = path.join(
    COMPANION_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vsce.cmd" : "vsce",
  );
  const vsceOut = execFileSync(vsceBin, ["ls"], {
    cwd: COMPANION_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packed = vsceOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const packedSet = new Set(packed);

  for (const required of [
    "dist/extension.js",
    "dist/uaw-plugin/runtime/bin/uaw-mcp.mjs",
    "dist/uaw-plugin/runtime/node_modules/js-yaml/package.json",
  ]) {
    assert.ok(packedSet.has(required), `VSIX must include ${required}`);
  }

  for (const key of ["chatAgents", "chatSkills", "chatPromptFiles", "chatInstructions"]) {
    for (const item of pkg.contributes[key]) {
      const normalized = item.path.replace(/^\.\//, "");
      assert.ok(packedSet.has(normalized), `VSIX missing ${key} file: ${normalized}`);
    }
  }

  for (const entry of packed) {
    assert.equal(
      /\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/.test(entry),
      false,
      `VSIX must not include DB file: ${entry}`,
    );
    assert.equal(entry.endsWith(".node"), false, `VSIX must not include .node binary: ${entry}`);
    assert.equal(
      /(?:^|\/)better-sqlite3(?:\/|$)/.test(entry),
      false,
      `VSIX must not include better-sqlite3: ${entry}`,
    );
    assert.equal(
      entry.startsWith("src/") ||
        entry.startsWith("test/") ||
        entry.startsWith(".vscode/") ||
        entry === "dist/test-exports.mjs",
      false,
      `VSIX must exclude dev/test file: ${entry}`,
    );
  }
});

// ── 2. McpServerConfig Security & Resolution Tests ──────────────────────────

test("validateRemoteUrl enforces HTTPS (except loopback) and blocks credentials/control chars", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/mcp"), /https:\/\//);
  assert.throws(() => validateRemoteUrl("https://user:pass@example.com/mcp"), /credentials/);
  assert.throws(() => validateRemoteUrl("file:///tmp/mcp"), /https:\/\/ or http:\/\//);
  assert.throws(() => validateRemoteUrl("https://example.com/\nmcp"), /control/);

  assert.throws(
    () => validateRemoteUrl("not-a-url?token=leak-secret-123"),
    (err) => {
      assert.equal(String(err).includes("leak-secret-123"), false);
      return true;
    },
  );

  assert.equal(validateRemoteUrl("http://127.0.0.1:8787/mcp"), "http://127.0.0.1:8787/mcp");
  assert.equal(validateRemoteUrl("http://localhost:8787/mcp"), "http://localhost:8787/mcp");
  assert.equal(validateRemoteUrl("https://uaw.example.com/mcp"), "https://uaw.example.com/mcp");
});

test("validateAllowedRoots rejects commas, leading dashes, empty entries, and NUL bytes", () => {
  assert.deepEqual(validateAllowedRoots([" /tmp/ws "]), ["/tmp/ws"]);
  assert.throws(() => validateAllowedRoots(["/a,/b"]), /commas/);
  assert.throws(() => validateAllowedRoots(["--flag"]), /'-'/);
  assert.throws(() => validateAllowedRoots(["   "]), /empty/);
  assert.throws(() => validateAllowedRoots(["/tmp\0evil"]), /control/);
});

test("resolveServerConfig sets ELECTRON_RUN_AS_NODE=1 only for Electron host process", () => {
  assert.equal(
    resolveBundledPluginRoot(COMPANION_ROOT),
    path.join(COMPANION_ROOT, "dist", "uaw-plugin"),
  );

  const electronCfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: REPO_ROOT,
    electronRuntime: true,
    settings: { allowedRoots: [REPO_ROOT] },
  });
  assert.equal(electronCfg.transport, "stdio");
  assert.equal(electronCfg.scriptPath, BUNDLED_MCP_BIN);
  assert.equal(electronCfg.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(electronCfg.args, [
    BUNDLED_MCP_BIN,
    "--transport",
    "stdio",
    "--allowed-roots",
    REPO_ROOT,
  ]);

  const plainNodeCfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: REPO_ROOT,
    electronRuntime: false,
  });
  assert.equal(plainNodeCfg.transport, "stdio");
  assert.equal(plainNodeCfg.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(plainNodeCfg.args, [
    BUNDLED_MCP_BIN,
    "--transport",
    "stdio",
    "--allowed-roots",
    REPO_ROOT,
  ]);

  const customNodeCfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: REPO_ROOT,
    electronRuntime: true,
    settings: { nodePath: process.execPath },
  });
  assert.equal(customNodeCfg.transport, "stdio");
  assert.equal(customNodeCfg.env.ELECTRON_RUN_AS_NODE, undefined);

  // Non-dev extension path without bundled dist/uaw-plugin must refuse ../bin/uaw-mcp.mjs fallback
  const isolatedExtDir = path.join(REPO_ROOT, "scripts");
  assert.throws(
    () =>
      resolveServerConfig({
        extensionPath: isolatedExtDir,
        workspaceRoot: REPO_ROOT,
        allowMonorepoFallback: false,
      }),
    /Could not locate uaw-mcp\.mjs/,
  );
  const devFallbackCfg = resolveServerConfig({
    extensionPath: isolatedExtDir,
    workspaceRoot: REPO_ROOT,
    allowMonorepoFallback: true,
  });
  assert.equal(devFallbackCfg.scriptPath, path.join(REPO_ROOT, "bin", "uaw-mcp.mjs"));

  // Fail closed when workspaceRoot is absent and neither allowedRoots nor absolute dataDir is set
  assert.throws(
    () =>
      resolveServerConfig({
        extensionPath: COMPANION_ROOT,
        workspaceRoot: undefined,
      }),
    /Open a workspace folder or configure uwf\.allowedRoots/,
  );
  assert.throws(
    () =>
      resolveServerConfig({
        extensionPath: COMPANION_ROOT,
        workspaceRoot: undefined,
        settings: { dataDir: "relative-dir" },
      }),
    /Relative uwf\.dataDir requires an open workspace folder/,
  );
  const absDataCfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: undefined,
    settings: { dataDir: REPO_ROOT },
  });
  assert.deepEqual(absDataCfg.args, [
    BUNDLED_MCP_BIN,
    "--transport",
    "stdio",
    "--allowed-roots",
    REPO_ROOT,
  ]);
});

test("package.json declares Workspace Trust restrictions, machine scopes, and origin-scoped secret keys", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(COMPANION_ROOT, "package.json"), "utf8"));
  const untrusted = pkg.capabilities?.untrustedWorkspaces;
  assert.equal(untrusted?.supported, "limited");

  const sensitiveKeys = [
    "uwf.nodePath",
    "uwf.mcpServerPath",
    "uwf.mcpServerUrl",
    "uwf.stateDir",
    "uwf.dataDir",
    "uwf.allowedRoots",
    "uwf.refreshIntervalMs",
  ];
  for (const key of sensitiveKeys) {
    assert.ok(
      untrusted?.restrictedConfigurations?.includes(key),
      `restrictedConfigurations missing ${key}`,
    );
    assert.equal(
      pkg.contributes?.configuration?.properties?.[key]?.scope,
      "machine",
      `${key} must declare scope: "machine"`,
    );
  }

  assert.equal(
    secretKeyForRemoteUrl("https://uaw.example.com/a"),
    secretKeyForRemoteUrl("https://uaw.example.com/b"),
  );
  assert.notEqual(
    secretKeyForRemoteUrl("https://uaw.example.com/mcp"),
    secretKeyForRemoteUrl("https://evil.example.com/mcp"),
  );
  assert.notEqual(
    secretKeyForRemoteUrl("https://uaw.example.com:8443/mcp"),
    secretKeyForRemoteUrl("https://uaw.example.com/mcp"),
  );
  assert.throws(() => secretKeyForRemoteUrl("http://evil.example.com/mcp"), /https:\/\//);
});

test("UawDataService.collectInsights blocks symlink-escape existence oracle inside workspace", async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-symlink-")));
  const wsDir = path.join(scratch, "ws");
  const outsideDir = path.join(scratch, "outside");
  const stateDir = path.join(scratch, "state");
  const outsideArtDir = path.join(outsideDir, "workflow-artifacts");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(outsideArtDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(outsideArtDir, "issues-intake.md"), "# Secret\n", "utf8");
  fs.mkdirSync(path.join(wsDir, "tmp"), { recursive: true });
  fs.symlinkSync(outsideArtDir, path.join(wsDir, "tmp", "workflow-artifacts"));

  const client = new UawMcpClient(
    resolveServerConfig({
      extensionPath: COMPANION_ROOT,
      workspaceRoot: wsDir,
      electronRuntime: false,
      settings: { stateDir, allowedRoots: [wsDir] },
    }),
  );
  const service = new UawDataService(client, {
    workspaceRoot: wsDir,
    bundledPluginRoot: resolveBundledPluginRoot(COMPANION_ROOT),
    transport: "stdio",
    settings: { workflow: "sw_dev" },
  });

  try {
    const insights = await service.collectInsights({ kind: "none", label: "none" });
    const intakeItem = insights.artifactInsights.find(
      (a) => a.workflow === "sw_dev" && a.stage === "intake",
    );
    assert.ok(intakeItem, "Expected sw_dev/intake artifact entry");
    assert.equal(intakeItem.exists, null, "Symlinked directory outside workspace must yield null");
  } finally {
    await client.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── 3. Live Stdio uaw-mcp/v1 Integration Tests ──────────────────────────────

test("UawMcpClient + UawDataService drive live stdio uaw-mcp/v1 run, reads, redaction, and question resolution", async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-stdio-")));
  const workspaceDir = path.join(scratch, "ws");
  const stateDir = path.join(scratch, "uaw-state");
  const dataDir = path.join(scratch, "run-data");
  const fixtureDir = path.join(REPO_ROOT, "scripts", "uwf-runner", "test", "fixtures", "sw_dev");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const cfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: workspaceDir,
    electronRuntime: false,
    settings: {
      stateDir,
      allowedRoots: [workspaceDir, dataDir, fixtureDir, REPO_ROOT],
    },
  });
  const client = new UawMcpClient(cfg, { requestTimeoutMs: 60_000 });
  const service = new UawDataService(client, {
    workspaceRoot: workspaceDir,
    bundledPluginRoot: resolveBundledPluginRoot(COMPANION_ROOT),
    transport: "stdio",
    settings: { workflow: "sw_dev" },
  });

  try {
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === "uaw_run"));
    assert.ok(tools.some((t) => t.name === "uaw_read_state"));

    const outputPath = path.join(workspaceDir, "tmp", "workflow-artifacts");
    const runRes = await client.callTool("uaw_run", {
      run_id: "comp-e2e-1",
      workflow: "sw_dev",
      goal: "Verify VS Code Companion Phase 2 MCP integration",
      adapter: "fake",
      fake_fixture_dir: fixtureDir,
      repo_root: workspaceDir,
      data_dir: dataDir,
      output_path: outputPath,
      non_interactive: true,
    });
    assert.equal(runRes.exit_code, 0, JSON.stringify(runRes));

    // Discover runs via MCP resources/list and verify all read endpoints
    const runs = await service.discoverRuns();
    assert.ok(runs.some((r) => r.runId === "comp-e2e-1"), JSON.stringify(runs));
    service.setSelection({ kind: "run_id", runId: "comp-e2e-1", dataDir, workflow: "sw_dev" });

    const [
      state,
      stages,
      reqs,
      adrs,
      discs,
      issues,
      reviews,
      cost,
      prescriptions,
      blueprints,
      insights,
      exported,
    ] = await Promise.all([
      service.getState(),
      service.getStages("sw_dev"),
      service.getRequirements(),
      service.getAdrs(),
      service.getDiscoveries(),
      service.getIssues(),
      service.getReviews(),
      service.getCost("sw_dev"),
      service.getGatePrescriptions("sw_dev"),
      service.listWorkflowBlueprints(),
      service.collectInsights(),
      service.collectExportSnapshot(),
    ]);

    assert.equal(state.exists, true);
    assert.equal(state.state?.phase, "closed");
    assert.equal(stages.exists, true);
    assert.ok(stages.stage_runs.length > 0);

    // Optional secondary DBs not initialized by the fake adapter return clean empty snapshots
    assert.equal(reqs.exists, false);
    assert.equal(reqs.count, 0);
    assert.equal(adrs.exists, false);
    assert.equal(adrs.count, 0);
    assert.equal(discs.exists, false);
    assert.equal(discs.count, 0);
    assert.equal(issues.exists, false);
    assert.equal(issues.count, 0);
    assert.equal(reviews.exists, false);
    assert.equal(reviews.count, 0);

    // Seed a real issue into isolated dataDir and verify UawDataService reads it via MCP
    const issuesScript = path.join(REPO_ROOT, ".github", "skills", "uwf-local-tracking", "issues.mjs");
    execFileSync(
      process.execPath,
      [
        issuesScript,
        "create",
        "--id",
        "I-200",
        "--title",
        "MCP isolated run issue",
        "--status",
        "open",
        "--data-dir",
        dataDir,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const seededIssues = await service.getIssues();
    assert.equal(seededIssues.exists, true);
    assert.equal(seededIssues.issues[0]?.id, "I-200");

    assert.ok(cost && cost.ok);
    assert.equal(prescriptions.ok, true);
    assert.ok(prescriptions.stages.length > 0);
    assert.ok(blueprints.some((b) => b.workflow === "sw_dev"));
    assert.equal(insights.currentPhase, "closed");
    assert.equal(insights.currentWorkflow, "sw_dev");
    assert.ok(exported.stages.length > 0);

    // Seed a pending question into isolated dataDir and resolve it through MCP
    const qScript = path.join(REPO_ROOT, ".github", "skills", "uwf-question-protocol", "questions.mjs");
    execFileSync(
      process.execPath,
      [
        qScript,
        "log",
        "--stage",
        "intake",
        "--question",
        "Choose persistence engine?",
        "--required",
        "true",
        "--data-dir",
        dataDir,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    const resolvedTarget = await service.resolveActiveTarget();
    const beforeQ = await service.getQuestions(resolvedTarget);
    const pending = beforeQ.questions.find((q) => q.status === "pending");
    assert.ok(pending, `Expected pending question: ${JSON.stringify(beforeQ)}`);

    // Fail-closed isQuestionRequired treats ambiguous/null/undefined values as required
    assert.equal(isQuestionRequired(undefined), true);
    assert.equal(isQuestionRequired(null), true);
    assert.equal(isQuestionRequired("Y"), true);
    assert.equal(isQuestionRequired("required"), true);
    assert.equal(isQuestionRequired(1), true);
    assert.equal(isQuestionRequired(true), true);
    assert.equal(isQuestionRequired(false), false);
    assert.equal(isQuestionRequired(0), false);
    assert.equal(isQuestionRequired("0"), false);
    assert.equal(isQuestionRequired(" false "), false);
    assert.equal(isQuestionRequired("no"), false);

    // Required question cannot be skipped and rejects mismatched expectedQuestion
    await assert.rejects(
      () =>
        service.resolveQuestion({
          action: "skip",
          id: Number(pending.id),
          target: resolvedTarget,
          expectedQuestion: String(pending.question),
        }),
      /required and cannot be skipped/,
    );
    await assert.rejects(
      () =>
        service.resolveQuestion({
          action: "answer",
          id: Number(pending.id),
          answer: "Use node:sqlite",
          target: resolvedTarget,
          expectedQuestion: "Different stale question text?",
        }),
      /SHA-256 mismatch/,
    );

    await service.resolveQuestion({
      action: "answer",
      id: Number(pending.id),
      answer: "Use node:sqlite via uaw-mcp/v1",
      target: resolvedTarget,
      expectedQuestion: String(pending.question),
    });

    // Server-side CAS guard rejects stale overwrite once no longer pending
    await assert.rejects(
      () =>
        service.resolveQuestion({
          action: "skip",
          id: Number(pending.id),
          target: resolvedTarget,
          expectedQuestion: String(pending.question),
        }),
      /status is "answered", expected "pending"/,
    );

    const afterQ = await service.getQuestions(resolvedTarget);
    const answered = afterQ.questions.find((q) => Number(q.id) === Number(pending.id));
    assert.equal(answered?.status, "answered");
    assert.equal(answered?.answer, "Use node:sqlite via uaw-mcp/v1");

    // Concurrent answer vs skip on an optional question: server-side CAS ensures exactly 1 wins
    execFileSync(
      process.execPath,
      [
        qScript,
        "log",
        "--stage",
        "intake",
        "--question",
        "Concurrent optional race?",
        "--required",
        "false",
        "--data-dir",
        dataDir,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const afterRaceLog = await service.getQuestions(resolvedTarget);
    const racePending = afterRaceLog.questions.find(
      (q) => q.question === "Concurrent optional race?",
    );
    assert.ok(racePending);
    const raceResults = await Promise.allSettled([
      service.resolveQuestion({
        action: "answer",
        id: Number(racePending.id),
        answer: "Winner answer",
        target: resolvedTarget,
        expectedQuestion: String(racePending.question),
      }),
      service.resolveQuestion({
        action: "skip",
        id: Number(racePending.id),
        target: resolvedTarget,
        expectedQuestion: String(racePending.question),
      }),
    ]);
    assert.equal(raceResults.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(raceResults.filter((r) => r.status === "rejected").length, 1);

    // Optional question (required=false) can still be skipped cleanly
    execFileSync(
      process.execPath,
      [
        qScript,
        "log",
        "--stage",
        "intake",
        "--question",
        "Optional telemetry preference?",
        "--required",
        "false",
        "--data-dir",
        dataDir,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const afterOptLog = await service.getQuestions(resolvedTarget);
    const optPending = afterOptLog.questions.find((q) => q.status === "pending");
    assert.ok(optPending);
    await service.resolveQuestion({
      action: "skip",
      id: Number(optPending.id),
      target: resolvedTarget,
      expectedQuestion: String(optPending.question),
    });
    const afterSkip = await service.getQuestions(resolvedTarget);
    const skippedRow = afterSkip.questions.find((q) => Number(q.id) === Number(optPending.id));
    assert.equal(skippedRow?.status, "skipped");

    // Seed a synthetic secret note in uwf-state.db and verify MCP redacts it
    const synthToken = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const stateScript = path.join(REPO_ROOT, ".github", "skills", "uwf-state-manager", "state.mjs");
    execFileSync(
      process.execPath,
      [
        stateScript,
        "note",
        "--agent",
        "companion-test",
        "--note",
        `Synthetic token leak test ${synthToken}`,
        "--data-dir",
        dataDir,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const redactedState = await service.getState();
    const stateJson = JSON.stringify(redactedState);
    assert.equal(stateJson.includes(synthToken), false, "MCP must scrub raw secret tokens");
    assert.match(stateJson, /\[redacted:/);
  } finally {
    await client.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("UawDataService legacy_workspace target reads .github/skills DBs through uaw-mcp/v1", async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-legacy-")));
  const wsDir = path.join(scratch, "legacy-ws");
  const stateDir = path.join(scratch, "uaw-state");
  const issuesSkillDir = path.join(wsDir, ".github", "skills", "uwf-local-tracking");
  fs.mkdirSync(issuesSkillDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const issuesScript = path.join(
    REPO_ROOT,
    ".github",
    "skills",
    "uwf-local-tracking",
    "issues.mjs",
  );
  execFileSync(
    process.execPath,
    [
      issuesScript,
      "create",
      "--id",
      "I-101",
      "--title",
      "Legacy DB read via uaw-mcp/v1",
      "--status",
      "open",
      "--data-dir",
      issuesSkillDir,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const cfg = resolveServerConfig({
    extensionPath: COMPANION_ROOT,
    workspaceRoot: wsDir,
    electronRuntime: false,
    settings: { stateDir, allowedRoots: [wsDir] },
  });
  const client = new UawMcpClient(cfg);
  const service = new UawDataService(client, {
    workspaceRoot: wsDir,
    bundledPluginRoot: resolveBundledPluginRoot(COMPANION_ROOT),
    transport: "stdio",
  });

  try {
    assert.equal(service.hasLegacyWorkspaceSkills(), true);
    const resolved = await service.resolveActiveTarget();
    assert.equal(resolved.kind, "legacy_workspace");
    const issues = await service.getIssues(resolved);
    assert.equal(issues.exists, true);
    assert.equal(issues.issues[0]?.id, "I-101");
    assert.equal(issues.issues[0]?.title, "Legacy DB read via uaw-mcp/v1");
  } finally {
    await client.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── 4. Live Streamable HTTP uaw-mcp/v1 Integration Test ─────────────────────

test("UawMcpClient connects over Streamable HTTP with bearer auth and handles wrong-token rejection", async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-http-")));
  const stateDir = path.join(scratch, "state");
  const wsDir = path.join(scratch, "ws");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const authToken = "companion-http-test-token-123";
  const serverProc = spawn(
    process.execPath,
    [
      BUNDLED_MCP_BIN,
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--auth-token",
      authToken,
      "--allowed-roots",
      wsDir,
      "--state-dir",
      stateDir,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  const serverUrl = await new Promise((resolveUrl, rejectUrl) => {
    let stderrText = "";
    const timer = setTimeout(() => {
      rejectUrl(new Error(`Timed out waiting for HTTP server startup; stderr=${stderrText}`));
    }, 10_000);
    serverProc.stderr.on("data", (chunk) => {
      stderrText += chunk.toString();
      const m = stderrText.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    serverProc.once("exit", (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`HTTP server exited early (${code}); stderr=${stderrText}`));
    });
  });

  const validClient = new UawMcpClient(
    resolveServerConfig({
      extensionPath: COMPANION_ROOT,
      workspaceRoot: wsDir,
      settings: { mcpServerUrl: serverUrl },
      authToken,
    }),
  );
  const badTokenClient = new UawMcpClient(
    resolveServerConfig({
      extensionPath: COMPANION_ROOT,
      workspaceRoot: wsDir,
      settings: { mcpServerUrl: serverUrl },
      authToken: "wrong-token-value",
    }),
  );

  try {
    const res = await validClient.callTool("uaw_gates", {
      workflow: "sw_dev",
      mode: "list",
      repo_root: wsDir,
    });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.stages) && res.stages.length > 0);

    await assert.rejects(
      () => badTokenClient.callTool("uaw_gates", { workflow: "sw_dev", mode: "list" }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /401|Unauthorized/);
        assert.equal(msg.includes("wrong-token-value"), false, "Auth token must never appear in errors");
        return true;
      },
    );
  } finally {
    await validClient.dispose();
    await badTokenClient.dispose();
    serverProc.kill("SIGTERM");
    await new Promise((res) => serverProc.once("exit", res));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── 5. Pure Webview, Formatter & Debouncer Tests ────────────────────────────

test("webviewUtils, ReportFormatter, and Debouncer behave accurately", async () => {
  assert.equal(
    escHtml('<script>alert("xss")</script>'),
    "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
  );
  assert.equal(formatCellValue({ ok: true }), '{"ok":true}');

  const cols = deriveColumns(
    [
      { id: 1, title: "A", extra: true },
      { id: 2, title: "B", tail: "x" },
    ],
    ["title", "id"],
  );
  assert.deepEqual(cols, ["title", "id", "extra", "tail"]);

  const tableHtml = renderDynamicTable(cols, [{ id: 1, title: "<B>", extra: { nested: 1 } }], {
    title: (v) => badge(String(v), "blue"),
  });
  assert.match(tableHtml, /&lt;B&gt;/);
  assert.match(tableHtml, /\{&quot;nested&quot;:1\}/);

  const shell = pageShell("Title", "<p>Body</p>");
  assert.match(shell, /Content-Security-Policy/);

  const csv = formatCsvReport({
    issues: [
      { id: "I-1", note: 'He said "hello"', meta: { a: 1 } },
      { id: "=cmd|'/C calc'!A0", note: "+1\t-2\r@SUM(1,2)", meta: " ok", tailOnly: "extra" },
    ],
    empty: [],
  });
  assert.ok(csv.startsWith("## issues"));
  assert.ok(csv.includes('"id","note","meta","tailOnly"'));
  assert.ok(csv.includes('"extra"'));
  assert.ok(csv.includes('He said ""hello""'));
  assert.ok(csv.includes("\"'=cmd|'/C calc'!A0\""));
  assert.ok(csv.includes("\"'+" + "1\t-2\r@SUM(1,2)\""));
  assert.ok(!csv.includes("## empty"));

  const jsonText = formatJsonReport({ issues: [{ id: "I-1" }] });
  assert.equal(JSON.parse(jsonText).issues[0].id, "I-1");

  // Symlink-safe report export helper
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-report-")));
  try {
    const cleanWs = path.join(scratch, "clean-ws");
    fs.mkdirSync(cleanWs, { recursive: true });
    const writtenPath = writeReportFileSafe(cleanWs, "uwf-report-test.json", jsonText);
    assert.equal(fs.readFileSync(writtenPath, "utf8"), jsonText);
    assert.throws(() => writeReportFileSafe(cleanWs, "uwf-report-test.json", jsonText), /EEXIST/);

    const evilWs = path.join(scratch, "evil-ws");
    const externalDir = path.join(scratch, "external");
    fs.mkdirSync(evilWs, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    fs.symlinkSync(externalDir, path.join(evilWs, "tmp"));
    assert.throws(
      () => writeReportFileSafe(evilWs, "uwf-report-test.json", jsonText),
      /symlink/i,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  let fired = 0;
  const debouncer = new Debouncer(40, () => {
    fired += 1;
  });
  debouncer.trigger();
  debouncer.trigger();
  debouncer.trigger();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 1);
  debouncer.dispose();
});

test("UawDataService.resolveActiveTarget fails closed when registered runs belong to another workspace", async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-unmatched-")));
  const otherRepo = path.join(scratch, "other-repo");
  const otherRepo2 = path.join(scratch, "other-repo-2");
  const currentWs = path.join(scratch, "current-ws");
  const stateDir = path.join(scratch, "state");
  const otherDataDir = path.join(scratch, "other-data");
  fs.mkdirSync(otherRepo, { recursive: true });
  fs.mkdirSync(otherRepo2, { recursive: true });
  fs.mkdirSync(currentWs, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const fixtureDir = path.join(REPO_ROOT, "scripts", "uwf-runner", "test", "fixtures", "sw_dev");
  const client = new UawMcpClient(
    resolveServerConfig({
      extensionPath: COMPANION_ROOT,
      workspaceRoot: currentWs,
      electronRuntime: false,
      settings: {
        stateDir,
        allowedRoots: [currentWs, otherRepo, otherRepo2, otherDataDir, fixtureDir],
      },
    }),
  );

  try {
    const setupRes = await client.callTool("uaw_run", {
      run_id: "unrelated-run-1",
      workflow: "sw_dev",
      goal: "Unrelated run",
      adapter: "fake",
      fake_fixture_dir: fixtureDir,
      repo_root: otherRepo,
      data_dir: otherDataDir,
      output_path: path.join(otherRepo, "tmp", "workflow-artifacts"),
      non_interactive: true,
    });
    assert.equal(setupRes.exit_code, 0);

    const service = new UawDataService(client, {
      workspaceRoot: currentWs,
      bundledPluginRoot: resolveBundledPluginRoot(COMPANION_ROOT),
      transport: "stdio",
    });
    const runs = await service.discoverRuns();
    assert.ok(runs.some((r) => r.runId === "unrelated-run-1"));

    const resolved = await service.resolveActiveTarget();
    assert.equal(resolved.kind, "none", "Unmatched run must never be auto-selected");
    assert.match(resolved.label, /1 run\(s\) available — select one/);

    // A run whose data_dir sits inside currentWs but whose repo_root is otherRepo2 must NOT match currentWs
    const nestedOtherData = path.join(currentWs, ".nested-other-run");
    const setupCrossRepo = await client.callTool("uaw_run", {
      run_id: "cross-repo-run-1",
      workflow: "sw_dev",
      goal: "Cross repo dataDir",
      adapter: "fake",
      fake_fixture_dir: fixtureDir,
      repo_root: otherRepo2,
      data_dir: nestedOtherData,
      output_path: path.join(otherRepo2, "tmp", "workflow-artifacts"),
      non_interactive: true,
    });
    assert.equal(setupCrossRepo.exit_code, 0);
    const resolvedAfterCross = await service.resolveActiveTarget();
    assert.equal(resolvedAfterCross.kind, "none");

    // Two distinct runs matching currentWs fail closed as ambiguous rather than guessing the first
    const wsRun1 = await client.callTool("uaw_run", {
      run_id: "ws-match-1",
      workflow: "sw_dev",
      goal: "Workspace run 1",
      adapter: "fake",
      fake_fixture_dir: fixtureDir,
      repo_root: currentWs,
      data_dir: path.join(currentWs, ".uaw-ws-data-1"),
      output_path: path.join(currentWs, "tmp", "workflow-artifacts"),
      non_interactive: true,
    });
    assert.equal(wsRun1.exit_code, 0);

    const wsRun2 = await client.callTool("uaw_run", {
      run_id: "ws-match-2",
      workflow: "sw_dev",
      goal: "Workspace run 2",
      adapter: "fake",
      fake_fixture_dir: fixtureDir,
      repo_root: currentWs,
      data_dir: path.join(currentWs, ".uaw-ws-data-2"),
      output_path: path.join(currentWs, "tmp", "out-2"),
      non_interactive: true,
    });
    assert.equal(wsRun2.run_id, "ws-match-2");

    const ambiguous = await service.resolveActiveTarget();
    assert.equal(ambiguous.kind, "none");
    assert.match(ambiguous.label, /2 workspace runs active — select one/);
  } finally {
    await client.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("UawMcpClient validates JSON-RPC 2.0 frames, bounds HTTP bodies, and reaps SIGTERM-ignoring children on dispose", async () => {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* ignore */
      }
      if (body.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }));
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (mode === "wrong-id") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { tools: [] } }));
      } else if (mode === "bad-version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "1.0", id: body.id, result: { tools: [] } }));
      } else if (mode === "empty-rpc") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
      } else if (mode === "sse-foreign") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/log", params: {} })}\n\n` +
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 88888, result: { tools: [] } })}\n\n`,
        );
      } else if (mode === "oversized") {
        const big = JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { pad: "x".repeat(512) },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(big);
      }
    });
  });

  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  const client = new UawMcpClient(
    { transport: "http", url: `http://127.0.0.1:${port}/mcp`, cwd: REPO_ROOT },
    { maxHttpResponseBytes: 128 },
  );

  try {
    mode = "wrong-id";
    await assert.rejects(() => client.listTools(), /id mismatch/);
    mode = "bad-version";
    await assert.rejects(() => client.listTools(), /Invalid JSON-RPC version/);
    mode = "empty-rpc";
    await assert.rejects(() => client.listTools(), /exactly one of result or error/);
    mode = "sse-foreign";
    await assert.rejects(() => client.listTools(), /no matching JSON-RPC 2\.0 response/);
    mode = "oversized";
    await assert.rejects(() => client.listTools(), /exceeds 128-byte limit/);
  } finally {
    await client.dispose();
    await new Promise((res) => server.close(res));
  }

  // Stdio child that traps SIGTERM must still be killed and waited on by dispose()
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uwf-comp-kill-")));
  const pidFile = path.join(scratch, "child.pid");
  try {
    const rogueClient = new UawMcpClient(
      {
        transport: "stdio",
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",
          pidFile,
        ],
        cwd: scratch,
        env: {},
        scriptPath: "",
      },
      { requestTimeoutMs: 5000 },
    );

    const initPending = rogueClient.initialize().catch(() => {});
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(fs.existsSync(pidFile), "Rogue child should write its PID file");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);

    await rogueClient.dispose();
    await initPending;
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
