import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  ensureRunMeta,
  materializeManifest,
  resolveDeliverableKey,
  scrubProvenanceOutputs,
  sealManifest,
  sha256Hex,
  validateManifest,
  verifyManifest,
} from "../provenance.mjs";
import { scrubDeep } from "../context-hub-sink.mjs";
import { listChanges, readEntry } from "../../uwf-on-pr/push-as-bot.mjs";

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

  const savedRetroBytes = readFileSync(retroPath);
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

  // Step G: stage.completed (phase=snapshot) verifies un-superseded outputs before dispatch and uses snapshot outputs[] digest for dedup_tuple.sha256
  const sentEnvelopes = [];
  await assert.rejects(
    () =>
      materializeManifest({
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
      }),
    /Stage output integrity verification failed/,
  );
  assert.equal(sentEnvelopes.length, 0, "tampered stage output must block snapshot checkpoint before Context Hub dispatch");
  writeFileSync(retroPath, savedRetroBytes);
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

    // Step J: finalization failure remains retryable via resume & run until manifest succeeds
    let retryStillBlocked = 0;
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "resume", "--workflow", "sw_dev", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData, "--defer-seal"],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      retryStillBlocked = err.status;
    }
    assert.equal(retryStillBlocked, 1, "resume must still fail when uaw-manifest.json write remains blocked");

    // Unblock uaw-manifest.json and retry via resume -> must exit 0 and finalize manifest
    rmSync(join(runData, "uaw-manifest.json"), { recursive: true, force: true });
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "resume", "--workflow", "sw_dev", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const healedManifest = JSON.parse(readFileSync(join(runData, "uaw-manifest.json"), "utf8"));
    assert.equal(healedManifest.phase, "closed", "resume after deferred finalization failure preserves deferSeal phase=closed");

    // Step K: snapshot strict sink failure with --defer-seal leaves snapshot pending so resume replays it
    let snapFailExit = 0;
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "sw_dev", "--from-stage", "snapshot", "--goal", "Fail snapshot sink", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData, "--defer-seal"],
        {
          encoding: "utf8",
          env: {
            ...env,
            UAW_CONTEXT_HUB_SINK: "webhook",
            UAW_CONTEXT_HUB_URL: "http://127.0.0.1:1/unreachable",
            UAW_CONTEXT_HUB_TOKEN: "tok",
            UAW_CONTEXT_HUB_MODE: "strict",
          },
          stdio: "pipe",
        },
      );
    } catch (err) {
      snapFailExit = err.status;
    }
    assert.equal(snapFailExit, 1, "snapshot strict sink failure must exit 1");

    const stagesDbAfterSnapFail = new Database(join(runData, "uwf-stages.db"), { readonly: true });
    const snapRow = stagesDbAfterSnapFail.prepare("SELECT status FROM stage_runs WHERE workflow = 'sw_dev' AND stage = 'snapshot'").get();
    stagesDbAfterSnapFail.close();
    assert.equal(snapRow?.status, "pending", "snapshot stage must reset to pending when checkpoint dispatch fails");

    // Clear strict sink and resume -> replays snapshot + retro and seals manifest
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "resume", "--workflow", "sw_dev", "--adapter", "fake", "--repo-root", runRoot, "--data-dir", runData],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const sealedManifest = JSON.parse(readFileSync(join(runData, "uaw-manifest.json"), "utf8"));
    assert.equal(sealedManifest.phase, "sealed");

    // Step L: provenance.mjs seal without --output-path or --workflow reuses run-meta.json (./tmp/workflow-artifacts)
    assert.equal(existsSync(join(runData, "workflow-artifacts")), false);
    const drsAbs = join(runRoot, "tmp", "workflow-artifacts", "issues-drs.json");
    const brAbs = join(runRoot, "tmp", "workflow-artifacts", "issues-br.json");
    const changelogAbs = join(runRoot, "tmp", "workflow-artifacts", "uwf-changelog.md");
    execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "seal", "--data-dir", runData, "--repo-root", runRoot],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const cliSealedManifest = JSON.parse(readFileSync(join(runData, "uaw-manifest.json"), "utf8"));
    assert.equal(cliSealedManifest.phase, "sealed");
    assert.equal(cliSealedManifest.architecture.drs?.path, "tmp/workflow-artifacts/issues-drs.json");
    assert.equal(cliSealedManifest.architecture.drs?.sha256, sha256Hex(readFileSync(drsAbs)));
    assert.equal(cliSealedManifest.architecture.br?.path, "tmp/workflow-artifacts/issues-br.json");
    assert.equal(cliSealedManifest.architecture.br?.sha256, sha256Hex(readFileSync(brAbs)));
    assert.equal(cliSealedManifest.architecture.changelog_snapshot?.path, "tmp/workflow-artifacts/uwf-changelog.md");
    assert.equal(cliSealedManifest.architecture.changelog_snapshot?.sha256, sha256Hex(readFileSync(changelogAbs)));

    // Step M1: local non-deferred runner run must fail closed if retro tampers with earlier stage output
    const fxTamper = join(runRoot, "fx-tamper");
    const rootTamper = join(runRoot, "root-tamper");
    const dataTamper = join(runRoot, "data-tamper");
    cpSync(fxDir, fxTamper, { recursive: true });
    mkdirSync(rootTamper, { recursive: true });
    writeFileSync(join(rootTamper, ".uwf.json"), JSON.stringify({ verify: [] }));
    const retroFx = JSON.parse(readFileSync(join(fxTamper, "retro.json"), "utf8"));
    retroFx.files["tmp/workflow-artifacts/issues-intake.md"] = "# Intake\nTAMPERED_DURING_RETRO\n";
    writeFileSync(join(fxTamper, "retro.json"), JSON.stringify(retroFx, null, 2));
    let tamperExit = 0;
    let tamperErr = "";
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Tamper test", "--adapter", "fake", "--repo-root", rootTamper, "--data-dir", dataTamper],
        { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxTamper, UWF_DATA_DIR: "" }, stdio: "pipe" },
      );
    } catch (err) {
      tamperExit = err.status;
      tamperErr = String(err.stderr ?? "");
    }
    assert.equal(tamperExit, 1, "local run must exit 1 (EXIT.GATE) when retro mutates an earlier stage output");
    assert.match(tamperErr, /Stage output integrity verification failed|Unexpected post-stage mutation/);
    const tamperOnDisk = JSON.parse(readFileSync(join(dataTamper, "uaw-manifest.json"), "utf8"));
    assert.equal(tamperOnDisk.phase, "snapshot", "tampered run must leave checkpoint at phase=snapshot and never emit closed/sealed manifest");

    // Step M2: on_verdict review round-trip preserves round_trips count in materialized manifest
    const fxRoute = join(runRoot, "fx-route");
    const rootRoute = join(runRoot, "root-route");
    const dataRoute = join(runRoot, "data-route");
    cpSync(fxDir, fxRoute, { recursive: true });
    mkdirSync(rootRoute, { recursive: true });
    writeFileSync(join(rootRoute, ".uwf.json"), JSON.stringify({ verify: [] }));
    const goodReview = JSON.parse(readFileSync(join(fxRoute, "review.json"), "utf8"));
    writeFileSync(
      join(fxRoute, "review.json"),
      JSON.stringify({
        attempts: [
          {
            files: {
              "tmp/workflow-artifacts/issues-review.md": "# Review\n\nverdict: changes_requested\n\n- high: fix item\n",
              "tmp/workflow-artifacts/issues-review.result.json":
                JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "high", summary: "fix item" }] }) + "\n",
            },
            transcript: "review: changes requested",
            delayMs: 0,
          },
          goodReview,
        ],
      }),
    );
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Round trip test", "--adapter", "fake", "--repo-root", rootRoute, "--data-dir", dataRoute, "--defer-seal"],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxRoute, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    const routedManifest = JSON.parse(readFileSync(join(dataRoute, "uaw-manifest.json"), "utf8"));
    const reviewAudit = routedManifest.execution_audit.stages.find((s) => s.stage === "review");
    assert.ok(reviewAudit && reviewAudit.round_trips >= 1, `expected review round_trips >= 1, got ${JSON.stringify(reviewAudit)}`);
    assert.equal(existsSync(join(dataRoute, "runner-routing.json")), false, "runner-routing.json should be cleaned up after finalization");

    // Step M3: switching workflows in an incomplete dataDir without --force rotates run_id cleanly
    const rootSwitch = join(runRoot, "root-switch");
    const dataSwitch = join(runRoot, "data-switch");
    const fxEmpty = join(runRoot, "fx-empty");
    mkdirSync(rootSwitch, { recursive: true });
    mkdirSync(fxEmpty, { recursive: true });
    writeFileSync(join(rootSwitch, ".uwf.json"), JSON.stringify({ verify: [] }));
    writeFileSync(join(fxEmpty, "intake.json"), JSON.stringify({ files: {}, transcript: "empty intake", delayMs: 0 }));
    let pmExit = 0;
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "project_manager", "--goal", "Incomplete PM run", "--adapter", "fake", "--repo-root", rootSwitch, "--data-dir", dataSwitch],
        { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxEmpty, UWF_DATA_DIR: "" }, stdio: "pipe" },
      );
    } catch (err) {
      pmExit = err.status;
    }
    assert.equal(pmExit, 1, "incomplete project_manager fixture run should exit 1");
    assert.equal(existsSync(join(dataSwitch, "uaw-manifest.json")), false);
    const pmMeta = JSON.parse(readFileSync(join(dataSwitch, "run-meta.json"), "utf8"));
    assert.equal(pmMeta.workflow, "project_manager");

    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Switch workflow without force", "--adapter", "fake", "--repo-root", rootSwitch, "--data-dir", dataSwitch, "--defer-seal"],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const swMeta = JSON.parse(readFileSync(join(dataSwitch, "run-meta.json"), "utf8"));
    const swManifest = JSON.parse(readFileSync(join(dataSwitch, "uaw-manifest.json"), "utf8"));
    assert.notEqual(swMeta.run_id, pmMeta.run_id, "switching workflows must rotate run_id");
    assert.equal(swMeta.workflow, "sw_dev");
    assert.equal(swManifest.workflow, "sw_dev");

    // Step M4: provenance.mjs scrub before seal preserves provenance integrity after secret redaction
    // while pre-scrub post-stage tampering still fails closed at seal time.
    const fxScrub = join(runRoot, "fx-scrub");
    const rootScrub = join(runRoot, "root-scrub");
    const dataScrub = join(runRoot, "data-scrub");
    cpSync(fxDir, fxScrub, { recursive: true });
    mkdirSync(rootScrub, { recursive: true });
    writeFileSync(join(rootScrub, ".uwf.json"), JSON.stringify({ verify: [] }));
    const intakeFx = JSON.parse(readFileSync(join(fxScrub, "intake.json"), "utf8"));
    intakeFx.files["tmp/workflow-artifacts/issues-intake.md"] =
      (intakeFx.files["tmp/workflow-artifacts/issues-intake.md"] ?? "") + `\nToken leak ${FAKE_GITHUB}\n`;
    intakeFx.transcript = `intake secret ${FAKE_ANTHROPIC}`;
    intakeFx.claudeResult = {
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: `intake secret ${FAKE_ANTHROPIC}`,
    };
    writeFileSync(join(fxScrub, "intake.json"), JSON.stringify(intakeFx, null, 2));

    const findIntakeTranscript = (dir) => {
      const txDir = join(dir, "transcripts");
      for (const f of readdirSync(txDir).filter((x) => x.endsWith(".json")).sort()) {
        const parsed = JSON.parse(readFileSync(join(txDir, f), "utf8"));
        if (/^Run the intake stage/m.test(String(parsed.prompt ?? ""))) return join(txDir, f);
      }
      return null;
    };

    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", `Goal with ${FAKE_GITHUB}`, "--adapter", "fake", "--repo-root", rootScrub, "--data-dir", dataScrub, "--defer-seal"],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxScrub, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        PROVENANCE_CLI,
        "scrub",
        "--data-dir",
        dataScrub,
        "--workflow",
        "sw_dev",
        "--repo-root",
        rootScrub,
        "--output-path",
        join(rootScrub, "tmp/workflow-artifacts"),
      ],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    // Running scrub.mjs right after (as uwf-on-pr.yml does) is a clean idempotent no-op on stage outputs.
    const { scrubPaths } = await import("../../uwf-on-pr/scrub.mjs");
    const scrubStats = scrubPaths([dataScrub, join(rootScrub, "tmp/workflow-artifacts")]);
    assert.equal(scrubStats.failed, 0);

    const scrubbedIntake = readFileSync(join(rootScrub, "tmp/workflow-artifacts/issues-intake.md"), "utf8");
    assert.ok(!scrubbedIntake.includes(FAKE_GITHUB), "stage output secret must be redacted on disk");
    assert.match(scrubbedIntake, /\[redacted:github-token\]/);
    const scrubSealOut = JSON.parse(
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "seal", "--data-dir", dataScrub, "--workflow", "sw_dev", "--repo-root", rootScrub, "--pr-url", "https://github.com/org/repo/pull/999"],
        { encoding: "utf8", env, stdio: "pipe" },
      ),
    );
    assert.equal(scrubSealOut.ok, true);
    assert.equal(scrubSealOut.phase, "sealed");
    const scrubVerifyOut = JSON.parse(
      execFileSync(process.execPath, [PROVENANCE_CLI, "verify", "--data-dir", dataScrub, "--repo-root", rootScrub], { encoding: "utf8", env, stdio: "pipe" }),
    );
    assert.equal(scrubVerifyOut.ok, true, `scrub + seal manifest must verify cleanly: ${JSON.stringify(scrubVerifyOut.errors)}`);
    const finalScrubManifest = readFileSync(join(dataScrub, "uaw-manifest.json"), "utf8");
    assert.ok(!finalScrubManifest.includes(FAKE_GITHUB) && !finalScrubManifest.includes(FAKE_ANTHROPIC));
    const finalParsed = JSON.parse(finalScrubManifest);
    const scrubbedIntakeAudit = finalParsed.execution_audit.stages.find((s) => s.stage === "intake");
    const scrubbedIntakeTxPath = findIntakeTranscript(dataScrub);
    assert.ok(scrubbedIntakeTxPath, "intake transcript file must exist");
    assert.equal(scrubbedIntakeAudit?.transcript_sha256, sha256Hex(readFileSync(scrubbedIntakeTxPath)));

    // Transcript-only scrub on a closed manifest must refresh transcript_sha256 even when manifest_sha256 is unchanged.
    const fxTxOnly = join(runRoot, "fx-tx-only");
    const rootTxOnly = join(runRoot, "root-tx-only");
    const dataTxOnly = join(runRoot, "data-tx-only");
    cpSync(fxDir, fxTxOnly, { recursive: true });
    mkdirSync(rootTxOnly, { recursive: true });
    writeFileSync(join(rootTxOnly, ".uwf.json"), JSON.stringify({ verify: [] }));
    const intakeTxOnlyFx = JSON.parse(readFileSync(join(fxTxOnly, "intake.json"), "utf8"));
    intakeTxOnlyFx.transcript = `tx-only secret ${FAKE_ANTHROPIC}`;
    intakeTxOnlyFx.claudeResult = {
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: `tx-only secret ${FAKE_ANTHROPIC}`,
    };
    writeFileSync(join(fxTxOnly, "intake.json"), JSON.stringify(intakeTxOnlyFx, null, 2));
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Transcript-only scrub", "--adapter", "fake", "--repo-root", rootTxOnly, "--data-dir", dataTxOnly, "--defer-seal"],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxTxOnly, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    const closedPreSha = JSON.parse(readFileSync(join(dataTxOnly, "uaw-manifest.json"), "utf8")).manifest_sha256;
    execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "scrub", "--data-dir", dataTxOnly, "--workflow", "sw_dev", "--repo-root", rootTxOnly],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    const closedPost = JSON.parse(readFileSync(join(dataTxOnly, "uaw-manifest.json"), "utf8"));
    assert.equal(closedPost.manifest_sha256, closedPreSha, "transcript-only scrub keeps content manifest_sha256 unchanged");
    const txOnlyIntakePath = findIntakeTranscript(dataTxOnly);
    assert.ok(txOnlyIntakePath);
    assert.equal(
      closedPost.execution_audit.stages.find((s) => s.stage === "intake")?.transcript_sha256,
      sha256Hex(readFileSync(txOnlyIntakePath)),
      "transcript-only scrub must update execution_audit.stages[].transcript_sha256",
    );

    // Symlink containment: planted symlink inside artifacts/data dir must never rewrite outside file during scrub.
    const outsideVictim = join(runRoot, "outside-secret.txt");
    writeFileSync(outsideVictim, `outside ${FAKE_GITHUB}\n`);
    symlinkSync(outsideVictim, join(rootScrub, "tmp", "workflow-artifacts", "escaped-secret.txt"));
    execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "scrub", "--data-dir", dataScrub, "--workflow", "sw_dev", "--repo-root", rootScrub, "--output-path", join(rootScrub, "tmp/workflow-artifacts")],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    scrubPaths([dataScrub, join(rootScrub, "tmp/workflow-artifacts")]);
    assert.ok(readFileSync(outsideVictim, "utf8").includes(FAKE_GITHUB), "symlink target outside root must remain unmodified");

    // Pre-scrub tampering on a declared stage output must still fail closed at seal time even if scrub ran.
    const fxTamperBeforeScrub = join(runRoot, "fx-tamper-before-scrub");
    const rootTamperBeforeScrub = join(runRoot, "root-tamper-before-scrub");
    const dataTamperBeforeScrub = join(runRoot, "data-tamper-before-scrub");
    cpSync(fxDir, fxTamperBeforeScrub, { recursive: true });
    mkdirSync(rootTamperBeforeScrub, { recursive: true });
    writeFileSync(join(rootTamperBeforeScrub, ".uwf.json"), JSON.stringify({ verify: [] }));
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Tamper before scrub", "--adapter", "fake", "--repo-root", rootTamperBeforeScrub, "--data-dir", dataTamperBeforeScrub, "--defer-seal"],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxTamperBeforeScrub, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    // Simulate post-run unauthorized mutation containing a secret before scrub runs
    writeFileSync(join(rootTamperBeforeScrub, "tmp/workflow-artifacts/issues-intake.md"), `# Intake\nTAMPERED ${FAKE_GITHUB}\n`);
    execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "scrub", "--data-dir", dataTamperBeforeScrub, "--workflow", "sw_dev", "--repo-root", rootTamperBeforeScrub],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    scrubPaths([dataTamperBeforeScrub, join(rootTamperBeforeScrub, "tmp/workflow-artifacts")]);
    assert.ok(
      !readFileSync(join(rootTamperBeforeScrub, "tmp/workflow-artifacts/issues-intake.md"), "utf8").includes(FAKE_GITHUB),
      "scrub.mjs still scrubs secrets even in tampered outputs",
    );
    let tamperedSealExit = 0;
    let tamperedSealOut = "";
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "seal", "--data-dir", dataTamperBeforeScrub, "--workflow", "sw_dev", "--repo-root", rootTamperBeforeScrub],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      tamperedSealExit = err.status;
      tamperedSealOut = String(err.stdout ?? "");
    }
    assert.equal(tamperedSealExit, 1, "seal must still fail closed on pre-scrub tampering");
    const tamperedParsed = JSON.parse(tamperedSealOut);
    assert.equal(tamperedParsed.ok, false);
    assert.match(tamperedParsed.error, /Pre-seal verification failed/);
    assert.match(tamperedParsed.error, /Unexpected post-stage mutation/);

    // Symlinked domain DB must fail closed instead of opening outside file or silently skipping.
    const outsideDomainDb = join(runRoot, "outside-req.db");
    writeFileSync(outsideDomainDb, "");
    const dataSymlinkDomain = join(runRoot, "data-symlink-domain");
    mkdirSync(dataSymlinkDomain, { recursive: true });
    symlinkSync(outsideDomainDb, join(dataSymlinkDomain, "uwf-requirements.db"));
    let symlinkDomainExit = 0;
    let symlinkDomainStderr = "";
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "materialize", "--data-dir", dataSymlinkDomain, "--workflow", "sw_dev", "--repo-root", rootScrub],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      symlinkDomainExit = err.status;
      symlinkDomainStderr = String(err.stderr ?? "");
    }
    assert.notEqual(symlinkDomainExit, 0, "symlinked domain DB must fail closed");
    assert.match(symlinkDomainStderr, /Refusing/);

    // scrubDeep redacts secret-bearing object keys and disambiguates collisions with #2.
    const secondGithub = "ghp_" + "9876543210fedcba9876543210fedcba9876";
    const keyScrubbed = scrubDeep({
      [FAKE_GITHUB]: "v1",
      [secondGithub]: "v2",
    });
    assert.deepEqual(Object.keys(keyScrubbed), ["[redacted:github-token]", "[redacted:github-token]#2"]);

    // CLI materialize must reject --phase sealed with exit 2 (sealing must go through provenance.mjs seal).
    let materializeSealedCode = 0;
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "materialize", "--data-dir", dataScrub, "--workflow", "sw_dev", "--repo-root", rootScrub, "--phase", "sealed"],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      materializeSealedCode = err.status;
    }
    assert.equal(materializeSealedCode, 2, "materialize --phase sealed must exit 2");

    // gitExec during seal must ignore attacker-planted .git/config core.fsmonitor / hooksPath.
    const repoFsMon = join(runRoot, "repo-fsmonitor");
    const dataFsMon = join(runRoot, "data-fsmonitor");
    mkdirSync(repoFsMon, { recursive: true });
    execFileSync("git", ["-C", repoFsMon, "init", "-q"]);
    execFileSync("git", ["-C", repoFsMon, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoFsMon, "config", "user.name", "Test"]);
    writeFileSync(join(repoFsMon, "README.md"), "# clean\n");
    execFileSync("git", ["-C", repoFsMon, "add", "README.md"]);
    execFileSync("git", ["-C", repoFsMon, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", repoFsMon, "config", "core.fsmonitor", "false_nonexistent_attacker_cmd"]);
    mkdirSync(dataFsMon, { recursive: true });
    const fsMonSeal = execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    assert.equal(JSON.parse(fsMonSeal).phase, "sealed");

    // Unsafe local git filter config + .gitattributes must fail closed without executing filter commands.
    execFileSync("git", ["-C", repoFsMon, "config", "--unset", "core.fsmonitor"]);
    writeFileSync(join(repoFsMon, ".gitattributes"), "* filter=evil\n");
    execFileSync("git", ["-C", repoFsMon, "add", ".gitattributes"]);
    execFileSync("git", ["-C", repoFsMon, "commit", "-q", "-m", "add gitattributes"]);
    execFileSync("git", ["-C", repoFsMon, "config", "filter.evil.clean", "evil_filter_cmd_must_not_run"]);
    let filterErrCode = 0;
    let filterErrStderr = "";
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      filterErrCode = err.status;
      filterErrStderr = String(err.stderr ?? "");
    }
    assert.notEqual(filterErrCode, 0, "unsafe local filter config must fail closed");
    assert.match(filterErrStderr, /Refusing unsafe.*git config keys/);

    // include.path bypass to filter driver must fail closed without executing filters
    execFileSync("git", ["-C", repoFsMon, "config", "--unset", "filter.evil.clean"]);
    const evilIncludeCfg = join(runRoot, "evil-inc.cfg");
    writeFileSync(evilIncludeCfg, '[filter "evil"]\n\tclean = evil_inc_cmd_must_not_run\n');
    execFileSync("git", ["-C", repoFsMon, "config", "include.path", evilIncludeCfg]);
    let incErrCode = 0;
    let incErrStderr = "";
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      incErrCode = err.status;
      incErrStderr = String(err.stderr ?? "");
    }
    assert.notEqual(incErrCode, 0, "include.path pointing to filter config must fail closed");
    assert.match(incErrStderr, /Refusing unsafe.*git config keys/);
    execFileSync("git", ["-C", repoFsMon, "config", "--unset", "include.path"]);

    // extensions.worktreeConfig + config.worktree filter bypass must fail closed, while benign worktree config passes
    execFileSync("git", ["-C", repoFsMon, "config", "extensions.worktreeConfig", "true"]);
    execFileSync("git", ["-C", repoFsMon, "config", "--worktree", "filter.evil.clean", "evil_wt_cmd_must_not_run"]);
    let wtErrCode = 0;
    let wtErrStderr = "";
    try {
      execFileSync(
        process.execPath,
        [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
        { encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (err) {
      wtErrCode = err.status;
      wtErrStderr = String(err.stderr ?? "");
    }
    assert.notEqual(wtErrCode, 0, "worktree config filter must fail closed");
    assert.match(wtErrStderr, /Refusing unsafe.*git config keys/);
    execFileSync("git", ["-C", repoFsMon, "config", "--worktree", "--unset", "filter.evil.clean"]);
    execFileSync("git", ["-C", repoFsMon, "config", "--worktree", "user.name", "Worktree Bot"]);
    const benignWtSeal = execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    assert.equal(JSON.parse(benignWtSeal).phase, "sealed");

    // CRLF file under * text=auto must hash identically to git commit without mismatch
    writeFileSync(join(repoFsMon, ".gitattributes"), "* text=auto\n");
    writeFileSync(join(repoFsMon, "crlf.txt"), Buffer.from("line1\r\nline2\r\n"));
    execFileSync("git", ["-C", repoFsMon, "add", ".gitattributes", "crlf.txt"]);
    execFileSync("git", ["-C", repoFsMon, "commit", "-q", "-m", "add crlf file"]);
    const crlfSeal = execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "seal", "--data-dir", dataFsMon, "--workflow", "sw_dev", "--repo-root", repoFsMon],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    assert.equal(JSON.parse(crlfSeal).phase, "sealed");

    // provenance.mjs seal --commit-git-dir resolves commit & tree from isolated bare repo without fetching into repoRoot.
    execFileSync("git", ["-C", repoFsMon, "config", "--unset", "extensions.worktreeConfig"]);
    const remoteSrc = join(runRoot, "remote-src");
    const localTarget = join(runRoot, "local-target");
    const bareCommitStore = join(runRoot, "bare-commit-store.git");
    const dataBareSeal = join(runRoot, "data-bare-seal");
    execFileSync("git", ["clone", "-q", repoFsMon, remoteSrc]);
    execFileSync("git", ["clone", "-q", remoteSrc, localTarget]);
    execFileSync("git", ["-C", remoteSrc, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", remoteSrc, "config", "user.name", "Test"]);
    writeFileSync(join(remoteSrc, "README.md"), "# shipped in bare\n");
    execFileSync("git", ["-C", remoteSrc, "add", "README.md"]);
    execFileSync("git", ["-C", remoteSrc, "commit", "-q", "-m", "remote commit"]);
    const remoteHead = execFileSync("git", ["-C", remoteSrc, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // Simulate post-push worktree matching remoteHead, while localTarget git object DB still only has parent commit.
    writeFileSync(join(localTarget, "README.md"), "# shipped in bare\n");
    mkdirSync(bareCommitStore, { recursive: true });
    execFileSync("git", ["-C", bareCommitStore, "init", "--bare", "-q"]);
    execFileSync("git", ["-C", bareCommitStore, "fetch", "--depth=1", "--no-tags", remoteSrc, remoteHead]);
    mkdirSync(dataBareSeal, { recursive: true });
    const bareSealOut = execFileSync(
      process.execPath,
      [
        PROVENANCE_CLI,
        "seal",
        "--data-dir", dataBareSeal,
        "--workflow", "sw_dev",
        "--repo-root", localTarget,
        "--head-commit", remoteHead,
        "--commit-git-dir", bareCommitStore,
      ],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    assert.equal(JSON.parse(bareSealOut).phase, "sealed");
    const bareManifest = JSON.parse(readFileSync(join(dataBareSeal, "uaw-manifest.json"), "utf8"));
    assert.equal(bareManifest.deliverable.head_commit_sha, remoteHead);

    // Direct materializeManifest({ phase: "sealed" }) must reject outside sealManifest()
    await assert.rejects(
      () =>
        materializeManifest({
          dataDir: dataBareSeal,
          workflow: "sw_dev",
          repoRoot: localTarget,
          phase: "sealed",
          deferSeal: false,
        }),
      /requires sealManifest/,
    );

    // sealManifest fails closed when commitGitDir or headCommitSha is given for a non-git repoRoot
    const nonGitRepo = join(runRoot, "non-git-root");
    const nonGitData = join(runRoot, "non-git-data");
    mkdirSync(nonGitRepo, { recursive: true });
    mkdirSync(nonGitData, { recursive: true });
    const nonGitSealRes = await sealManifest({
      dataDir: nonGitData,
      workflow: "sw_dev",
      repoRoot: nonGitRepo,
      headCommitSha: remoteHead,
      commitGitDir: bareCommitStore,
    });
    assert.equal(nonGitSealRes.ok, false);
    assert.equal(nonGitSealRes.exitCode, 1);
    assert.match(nonGitSealRes.error, /non-git repoRoot/);

    // Local runner.mjs run without --defer-seal in a git repo with uncommitted tracked changes
    // must materialize phase=closed (head_commit_sha=null, tree:<sha>) until committed and sealed
    const dirtyRepo = join(runRoot, "dirty-seal-repo");
    const dirtyData = join(runRoot, "dirty-seal-data");
    const fxDirty = join(runRoot, "fx-dirty");
    cpSync(fxDir, fxDirty, { recursive: true });
    mkdirSync(dirtyRepo, { recursive: true });
    execFileSync("git", ["-C", dirtyRepo, "init", "-q"]);
    execFileSync("git", ["-C", dirtyRepo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dirtyRepo, "config", "user.name", "Test"]);
    writeFileSync(join(dirtyRepo, ".uwf.json"), JSON.stringify({ verify: [] }));
    writeFileSync(join(dirtyRepo, ".gitignore"), "tmp/\n");
    writeFileSync(join(dirtyRepo, "app.txt"), "v1\n");
    execFileSync("git", ["-C", dirtyRepo, "add", ".uwf.json", ".gitignore", "app.txt"]);
    execFileSync("git", ["-C", dirtyRepo, "commit", "-q", "-m", "initial"]);
    const implFx = JSON.parse(readFileSync(join(fxDirty, "implementation.json"), "utf8"));
    implFx.files = { ...(implFx.files ?? {}), "app.txt": "v2-uncommitted\n" };
    writeFileSync(join(fxDirty, "implementation.json"), JSON.stringify(implFx, null, 2));

    execFileSync(
      process.execPath,
      [
        RUNNER_CLI,
        "run",
        "--workflow", "sw_dev",
        "--goal", "Dirty worktree defers seal",
        "--adapter", "fake",
        "--repo-root", dirtyRepo,
        "--data-dir", dirtyData,
      ],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxDirty, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    const dirtyManifest = JSON.parse(readFileSync(join(dirtyData, "uaw-manifest.json"), "utf8"));
    const expectedWtTree = computeWorktreeTreeSha(dirtyRepo, { dataDir: dirtyData });
    assert.equal(dirtyManifest.phase, "closed", "uncommitted tracked changes must materialize closed, not sealed");
    assert.equal(dirtyManifest.deliverable.head_commit_sha, null);
    assert.equal(dirtyManifest.deliverable.git_tree_sha, expectedWtTree);
    assert.equal(dirtyManifest.deliverable_key, `tree:${expectedWtTree}`);

    execFileSync("git", ["-C", dirtyRepo, "add", "app.txt"]);
    execFileSync("git", ["-C", dirtyRepo, "commit", "-q", "-m", "commit v2"]);
    const v2Head = execFileSync("git", ["-C", dirtyRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const afterCommitSeal = execFileSync(
      process.execPath,
      [PROVENANCE_CLI, "seal", "--data-dir", dirtyData, "--workflow", "sw_dev", "--repo-root", dirtyRepo],
      { encoding: "utf8", env, stdio: "pipe" },
    );
    assert.equal(JSON.parse(afterCommitSeal).phase, "sealed");
    const dirtySealed = JSON.parse(readFileSync(join(dirtyData, "uaw-manifest.json"), "utf8"));
    assert.equal(dirtySealed.deliverable.head_commit_sha, v2Head);

    // stage-tracker.mjs --repo-root works from a different cwd and when repo dir name contains [bracket]
    const bracketRepo = join(runRoot, "repo-[v1]");
    const bracketData = join(runRoot, "data-bracket");
    const bracketOutRel = "tmp/workflow-artifacts";
    const trackerCli = join(REPO_ROOT, ".github", "skills", "uwf-orchestration-engine", "stage-tracker.mjs");
    mkdirSync(join(bracketRepo, bracketOutRel), { recursive: true });
    writeFileSync(join(bracketRepo, bracketOutRel, "issues-intake.md"), "# Intake\nBracket dir ok\n");
    execFileSync(
      process.execPath,
      [trackerCli, "init", "--workflow", "sw_dev", "--data-dir", bracketData, "--skills-root", REPO_ROOT, "--repo-root", bracketRepo, "--output-path", bracketOutRel],
      { cwd: runRoot, encoding: "utf8", stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [trackerCli, "stage-complete", "--workflow", "sw_dev", "--stage", "intake", "--data-dir", bracketData, "--skills-root", REPO_ROOT, "--repo-root", bracketRepo, "--output-path", bracketOutRel],
      { cwd: runRoot, encoding: "utf8", stdio: "pipe" },
    );
    await materializeManifest({
      dataDir: bracketData,
      workflow: "sw_dev",
      repoRoot: bracketRepo,
      skillsRoot: REPO_ROOT,
      outputPath: bracketOutRel,
      phase: "closed",
      deferSeal: true,
    });
    const bracketManifest = JSON.parse(readFileSync(join(bracketData, "uaw-manifest.json"), "utf8"));
    const bracketIntake = bracketManifest.stages.find((s) => s.stage === "intake");
    assert.deepEqual(
      bracketIntake?.outputs.map((o) => o.path),
      ["tmp/workflow-artifacts/issues-intake.md"],
    );
    const bracketVerify = verifyManifest({ dataDir: bracketData, repoRoot: bracketRepo });
    assert.equal(bracketVerify.ok, true, JSON.stringify(bracketVerify.errors));

    // Step N: --defer-seal delivers snapshot stage.completed to strict sink while deferring run.finalized
    const snapDeferRoot = join(runRoot, "snap-defer-root");
    const snapDeferData = join(runRoot, "snap-defer-data");
    mkdirSync(snapDeferRoot, { recursive: true });
    writeFileSync(join(snapDeferRoot, ".uwf.json"), JSON.stringify({ verify: [] }));
    const receivedEvents = [];
    const snapServer = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        receivedEvents.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolveListen) => snapServer.listen(0, "127.0.0.1", resolveListen));
    try {
      const { port } = snapServer.address();
      await new Promise((resolveSpawn, rejectSpawn) => {
        const child = spawn(
          process.execPath,
          [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Defer seal snapshot delivery", "--adapter", "fake", "--repo-root", snapDeferRoot, "--data-dir", snapDeferData, "--defer-seal"],
          {
            env: {
              ...env,
              UAW_CONTEXT_HUB_SINK: "webhook",
              UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook`,
              UAW_CONTEXT_HUB_TOKEN: "tok",
              UAW_CONTEXT_HUB_MODE: "strict",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", rejectSpawn);
        child.on("close", (code) => {
          if (code === 0) resolveSpawn();
          else rejectSpawn(new Error(`runner exited ${code}: ${stderr}`));
        });
      });
    } finally {
      await new Promise((resolveClose) => snapServer.close(resolveClose));
    }
    assert.equal(receivedEvents.length, 1, "exactly snapshot stage.completed must be dispatched under --defer-seal");
    assert.equal(receivedEvents[0].event, "stage.completed");
    assert.equal(receivedEvents[0].stage, "snapshot");
    const snapDeferManifest = JSON.parse(readFileSync(join(snapDeferData, "uaw-manifest.json"), "utf8"));
    assert.equal(snapDeferManifest.phase, "closed");
    const snapDeferDb = new Database(join(snapDeferData, "uwf-state.db"), { readonly: true });
    const snapDeferRow = snapDeferDb.prepare("SELECT phase, sink_status FROM run_manifests LIMIT 1").get();
    snapDeferDb.close();
    assert.equal(snapDeferRow?.phase, "closed");
    assert.equal(snapDeferRow?.sink_status, "deferred");

    // Step O: runner.mjs resume restores custom output_path when --output-path flag is omitted
    const customRoot = join(runRoot, "custom-out-root");
    const customData = join(runRoot, "custom-out-data");
    const customOutAbs = join(customRoot, "custom-out");
    const fxCustom = join(runRoot, "fx-custom-out");
    cpSync(fxDir, fxCustom, { recursive: true });
    const rewriteFilesMap = (filesObj) => {
      if (!filesObj || typeof filesObj !== "object") return filesObj;
      return Object.fromEntries(
        Object.entries(filesObj).map(([k, v]) => [k.replace(/^tmp\/workflow-artifacts\//, "custom-out/"), v]),
      );
    };
    for (const entry of readdirSync(fxCustom)) {
      if (!entry.endsWith(".json")) continue;
      const p = join(fxCustom, entry);
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed.files) parsed.files = rewriteFilesMap(parsed.files);
      if (Array.isArray(parsed.attempts)) {
        parsed.attempts = parsed.attempts.map((a) => ({ ...a, files: rewriteFilesMap(a.files) }));
      }
      writeFileSync(p, JSON.stringify(parsed, null, 2));
    }
    mkdirSync(customRoot, { recursive: true });
    writeFileSync(join(customRoot, ".uwf.json"), JSON.stringify({ verify: [] }));
    const savedDiscovery = readFileSync(join(fxCustom, "discovery.json"), "utf8");
    writeFileSync(join(fxCustom, "discovery.json"), JSON.stringify({ files: {}, transcript: "empty", sessionId: "sess-fail-disc" }));
    let customFailExit = 0;
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Custom output path resume", "--adapter", "fake", "--repo-root", customRoot, "--data-dir", customData, "--output-path", customOutAbs, "--defer-seal"],
        { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxCustom, UWF_DATA_DIR: "" }, stdio: "pipe" },
      );
    } catch (err) {
      customFailExit = err.status;
    }
    assert.equal(customFailExit, 1, "initial custom output-path run must fail on broken discovery fixture");
    writeFileSync(join(fxCustom, "discovery.json"), savedDiscovery);
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "resume", "--workflow", "sw_dev", "--adapter", "fake", "--repo-root", customRoot, "--data-dir", customData, "--defer-seal"],
      { encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fxCustom, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    assert.equal(existsSync(join(customRoot, "tmp", "workflow-artifacts")), false, "resume must not fall back to ./tmp/workflow-artifacts");
    const customVerify = verifyManifest({ dataDir: customData, repoRoot: customRoot });
    assert.equal(customVerify.ok, true, JSON.stringify(customVerify.errors));
    const customManifest = JSON.parse(readFileSync(join(customData, "uaw-manifest.json"), "utf8"));
    assert.ok(
      customManifest.stages.find((s) => s.stage === "intake")?.outputs.some((o) => o.path === "custom-out/issues-intake.md"),
      "resumed custom output-path manifest must retain custom-out intake output",
    );
    assert.ok(
      customManifest.stages.find((s) => s.stage === "discovery")?.outputs.some((o) => o.path === "custom-out/issues-discovery.md"),
      "resumed custom output-path manifest must record custom-out discovery output",
    );

    // Step P: sealManifest accepts bot-created raw-byte commits (createBlob without .gitattributes clean conversion)
    const botRawRepo = join(runRoot, "bot-raw-repo");
    const botRawStore = join(runRoot, "bot-raw-store.git");
    const botRawData = join(runRoot, "bot-raw-data");
    mkdirSync(botRawRepo, { recursive: true });
    mkdirSync(botRawStore, { recursive: true });
    mkdirSync(botRawData, { recursive: true });
    execFileSync("git", ["-C", botRawRepo, "init", "-q"]);
    execFileSync("git", ["-C", botRawRepo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", botRawRepo, "config", "user.name", "Test"]);
    writeFileSync(join(botRawRepo, ".gitattributes"), "* text=auto\n");
    writeFileSync(join(botRawRepo, "crlf.txt"), Buffer.from("line1\r\nline2\r\n"));
    execFileSync("git", ["-C", botRawRepo, "add", ".gitattributes", "crlf.txt"]);
    execFileSync("git", ["-C", botRawRepo, "commit", "-q", "-m", "base with gitattributes"]);
    const botBaseHead = execFileSync("git", ["-C", botRawRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // Modify crlf.txt with raw CRLF bytes in the working tree without local commit
    writeFileSync(join(botRawRepo, "crlf.txt"), Buffer.from("updated1\r\nupdated2\r\n"));
    const botChanges = listChanges(botRawRepo);
    assert.deepEqual(botChanges, [{ path: "crlf.txt", deleted: false }]);

    // Construct the exact tree+commit that push-as-bot.mjs createBlob+createTree produces in bare store
    execFileSync("git", ["-C", botRawStore, "init", "--bare", "-q"]);
    execFileSync("git", ["--git-dir", botRawStore, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["--git-dir", botRawStore, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", botRawStore, "fetch", "--depth=1", "--no-tags", botRawRepo, botBaseHead]);
    const botIdx = join(runRoot, "bot-raw.idx");
    const botEnv = { ...process.env, GIT_INDEX_FILE: botIdx };
    execFileSync("git", ["--git-dir", botRawStore, "read-tree", botBaseHead], { env: botEnv });
    const entry = readEntry(botRawRepo, "crlf.txt");
    const rawBlobSha = execFileSync("git", ["--git-dir", botRawStore, "hash-object", "-w", "--no-filters", "--stdin"], {
      input: entry.content,
      encoding: "utf8",
    }).trim();
    const filteredTreeSha = computeWorktreeTreeSha(botRawRepo, { dataDir: botRawData });
    execFileSync("git", ["--git-dir", botRawStore, "update-index", "-z", "--index-info"], {
      env: botEnv,
      input: `${entry.mode} ${rawBlobSha}\tcrlf.txt\0`,
    });
    const botTreeSha = execFileSync("git", ["--git-dir", botRawStore, "write-tree"], {
      env: botEnv,
      encoding: "utf8",
    }).trim();
    assert.notEqual(filteredTreeSha, botTreeSha, "filtered CRLF tree must differ from raw Git Data API blob tree");
    const botCommitSha = execFileSync(
      "git",
      ["--git-dir", botRawStore, "commit-tree", botTreeSha, "-p", botBaseHead, "-m", "bot raw commit"],
      { encoding: "utf8" },
    ).trim();

    const botSealRaw = execFileSync(
      process.execPath,
      [
        PROVENANCE_CLI,
        "seal",
        "--data-dir", botRawData,
        "--workflow", "sw_dev",
        "--repo-root", botRawRepo,
        "--head-commit", botCommitSha,
        "--commit-git-dir", botRawStore,
      ],
      { encoding: "utf8", env: { ...process.env, UWF_DATA_DIR: "" }, stdio: "pipe" },
    );
    const botSealSummary = JSON.parse(botSealRaw);
    assert.equal(botSealSummary.phase, "sealed");
    const botSealed = JSON.parse(readFileSync(join(botRawData, "uaw-manifest.json"), "utf8"));
    assert.equal(botSealed.phase, "sealed");
    assert.equal(botSealed.deliverable.head_commit_sha, botCommitSha);
    assert.equal(botSealed.deliverable.git_tree_sha, botTreeSha);

    // Tampering worktree bytes after the bot commit must still fail closed
    writeFileSync(join(botRawRepo, "crlf.txt"), Buffer.from("tampered1\r\ntampered2\r\n"));
    let tamperStatus = 0;
    let tamperOutput = "";
    try {
      execFileSync(
        process.execPath,
        [
          PROVENANCE_CLI,
          "seal",
          "--data-dir", botRawData,
          "--workflow", "sw_dev",
          "--repo-root", botRawRepo,
          "--head-commit", botCommitSha,
          "--commit-git-dir", botRawStore,
        ],
        { encoding: "utf8", env: { ...process.env, UWF_DATA_DIR: "" }, stdio: "pipe" },
      );
    } catch (err) {
      tamperStatus = err.status;
      tamperOutput = String(err.stdout ?? "") + String(err.stderr ?? "");
    }
    assert.notEqual(tamperStatus, 0, "tampered worktree bytes must fail closed");
    assert.match(tamperOutput, /does not match post-retro tracked worktree state/);

    // Step Q: Non-Claude adapter transcripts still populate transcript_sha256, and domain-store query errors propagate.
    const ncRepo = join(runRoot, "non-claude-repo");
    const ncData = join(runRoot, "non-claude-data");
    mkdirSync(ncRepo, { recursive: true });
    mkdirSync(join(ncData, "transcripts"), { recursive: true });
    {
      const sdb = new Database(join(ncData, "uwf-stages.db"));
      sdb.exec(`
        CREATE TABLE stage_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, stage TEXT NOT NULL,
          status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, run_as_subagent INTEGER NOT NULL DEFAULT 1,
          started_at TEXT, completed_at TEXT, gate_result TEXT, notes TEXT, session_id TEXT, outputs_json TEXT
        );
        INSERT INTO stage_runs (workflow, stage, status, started_at, completed_at, outputs_json) VALUES
          ('sw_dev', 'intake', 'passed', '2026-11-20T00:00:01Z', '2026-11-20T00:00:02Z', '[]'),
          ('sw_dev', 'discovery', 'passed', '2026-11-20T00:00:03Z', '2026-11-20T00:00:04Z', '[]'),
          ('sw_dev', 'review', 'passed', '2026-11-20T00:00:05Z', '2026-11-20T00:00:06Z', '[]');
      `);
      sdb.close();
    }
    const codexTxPath = join(ncData, "transcripts", "2026-11-20T00-00-01-codex1.json");
    const grokTxPath = join(ncData, "transcripts", "2026-11-20T00-00-02-grok01.json");
    const explicitStageTxPath = join(ncData, "transcripts", "2026-11-20T00-00-03-explicit.json");
    const nonObjectTxPath = join(ncData, "transcripts", "2026-11-20T00-00-04-array.json");
    const symTxPath = join(ncData, "transcripts", "2026-11-20T00-00-05-sym.json");
    writeFileSync(
      codexTxPath,
      JSON.stringify({
        adapter: "codex",
        prompt: "Run the intake stage for the sw_dev workflow.\nDo intake.",
        sessionId: "codex-sid-1",
        exitCode: 0,
        stdout: "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10}}\n",
      }, null, 2),
    );
    writeFileSync(
      grokTxPath,
      JSON.stringify({
        adapter: "grokbot",
        prompt: "Run the discovery stage for the sw_dev workflow.\nDo discovery.",
        sessionId: "grok-sid-1",
        exitCode: 0,
        stdout: "plain text summary",
      }, null, 2),
    );
    writeFileSync(
      explicitStageTxPath,
      JSON.stringify({
        adapter: "codex",
        stage: "review",
        prompt: "unmatched prompt format",
        exitCode: 0,
        stdout: "done",
      }, null, 2),
    );
    writeFileSync(nonObjectTxPath, "[]");
    const outsideTx = join(runRoot, "outside-tx.json");
    writeFileSync(outsideTx, JSON.stringify({ stage: "intake", prompt: "Run the intake stage for the sw_dev workflow.", stdout: "hijacked" }));
    symlinkSync(outsideTx, symTxPath);
    const ncBuilt = buildManifest({
      dataDir: ncData,
      workflow: "sw_dev",
      repoRoot: ncRepo,
      phase: "closed",
      now: "2026-11-20T00:00:05.000Z",
    });
    const ncIntake = ncBuilt.manifest.execution_audit.stages.find((s) => s.stage === "intake");
    const ncDiscovery = ncBuilt.manifest.execution_audit.stages.find((s) => s.stage === "discovery");
    const ncReview = ncBuilt.manifest.execution_audit.stages.find((s) => s.stage === "review");
    assert.equal(ncIntake?.transcript_sha256, sha256Hex(readFileSync(codexTxPath)), "Codex NDJSON transcript must populate transcript_sha256 and skip symlinks");
    assert.equal(ncDiscovery?.transcript_sha256, sha256Hex(readFileSync(grokTxPath)), "Grokbot plain-text transcript must populate transcript_sha256");
    assert.equal(ncReview?.transcript_sha256, sha256Hex(readFileSync(explicitStageTxPath)), "Explicit stage metadata must populate transcript_sha256");
    assert.equal(ncBuilt.manifest.execution_audit.cost_summary.turns, 0);
    assert.equal(ncBuilt.manifest.execution_audit.cost_summary.cost_usd, 0);

    // Symlinked transcripts/ directory must fail closed.
    const symDataDir = join(runRoot, "sym-tx-data");
    const outsideTxDir = join(runRoot, "outside-tx-dir");
    mkdirSync(symDataDir, { recursive: true });
    mkdirSync(outsideTxDir, { recursive: true });
    symlinkSync(outsideTxDir, join(symDataDir, "transcripts"));
    assert.throws(
      () => buildManifest({ dataDir: symDataDir, workflow: "sw_dev", repoRoot: ncRepo, phase: "closed" }),
      /symlinked transcripts directory/i,
    );

    // Broken schema in a domain store must propagate instead of silently reporting empty store counts.
    {
      const badAdrDb = new Database(join(ncData, "uwf-adrs.db"));
      badAdrDb.exec("CREATE TABLE adrs (id INTEGER PRIMARY KEY, slug TEXT); INSERT INTO adrs VALUES (1, 'broken');");
      badAdrDb.close();
    }
    assert.throws(
      () => buildManifest({ dataDir: ncData, workflow: "sw_dev", repoRoot: ncRepo, phase: "closed" }),
      /no such column: number/i,
    );
    await assert.rejects(
      () => materializeManifest({ dataDir: ncData, workflow: "sw_dev", repoRoot: ncRepo, phase: "closed", deferSeal: true, dispatchSink: false }),
      /no such column: number/i,
    );

    // Corrupt non-SQLite database file must also propagate instead of being treated as empty.
    rmSync(join(ncData, "uwf-adrs.db"), { force: true });
    writeFileSync(join(ncData, "uwf-reviews.db"), "not a valid sqlite database");
    assert.throws(
      () => buildManifest({ dataDir: ncData, workflow: "sw_dev", repoRoot: ncRepo, phase: "closed" }),
      /not a database/i,
    );

    // Step R: Retro replay after seal, persisted run_id recovery, and deep JSON Schema validation
    const replayRepo = join(runRoot, "replay-repo");
    const replayData = join(runRoot, "replay-data");
    const replayFx = join(runRoot, "replay-fx");
    cpSync(fxDir, replayFx, { recursive: true });
    mkdirSync(replayRepo, { recursive: true });
    execFileSync("git", ["-C", replayRepo, "init", "-q"]);
    execFileSync("git", ["-C", replayRepo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", replayRepo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", replayRepo, "config", "commit.gpgsign", "false"]);
    writeFileSync(join(replayRepo, ".uwf.json"), JSON.stringify({ verify: [] }));
    writeFileSync(join(replayRepo, ".gitignore"), "tmp/\n");
    writeFileSync(join(replayRepo, "README.md"), "# Replay\n");
    execFileSync("git", ["-C", replayRepo, "add", "."]);
    execFileSync("git", ["-C", replayRepo, "commit", "-q", "-m", "init"]);

    const replayEnv = { ...process.env, UWF_FAKE_FIXTURE_DIR: replayFx, UWF_DATA_DIR: "" };
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Replay seal test", "--adapter", "fake", "--repo-root", replayRepo, "--data-dir", replayData, "--defer-seal"],
      { encoding: "utf8", env: replayEnv, stdio: "pipe" },
    );
    execFileSync("git", ["-C", replayRepo, "add", "-A"]);
    execFileSync("git", ["-C", replayRepo, "commit", "-q", "--allow-empty", "-m", "v1"]);
    const sealV1 = await sealManifest({ dataDir: replayData, workflow: "sw_dev", repoRoot: replayRepo, now: "2026-11-20T01:00:00.000Z" });
    assert.equal(sealV1.ok, true, sealV1.error);
    const sealedRunId = sealV1.manifest.run_id;

    // Truncated run-meta.json before `run --from-stage retro` recovers run_id from uwf-state.db and re-seal succeeds even if stale sealed uaw-manifest.json remains on disk.
    const replayRetroFxPath = join(replayFx, "retro.json");
    const replayRetroFx = JSON.parse(readFileSync(replayRetroFxPath, "utf8"));
    replayRetroFx.files["tmp/workflow-artifacts/issues-retro.md"] = "# Retro v2\nUpdated replay output\n";
    writeFileSync(replayRetroFxPath, JSON.stringify(replayRetroFx, null, 2));
    writeFileSync(join(replayData, "run-meta.json"), "{truncated");
    execFileSync(
      process.execPath,
      [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Replay seal test", "--from-stage", "retro", "--adapter", "fake", "--repo-root", replayRepo, "--data-dir", replayData, "--defer-seal"],
      { encoding: "utf8", env: replayEnv, stdio: "pipe" },
    );
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId, "truncated run-meta.json must recover persisted run_id");
    // Simulate stale sealed uaw-manifest.json from v1 still on disk before sealManifest runs
    writeFileSync(join(replayData, "uaw-manifest.json"), sealV1.canonicalJson);
    execFileSync("git", ["-C", replayRepo, "add", "-A"]);
    execFileSync("git", ["-C", replayRepo, "commit", "-q", "--allow-empty", "-m", "retro v2"]);
    const sealV2 = await sealManifest({ dataDir: replayData, workflow: "sw_dev", repoRoot: replayRepo, now: "2026-11-20T01:05:00.000Z" });
    assert.equal(sealV2.ok, true, `sealManifest after --from-stage retro must rebuild from updated stage ledger: ${sealV2.error}`);
    assert.equal(sealV2.manifest.run_id, sealedRunId);
    assert.equal(
      sealV2.manifest.stages.find((s) => s.stage === "retro")?.outputs.find((o) => o.path === "tmp/workflow-artifacts/issues-retro.md")?.sha256,
      sha256Hex(Buffer.from("# Retro v2\nUpdated replay output\n")),
    );

    // Deleted run-meta.json before buildManifest also recovers persisted run_id from uwf-state.db.
    rmSync(join(replayData, "run-meta.json"), { force: true });
    // Read-only pre-seal failure must not recreate run-meta.json on disk.
    const retroArtifactPath = join(replayRepo, "tmp/workflow-artifacts/issues-retro.md");
    const savedRetroArtifact = readFileSync(retroArtifactPath);
    writeFileSync(retroArtifactPath, "# Tampered before seal\n");
    const roSealFail = await sealManifest({ dataDir: replayData, workflow: "sw_dev", repoRoot: replayRepo, now: "2026-11-20T01:06:00.000Z" });
    assert.equal(roSealFail.ok, false, "sealManifest must fail on tampered stage output even when run-meta.json is absent");
    assert.equal(existsSync(join(replayData, "run-meta.json")), false, "failing sealManifest pre-check must not recreate run-meta.json on disk");
    writeFileSync(retroArtifactPath, savedRetroArtifact);

    const rebuiltRecovered = buildManifest({ dataDir: replayData, workflow: "sw_dev", repoRoot: replayRepo, phase: "closed" });
    assert.equal(rebuiltRecovered.manifest.run_id, sealedRunId, "deleted run-meta.json must recover run_id from uwf-state.db");
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId);

    // Conflicting explicit runId / UAW_RUN_ID during resume / --from-stage fails closed when forceNew is false.
    assert.throws(
      () => ensureRunMeta(replayData, { workflow: "sw_dev", runId: "conflicting-explicit-id", repoRoot: replayRepo }),
      /Run ID mismatch/i,
    );
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId);

    let mismatchExit = 0;
    let mismatchStderr = "";
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Replay seal test", "--from-stage", "retro", "--adapter", "fake", "--repo-root", replayRepo, "--data-dir", replayData, "--defer-seal"],
        { encoding: "utf8", env: { ...replayEnv, UAW_RUN_ID: "conflicting-env-id" }, stdio: "pipe" },
      );
    } catch (err) {
      mismatchExit = err.status ?? 1;
      mismatchStderr = String(err.stderr ?? "");
    }
    assert.notEqual(mismatchExit, 0, "runner --from-stage with conflicting UAW_RUN_ID must fail closed");
    assert.match(mismatchStderr, /Run ID mismatch/i);
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId);

    // Conflicting workflow against intact run-meta.json fails closed during ensureRunMeta and runner --from-stage
    assert.throws(
      () => ensureRunMeta(replayData, { workflow: "project_manager", repoRoot: replayRepo }),
      /Workflow mismatch/i,
    );
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId);
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).workflow, "sw_dev");

    let wfFromStageExit = 0;
    let wfFromStageStderr = "";
    try {
      execFileSync(
        process.execPath,
        [RUNNER_CLI, "run", "--workflow", "project_manager", "--goal", "Cross-workflow from-stage mismatch", "--from-stage", "intake", "--adapter", "fake", "--repo-root", replayRepo, "--data-dir", replayData, "--defer-seal"],
        { encoding: "utf8", env: replayEnv, stdio: "pipe" },
      );
    } catch (err) {
      wfFromStageExit = err.status ?? 1;
      wfFromStageStderr = String(err.stderr ?? "");
    }
    assert.notEqual(wfFromStageExit, 0, "runner --from-stage with conflicting workflow against intact run-meta.json must fail closed");
    assert.match(wfFromStageStderr, /Workflow mismatch/i);
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).run_id, sealedRunId);
    assert.equal(JSON.parse(readFileSync(join(replayData, "run-meta.json"), "utf8")).workflow, "sw_dev");
    {
      const pmCheckDb = new Database(join(replayData, "uwf-stages.db"), { readonly: true });
      const pmCount = pmCheckDb.prepare("SELECT COUNT(*) AS n FROM stage_runs WHERE workflow = 'project_manager'").get().n;
      pmCheckDb.close();
      assert.equal(pmCount, 0, "rejected cross-workflow --from-stage must not seed or execute stages under prior run");
    }

    // Intact run-meta.json without workflow must not adopt an unrelated run_id's workflow from state/stage DBs
    const intactNoWfData = join(runRoot, "intact-no-wf-data");
    cpSync(replayData, intactNoWfData, { recursive: true });
    writeFileSync(
      join(intactNoWfData, "run-meta.json"),
      JSON.stringify({ run_id: "unrelated-intact-run", output_path: join(replayRepo, "tmp/workflow-artifacts") }, null, 2),
    );
    const repNoWf = ensureRunMeta(intactNoWfData, { workflow: "project_manager", repoRoot: replayRepo, persist: true });
    assert.equal(repNoWf.run_id, "unrelated-intact-run");
    assert.equal(repNoWf.workflow, "project_manager");

    const forceRotData = join(runRoot, "force-rotate-data");
    mkdirSync(forceRotData, { recursive: true });
    cpSync(replayData, forceRotData, { recursive: true });

    const forcedMeta = ensureRunMeta(forceRotData, {
      workflow: "sw_dev",
      runId: "forced-explicit-id",
      repoRoot: replayRepo,
      forceNew: true,
    });
    assert.equal(forcedMeta.run_id, "forced-explicit-id");
    assert.equal(JSON.parse(readFileSync(join(forceRotData, "run-meta.json"), "utf8")).run_id, "forced-explicit-id");

    // Corrupt run-meta.json in a fresh data dir with no persisted run_id fails closed instead of minting a replacement.
    const corruptEmptyData = join(runRoot, "corrupt-empty-data");
    mkdirSync(corruptEmptyData, { recursive: true });
    writeFileSync(join(corruptEmptyData, "run-meta.json"), "{corrupt");
    assert.throws(
      () => buildManifest({ dataDir: corruptEmptyData, workflow: "sw_dev", repoRoot: replayRepo, phase: "closed" }),
      /Corrupt run metadata/i,
    );

    // Full nested schema validation rejects structurally invalid stores/architecture/audit payloads even with recomputed manifest_sha256.
    const schemaTestData = join(runRoot, "schema-test-data");
    mkdirSync(schemaTestData, { recursive: true });
    const schemaMutators = [
      (m) => { m.stores.requirements = {}; },
      (m) => { m.stores.adrs = { sha256: "a".repeat(64), total: 0, records: [{}] }; },
      (m) => { m.architecture.drs = { path: "x" }; },
      (m) => { m.execution_audit.cost_summary = {}; },
      (m) => { m.stores.unexpected = null; },
    ];
    for (const mutate of schemaMutators) {
      const candidate = JSON.parse(readFileSync(join(replayData, "uaw-manifest.json"), "utf8"));
      mutate(candidate);
      const { execution_audit: _ea, manifest_sha256: _ms, ...contentOnly } = candidate;
      candidate.manifest_sha256 = sha256Hex(canonicalizeJcs(contentOnly));
      assert.ok(validateManifest(candidate).length > 0, "validateManifest must reject invalid nested schema object");
      writeFileSync(join(schemaTestData, "uaw-manifest.json"), canonicalizeJcs(candidate));
      const vr = verifyManifest({ dataDir: schemaTestData, repoRoot: replayRepo });
      assert.equal(vr.ok, false, "verifyManifest must fail on schema-invalid nested payload");
    }

    // Step S1: Cross-workflow data-dir reuse recovers active run_id & workflow without colliding with prior run_manifests
    const stateCliPath = join(REPO_ROOT, ".github", "skills", "uwf-state-manager", "state.mjs");
    const trackerCliPath = join(REPO_ROOT, ".github", "skills", "uwf-orchestration-engine", "stage-tracker.mjs");
    const reuseData = join(runRoot, "reuse-cross-workflow-data");
    cpSync(replayData, reuseData, { recursive: true });
    execFileSync(
      process.execPath,
      [trackerCliPath, "init", "--workflow", "project_manager", "--data-dir", reuseData, "--repo-root", replayRepo],
      { encoding: "utf8", stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [stateCliPath, "init", "--run-id", "run-b-pm", "--data-dir", reuseData],
      { encoding: "utf8", stdio: "pipe" },
    );
    // Deliberately delete run-meta.json while sw_dev row in run_manifests AND stale sw_dev uaw-manifest.json still exist
    rmSync(join(reuseData, "run-meta.json"), { force: true });
    const pmRecoveredMeta = ensureRunMeta(reuseData, { workflow: "project_manager", repoRoot: replayRepo });
    assert.equal(pmRecoveredMeta.run_id, "run-b-pm");
    assert.equal(pmRecoveredMeta.workflow, "project_manager");

    for (const badMetaText of [null, "{corrupt", "{}"]) {
      if (badMetaText === null) rmSync(join(reuseData, "run-meta.json"), { force: true });
      else writeFileSync(join(reuseData, "run-meta.json"), badMetaText);
      const pmBuilt = buildManifest({
        dataDir: reuseData,
        workflow: "project_manager",
        repoRoot: replayRepo,
        phase: "snapshot",
      });
      assert.equal(pmBuilt.manifest.run_id, "run-b-pm");
      assert.equal(pmBuilt.manifest.workflow, "project_manager");
    }

    rmSync(join(reuseData, "run-meta.json"), { force: true });
    assert.throws(
      () => ensureRunMeta(reuseData, { workflow: "sw_dev", repoRoot: replayRepo }),
      /Workflow mismatch/i,
    );
    await assert.rejects(
      () => scrubProvenanceOutputs({ dataDir: reuseData, workflow: "sw_dev", repoRoot: replayRepo }),
      /Workflow mismatch/i,
    );

    // Resuming an older workflow in uwf-stages.db (stage-start without runner-start history or workflow_state.run_id) must track stage_history recency, not highest stage_runs.id
    const resumeOlderData = join(runRoot, "resume-older-wf-data");
    cpSync(reuseData, resumeOlderData, { recursive: true });
    execFileSync(
      process.execPath,
      [trackerCliPath, "stage-start", "--workflow", "sw_dev", "--stage", "retro", "--data-dir", resumeOlderData, "--repo-root", replayRepo],
      { encoding: "utf8", stdio: "pipe" },
    );
    {
      const sdbLegacy = new Database(join(resumeOlderData, "uwf-state.db"));
      sdbLegacy.exec("UPDATE workflow_state SET run_id = NULL WHERE id = 1; DELETE FROM workflow_history;");
      sdbLegacy.close();
    }
    const swResumedMeta = ensureRunMeta(resumeOlderData, { workflow: "sw_dev", repoRoot: replayRepo });
    assert.equal(swResumedMeta.run_id, sealedRunId);
    assert.equal(swResumedMeta.workflow, "sw_dev");

    // Stale run_manifests + uaw-manifest.json with no active workflow or run_id must NOT be adopted into an unrelated workflow
    const staleOnlyData = join(runRoot, "stale-manifest-only-data");
    cpSync(replayData, staleOnlyData, { recursive: true });
    rmSync(join(staleOnlyData, "run-meta.json"), { force: true });
    rmSync(join(staleOnlyData, "uwf-stages.db"), { force: true });
    {
      const staleStateDb = new Database(join(staleOnlyData, "uwf-state.db"));
      staleStateDb.exec("UPDATE workflow_state SET run_id = NULL WHERE id = 1; DELETE FROM workflow_history;");
      staleStateDb.close();
    }
    const freshUnrelatedMeta = ensureRunMeta(staleOnlyData, { workflow: "project_manager", repoRoot: replayRepo, persist: false });
    assert.notEqual(freshUnrelatedMeta.run_id, sealedRunId, "stale run_manifests/uaw-manifest.json without active workflow or run_id must not leak prior run_id");
    assert.equal(freshUnrelatedMeta.workflow, "project_manager");

    // Step S2: Corrupted outputs_json on passed stages must fail closed across build, materialize, scrub, and seal
    const corruptCases = [
      "{corrupt",
      "",
      null,
      "{}",
      JSON.stringify([
        { path: "tmp/workflow-artifacts/issues-intake.md", sha256: "a".repeat(64), bytes: 10 },
        { path: "bad", sha256: "not-hex", bytes: 1 },
      ]),
    ];
    for (let idx = 0; idx < corruptCases.length; idx++) {
      const badOutData = join(runRoot, `corrupt-outputs-${idx}`);
      cpSync(replayData, badOutData, { recursive: true });
      const sdb = new Database(join(badOutData, "uwf-stages.db"));
      sdb.prepare("UPDATE stage_runs SET outputs_json = ? WHERE workflow = 'sw_dev' AND stage = 'intake'").run(corruptCases[idx]);
      sdb.close();

      assert.throws(
        () => buildManifest({ dataDir: badOutData, workflow: "sw_dev", repoRoot: replayRepo, phase: "closed" }),
        /Corrupt outputs_json/i,
      );
      await assert.rejects(
        () => materializeManifest({ dataDir: badOutData, workflow: "sw_dev", repoRoot: replayRepo, phase: "snapshot", deferSeal: false, dispatchSink: false }),
        /Corrupt outputs_json/i,
      );
      await assert.rejects(
        () => materializeManifest({ dataDir: badOutData, workflow: "sw_dev", repoRoot: replayRepo, phase: "closed", deferSeal: true, dispatchSink: false }),
        /Corrupt outputs_json/i,
      );
      await assert.rejects(
        () => scrubProvenanceOutputs({ dataDir: badOutData, workflow: "sw_dev", repoRoot: replayRepo }),
        /Corrupt outputs_json/i,
      );
      const sealBadOut = await sealManifest({ dataDir: badOutData, workflow: "sw_dev", repoRoot: replayRepo });
      assert.equal(sealBadOut.ok, false);
      assert.equal(sealBadOut.exitCode, 1);
      assert.match(sealBadOut.error ?? "", /Corrupt outputs_json/i);
    }

    // Step S3: runner.mjs must abort snapshot checkpoint dispatch and roll snapshot back if snapshot mutates an earlier stage output
    const snapTamperFx = join(runRoot, "fx-snap-tamper");
    const snapTamperRoot = join(runRoot, "root-snap-tamper");
    const snapTamperData = join(runRoot, "data-snap-tamper");
    cpSync(fxDir, snapTamperFx, { recursive: true });
    mkdirSync(snapTamperRoot, { recursive: true });
    writeFileSync(join(snapTamperRoot, ".uwf.json"), JSON.stringify({ verify: [] }));
    const snapFx = JSON.parse(readFileSync(join(snapTamperFx, "snapshot.json"), "utf8"));
    snapFx.files["tmp/workflow-artifacts/issues-intake.md"] = "# Intake\nTAMPERED_DURING_SNAPSHOT\n";
    writeFileSync(join(snapTamperFx, "snapshot.json"), JSON.stringify(snapFx, null, 2));

    const snapTamperEvents = [];
    const snapTamperServer = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        snapTamperEvents.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolveListen) => snapTamperServer.listen(0, "127.0.0.1", resolveListen));
    let snapTamperExit = 0;
    let snapTamperStderr = "";
    try {
      const { port } = snapTamperServer.address();
      await new Promise((resolveSpawn, rejectSpawn) => {
        const child = spawn(
          process.execPath,
          [RUNNER_CLI, "run", "--workflow", "sw_dev", "--goal", "Snapshot tamper test", "--adapter", "fake", "--repo-root", snapTamperRoot, "--data-dir", snapTamperData, "--defer-seal"],
          {
            env: {
              ...process.env,
              UWF_FAKE_FIXTURE_DIR: snapTamperFx,
              UWF_DATA_DIR: "",
              UAW_CONTEXT_HUB_SINK: "webhook",
              UAW_CONTEXT_HUB_URL: `http://127.0.0.1:${port}/webhook`,
              UAW_CONTEXT_HUB_TOKEN: "tok",
              UAW_CONTEXT_HUB_MODE: "strict",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stderr.on("data", (d) => { snapTamperStderr += d; });
        child.on("error", rejectSpawn);
        child.on("close", (code) => {
          snapTamperExit = code ?? 1;
          resolveSpawn();
        });
      });
    } finally {
      await new Promise((resolveClose) => snapTamperServer.close(resolveClose));
    }
    assert.equal(snapTamperExit, 1, "runner.mjs must exit 1 when snapshot mutates an earlier stage output");
    assert.match(snapTamperStderr, /Stage output integrity verification failed|Unexpected post-stage mutation/);
    assert.equal(snapTamperEvents.length, 0, "tampered snapshot must not dispatch to Context Hub");
    assert.equal(existsSync(join(snapTamperData, "uaw-manifest.json")), false, "tampered snapshot must not persist uaw-manifest.json");
    const snapTamperStateDb = new Database(join(snapTamperData, "uwf-state.db"), { readonly: true });
    const hasManifestTbl = snapTamperStateDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_manifests'").get();
    const manifestCnt = hasManifestTbl ? snapTamperStateDb.prepare("SELECT COUNT(*) AS n FROM run_manifests").get().n : 0;
    snapTamperStateDb.close();
    assert.equal(manifestCnt, 0, "tampered snapshot must not upsert into run_manifests");
    const snapTamperStagesDb = new Database(join(snapTamperData, "uwf-stages.db"), { readonly: true });
    const snapTamperRow = snapTamperStagesDb.prepare("SELECT status FROM stage_runs WHERE workflow = 'sw_dev' AND stage = 'snapshot'").get();
    snapTamperStagesDb.close();
    assert.equal(snapTamperRow?.status, "pending", "tampered snapshot must roll snapshot stage back to pending");
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }

  console.log("provenance tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
