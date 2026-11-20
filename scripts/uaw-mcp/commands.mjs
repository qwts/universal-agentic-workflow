/**
 * commands.mjs — Deterministic MCP command tools for uaw-mcp/v1.
 *
 * Wraps the existing UAW CLIs asynchronously (`node:child_process` `spawn`) so
 * parallel MCP calls never block the server event loop:
 *   - uaw_run
 *   - uaw_resume
 *   - uaw_gates
 *   - uaw_cost
 *   - uaw_stage_transition
 *   - uaw_question_resolve
 *
 * Preserves runner.mjs exit codes:
 *   0 = OK | 1 = GATE | 2 = USAGE | 3 = QUESTIONS | 4 = COST
 */

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../hooks/secret-patterns.mjs";
import { costReport, transcriptRow } from "../uwf-runner/cost.mjs";
import { assertNoActiveRunLock, claimOutputPath } from "./ownership.mjs";
import {
  assertAllowedPath,
  defaultOutputPath,
  generateRunId,
  readRunMeta,
  registerRunIndex,
  resolveRunTarget,
  resolveUawStateDir,
  UsageError,
  writeRunMeta,
} from "./paths.mjs";
import { redactDeep, readQuestions, readStages, readState } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_REPO_ROOT = resolve(HERE, "..", "..");
const RUNNER_CLI = join(OWN_REPO_ROOT, "scripts", "uwf-runner", "runner.mjs");
const SKILLS_DIR = join(OWN_REPO_ROOT, ".github", "skills");
const STATE_CLI = join(SKILLS_DIR, "uwf-state-manager", "state.mjs");
const TRACKER_CLI = join(SKILLS_DIR, "uwf-orchestration-engine", "stage-tracker.mjs");
const QUESTIONS_CLI = join(SKILLS_DIR, "uwf-question-protocol", "questions.mjs");

export const EXIT = Object.freeze({
  OK: 0,
  GATE: 1,
  USAGE: 2,
  QUESTIONS: 3,
  COST: 4,
});

const EXIT_STATUS = Object.freeze({
  0: "ok",
  1: "gate_blocked",
  2: "usage_error",
  3: "questions_pending",
  4: "cost_cap_exceeded",
});

const STATE_ACTIONS = new Set([
  "init",
  "advance",
  "rollback",
  "set-agent",
  "release-agent",
  "check-ready",
  "set-status",
  "set-model-profile",
  "sync",
  "note",
]);

const STAGE_ACTIONS = new Set([
  "init",
  "stage-start",
  "stage-complete",
  "stage-fail",
  "stage-skip",
  "stage-session",
  "reset-from",
]);

const QUESTION_ACTIONS = new Set(["list", "check", "answer", "skip"]);

/**
 * Spawn a Node CLI script asynchronously (no shell).
 * Returns `{ code, stdout, stderr, json }`.
 */
function execNodeAsync(scriptPath, args, { cwd, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: cwd ?? OWN_REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    child.on("error", (err) => {
      resolvePromise({
        code: EXIT.USAGE,
        stdout: "",
        stderr: err.message,
        json: null,
      });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* non-JSON CLI output */
      }
      resolvePromise({
        code: typeof code === "number" ? code : EXIT.GATE,
        stdout,
        stderr,
        json,
      });
    });
  });
}

/**
 * Compute structured cost summary from `<data-dir>/transcripts/*.json`.
 */
export function computeCostSummary(dataDir) {
  const dir = join(resolve(dataDir), "transcripts");
  if (!existsSync(dir)) {
    return {
      stages: [],
      totals: {
        turns: 0,
        ctx_per_turn: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        thinking: 0,
        cost_usd: 0,
      },
      flags: [],
    };
  }
  const dirLst = lstatSync(dir);
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`Invalid transcripts directory at ${dir}`);
  }
  const realDir = realpathSync(dir);
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const full = join(dir, f);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const realFull = realpathSync(full);
      if (!realFull.startsWith(realDir + "/") && !realFull.startsWith(realDir + "\\")) continue;
      const parsed = JSON.parse(readFileSync(realFull, "utf8"));
      const row = transcriptRow(f, parsed);
      if (row) rows.push(row);
    } catch {
      /* ignore unreadable transcript */
    }
  }
  const sum = (k) => rows.reduce((acc, r) => acc + (r[k] ?? 0), 0);
  const totalTurns = sum("turns");
  const totalInput = sum("input");
  const totalRead = sum("read");
  const totalWrite = sum("write");
  const allFlags = [...new Set(rows.flatMap((r) => r.flags ?? []))];
  return {
    stages: rows.map((r) => ({
      file: r.file,
      stage: r.stage,
      turns: r.turns,
      ctx_per_turn: Math.round(r.perTurn),
      last_turn: Math.round(r.lastCtx),
      cache_read: r.read,
      cache_write: r.write,
      output: r.output,
      thinking: r.thinking ?? null,
      cost_usd: r.cost,
      flags: r.flags,
    })),
    totals: {
      turns: totalTurns,
      ctx_per_turn: totalTurns > 0 ? Math.round((totalInput + totalRead + totalWrite) / totalTurns) : 0,
      cache_read: totalRead,
      cache_write: totalWrite,
      output: sum("output"),
      thinking: sum("thinking"),
      cost_usd: Number(sum("cost").toFixed(6)),
    },
    flags: allFlags,
  };
}

function buildRunEnvelope({ runId, dataDir, outputPath, workflow, exitCode, stdout, stderr, dryRun = false }) {
  const scrubbedStdout = redactSecrets(stdout ?? "").text;
  const scrubbedStderr = redactSecrets(stderr ?? "").text;

  if (dryRun) {
    return {
      ok: exitCode === EXIT.OK,
      run_id: runId,
      data_dir: dataDir,
      output_path: outputPath,
      exit_code: exitCode,
      status: EXIT_STATUS[exitCode] ?? "error",
      phase: null,
      failed_stage: null,
      pending_questions: [],
      cost_summary: null,
      stdout: scrubbedStdout,
      stderr: scrubbedStderr,
    };
  }

  let phase = null;
  let failedStage = null;
  let pendingQuestions = [];
  let costSummary = null;

  try {
    const st = readState(dataDir);
    phase = st.state?.phase ?? null;
  } catch {
    /* DB may not exist on early exit 2 */
  }
  try {
    const stages = readStages(dataDir, { workflow });
    const failed = stages.stage_runs.find((s) => s.status === "failed");
    const active = stages.stage_runs.find((s) => s.status === "active");
    failedStage = failed?.stage ?? (exitCode !== EXIT.OK ? active?.stage ?? null : null);
  } catch {
    /* DB may not exist on early exit 2 */
  }
  try {
    const qs = readQuestions(dataDir, { status: "pending" });
    pendingQuestions = qs.questions ?? [];
  } catch {
    /* DB may not exist */
  }
  try {
    costSummary = computeCostSummary(dataDir);
  } catch {
    /* no transcripts */
  }

  return {
    ok: exitCode === EXIT.OK,
    run_id: runId,
    data_dir: dataDir,
    output_path: outputPath,
    exit_code: exitCode,
    status: EXIT_STATUS[exitCode] ?? "error",
    phase,
    failed_stage: failedStage,
    pending_questions: pendingQuestions,
    cost_summary: costSummary,
    stdout: scrubbedStdout,
    stderr: scrubbedStderr,
  };
}

const SAFE_WORKFLOW_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeWorkflow(value, label = "workflow") {
  if (!value || typeof value !== "string" || !SAFE_WORKFLOW_RE.test(value)) {
    throw new UsageError(`${label} must match [A-Za-z0-9_-]+`);
  }
  return value;
}

function assertSafeIdentifier(value, label) {
  if (!value || typeof value !== "string" || value.startsWith("-") || value.includes("..") || !SAFE_ID_RE.test(value)) {
    throw new UsageError(`${label} contains invalid characters`);
  }
  return value;
}

function assertNoLeadingDash(value, label) {
  const s = String(value);
  if (s.startsWith("-")) {
    throw new UsageError(`${label} must not start with "-"`);
  }
  return s;
}

function resolveOptionalPath(value, allowedRoots, label) {
  if (!value) return undefined;
  return assertAllowedPath(value, allowedRoots, label);
}

function resolveRepoRoot(explicitRepoRoot, metaRepoRoot, allowedRoots) {
  const raw = explicitRepoRoot ?? metaRepoRoot ?? null;
  if (raw) return assertAllowedPath(raw, allowedRoots, "repo_root");
  if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
    throw new UsageError("repo_root is required when workspace root allowlist is configured");
  }
  return OWN_REPO_ROOT;
}

/**
 * Constrain file-backed `goal` or `goal_file` so `runner.mjs` (`existsSync(flags.goal)`)
 * can never read files outside `allowedRoots` or traverse symlinks.
 */
function resolveGoalArg(params, effectiveRepoRoot, allowedRoots) {
  if (params.goal_file !== undefined) {
    if (typeof params.goal_file !== "string" || !params.goal_file.trim()) {
      throw new UsageError("goal_file must be a non-empty string");
    }
    const candidate = isAbsolute(params.goal_file)
      ? params.goal_file
      : resolve(effectiveRepoRoot, params.goal_file);
    const safePath = assertAllowedPath(candidate, allowedRoots, "goal_file");
    let lst;
    try {
      lst = lstatSync(safePath);
    } catch {
      throw new UsageError(`goal_file not found: "${params.goal_file}"`);
    }
    if (lst.isSymbolicLink() || !statSync(safePath).isFile()) {
      throw new UsageError(`goal_file "${params.goal_file}" must be a regular file inside allowedRoots`);
    }
    return safePath;
  }

  if (!params.goal || typeof params.goal !== "string") {
    throw new UsageError("goal is required");
  }
  const goalStr = params.goal;
  if (goalStr.startsWith("--")) {
    throw new UsageError('goal cannot start with "--" (pass literal text not starting with --, or use goal_file)');
  }
  const candidate = isAbsolute(goalStr) ? goalStr : resolve(effectiveRepoRoot, goalStr);
  const looksLikePath = isAbsolute(goalStr) || goalStr.startsWith("./") || goalStr.startsWith("../") || goalStr.includes("/../");
  if (Array.isArray(allowedRoots) && allowedRoots.length > 0 && looksLikePath) {
    // Validate BEFORE any filesystem stat so non-existent paths outside allowlist don't probe host FS.
    assertAllowedPath(candidate, allowedRoots, "goal");
  }

  let lst = null;
  try {
    lst = lstatSync(candidate);
  } catch {
    lst = null;
  }
  if (lst) {
    const safePath = assertAllowedPath(candidate, allowedRoots, "goal");
    if (lst.isSymbolicLink() || !statSync(safePath).isFile()) {
      throw new UsageError(`goal path "${goalStr}" must reference a regular file inside allowedRoots`);
    }
    return safePath;
  }
  return goalStr;
}

/**
 * uaw_run — Invoke `runner.mjs run`, persisting durable `run_id` and `output_path`
 * and enforcing out-of-tree output_path ownership.
 */
export async function cmdRun(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);
  const dryRun = params.dry_run === true;
  const force = params.force === true;

  const workflow = assertSafeWorkflow(params.workflow, "workflow");

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = target.dataDir;
  const existingMeta = target.meta;
  const runId = force && !params.run_id && !params.from_stage
    ? generateRunId(workflow)
    : (existingMeta?.run_id ?? params.run_id ?? generateRunId(workflow));
  const rawOutputPath = params.output_path ?? existingMeta?.output_path ?? defaultOutputPath(dataDir);
  const outputPath = assertAllowedPath(rawOutputPath, allowedRoots, "output_path");
  const repoRoot = resolveRepoRoot(params.repo_root, existingMeta?.repo_root, allowedRoots);
  const skillsRoot = resolveOptionalPath(params.skills_root ?? existingMeta?.skills_root, allowedRoots, "skills_root");
  const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");
  const goalArg = resolveGoalArg(params, repoRoot, allowedRoots);

  const args = [
    "run",
    "--workflow",
    workflow,
    "--goal",
    goalArg,
    "--data-dir",
    dataDir,
    "--output-path",
    outputPath,
  ];
  if (params.adapter) args.push("--adapter", assertSafeIdentifier(params.adapter, "adapter"));
  if (params.model) args.push("--model", assertNoLeadingDash(params.model, "model"));
  if (params.from_stage) args.push("--from-stage", assertSafeIdentifier(params.from_stage, "from_stage"));
  if (force) args.push("--force");
  if (params.unlock === true) args.push("--unlock");
  if (params.non_interactive === true) args.push("--non-interactive");
  if (dryRun) args.push("--dry-run");
  if (params.timeout_ms !== undefined) args.push("--timeout-ms", assertNoLeadingDash(params.timeout_ms, "timeout_ms"));
  if (params.repo_root || (Array.isArray(allowedRoots) && allowedRoots.length > 0)) {
    args.push("--repo-root", repoRoot);
  }
  if (skillsRoot) args.push("--skills-root", skillsRoot);
  if (params.max_cost_usd !== undefined) args.push("--max-cost-usd", assertNoLeadingDash(params.max_cost_usd, "max_cost_usd"));
  if (params.resume_max_context !== undefined) {
    args.push("--resume-max-context", assertNoLeadingDash(params.resume_max_context, "resume_max_context"));
  }

  const env = { UAW_RUN_ID: runId };
  if (fakeFixtureDir) env.UWF_FAKE_FIXTURE_DIR = fakeFixtureDir;

  let claim = null;
  if (!dryRun) {
    assertNoActiveRunLock(dataDir);
    claim = claimOutputPath({
      outputPath,
      runId,
      dataDir,
      stateDir,
      unlock: params.unlock === true,
      force,
    });
  }

  try {
    if (!dryRun) {
      const preserved = existingMeta && !force ? existingMeta : {};
      const meta = {
        ...preserved,
        run_id: runId,
        workflow,
        data_dir: dataDir,
        output_path: outputPath,
        repo_root: repoRoot,
        skills_root: skillsRoot ?? preserved.skills_root ?? null,
        created_at: !force && existingMeta?.created_at ? existingMeta.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      writeRunMeta(dataDir, meta);
      registerRunIndex(stateDir, meta);
    }

    const res = await execNodeAsync(RUNNER_CLI, args, {
      cwd: repoRoot,
      env,
    });

    return buildRunEnvelope({
      runId,
      dataDir,
      outputPath,
      workflow,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      dryRun,
    });
  } finally {
    claim?.release();
  }
}

/**
 * uaw_resume — Reload durable `run_id` and `output_path` from `<data-dir>/run-meta.json`
 * (or `uwf-state.db`) and invoke `runner.mjs resume`.
 */
export async function cmdResume(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: true,
  });

  const dataDir = target.dataDir;
  const meta = target.meta ?? readRunMeta(dataDir);
  let stateFallback = null;
  try {
    stateFallback = readState(dataDir);
  } catch {
    /* ignore */
  }

  const rawWorkflow = params.workflow ?? meta?.workflow;
  const workflow = assertSafeWorkflow(rawWorkflow, "workflow");

  const runId = meta?.run_id ?? params.run_id ?? generateRunId(workflow);
  const persistedOutput =
    params.output_path ??
    meta?.output_path ??
    stateFallback?.state?.artifact_path ??
    defaultOutputPath(dataDir);
  const outputPath = assertAllowedPath(persistedOutput, allowedRoots, "output_path");
  const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );
  const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");

  const args = [
    "resume",
    "--workflow",
    workflow,
    "--data-dir",
    dataDir,
    "--output-path",
    outputPath,
  ];
  if (params.adapter) args.push("--adapter", assertSafeIdentifier(params.adapter, "adapter"));
  if (params.model) args.push("--model", assertNoLeadingDash(params.model, "model"));
  if (params.unlock === true) args.push("--unlock");
  if (params.non_interactive === true) args.push("--non-interactive");
  if (params.timeout_ms !== undefined) args.push("--timeout-ms", assertNoLeadingDash(params.timeout_ms, "timeout_ms"));
  if (params.repo_root || meta?.repo_root || (Array.isArray(allowedRoots) && allowedRoots.length > 0)) {
    args.push("--repo-root", repoRoot);
  }
  if (skillsRoot) args.push("--skills-root", skillsRoot);
  if (params.max_cost_usd !== undefined) args.push("--max-cost-usd", assertNoLeadingDash(params.max_cost_usd, "max_cost_usd"));
  if (params.resume_max_context !== undefined) {
    args.push("--resume-max-context", assertNoLeadingDash(params.resume_max_context, "resume_max_context"));
  }

  const env = { UAW_RUN_ID: runId };
  if (fakeFixtureDir) env.UWF_FAKE_FIXTURE_DIR = fakeFixtureDir;

  const claim = claimOutputPath({
    outputPath,
    runId,
    dataDir,
    stateDir,
    unlock: params.unlock === true,
  });

  try {
    const res = await execNodeAsync(RUNNER_CLI, args, {
      cwd: repoRoot,
      env,
    });
    return buildRunEnvelope({
      runId,
      dataDir,
      outputPath,
      workflow,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  } finally {
    claim.release();
  }
}

/**
 * uaw_gates — Evaluate gate checks or list gate prescriptions/stages without advancing state.
 */
export async function cmdGates(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);

  let dataDir = null;
  let runId = params.run_id ?? null;
  let meta = null;
  if (params.run_id || params.data_dir) {
    const target = resolveRunTarget({
      run_id: params.run_id,
      data_dir: params.data_dir,
      stateDir,
      allowedRoots,
      requireExisting: false,
    });
    dataDir = target.dataDir;
    runId = target.runId;
    meta = target.meta;
  }

  const workflow = assertSafeWorkflow(params.workflow ?? meta?.workflow, "workflow");

  const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );
  const outputPath = params.output_path
    ? assertAllowedPath(params.output_path, allowedRoots, "output_path")
    : meta?.output_path ?? (dataDir ? defaultOutputPath(dataDir) : undefined);

  const mode = params.mode ?? (params.stage ? "check" : "prescriptions");
  const env = {};
  if (skillsRoot) env.UWF_SKILLS_ROOT = skillsRoot;

  if (mode === "list") {
    const scratch = mkdtempSync(join(tmpdir(), "uaw-mcp-gates-"));
    try {
      const args = ["list-stages", "--workflow", workflow, "--data-dir", scratch];
      if (outputPath) args.push("--output-path", outputPath);
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot, env });
      return redactDeep({
        ok: res.code === 0,
        exit_code: res.code,
        mode: "list",
        workflow,
        stages: Array.isArray(res.json) ? res.json : [],
        error: res.code === 0 ? null : (res.stderr || res.stdout).trim(),
      }).value;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (mode === "check") {
    if (!params.stage) throw new UsageError("stage is required for mode=check");
    const safeStage = assertSafeIdentifier(params.stage, "stage");
    // Use a scratch DB path so checking gates never mutates uwf-stages.db
    const scratch = mkdtempSync(join(tmpdir(), "uaw-mcp-gate-check-"));
    try {
      const dbPath = join(scratch, "uwf-stages.db");
      const args = [
        "check-gate",
        "--workflow",
        workflow,
        "--stage",
        safeStage,
        "--db-path",
        dbPath,
      ];
      if (dataDir) args.push("--data-dir", dataDir);
      if (outputPath) args.push("--output-path", outputPath);
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      const res = await execNodeAsync(TRACKER_CLI, args, {
        cwd: repoRoot,
        env: { ...env, ...(dataDir ? { UWF_DATA_DIR: dataDir } : {}) },
      });
      return redactDeep({
        ok: res.code === 0,
        exit_code: res.code,
        mode: "check",
        run_id: runId,
        workflow,
        stage: safeStage,
        gate: res.json,
        error: res.code === 0 ? null : res.json?.failures?.join("; ") || res.stderr.trim() || null,
      }).value;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // Default: prescriptions audit via stage-tracker.mjs gate-prescriptions
  const scratch = mkdtempSync(join(tmpdir(), "uaw-mcp-prescriptions-"));
  try {
    const args = [
      "gate-prescriptions",
      "--workflow",
      workflow,
      "--output-path",
      outputPath ?? "<output_path>",
      "--data-dir",
      scratch,
    ];
    if (skillsRoot) args.push("--skills-root", skillsRoot);
    const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot, env });
    return redactDeep({
      ok: res.code === 0,
      exit_code: res.code,
      mode: "prescriptions",
      workflow,
      stages: res.json?.stages ?? [],
      error: res.code === 0 ? null : (res.stderr || res.stdout).trim(),
    }).value;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * uaw_cost — Parse `<data-dir>/transcripts/*.json` via `cost.mjs`.
 */
export async function cmdCost(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);
  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: true,
  });

  const dataDir = target.dataDir;
  const meta = target.meta;
  const workflow = params.workflow ?? meta?.workflow;
  if (workflow) assertSafeWorkflow(workflow, "workflow");
  const repoRoot = params.repo_root || meta?.repo_root
    ? resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots)
    : OWN_REPO_ROOT;
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );
  const outputPath = params.output_path
    ? assertAllowedPath(params.output_path, allowedRoots, "output_path")
    : meta?.output_path ?? defaultOutputPath(dataDir);

  const summary = computeCostSummary(dataDir);
  let report = null;
  if (summary.stages.length > 0) {
    try {
      report = await costReport({
        dataDir,
        workflow,
        repoRoot,
        skillsRoot,
        outputPath,
      });
    } catch {
      report = null;
    }
  }

  return redactDeep({
    ok: true,
    exit_code: EXIT.OK,
    run_id: target.runId,
    data_dir: dataDir,
    ...summary,
    report,
  }).value;
}

/**
 * uaw_stage_transition — Execute explicit state.mjs or stage-tracker.mjs transitions,
 * refusing mutation with exit code 2 if an active `run.lock` is held.
 */
export async function cmdStageTransition(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);

  const scope = params.target;
  const action = params.action;
  if (scope !== "state" && scope !== "stage") {
    throw new UsageError('target must be "state" or "stage"');
  }
  if (scope === "state" && !STATE_ACTIONS.has(action)) {
    throw new UsageError(
      `Invalid state action "${action}". Expected one of: ${[...STATE_ACTIONS].join(", ")}`,
    );
  }
  if (scope === "stage" && !STAGE_ACTIONS.has(action)) {
    throw new UsageError(
      `Invalid stage action "${action}". Expected one of: ${[...STAGE_ACTIONS].join(", ")}`,
    );
  }

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = target.dataDir;
  const meta = target.meta;
  const workflow = scope === "stage"
    ? assertSafeWorkflow(params.workflow ?? meta?.workflow, "workflow")
    : (params.workflow ? assertSafeWorkflow(params.workflow, "workflow") : meta?.workflow ?? null);
  const runId = target.runId ?? generateRunId(workflow ?? "uaw");
  const outputPath = assertAllowedPath(
    params.output_path ?? meta?.output_path ?? defaultOutputPath(dataDir),
    allowedRoots,
    "output_path",
  );
  const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );

  // Enforce single-writer lock & cross-run output ownership invariants (ADR-0008).
  assertNoActiveRunLock(dataDir);
  const claim = claimOutputPath({
    outputPath,
    runId,
    dataDir,
    stateDir,
    unlock: params.unlock === true,
  });

  const common = ["--data-dir", dataDir, "--output-path", outputPath];
  const env = { UWF_DATA_DIR: dataDir, ...(skillsRoot ? { UWF_SKILLS_ROOT: skillsRoot } : {}) };

  try {
    if (!meta) {
      const createdMeta = {
        run_id: runId,
        workflow,
        data_dir: dataDir,
        output_path: outputPath,
        repo_root: repoRoot,
        skills_root: skillsRoot ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      writeRunMeta(dataDir, createdMeta);
      registerRunIndex(stateDir, createdMeta);
    }

    if (scope === "state") {
      const args = [action];
      if (params.mode) args.push("--mode", assertNoLeadingDash(params.mode, "mode"));
      if (params.to) args.push("--to", assertSafeIdentifier(params.to, "to"));
      if (params.agent) args.push("--agent", assertNoLeadingDash(params.agent, "agent"));
      if (params.note) args.push("--note", assertNoLeadingDash(params.note, "note"));
      if (params.phases) {
        const phasesVal = Array.isArray(params.phases) ? params.phases.join(",") : String(params.phases);
        args.push("--phases", assertNoLeadingDash(phasesVal, "phases"));
      }
      if (params.status) args.push("--status", assertSafeIdentifier(params.status, "status"));
      if (params.profile) args.push("--profile", assertSafeIdentifier(params.profile, "profile"));
      if (params.model) args.push("--model", assertNoLeadingDash(params.model, "model"));
      if (params.force === true) args.push("--force");
      args.push(...common);

      const res = await execNodeAsync(STATE_CLI, args, { cwd: repoRoot, env });
      return redactDeep({
        ok: res.code === 0 && res.json?.ok !== false,
        exit_code: res.code,
        run_id: runId,
        data_dir: dataDir,
        target: "state",
        action,
        result: res.json,
        error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
      }).value;
    }

    // scope === "stage"
    const args = [action, "--workflow", workflow];
    if (params.stage) args.push("--stage", assertSafeIdentifier(params.stage, "stage"));
    if (params.note) args.push("--note", assertNoLeadingDash(params.note, "note"));
    if (params.session_id) args.push("--session-id", assertNoLeadingDash(params.session_id, "session_id"));
    if (skillsRoot) args.push("--skills-root", skillsRoot);
    args.push(...common);

    const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot, env });
    return redactDeep({
      ok: res.code === 0 && res.json?.ok !== false,
      exit_code: res.code,
      run_id: runId,
      data_dir: dataDir,
      target: "stage",
      action,
      result: res.json,
      error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
    }).value;
  } finally {
    claim.release();
  }
}

/**
 * uaw_question_resolve — Wrap `questions.mjs` (`list`, `check`, `answer`, `skip`)
 * so any host surface can resolve exit-3 QUESTIONS pauses and call `uaw_resume`.
 */
export async function cmdQuestionResolve(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);
  const action = params.action;

  if (!QUESTION_ACTIONS.has(action)) {
    throw new UsageError(
      `Invalid question action "${action}". Expected one of: ${[...QUESTION_ACTIONS].join(", ")}`,
    );
  }

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });
  const dataDir = target.dataDir;

  if (action === "answer" || action === "skip") {
    assertNoActiveRunLock(dataDir);
  }

  const args = [action, "--data-dir", dataDir];
  if (params.stage) args.push("--stage", assertSafeIdentifier(params.stage, "stage"));
  if (params.status) args.push("--status", assertSafeIdentifier(params.status, "status"));
  if (params.id !== undefined) args.push("--id", assertNoLeadingDash(params.id, "id"));
  if (params.ids !== undefined) {
    const idsVal = Array.isArray(params.ids) ? params.ids.join(",") : String(params.ids);
    args.push("--ids", assertNoLeadingDash(idsVal, "ids"));
  }
  if (params.answer !== undefined) args.push("--answer", assertNoLeadingDash(params.answer, "answer"));

  const res = await execNodeAsync(QUESTIONS_CLI, args, {
    cwd: OWN_REPO_ROOT,
    env: { UWF_DATA_DIR: dataDir },
  });

  return redactDeep({
    ok: res.code === 0 && res.json?.ok !== false,
    exit_code: res.code,
    run_id: target.runId,
    data_dir: dataDir,
    action,
    result: res.json,
    error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || null,
  }).value;
}
