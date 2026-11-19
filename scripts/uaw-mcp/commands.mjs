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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
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

function resolveOptionalPath(value, allowedRoots, label) {
  if (!value) return undefined;
  return assertAllowedPath(value, allowedRoots, label);
}

/**
 * uaw_run — Invoke `runner.mjs run`, persisting durable `run_id` and `output_path`
 * and enforcing out-of-tree output_path ownership.
 */
export async function cmdRun(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);
  const dryRun = params.dry_run === true;

  if (!params.workflow || typeof params.workflow !== "string") {
    throw new UsageError("workflow is required");
  }
  if (!params.goal || typeof params.goal !== "string") {
    throw new UsageError("goal is required");
  }

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = target.dataDir;
  const existingMeta = target.meta;
  const runId = existingMeta?.run_id ?? params.run_id ?? generateRunId(params.workflow);
  const rawOutputPath = params.output_path ?? existingMeta?.output_path ?? defaultOutputPath(dataDir);
  const outputPath = assertAllowedPath(rawOutputPath, allowedRoots, "output_path");
  const repoRoot = resolveOptionalPath(params.repo_root, allowedRoots, "repo_root");
  const skillsRoot = resolveOptionalPath(params.skills_root, allowedRoots, "skills_root");
  const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");

  const args = [
    "run",
    "--workflow",
    params.workflow,
    "--goal",
    params.goal,
    "--data-dir",
    dataDir,
    "--output-path",
    outputPath,
  ];
  if (params.adapter) args.push("--adapter", String(params.adapter));
  if (params.model) args.push("--model", String(params.model));
  if (params.from_stage) args.push("--from-stage", String(params.from_stage));
  if (params.force === true) args.push("--force");
  if (params.unlock === true) args.push("--unlock");
  if (params.non_interactive === true) args.push("--non-interactive");
  if (dryRun) args.push("--dry-run");
  if (params.timeout_ms !== undefined) args.push("--timeout-ms", String(params.timeout_ms));
  if (repoRoot) args.push("--repo-root", repoRoot);
  if (skillsRoot) args.push("--skills-root", skillsRoot);
  if (params.max_cost_usd !== undefined) args.push("--max-cost-usd", String(params.max_cost_usd));
  if (params.resume_max_context !== undefined) {
    args.push("--resume-max-context", String(params.resume_max_context));
  }

  const env = {};
  if (fakeFixtureDir) env.UWF_FAKE_FIXTURE_DIR = fakeFixtureDir;

  let claim = null;
  if (!dryRun) {
    claim = claimOutputPath({
      outputPath,
      runId,
      dataDir,
      stateDir,
      unlock: params.unlock === true,
    });
  }

  try {
    if (!dryRun) {
      const meta = {
        run_id: runId,
        workflow: params.workflow,
        data_dir: dataDir,
        output_path: outputPath,
        repo_root: repoRoot ?? existingMeta?.repo_root ?? null,
        skills_root: skillsRoot ?? existingMeta?.skills_root ?? null,
        created_at: existingMeta?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      writeRunMeta(dataDir, meta);
      registerRunIndex(stateDir, meta);
    }

    const res = await execNodeAsync(RUNNER_CLI, args, {
      cwd: repoRoot ?? OWN_REPO_ROOT,
      env,
    });

    return buildRunEnvelope({
      runId,
      dataDir,
      outputPath,
      workflow: params.workflow,
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

  const workflow = params.workflow ?? meta?.workflow;
  if (!workflow || typeof workflow !== "string") {
    throw new UsageError("workflow is required (not found in run-meta.json)");
  }

  const runId = meta?.run_id ?? params.run_id ?? generateRunId(workflow);
  const persistedOutput =
    params.output_path ??
    meta?.output_path ??
    stateFallback?.state?.artifact_path ??
    defaultOutputPath(dataDir);
  const outputPath = assertAllowedPath(persistedOutput, allowedRoots, "output_path");
  const repoRoot = resolveOptionalPath(params.repo_root ?? meta?.repo_root, allowedRoots, "repo_root");
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );
  const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");

  const claim = claimOutputPath({
    outputPath,
    runId,
    dataDir,
    stateDir,
    unlock: params.unlock === true,
  });

  const args = [
    "resume",
    "--workflow",
    workflow,
    "--data-dir",
    dataDir,
    "--output-path",
    outputPath,
  ];
  if (params.adapter) args.push("--adapter", String(params.adapter));
  if (params.model) args.push("--model", String(params.model));
  if (params.unlock === true) args.push("--unlock");
  if (params.non_interactive === true) args.push("--non-interactive");
  if (params.timeout_ms !== undefined) args.push("--timeout-ms", String(params.timeout_ms));
  if (repoRoot) args.push("--repo-root", repoRoot);
  if (skillsRoot) args.push("--skills-root", skillsRoot);
  if (params.max_cost_usd !== undefined) args.push("--max-cost-usd", String(params.max_cost_usd));
  if (params.resume_max_context !== undefined) {
    args.push("--resume-max-context", String(params.resume_max_context));
  }

  const env = {};
  if (fakeFixtureDir) env.UWF_FAKE_FIXTURE_DIR = fakeFixtureDir;

  try {
    const res = await execNodeAsync(RUNNER_CLI, args, {
      cwd: repoRoot ?? OWN_REPO_ROOT,
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

  const workflow = params.workflow ?? meta?.workflow;
  if (!workflow || typeof workflow !== "string") {
    throw new UsageError("workflow is required");
  }

  const repoRoot = resolveOptionalPath(params.repo_root ?? meta?.repo_root, allowedRoots, "repo_root");
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
      const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot ?? OWN_REPO_ROOT, env });
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
    // Use a scratch DB path so checking gates never mutates uwf-stages.db
    const scratch = mkdtempSync(join(tmpdir(), "uaw-mcp-gate-check-"));
    try {
      const dbPath = join(scratch, "uwf-stages.db");
      const args = [
        "check-gate",
        "--workflow",
        workflow,
        "--stage",
        params.stage,
        "--db-path",
        dbPath,
      ];
      if (dataDir) args.push("--data-dir", dataDir);
      if (outputPath) args.push("--output-path", outputPath);
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      const res = await execNodeAsync(TRACKER_CLI, args, {
        cwd: repoRoot ?? OWN_REPO_ROOT,
        env: { ...env, ...(dataDir ? { UWF_DATA_DIR: dataDir } : {}) },
      });
      return redactDeep({
        ok: res.code === 0,
        exit_code: res.code,
        mode: "check",
        run_id: runId,
        workflow,
        stage: params.stage,
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
    const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot ?? OWN_REPO_ROOT, env });
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
  const repoRoot = resolveOptionalPath(params.repo_root ?? meta?.repo_root, allowedRoots, "repo_root");
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
        repoRoot: repoRoot ?? OWN_REPO_ROOT,
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

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = target.dataDir;
  const meta = target.meta;
  const outputPath = assertAllowedPath(
    params.output_path ?? meta?.output_path ?? defaultOutputPath(dataDir),
    allowedRoots,
    "output_path",
  );
  const repoRoot = resolveOptionalPath(params.repo_root ?? meta?.repo_root, allowedRoots, "repo_root");
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );

  // Enforce single-writer lock invariant (ADR-0008): refuse mutation with code 2 if run.lock is active
  assertNoActiveRunLock(dataDir);

  const scope = params.target;
  const action = params.action;
  if (scope !== "state" && scope !== "stage") {
    throw new UsageError('target must be "state" or "stage"');
  }

  const common = ["--data-dir", dataDir, "--output-path", outputPath];
  const env = { UWF_DATA_DIR: dataDir, ...(skillsRoot ? { UWF_SKILLS_ROOT: skillsRoot } : {}) };

  if (scope === "state") {
    if (!STATE_ACTIONS.has(action)) {
      throw new UsageError(
        `Invalid state action "${action}". Expected one of: ${[...STATE_ACTIONS].join(", ")}`,
      );
    }
    const args = [action];
    if (params.mode) args.push("--mode", String(params.mode));
    if (params.to) args.push("--to", String(params.to));
    if (params.agent) args.push("--agent", String(params.agent));
    if (params.note) args.push("--note", String(params.note));
    if (params.phases) {
      args.push("--phases", Array.isArray(params.phases) ? params.phases.join(",") : String(params.phases));
    }
    if (params.status) args.push("--status", String(params.status));
    if (params.profile) args.push("--profile", String(params.profile));
    if (params.model) args.push("--model", String(params.model));
    if (params.force === true) args.push("--force");
    args.push(...common);

    const res = await execNodeAsync(STATE_CLI, args, { cwd: repoRoot ?? OWN_REPO_ROOT, env });
    return redactDeep({
      ok: res.code === 0 && res.json?.ok !== false,
      exit_code: res.code,
      run_id: target.runId,
      data_dir: dataDir,
      target: "state",
      action,
      result: res.json,
      error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
    }).value;
  }

  // scope === "stage"
  if (!STAGE_ACTIONS.has(action)) {
    throw new UsageError(
      `Invalid stage action "${action}". Expected one of: ${[...STAGE_ACTIONS].join(", ")}`,
    );
  }
  const workflow = params.workflow ?? meta?.workflow;
  if (!workflow) throw new UsageError("workflow is required for stage transitions");

  const args = [action, "--workflow", workflow];
  if (params.stage) args.push("--stage", String(params.stage));
  if (params.note) args.push("--note", String(params.note));
  if (params.session_id) args.push("--session-id", String(params.session_id));
  if (skillsRoot) args.push("--skills-root", skillsRoot);
  args.push(...common);

  const res = await execNodeAsync(TRACKER_CLI, args, { cwd: repoRoot ?? OWN_REPO_ROOT, env });
  return redactDeep({
    ok: res.code === 0 && res.json?.ok !== false,
    exit_code: res.code,
    run_id: target.runId,
    data_dir: dataDir,
    target: "stage",
    action,
    result: res.json,
    error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
  }).value;
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
  if (params.stage) args.push("--stage", String(params.stage));
  if (params.status) args.push("--status", String(params.status));
  if (params.id !== undefined) args.push("--id", String(params.id));
  if (params.ids !== undefined) {
    args.push("--ids", Array.isArray(params.ids) ? params.ids.join(",") : String(params.ids));
  }
  if (params.answer !== undefined) args.push("--answer", String(params.answer));

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
