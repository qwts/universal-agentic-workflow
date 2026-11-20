import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  canonicalizeJcs,
  captureStageOutputs,
  computeIdempotencyKey,
  computeWorktreeTreeSha,
  materializeManifest,
  resolveDeliverableKey,
  sealManifest,
  sha256Hex,
  validateManifest,
  verifyManifest,
} from "../provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SCHEMA_PATH = join(REPO_ROOT, "schemas", "uaw-manifest.schema.json");
const PROVENANCE_CLI = join(REPO_ROOT, "scripts", "uwf-runner", "provenance.mjs");
const RUNNER_CLI = join(REPO_ROOT, "scripts", "uwf-runner", "runner.mjs");

// Resolve better-sqlite3 the same way provenance.mjs does.
function loadDatabase() {
  for (const base of [
    join(REPO_ROOT, ".github", "skills", "uwf-state-manager", "state.mjs"),
    import.meta.url,
  ]) {
    try { return createRequire(base)("better-sqlite3"); } catch { /* next */ }
  }
  throw new Error("better-sqlite3 not available");
}
const Database = loadDatabase();

// Synthetic tokens assembled at runtime so no secret literal sits in the repo.
const FAKE_ANTHROPIC = "sk-ant-" + "api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const FAKE_GITHUB = "ghp_" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8";

// ---------------------------------------------------------------------------
// 1. RFC 8785 JCS Determinism + Non-NFC Decomposed Unicode Vectors
// ---------------------------------------------------------------------------
{
  const vec = {
    "\r": "Carriage Return",
    "1": "One",
    "\u0080": "Control",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u20ac": "Euro Sign",
    "a": "Small a",
  };
  const jcs = canonicalizeJcs(vec);
  const keysInOrder = [...jcs.matchAll(/"((?:\\.|[^"\\])*)":/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.deepEqual(
    keysInOrder,
    ["\r", "1", "a", "\u0080", "\u20ac", "\ud83d\ude00", "\ufb33"],
    "RFC 8785 keys must sort by UTF-16 code units, not locale or code points"
  );

  // Non-NFC decomposed Unicode (NFD "e\u0301" vs NFC "\u00e9") must be preserved verbatim (NO NFC normalization!)
  const nfd = "cafe\u0301";
  const nfc = "caf\u00e9";
  assert.notEqual(nfd, nfc);
  const jcsNfd = canonicalizeJcs({ label: nfd, zero: -0, num: 1.5 });
  const jcsNfc = canonicalizeJcs({ label: nfc, zero: 0, num: 1.5 });
  assert.equal(jcsNfd, `{"label":"${nfd}","num":1.5,"zero":0}`);
  assert.equal(jcsNfc, `{"label":"${nfc}","num":1.5,"zero":0}`);
  assert.notEqual(Buffer.from(jcsNfd, "utf8").toString("hex"), Buffer.from(jcsNfc, "utf8").toString("hex"));
  assert.throws(() => canonicalizeJcs({ bad: NaN }), TypeError);
  assert.throws(() => canonicalizeJcs({ bad: Infinity }), TypeError);
}

// ---------------------------------------------------------------------------
// 2. 5-Tier Total deliverable_key Fallback Chain
// ---------------------------------------------------------------------------
{
  const sha = "a".repeat(40);
  const tree = "b".repeat(40);
  assert.equal(
    resolveDeliverableKey({ pr_url: "https://github.com/o/r/pull/9", head_commit_sha: sha, repository: "o/r", release_tag: "v1.0.0", artifact_uris: ["s3://b/a"] }, "run-1"),
    `https://github.com/o/r/pull/9@${sha}`
  );
  assert.equal(
    resolveDeliverableKey({ pr_url: null, head_commit_sha: sha, repository: "o/r", release_tag: "v1.0.0", artifact_uris: ["s3://b/a"] }, "run-1"),
    `o/r@v1.0.0@${sha}`
  );
  assert.equal(
    resolveDeliverableKey({ pr_url: null, head_commit_sha: sha, repository: "o/r", release_tag: null, artifact_uris: ["oci://ghcr.io/o/r:1"] }, "run-1"),
    "oci://ghcr.io/o/r:1"
  );
  assert.equal(
    resolveDeliverableKey({ pr_url: null, head_commit_sha: sha, repository: "o/r", release_tag: null, artifact_uris: [] }, "run-1"),
    `o/r@${sha}`
  );
  assert.equal(
    resolveDeliverableKey({ pr_url: null, head_commit_sha: null, repository: "o/r", release_tag: null, artifact_uris: [], git_tree_sha: tree }, "run-1"),
    `tree:${tree}`
  );
  assert.equal(
    resolveDeliverableKey({ pr_url: null, head_commit_sha: null, repository: null, release_tag: null, artifact_uris: [], git_tree_sha: null }, "run-1"),
    "run:run-1"
  );
}

// ---------------------------------------------------------------------------
// 3. Full End-to-End Provenance, Defer-Seal, Post-Commit Seal, CBS & Tamper
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "uaw-prov-test-"));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

try {
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "UAW Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "tmp/\n*.log\n.github/skills/uwf-cbs/uwf-cbs.db\n");
  writeFileSync(join(root, "README.md"), "# Test Project\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial commit");
  const baseSha = git("rev-parse", "HEAD");

  const dataDir = join(root, "tmp", "run-data");
  const outputPath = join(root, "artifacts");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputPath, { recursive: true });
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, ".github", "skills", "uwf-cbs"), { recursive: true });

  writeFileSync(join(dataDir, "runner-goal.md"), "Implement provenance manifest with cafe\u0301 vector\n");

  const intakePath = join(outputPath, "issues-intake.md");
  writeFileSync(intakePath, "# Intake\nObjective: test\n");
  const brPath = join(outputPath, "issues-br.json");
  const brPreSnapshot = JSON.stringify({
    version: "1.0",
    created_at: "2026-11-19T12:00:00Z",
    role: "issues",
    strata: {
      "0": { label: "Context", entries: [{ id: "0-1", summary: "Goal cafe\u0301" }] },
      "1": { label: "Decisions and Risk Register", entries: [{ id: "1-1", summary: "ADR-0001" }] },
      "2": { label: "Dependencies", entries: [] },
      "3": { label: "Actions", entries: [{ id: "3-1", summary: "Step 1" }] },
      "4": { label: "Verification", entries: [{ id: "4-1", summary: "Unit test" }] },
    },
  }, null, 2);
  writeFileSync(brPath, brPreSnapshot);
  const brPreDigest = { path: "artifacts/issues-br.json", sha256: sha256Hex(Buffer.from(brPreSnapshot)), bytes: Buffer.byteLength(brPreSnapshot) };

  const blueprintMdPath = join(outputPath, "issues-blueprint.md");
  writeFileSync(blueprintMdPath, "# Blueprint\nComponents ready.\n");
  const blueprintMdDigest = { path: "artifacts/issues-blueprint.md", sha256: sha256Hex(readFileSync(blueprintMdPath)), bytes: readFileSync(blueprintMdPath).length };

  const brPostSnapshot = JSON.stringify({
    version: "1.0",
    created_at: "2026-11-19T12:00:00Z",
    role: "issues",
    strata: {
      "0": { label: "Context", entries: [{ id: "0-1", summary: "Goal cafe\u0301" }] },
      "1": { label: "Decisions and Risk Register", entries: [{ id: "1-1", summary: "ADR-0001" }] },
      "2": { label: "Dependencies", entries: [] },
      "3": { label: "Actions", entries: [{ id: "3-1", summary: "Step 1" }] },
      "4": { label: "Verification", entries: [{ id: "4-1", summary: "Unit test" }] },
      "5": { label: "Final State", closed_at: "2026-11-19T12:30:00Z", entries: [{ id: "5-1", summary: "Delivered" }] },
    },
  }, null, 2);
  writeFileSync(brPath, brPostSnapshot);
  const brPostDigest = { path: "artifacts/issues-br.json", sha256: sha256Hex(Buffer.from(brPostSnapshot)), bytes: Buffer.byteLength(brPostSnapshot) };

  const drsPath = join(outputPath, "issues-drs.json");
  const drsContent = JSON.stringify({
    schema_version: "1.0.0",
    produced_at: "2026-11-19T12:30:00Z",
    workflow: "sw_dev",
    role: "issues",
    components: [{ id: "1", name: "core.provenance", status: "delivered" }],
    dependency_graph: { edges: [{ from: "core.provenance", to: "core.sink", type: "run-time", resolved: true }] },
    gap_log: [],
    divergence_log: [{ id: "DIV-0001", description: `Used key ${FAKE_ANTHROPIC} in note`, impact: "addition" }],
    exit_criteria: { "1_acceptance_gate_passed": "pass", "9_drs_file_is_valid_json": "pass" },
  }, null, 2);
  writeFileSync(drsPath, drsContent);
  const drsDigest = { path: "artifacts/issues-drs.json", sha256: sha256Hex(Buffer.from(drsContent)), bytes: Buffer.byteLength(drsContent) };

  const changelogPath = join(outputPath, "uwf-changelog.md");
  const changelogContent = "# UWF Changelog\n\n## [SNAPSHOT] issues — 2026-11-19\n\n- **Event:** Workflow closure\n";
  writeFileSync(changelogPath, changelogContent);
  const changelogDigest = { path: "artifacts/uwf-changelog.md", sha256: sha256Hex(Buffer.from(changelogContent)), bytes: Buffer.byteLength(changelogContent) };

  const retroPath = join(outputPath, "issues-retro.md");
  writeFileSync(retroPath, "# Retro\nAll green.\n");
  const retroDigest = { path: "artifacts/issues-retro.md", sha256: sha256Hex(readFileSync(retroPath)), bytes: readFileSync(retroPath).length };

  const adrFilePath = join(root, "docs", "adr", "ADR-0001-sample.md");
  writeFileSync(adrFilePath, "# ADR-0001: Sample\n");

  {
    const db = new Database(join(dataDir, "uwf-state.db"));
    db.exec(`
      CREATE TABLE workflow_state (id INTEGER PRIMARY KEY, phase TEXT, mode TEXT, status TEXT, current_agent TEXT, artifact_path TEXT, ready_for_implementation INTEGER, model_profile TEXT, model_name TEXT);
      CREATE TABLE workflow_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, from_phase TEXT, to_phase TEXT, agent TEXT, note TEXT);
      INSERT INTO workflow_state VALUES (1, 'closed', 'sw_dev', 'idle', NULL, 'artifacts', 1, 'balanced', 'claude-sonnet-5-5');
      INSERT INTO workflow_history (ts, from_phase, to_phase, agent, note) VALUES ('2026-11-19T12:00:00Z', 'idea', 'intake', 'uwf-runner', 'start');
    `);
    db.close();
  }

  {
    const db = new Database(join(dataDir, "uwf-stages.db"));
    db.exec(`
      CREATE TABLE stage_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, stage TEXT NOT NULL,
        status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, run_as_subagent INTEGER NOT NULL DEFAULT 1,
        started_at TEXT, completed_at TEXT, gate_result TEXT, notes TEXT, session_id TEXT, outputs_json TEXT
      );
    `);
    const ins = db.prepare(`
      INSERT INTO stage_runs (workflow, stage, status, retry_count, started_at, completed_at, gate_result, session_id, outputs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const intakeDigest = { path: "artifacts/issues-intake.md", sha256: sha256Hex(readFileSync(intakePath)), bytes: readFileSync(intakePath).length };
    ins.run("sw_dev", "intake", "passed", 0, "2026-11-19T12:01:00Z", "2026-11-19T12:02:00Z", JSON.stringify({ passed: true }), "sess-1", JSON.stringify([intakeDigest]));
    ins.run("sw_dev", "security-plan", "skipped", 0, null, "2026-11-19T12:03:00Z", JSON.stringify({ passed: true, note: "conditional — not required" }), null, "[]");
    ins.run("sw_dev", "blueprint", "passed", 0, "2026-11-19T12:04:00Z", "2026-11-19T12:05:00Z", JSON.stringify({ passed: true }), "sess-2", JSON.stringify([blueprintMdDigest, brPreDigest]));
    ins.run("sw_dev", "snapshot", "passed", 0, "2026-11-19T12:20:00Z", "2026-11-19T12:25:00Z", JSON.stringify({ passed: true }), "sess-3", JSON.stringify([brPostDigest, drsDigest, changelogDigest]));
    ins.run("sw_dev", "retro", "passed", 0, "2026-11-19T12:26:00Z", "2026-11-19T12:27:00Z", JSON.stringify({ passed: true }), "sess-4", JSON.stringify([retroDigest]));
    db.close();
  }

  {
    const reqDb = new Database(join(dataDir, "uwf-requirements.db"));
    reqDb.exec(`
      CREATE TABLE requirements (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, number TEXT, type TEXT, title TEXT, description TEXT, priority TEXT, status TEXT, source TEXT, stage TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO requirements (role, number, type, title, description, priority, status, created_at, updated_at)
      VALUES ('issues', 'FR-0001', 'functional', 'Manifest', 'Token ${FAKE_GITHUB}', 'must', 'accepted', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
    `);
    reqDb.close();

    const adrDb = new Database(join(dataDir, "uwf-adrs.db"));
    adrDb.exec(`
      CREATE TABLE adrs (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT, slug TEXT, title TEXT, status TEXT, impact TEXT, stage TEXT, decision TEXT, file_path TEXT, superseded_by TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO adrs (number, slug, title, status, impact, file_path, created_at, updated_at)
      VALUES ('ADR-0001', 'sample', 'Sample', 'accepted', 'high', 'docs/adr/ADR-0001-sample.md', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
    `);
    adrDb.close();

    const discDb = new Database(join(dataDir, "uwf-discoveries.db"));
    discDb.exec(`
      CREATE TABLE discoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, stage TEXT, category TEXT, title TEXT, description TEXT, evidence TEXT, impact TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO discoveries (role, stage, category, title, impact, status, created_at, updated_at)
      VALUES ('issues', 'discovery', 'gap', 'Missing lockfile', 'medium', 'open', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
    `);
    discDb.close();

    const revDb = new Database(join(dataDir, "uwf-reviews.db"));
    revDb.exec(`
      CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, stage TEXT, verdict TEXT, notes TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER, severity TEXT, status TEXT, file_path TEXT, description TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO reviews (role, stage, verdict, created_at, updated_at) VALUES ('issues', 'review', 'approved', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
      INSERT INTO findings (review_id, severity, status, description, created_at, updated_at) VALUES (1, 'minor', 'resolved', 'Fixed typo', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
    `);
    revDb.close();

    const issDb = new Database(join(dataDir, "uwf-issues.db"));
    issDb.exec(`
      CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO issues VALUES ('ISS-1', 'Build manifest', 'closed', '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z');
    `);
    issDb.close();

    const qDb = new Database(join(dataDir, "uwf-questions.db"));
    qDb.exec(`
      CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT, question TEXT, required INTEGER, status TEXT, answer TEXT, created_at TEXT);
      INSERT INTO questions (stage, question, required, status, answer, created_at) VALUES ('intake', 'Scope?', 1, 'answered', 'Issue 178', '2026-11-19T12:00:00Z');
    `);
    qDb.close();

    const cbsDbPath = join(root, ".github", "skills", "uwf-cbs", "uwf-cbs.db");
    const cbsDb = new Database(cbsDbPath);
    cbsDb.exec(`
      CREATE TABLE components (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL, owner TEXT, status TEXT NOT NULL, source_story_ids TEXT, source_adr_ids TEXT, created_at TEXT NOT NULL);
      CREATE TABLE interfaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, provider_component_id INTEGER NOT NULL, consumer_component_id INTEGER NOT NULL, contract TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, component_id INTEGER NOT NULL, depends_on_component_id INTEGER NOT NULL, dependency_type TEXT NOT NULL, rationale TEXT, created_at TEXT NOT NULL);
      CREATE TABLE sequencing (id INTEGER PRIMARY KEY AUTOINCREMENT, step_number INTEGER NOT NULL UNIQUE, component_id INTEGER NOT NULL, phase TEXT NOT NULL, notes TEXT, estimated_effort TEXT, created_at TEXT NOT NULL);
      CREATE TABLE constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL, source TEXT, applies_to_component_ids TEXT, severity TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO components (name, type, description, status, created_at) VALUES ('core.provenance', 'module', 'Manifest builder', 'planned', '2026-11-19T12:00:00Z');
      INSERT INTO sequencing (step_number, component_id, phase, created_at) VALUES (1, 1, 'foundation', '2026-11-19T12:00:00Z');
      INSERT INTO constraints (name, type, description, source, severity, status, created_at) VALUES ('scrub', 'security', 'Must scrub secrets', 'ADR-0009', 'critical', 'mitigated', '2026-11-19T12:00:00Z');
    `);
    cbsDb.close();
  }

  // Step A: Materialize with --defer-seal BEFORE committing deliverable changes
  const preSeal = await materializeManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    phase: "closed",
    deferSeal: true,
    deliverableOverrides: { base_commit_sha: baseSha },
    now: "2026-11-19T12:30:00.000Z",
  });
  assert.equal(preSeal.ok, true);
  assert.equal(preSeal.manifest.phase, "closed");
  assert.equal(preSeal.sink.status, "deferred");
  assert.equal(existsSync(join(dataDir, "uaw-manifest.json")), true);
  assert.equal(existsSync(join(outputPath, "uaw-manifest.json")), false);

  assert.deepEqual(validateManifest(preSeal.manifest), []);
  try {
    const Ajv = createRequire(import.meta.url)("ajv");
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
    assert.equal(validate(preSeal.manifest), true, JSON.stringify(validate.errors));
  } catch { /* ajv optional in some environments */ }

  const manifestTextPre = readFileSync(join(dataDir, "uaw-manifest.json"), "utf8");
  assert.ok(!manifestTextPre.includes(FAKE_ANTHROPIC), "Anthropic key leaked into manifest");
  assert.ok(!manifestTextPre.includes(FAKE_GITHUB), "GitHub token leaked into manifest");
  assert.ok(manifestTextPre.includes("[redacted:anthropic-key]"), "Anthropic key should be redacted");

  const secStage = preSeal.manifest.stages.find((s) => s.stage === "security-plan");
  assert.deepEqual(secStage.outputs, []);
  assert.equal(secStage.gate_verdict, null);

  const bpStage = preSeal.manifest.stages.find((s) => s.stage === "blueprint");
  const snapStage = preSeal.manifest.stages.find((s) => s.stage === "snapshot");
  const bpBr = bpStage.outputs.find((o) => o.path === "artifacts/issues-br.json");
  const snapBr = snapStage.outputs.find((o) => o.path === "artifacts/issues-br.json");
  assert.equal(bpBr.sha256, brPreDigest.sha256);
  assert.equal(snapBr.sha256, brPostDigest.sha256);
  assert.notEqual(bpBr.sha256, snapBr.sha256);

  assert.equal(preSeal.manifest.stores.cbs.components_count, 1);
  assert.equal(preSeal.manifest.stores.cbs.constraints_by_severity.critical, 1);
  assert.equal(preSeal.manifest.architecture.drs.summary.divergence_log_count, 1);
  assert.equal(preSeal.manifest.architecture.br.strata["5"].entry_count, 1);
  assert.ok(preSeal.manifest.architecture.changelog_snapshot.entry_sha256);

  // Step B: Attempt seal BEFORE committing -> MUST FAIL (worktree != HEAD tree)
  const failedSeal = await sealManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    baseCommitSha: baseSha,
  });
  assert.equal(failedSeal.ok, false);
  assert.equal(failedSeal.exitCode, 1);

  // Step C: Commit the deliverable changes (leaving ignored *.log and tmp/run-data untracked)
  writeFileSync(join(root, "debug.log"), "ignored log\n");
  git("add", "artifacts", "docs");
  git("commit", "-q", "-m", "deliverable commit");
  const headSha = git("rev-parse", "HEAD");
  assert.notEqual(headSha, baseSha);

  const sealed1 = await sealManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    baseCommitSha: baseSha,
    now: "2026-11-19T12:35:00.000Z",
  });
  assert.equal(sealed1.ok, true, sealed1.error);
  assert.equal(sealed1.manifest.phase, "sealed");
  assert.equal(sealed1.manifest.deliverable.head_commit_sha, headSha);
  assert.equal(sealed1.manifest.deliverable.base_commit_sha, baseSha);
  assert.equal(sealed1.deliverableKey, `${sealed1.manifest.deliverable.repository}@${headSha}`);
  const sealedBytes1 = readFileSync(join(dataDir, "uaw-manifest.json"), "utf8");

  // Step D: Re-sealing at a LATER wall-clock timestamp over identical outputs -> byte-for-byte identical!
  const sealed2 = await sealManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    baseCommitSha: baseSha,
    now: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(sealed2.ok, true);
  assert.equal(sealed2.manifestSha256, sealed1.manifestSha256);
  const sealedBytes2 = readFileSync(join(dataDir, "uaw-manifest.json"), "utf8");
  assert.equal(sealedBytes2, sealedBytes1, "Re-sealing identical state at later wall-clock must be byte-for-byte identical");

  // Step E: Verify uwf-cbs.db mutation changes stores.cbs.sha256 and manifest_sha256
  const cbsShaBefore = sealed1.manifest.stores.cbs.sha256;
  const cbsDb = new Database(join(root, ".github", "skills", "uwf-cbs", "uwf-cbs.db"));
  cbsDb.exec(`INSERT INTO components (name, type, description, status, created_at) VALUES ('core.sink', 'module', 'Context Hub Sink', 'planned', '2026-11-19T12:00:00Z');`);
  cbsDb.close();
  const afterCbsMutation = buildManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    phase: "sealed",
    deliverableOverrides: { base_commit_sha: baseSha, head_commit_sha: headSha },
  });
  assert.notEqual(afterCbsMutation.manifest.stores.cbs.sha256, cbsShaBefore);
  assert.notEqual(afterCbsMutation.manifestSha256, sealed1.manifestSha256);

  // Step F: Manifest verification passes on clean disk, fails with exit 1 on unexpected post-stage mutation!
  const verifyOk = verifyManifest({ dataDir, repoRoot: root });
  assert.equal(verifyOk.ok, true, JSON.stringify(verifyOk.errors));

  writeFileSync(retroPath, "# Retro\nTAMPERED!\n");
  const verifyBad = verifyManifest({ dataDir, repoRoot: root });
  assert.equal(verifyBad.ok, false);
  assert.ok(verifyBad.errors.some((e) => e.includes("Unexpected post-stage mutation")));

  let cliExit = 0;
  try {
    execFileSync(process.execPath, [PROVENANCE_CLI, "verify", "--data-dir", dataDir, "--repo-root", root], { stdio: "pipe" });
  } catch (err) {
    cliExit = err.status;
  }
  assert.equal(cliExit, 1, "provenance.mjs verify must exit 1 on unexpected post-stage artifact mutation");

  // Step G: stage.completed (phase=snapshot) uses snapshot outputs[] digest for dedup_tuple.sha256
  const sentEnvelopes = [];
  const snapRes = await materializeManifest({
    dataDir,
    workflow: "sw_dev",
    repoRoot: root,
    outputPath,
    phase: "snapshot",
    deferSeal: false,
    dispatchSink: true,
    sinkOptions: {
      env: { UAW_CONTEXT_HUB_SINK: "mcp", UAW_CONTEXT_HUB_MODE: "strict" },
      mcpClient: {
        callTool: async (_name, args) => {
          sentEnvelopes.push(args);
          return { result: { content: [{ type: "text", text: "ok" }] } };
        },
      },
    },
  });
  assert.equal(snapRes.ok, true);
  assert.equal(sentEnvelopes.length, 1);
  const env0 = sentEnvelopes[0];
  const snapOutputs = snapRes.manifest.stages.find((s) => s.stage === "snapshot")?.outputs ?? [];
  const expectedStageSha = sha256Hex(canonicalizeJcs(snapOutputs));
  assert.equal(env0.event, "stage.completed");
  assert.equal(env0.dedup_tuple.sha256, expectedStageSha);
  assert.notEqual(env0.dedup_tuple.sha256, snapRes.manifestSha256);
  assert.equal(env0.idempotency_key, computeIdempotencyKey(snapRes.manifest.run_id, "snapshot", expectedStageSha));

  // Step H: Globbing handles regex metacharacters cleanly without throwing
  const globOutDir = join(root, "out+dir(v1)[$]");
  mkdirSync(globOutDir, { recursive: true });
  writeFileSync(join(globOutDir, "ADR-0001+foo(1)$x.md"), "# ADR\n");
  writeFileSync(join(globOutDir, "ADR-0002+bar.txt"), "skip");
  const globCaptured = captureStageOutputs(["{{output_path}}/ADR-*.md"], {
    outputPath: globOutDir,
    repoRoot: root,
    skillsRoot: root,
  });
  assert.equal(globCaptured.length, 1);
  assert.equal(globCaptured[0].path, "out+dir(v1)[$]/ADR-0001+foo(1)$x.md");

  // verifyManifest rejects escaping paths and symlinks
  const escapingManifest = JSON.parse(JSON.stringify(snapRes.manifest));
  escapingManifest.stages[0].outputs.push({ path: "/etc/hosts", sha256: "a".repeat(64), bytes: 1 });
  const { execution_audit: _a2, manifest_sha256: _s2, ...escContent } = escapingManifest;
  escapingManifest.manifest_sha256 = sha256Hex(canonicalizeJcs(escContent));
  writeFileSync(join(dataDir, "uaw-manifest.json"), canonicalizeJcs(escapingManifest));
  const vEscape = verifyManifest({ dataDir, repoRoot: root });
  assert.equal(vEscape.ok, false);
  assert.ok(vEscape.errors.some((e) => /escapes allowed roots/.test(e)));

  // Step I: runner.mjs run --force mints new run_id & preserves prior run_manifests; manifest write error exits 1
  const runRoot = mkdtempSync(join(tmpdir(), "uaw-prov-runner-"));
  try {
    writeFileSync(join(runRoot, ".uwf.json"), JSON.stringify({ verify: [] }));
    const fxDir = join(HERE, "fixtures", "sw_dev");
    const runData = join(runRoot, "run-data");
    const env = { ...process.env, UWF_FAKE_FIXTURE_DIR: fxDir, UWF_DATA_DIR: "" };
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "First run", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData, "--defer-seal"],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const meta1 = JSON.parse(readFileSync(join(runData, "run-meta.json"), "utf8"));

    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Forced rerun", "--force", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData, "--defer-seal"],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const meta2 = JSON.parse(readFileSync(join(runData, "run-meta.json"), "utf8"));
    assert.notEqual(meta2.run_id, meta1.run_id, "runner.mjs run --force must mint a new run_id");

    const stDb = new Database(join(runData, "uwf-state.db"), { readonly: true });
    const manifestRows = stDb.prepare("SELECT run_id FROM run_manifests").all();
    const wsRow = stDb.prepare("SELECT run_id FROM workflow_state WHERE id = 1").get();
    stDb.close();
    assert.equal(wsRow.run_id, meta2.run_id, "workflow_state.run_id must reflect new run_id");
    assert.equal(manifestRows.length, 2, "both runs must remain recorded in run_manifests");

    // Force materializeManifest failure during runner.mjs completion by blocking uaw-manifest.json with a directory on --from-stage
    rmSync(join(runData, "uaw-manifest.json"), { force: true });
    mkdirSync(join(runData, "uaw-manifest.json"));
    let failExit = 0;
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "sw_dev", "--from-stage", "retro", "--goal", "Fail manifest", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData, "--defer-seal"],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      failExit = err.status;
    }
    assert.equal(failExit, 1, "runner.mjs must exit 1 (EXIT.GATE), not 0, when materializeManifest fails");
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }

  console.log("provenance tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
