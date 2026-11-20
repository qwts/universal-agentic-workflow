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
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../hooks/secret-patterns.mjs";
import { costReport, transcriptRow } from "../uwf-runner/cost.mjs";
import { PromptError, validateWorkflowStageInputs } from "../uwf-runner/prompt.mjs";
import { assertNoActiveRunLock, claimDataDirLock, claimOutputPath } from "./ownership.mjs";
import {
  assertAllowedPath,
  assertRegularFileInDir,
  assertSafeDataDir,
  assertSafeRegularTree,
  assertSafeSkillDbs,
  canonicalPathKey,
  defaultOutputPath,
  generateRunId,
  pruneSupersededRunIndices,
  readRegularFileBounded,
  readRunMeta,
  registerRunIndex,
  resolveRunTarget,
  resolveUawStateDir,
  UsageError,
  writeRunMeta,
} from "./paths.mjs";
import { queryQuestionsAction, redactDeep, readQuestions, readStages, readState } from "./store.mjs";

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
  INTERNAL: 70,
});

export const EXIT_STATUS = Object.freeze({
  0: "ok",
  1: "gate_blocked",
  2: "usage_error",
  3: "questions_pending",
  4: "cost_cap_exceeded",
  70: "internal_error",
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

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const DEFAULT_METADATA_CLI_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_CLI_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_STAGE_TIMEOUT_MS = DEFAULT_RUN_CLI_TIMEOUT_MS - 60_000;

const STRIPPED_ENV_KEYS = new Set([
  "UWF_BOT_TOKEN",
  "UWF_DATA_DIR",
  "UWF_SKILLS_ROOT",
  "UWF_FAKE_FIXTURE_DIR",
  "UWF_FAKE_FIXTURE",
  "UAW_RUN_ID",
  "UAW_STATE_DIR",
  "UAW_RUNS_DIR",
]);

const activeChildren = new Set();
const inFlightMutations = new Set();

async function withTrackedMutation(fn) {
  const p = Promise.resolve().then(fn);
  inFlightMutations.add(p);
  try {
    return await p;
  } finally {
    inFlightMutations.delete(p);
  }
}

/**
 * Terminate any active child CLIs and their POSIX process groups on server shutdown/signal.
 */
export function terminateActiveChildren(sig = "SIGTERM") {
  for (const entry of activeChildren) {
    try { entry.killTree(sig); } catch { /* ignore */ }
  }
}

/**
 * Gracefully terminate active children (`SIGTERM` -> wait -> `SIGKILL`) and wait briefly
 * for in-flight lock-holding mutations to finish their rollback / lock release cleanup.
 */
export async function drainActiveChildren({ graceMs = 1_500 } = {}) {
  for (const entry of activeChildren) {
    try {
      entry.terminate("MCP server shutting down");
    } catch {
      /* ignore */
    }
  }
  const pending = () => [
    ...Array.from(activeChildren, (c) => c.promise),
    ...inFlightMutations,
  ];
  if (pending().length > 0) {
    await Promise.race([
      Promise.allSettled(pending()),
      new Promise((r) => setTimeout(r, graceMs)),
    ]);
  }
  for (const entry of [...activeChildren]) {
    try {
      entry.killTree("SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      entry.forceSettle();
    } catch {
      /* ignore */
    }
  }
  if (inFlightMutations.size > 0) {
    await Promise.race([
      Promise.allSettled([...inFlightMutations]),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

process.once("exit", () => terminateActiveChildren("SIGKILL"));

/**
 * Spawn a Node CLI script asynchronously (no shell), isolating server secrets and per-run env vars,
 * bounding buffered output, and enforcing optional timeouts so locks cannot wedge indefinitely.
 * Returns `{ code, stdout, stderr, json, spawnError }`.
 */
export function execNodeAsync(scriptPath, args, { cwd, env, maxBytes = MAX_CHILD_OUTPUT_BYTES, timeoutMs = 0 } = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (!upper.startsWith("UAW_MCP_") && !STRIPPED_ENV_KEYS.has(upper)) {
      childEnv[k] = v;
    }
  }
  Object.assign(childEnv, env);
  const useProcessGroup = process.platform !== "win32";
  let entry = null;
  const promise = new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: cwd ?? OWN_REPO_ROOT,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: useProcessGroup,
      });
    } catch (err) {
      resolvePromise({
        code: EXIT.INTERNAL,
        stdout: "",
        stderr: err.message,
        json: null,
        spawnError: true,
      });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let totalBytes = 0;
    let settled = false;
    let abortedReason = null;
    let killTimer = null;
    let forceKillTimer = null;
    let unstickTimer = null;

    const killTree = (sig) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          /* fall back to direct child signal */
        }
      }
      try { child.kill(sig); } catch { /* ignore */ }
    };

    const clearAllTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (unstickTimer) clearTimeout(unstickTimer);
    };

    const finishExec = (code, { spawnError = false, spawnErrMsg = "" } = {}) => {
      if (settled) return;
      settled = true;
      if (entry) activeChildren.delete(entry);
      clearAllTimers();
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, abortedReason || spawnError ? "SIGKILL" : "SIGTERM");
        } catch {
          /* process group already exited */
        }
      }
      const stdout = spawnError ? "" : Buffer.concat(outChunks).toString("utf8");
      let stderr = spawnError ? spawnErrMsg : Buffer.concat(errChunks).toString("utf8");
      if (abortedReason && !spawnError) {
        stderr = stderr ? `${stderr}\n${abortedReason}` : abortedReason;
      }
      let json = null;
      if (!spawnError) {
        try {
          json = JSON.parse(stdout);
        } catch {
          /* non-JSON CLI output */
        }
      }
      resolvePromise({
        code: abortedReason || spawnError || typeof code !== "number" ? EXIT.INTERNAL : code,
        stdout,
        stderr,
        json,
        spawnError,
      });
    };

    const forceSettle = () => {
      if (!abortedReason) abortedReason = "child CLI forcibly terminated";
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      finishExec(EXIT.INTERNAL);
    };

    const terminate = (reason) => {
      if (abortedReason) return;
      abortedReason = reason;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        killTree("SIGKILL");
        unstickTimer = setTimeout(forceSettle, 500);
        unstickTimer.unref?.();
      }, 2_000);
      forceKillTimer.unref?.();
    };

    entry = { terminate, killTree, forceSettle, promise: null };
    activeChildren.add(entry);

    const boundedTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(Math.floor(timeoutMs), DEFAULT_RUN_CLI_TIMEOUT_MS)
        : 0;
    if (boundedTimeoutMs > 0) {
      killTimer = setTimeout(() => terminate(`child CLI timed out after ${boundedTimeoutMs}ms`), boundedTimeoutMs);
      killTimer.unref?.();
    }

    const pushBounded = (arr, chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        terminate(`child CLI output exceeded ${maxBytes} bytes`);
        return;
      }
      arr.push(chunk);
    };

    child.stdout.on("data", (c) => pushBounded(outChunks, c));
    child.stderr.on("data", (c) => pushBounded(errChunks, c));
    child.on("error", (err) => {
      finishExec(EXIT.INTERNAL, { spawnError: true, spawnErrMsg: err.message });
    });
    child.on("close", (code) => {
      finishExec(code);
    });
  });
  if (entry) entry.promise = promise;
  return promise;
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
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const raw = readRegularFileBounded(dir, f, { maxBytes: MAX_TRANSCRIPT_BYTES, label: f });
      if (raw === null) continue;
      const parsed = JSON.parse(raw);
      const row = transcriptRow(f, parsed);
      if (row) rows.push(row);
    } catch {
      /* ignore unreadable or oversized transcript */
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
    costSummary = redactDeep(computeCostSummary(dataDir)).value;
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

function hasRunDatabases(dir) {
  return existsSync(join(dir, "uwf-state.db")) || existsSync(join(dir, "uwf-stages.db"));
}

function cleanupFailedInitDb(dir, scope) {
  const base = scope === "state" ? "uwf-state.db" : scope === "stage" ? "uwf-stages.db" : null;
  if (!base) return;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const full = join(dir, `${base}${suffix}`);
    try {
      const lst = lstatSync(full);
      if (!lst.isSymbolicLink() && lst.isFile()) {
        rmSync(full, { force: true });
      }
    } catch {
      /* absent */
    }
  }
}

function rollbackClaimAndIndex(claim, idxReg, metaWrite = null) {
  try {
    metaWrite?.rollback?.();
  } catch {
    /* best-effort metadata rollback */
  }
  try {
    claim?.rollback?.();
  } catch {
    /* best-effort rollback */
  }
  try {
    claim?.release?.();
  } catch {
    /* best-effort lock release */
  }
  try {
    idxReg?.rollback?.();
  } catch {
    /* best-effort index rollback */
  }
}

const SAFE_WORKFLOW_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeWorkflow(value, label = "workflow") {
  if (!value || typeof value !== "string" || value.includes("\0") || !SAFE_WORKFLOW_RE.test(value)) {
    throw new UsageError(`${label} must match [A-Za-z0-9_-]+`);
  }
  return value;
}

function assertWorkflowMatchesMeta(requestedWorkflow, persistedWorkflow, toolName) {
  if (requestedWorkflow && persistedWorkflow && requestedWorkflow !== persistedWorkflow) {
    throw new UsageError(
      `${toolName} workflow "${requestedWorkflow}" does not match persisted workflow "${persistedWorkflow}"`,
    );
  }
}

function assertExistingRunDir(dataDir, toolName) {
  let lst;
  try {
    lst = lstatSync(dataDir);
  } catch {
    throw new UsageError(`No run directory found at "${dataDir}" (${toolName})`);
  }
  if (lst.isSymbolicLink() || !lst.isDirectory()) {
    throw new UsageError(`Invalid run directory at "${dataDir}" (${toolName})`);
  }
}

function assertSafeIdentifier(value, label) {
  if (
    !value ||
    typeof value !== "string" ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("\0") ||
    !SAFE_ID_RE.test(value)
  ) {
    throw new UsageError(`${label} contains invalid characters`);
  }
  return value;
}

function assertNoLeadingDash(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new UsageError(`${label} must be a string or number`);
  }
  const s = String(value);
  if (s.includes("\0")) {
    throw new UsageError(`${label} must not contain NUL bytes`);
  }
  if (s.startsWith("-")) {
    throw new UsageError(`${label} must not start with "-"`);
  }
  return s;
}

function assertBoundedTimeoutMs(value, label = "timeout_ms") {
  const raw = assertNoLeadingDash(value, label);
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > MAX_STAGE_TIMEOUT_MS) {
    throw new UsageError(`${label} must be an integer number of milliseconds between 1 and ${MAX_STAGE_TIMEOUT_MS}`);
  }
  return String(n);
}

function assertSafeStageInputsForRun({ workflow, repoRoot, skillsRoot, outputPath, dataDir }) {
  try {
    validateWorkflowStageInputs({ workflow, repoRoot, skillsRoot, outputPath, dataDir });
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err?.message ?? String(err));
  }
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
    if (typeof params.goal_file !== "string" || !params.goal_file.trim() || params.goal_file.includes("\0")) {
      throw new UsageError("goal_file must be a non-empty string without NUL bytes");
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

  if (!params.goal || typeof params.goal !== "string" || params.goal.includes("\0")) {
    throw new UsageError("goal must be a non-empty string without NUL bytes");
  }
  const goalStr = params.goal;
  if (goalStr.startsWith("-")) {
    throw new UsageError('goal cannot start with "-" (pass literal text not starting with -, or use goal_file)');
  }
  if (goalStr.split(/[\\/]/).includes("..")) {
    throw new UsageError('goal cannot contain ".." path traversal segments');
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
  if (params.adapter) assertSafeIdentifier(params.adapter, "adapter");
  if (params.model) assertNoLeadingDash(params.model, "model");
  if (params.from_stage) assertSafeIdentifier(params.from_stage, "from_stage");
  if (params.timeout_ms !== undefined) assertBoundedTimeoutMs(params.timeout_ms, "timeout_ms");
  if (params.max_cost_usd !== undefined) assertNoLeadingDash(params.max_cost_usd, "max_cost_usd");
  if (params.resume_max_context !== undefined) {
    assertNoLeadingDash(params.resume_max_context, "resume_max_context");
  }

  const initialTarget = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = initialTarget.dataDir;

  if (dryRun) {
    assertSafeDataDir(dataDir);
    const existingMeta = initialTarget.meta;
    if (!force) {
      assertWorkflowMatchesMeta(workflow, existingMeta?.workflow, "uaw_run");
    }
    const runId = force && !params.run_id && !params.from_stage
      ? generateRunId(workflow)
      : (existingMeta?.run_id ?? params.run_id ?? generateRunId(workflow));
    const rawOutputPath = params.output_path ?? existingMeta?.output_path ?? defaultOutputPath(dataDir);
    const outputPath = assertAllowedPath(rawOutputPath, allowedRoots, "output_path");
    const repoRoot = resolveRepoRoot(params.repo_root, existingMeta?.repo_root, allowedRoots);
    const skillsRoot = resolveOptionalPath(params.skills_root ?? existingMeta?.skills_root, allowedRoots, "skills_root");
    assertSafeSkillDbs(repoRoot, "repo_root");
    if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
    assertSafeStageInputsForRun({ workflow, repoRoot, skillsRoot, outputPath, dataDir });
    const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");
    if (fakeFixtureDir) assertSafeRegularTree(fakeFixtureDir, "fake_fixture_dir");
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
      "--dry-run",
    ];
    if (params.adapter) args.push("--adapter", assertSafeIdentifier(params.adapter, "adapter"));
    if (params.model) args.push("--model", assertNoLeadingDash(params.model, "model"));
    if (params.from_stage) args.push("--from-stage", assertSafeIdentifier(params.from_stage, "from_stage"));
    if (force) args.push("--force");
    if (params.unlock === true) args.push("--unlock");
    if (params.non_interactive === true) args.push("--non-interactive");
    if (params.timeout_ms !== undefined) args.push("--timeout-ms", assertBoundedTimeoutMs(params.timeout_ms, "timeout_ms"));
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
    const res = await execNodeAsync(RUNNER_CLI, args, {
      cwd: repoRoot,
      env,
      timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
    });
    return buildRunEnvelope({
      runId,
      dataDir,
      outputPath,
      workflow,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      dryRun: true,
    });
  }

  // Acquire atomic out-of-tree data_dir lock BEFORE reading/mutating metadata or claiming output_path.
  const dataLock = claimDataDirLock({
    dataDir,
    runId: params.run_id ?? initialTarget.runId ?? "run",
    stateDir,
    unlock: params.unlock === true,
  });
  let claim = null;
  return await withTrackedMutation(async () => {
    try {
    assertSafeDataDir(dataDir);
    assertNoActiveRunLock(dataDir);
    const lockedTarget = resolveRunTarget({
      run_id: params.run_id,
      data_dir: dataDir,
      stateDir,
      allowedRoots,
      requireExisting: false,
    });
    const existingMeta = lockedTarget.meta;
    if (!force) {
      assertWorkflowMatchesMeta(workflow, existingMeta?.workflow, "uaw_run");
    }
    const runId = force && !params.run_id && !params.from_stage
      ? generateRunId(workflow)
      : (existingMeta?.run_id ?? params.run_id ?? generateRunId(workflow));
    const rawOutputPath = params.output_path ?? existingMeta?.output_path ?? defaultOutputPath(dataDir);
    const outputPath = assertAllowedPath(rawOutputPath, allowedRoots, "output_path");
    if (!force && existingMeta?.output_path) {
      const persistedOut = assertAllowedPath(existingMeta.output_path, allowedRoots, "output_path");
      if (canonicalPathKey(persistedOut) !== canonicalPathKey(outputPath)) {
        throw new UsageError(
          `Cannot change output_path from "${persistedOut}" to "${outputPath}" on existing data_dir without force=true`,
        );
      }
    }
    const repoRoot = resolveRepoRoot(params.repo_root, existingMeta?.repo_root, allowedRoots);
    const skillsRoot = resolveOptionalPath(params.skills_root ?? existingMeta?.skills_root, allowedRoots, "skills_root");
    assertSafeSkillDbs(repoRoot, "repo_root");
    if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
    const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");
    if (fakeFixtureDir) assertSafeRegularTree(fakeFixtureDir, "fake_fixture_dir");
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
    if (params.timeout_ms !== undefined) args.push("--timeout-ms", assertBoundedTimeoutMs(params.timeout_ms, "timeout_ms"));
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

    // Reserve run_id BEFORE claiming output_path so a cross-process run_id collision
    // never leaves an orphaned output-owners record behind.
    const hadStateDbBefore = existsSync(join(dataDir, "uwf-state.db"));
    const hadStageDbBefore = existsSync(join(dataDir, "uwf-stages.db"));
    const hadDbBefore = hadStateDbBefore || hadStageDbBefore;
    const idxReg = registerRunIndex(stateDir, meta, { pruneSuperseded: false });
    let metaWrite = null;
    let res;
    try {
      claim = claimOutputPath({
        outputPath,
        runId,
        dataDir,
        stateDir,
        unlock: params.unlock === true,
        force,
      });
      metaWrite = writeRunMeta(dataDir, meta);
      assertSafeDataDir(dataDir);
      assertSafeSkillDbs(repoRoot, "repo_root");
      if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
      if (fakeFixtureDir) assertSafeRegularTree(fakeFixtureDir, "fake_fixture_dir");
      assertSafeStageInputsForRun({ workflow, repoRoot, skillsRoot, outputPath, dataDir });
      res = await execNodeAsync(RUNNER_CLI, args, {
        cwd: repoRoot,
        env,
        timeoutMs: DEFAULT_RUN_CLI_TIMEOUT_MS,
      });
    } catch (err) {
      rollbackClaimAndIndex(claim, idxReg, metaWrite);
      claim = null;
      throw err;
    }
    const shouldRollbackRun =
      res.spawnError ||
      res.code === EXIT.USAGE ||
      (!existingMeta && !hadDbBefore && !hasRunDatabases(dataDir) && res.code !== EXIT.OK);
    if (shouldRollbackRun) {
      rollbackClaimAndIndex(claim, idxReg, metaWrite);
      claim = null;
      if (res.spawnError || res.code === EXIT.USAGE) {
        if (!hadStageDbBefore) cleanupFailedInitDb(dataDir, "stage");
        if (!hadStateDbBefore) cleanupFailedInitDb(dataDir, "state");
      }
    } else {
      pruneSupersededRunIndices(stateDir, meta);
    }

    return buildRunEnvelope({
      runId,
      dataDir,
      outputPath,
      workflow,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      dryRun: false,
    });
    } finally {
      claim?.release();
      dataLock.release();
    }
  });
}

/**
 * uaw_resume — Reload durable `run_id` and `output_path` from `<data-dir>/run-meta.json`
 * (or `uwf-state.db`) and invoke `runner.mjs resume`.
 */
export async function cmdResume(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);

  if (params.workflow !== undefined) assertSafeWorkflow(params.workflow, "workflow");
  if (params.adapter) assertSafeIdentifier(params.adapter, "adapter");
  if (params.model) assertNoLeadingDash(params.model, "model");
  if (params.timeout_ms !== undefined) assertBoundedTimeoutMs(params.timeout_ms, "timeout_ms");
  if (params.max_cost_usd !== undefined) assertNoLeadingDash(params.max_cost_usd, "max_cost_usd");
  if (params.resume_max_context !== undefined) {
    assertNoLeadingDash(params.resume_max_context, "resume_max_context");
  }

  const initialTarget = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: true,
  });

  const dataDir = initialTarget.dataDir;
  assertExistingRunDir(dataDir, "uaw_resume");
  const dataLock = claimDataDirLock({
    dataDir,
    runId: params.run_id ?? initialTarget.runId ?? "resume",
    stateDir,
    unlock: params.unlock === true,
  });
  let claim = null;

  return await withTrackedMutation(async () => {
    try {
    assertSafeDataDir(dataDir);
    assertExistingRunDir(dataDir, "uaw_resume");
    assertNoActiveRunLock(dataDir);
    const meta = readRunMeta(dataDir) ?? initialTarget.meta;
    let stateFallback = null;
    try {
      stateFallback = readState(dataDir);
    } catch {
      /* ignore */
    }
    if (!meta && !existsSync(join(dataDir, "uwf-state.db")) && !existsSync(join(dataDir, "uwf-stages.db"))) {
      throw new UsageError(`No initialized run found in "${dataDir}" (uaw_resume)`);
    }

    assertWorkflowMatchesMeta(params.workflow, meta?.workflow, "uaw_resume");
    const rawWorkflow = params.workflow ?? meta?.workflow;
    const workflow = assertSafeWorkflow(rawWorkflow, "workflow");

    const runId = meta?.run_id ?? params.run_id ?? generateRunId(workflow);
    const persistedRaw = meta?.output_path ?? stateFallback?.state?.artifact_path ?? null;
    let outputPath;
    if (persistedRaw) {
      const persistedOutput = assertAllowedPath(persistedRaw, allowedRoots, "output_path");
      if (params.output_path !== undefined) {
        const requestedOutput = assertAllowedPath(params.output_path, allowedRoots, "output_path");
        if (canonicalPathKey(requestedOutput) !== canonicalPathKey(persistedOutput)) {
          throw new UsageError(
            `uaw_resume output_path "${requestedOutput}" does not match persisted output_path "${persistedOutput}"`,
          );
        }
      }
      outputPath = persistedOutput;
    } else {
      outputPath = assertAllowedPath(
        params.output_path ?? defaultOutputPath(dataDir),
        allowedRoots,
        "output_path",
      );
    }

    const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
    const skillsRoot = resolveOptionalPath(
      params.skills_root ?? meta?.skills_root,
      allowedRoots,
      "skills_root",
    );
    assertSafeSkillDbs(repoRoot, "repo_root");
    if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
    const fakeFixtureDir = resolveOptionalPath(params.fake_fixture_dir, allowedRoots, "fake_fixture_dir");
    if (fakeFixtureDir) assertSafeRegularTree(fakeFixtureDir, "fake_fixture_dir");

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
    if (params.timeout_ms !== undefined) args.push("--timeout-ms", assertBoundedTimeoutMs(params.timeout_ms, "timeout_ms"));
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

    const hadStateDbBefore = existsSync(join(dataDir, "uwf-state.db"));
    const hadStageDbBefore = existsSync(join(dataDir, "uwf-stages.db"));
    const hadDbBefore = hadStateDbBefore || hadStageDbBefore;
    let resumeIdxReg = null;
    let resumeMetaWrite = null;
    let updatedMetaForPrune = null;
    let res;
    try {
      if (!meta || !meta.output_path) {
        const updatedMeta = {
          ...(meta ?? {}),
          run_id: runId,
          workflow,
          data_dir: dataDir,
          output_path: outputPath,
          repo_root: repoRoot,
          skills_root: skillsRoot ?? meta?.skills_root ?? null,
          created_at: meta?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        resumeIdxReg = registerRunIndex(stateDir, updatedMeta, { pruneSuperseded: false });
        claim = claimOutputPath({
          outputPath,
          runId,
          dataDir,
          stateDir,
          unlock: params.unlock === true,
        });
        resumeMetaWrite = writeRunMeta(dataDir, updatedMeta);
        updatedMetaForPrune = updatedMeta;
      } else {
        claim = claimOutputPath({
          outputPath,
          runId,
          dataDir,
          stateDir,
          unlock: params.unlock === true,
        });
      }

      assertSafeDataDir(dataDir);
      assertSafeSkillDbs(repoRoot, "repo_root");
      if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
      if (fakeFixtureDir) assertSafeRegularTree(fakeFixtureDir, "fake_fixture_dir");
      assertSafeStageInputsForRun({ workflow, repoRoot, skillsRoot, outputPath, dataDir });

      res = await execNodeAsync(RUNNER_CLI, args, {
        cwd: repoRoot,
        env,
        timeoutMs: DEFAULT_RUN_CLI_TIMEOUT_MS,
      });
    } catch (err) {
      if (resumeIdxReg || resumeMetaWrite) {
        rollbackClaimAndIndex(claim, resumeIdxReg, resumeMetaWrite);
        claim = null;
      }
      throw err;
    }
    const shouldRollbackResume =
      (resumeIdxReg || resumeMetaWrite) &&
      (res.spawnError ||
        res.code === EXIT.USAGE ||
        (!meta && !hadDbBefore && !hasRunDatabases(dataDir) && res.code !== EXIT.OK));
    if (shouldRollbackResume) {
      rollbackClaimAndIndex(claim, resumeIdxReg, resumeMetaWrite);
      claim = null;
    } else if (updatedMetaForPrune) {
      pruneSupersededRunIndices(stateDir, updatedMetaForPrune);
    }
    if (res.spawnError || res.code === EXIT.USAGE) {
      if (!hadStageDbBefore) cleanupFailedInitDb(dataDir, "stage");
      if (!hadStateDbBefore) cleanupFailedInitDb(dataDir, "state");
    }
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
      claim?.release();
      dataLock.release();
    }
  });
}

/**
 * uaw_gates — Evaluate gate checks or list gate prescriptions/stages without advancing state.
 */
export async function cmdGates(params = {}, ctx = {}) {
  const allowedRoots = ctx.allowedRoots ?? [];
  const stateDir = resolveUawStateDir(ctx.stateDir);
  const rawMode = params.mode ?? (params.stage ? "check" : "prescriptions");
  if (typeof rawMode !== "string" || !["list", "check", "prescriptions"].includes(rawMode)) {
    throw new UsageError('mode must be one of "list", "check", or "prescriptions"');
  }
  const mode = rawMode;

  let dataDir = null;
  let runId = params.run_id ?? null;
  let meta = null;
  if (params.run_id || params.data_dir) {
    const target = resolveRunTarget({
      run_id: params.run_id,
      data_dir: params.data_dir,
      stateDir,
      allowedRoots,
      requireExisting: mode === "check",
    });
    dataDir = target.dataDir;
    runId = target.runId;
    meta = target.meta;
  }

  if (params.workflow !== undefined) assertSafeWorkflow(params.workflow, "workflow");
  assertWorkflowMatchesMeta(params.workflow, meta?.workflow, "uaw_gates");
  const workflow = assertSafeWorkflow(params.workflow ?? meta?.workflow, "workflow");

  const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
  const skillsRoot = resolveOptionalPath(
    params.skills_root ?? meta?.skills_root,
    allowedRoots,
    "skills_root",
  );
  const rawOutput = params.output_path ?? meta?.output_path ?? (dataDir ? defaultOutputPath(dataDir) : undefined);
  const outputPath = rawOutput ? assertAllowedPath(rawOutput, allowedRoots, "output_path") : undefined;

  if (dataDir) assertSafeDataDir(dataDir);
  assertSafeSkillDbs(repoRoot, "repo_root");
  if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");
  const env = {};
  if (skillsRoot) env.UWF_SKILLS_ROOT = skillsRoot;

  if (mode === "list") {
    const scratch = mkdtempSync(join(tmpdir(), "uaw-mcp-gates-"));
    try {
      const args = ["list-stages", "--workflow", workflow, "--data-dir", scratch];
      if (outputPath) args.push("--output-path", outputPath);
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      const res = await execNodeAsync(TRACKER_CLI, args, {
        cwd: repoRoot,
        env: { ...env, UWF_DATA_DIR: scratch },
        timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
      });
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
    if (!dataDir) throw new UsageError("run_id or data_dir is required for mode=check");
    assertExistingRunDir(dataDir, "uaw_gates");
    const persistedMeta = readRunMeta(dataDir) ?? meta;
    if (
      !persistedMeta &&
      !existsSync(join(dataDir, "uwf-state.db")) &&
      !existsSync(join(dataDir, "uwf-stages.db"))
    ) {
      throw new UsageError(`No initialized run found in "${dataDir}" (uaw_gates mode=check)`);
    }
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
        "--data-dir",
        dataDir,
      ];
      if (outputPath) args.push("--output-path", outputPath);
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      const res = await execNodeAsync(TRACKER_CLI, args, {
        cwd: repoRoot,
        env: { ...env, UWF_DATA_DIR: dataDir },
        timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
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
    const res = await execNodeAsync(TRACKER_CLI, args, {
      cwd: repoRoot,
      env: { ...env, UWF_DATA_DIR: scratch },
      timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
    });
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
  if (params.workflow !== undefined) assertSafeWorkflow(params.workflow, "workflow");
  assertWorkflowMatchesMeta(params.workflow, meta?.workflow, "uaw_cost");
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
  const outputPath = assertAllowedPath(
    params.output_path ?? meta?.output_path ?? defaultOutputPath(dataDir),
    allowedRoots,
    "output_path",
  );

  assertSafeDataDir(dataDir, { strictTranscripts: false });
  assertSafeSkillDbs(repoRoot, "repo_root");
  if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");

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
function backfillExistingRunMeta(stateDir, dataDir, meta, { workflow, skillsRoot }) {
  if (!meta) return null;
  const needsWorkflow = !meta.workflow && workflow;
  const needsSkills = !meta.skills_root && skillsRoot;
  if (!needsWorkflow && !needsSkills) return null;
  const nextMeta = {
    ...meta,
    workflow: meta.workflow ?? workflow ?? null,
    skills_root: meta.skills_root ?? skillsRoot ?? null,
    updated_at: new Date().toISOString(),
  };
  let metaWrite = null;
  try {
    metaWrite = writeRunMeta(dataDir, nextMeta);
    registerRunIndex(stateDir, nextMeta, { pruneSuperseded: true });
    return null;
  } catch (err) {
    try {
      metaWrite?.rollback();
    } catch { /* best-effort rollback */ }
    return `run-meta backfill warning: ${err.message}`;
  }
}

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
  if (params.workflow !== undefined) assertSafeWorkflow(params.workflow, "workflow");

  const target = resolveRunTarget({
    run_id: params.run_id,
    data_dir: params.data_dir,
    stateDir,
    allowedRoots,
    requireExisting: false,
  });

  const dataDir = target.dataDir;
  if (action !== "init") {
    assertExistingRunDir(dataDir, "uaw_stage_transition");
  }

  const dataLock = claimDataDirLock({
    dataDir,
    runId: target.runId ?? "stage-transition",
    stateDir,
    unlock: params.unlock === true,
  });
  let claim = null;

  return await withTrackedMutation(async () => {
    try {
    assertSafeDataDir(dataDir);
    if (action !== "init") {
      assertExistingRunDir(dataDir, "uaw_stage_transition");
    }
    assertNoActiveRunLock(dataDir);
    const meta = readRunMeta(dataDir) ?? target.meta;
    if (action !== "init" && !meta && !existsSync(join(dataDir, "uwf-state.db")) && !existsSync(join(dataDir, "uwf-stages.db"))) {
      throw new UsageError(`No initialized run found in "${dataDir}" (uaw_stage_transition action=${action})`);
    }
    assertWorkflowMatchesMeta(params.workflow, meta?.workflow, "uaw_stage_transition");
    const workflow = scope === "stage"
      ? assertSafeWorkflow(params.workflow ?? meta?.workflow, "workflow")
      : (params.workflow ? assertSafeWorkflow(params.workflow, "workflow") : meta?.workflow ?? null);
    const runId = meta?.run_id ?? target.runId ?? generateRunId(workflow ?? "uaw");
    const rawOutput = params.output_path ?? meta?.output_path ?? defaultOutputPath(dataDir);
    const outputPath = assertAllowedPath(rawOutput, allowedRoots, "output_path");
    if (meta?.output_path && params.output_path) {
      const persistedOut = assertAllowedPath(meta.output_path, allowedRoots, "output_path");
      if (canonicalPathKey(persistedOut) !== canonicalPathKey(outputPath)) {
        throw new UsageError(
          `uaw_stage_transition output_path "${outputPath}" does not match persisted output_path "${persistedOut}"`,
        );
      }
    }
    const repoRoot = resolveRepoRoot(params.repo_root, meta?.repo_root, allowedRoots);
    const skillsRoot = resolveOptionalPath(
      params.skills_root ?? meta?.skills_root,
      allowedRoots,
      "skills_root",
    );
    assertSafeSkillDbs(repoRoot, "repo_root");
    if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");

    const common = ["--data-dir", dataDir, "--output-path", outputPath];
    const env = { UWF_DATA_DIR: dataDir, ...(skillsRoot ? { UWF_SKILLS_ROOT: skillsRoot } : {}) };

    const hadDbBefore = hasRunDatabases(dataDir);
    let transIdxReg = null;
    let transMetaWrite = null;
    let createdMetaForPrune = null;
    let res;
    let stageBackfillWarning = null;
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
        transIdxReg = registerRunIndex(stateDir, createdMeta, { pruneSuperseded: false });
        claim = claimOutputPath({
          outputPath,
          runId,
          dataDir,
          stateDir,
          unlock: params.unlock === true,
        });
        transMetaWrite = writeRunMeta(dataDir, createdMeta);
        createdMetaForPrune = createdMeta;
      } else {
        claim = claimOutputPath({
          outputPath,
          runId,
          dataDir,
          stateDir,
          unlock: params.unlock === true,
        });
      }

      if (scope === "state") {
        const args = [action];
        if (params.mode) args.push("--mode", assertNoLeadingDash(params.mode, "mode"));
        if (params.to) args.push("--to", assertSafeIdentifier(params.to, "to"));
        if (params.agent) args.push("--agent", assertNoLeadingDash(params.agent, "agent"));
        if (params.note) args.push("--note", assertNoLeadingDash(params.note, "note"));
        if (params.phases !== undefined) {
          const phasesVal = Array.isArray(params.phases)
            ? params.phases.map((p) => assertNoLeadingDash(p, "phases")).join(",")
            : assertNoLeadingDash(params.phases, "phases");
          args.push("--phases", phasesVal);
        }
        if (params.status) args.push("--status", assertSafeIdentifier(params.status, "status"));
        if (params.profile) args.push("--profile", assertSafeIdentifier(params.profile, "profile"));
        if (params.model) args.push("--model", assertNoLeadingDash(params.model, "model"));
        if (params.force === true) args.push("--force");
        args.push(...common);

        assertSafeDataDir(dataDir);
        assertSafeSkillDbs(repoRoot, "repo_root");
        if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");

        res = await execNodeAsync(STATE_CLI, args, {
          cwd: repoRoot,
          env,
          timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
        });
        const stateFailed = res.spawnError || res.code !== 0 || res.json?.ok === false;
        let backfillWarning = null;
        if (stateFailed && (transIdxReg || transMetaWrite)) {
          if (action === "init" && !hadDbBefore) cleanupFailedInitDb(dataDir, scope);
          rollbackClaimAndIndex(claim, transIdxReg, transMetaWrite);
          claim = null;
        } else {
          if (!stateFailed) backfillWarning = backfillExistingRunMeta(stateDir, dataDir, meta, { workflow, skillsRoot });
          if (createdMetaForPrune) pruneSupersededRunIndices(stateDir, createdMetaForPrune);
        }
        return redactDeep({
          ok: res.code === 0 && res.json?.ok !== false,
          exit_code: res.code,
          run_id: runId,
          data_dir: dataDir,
          target: "state",
          action,
          result: res.json,
          error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
          ...(backfillWarning ? { warning: backfillWarning } : {}),
        }).value;
      }

      // scope === "stage"
      const args = [action, "--workflow", workflow];
      if (params.stage) args.push("--stage", assertSafeIdentifier(params.stage, "stage"));
      if (params.note) args.push("--note", assertNoLeadingDash(params.note, "note"));
      if (params.session_id) args.push("--session-id", assertNoLeadingDash(params.session_id, "session_id"));
      if (skillsRoot) args.push("--skills-root", skillsRoot);
      args.push(...common);

      assertSafeDataDir(dataDir);
      assertSafeSkillDbs(repoRoot, "repo_root");
      if (skillsRoot) assertSafeSkillDbs(skillsRoot, "skills_root");

      res = await execNodeAsync(TRACKER_CLI, args, {
        cwd: repoRoot,
        env,
        timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
      });
      const stageFailed = res.spawnError || res.code !== 0 || res.json?.ok === false;
      if (stageFailed && (transIdxReg || transMetaWrite)) {
        if (action === "init" && !hadDbBefore) cleanupFailedInitDb(dataDir, scope);
        rollbackClaimAndIndex(claim, transIdxReg, transMetaWrite);
        claim = null;
      } else {
        if (!stageFailed) stageBackfillWarning = backfillExistingRunMeta(stateDir, dataDir, meta, { workflow, skillsRoot });
        if (createdMetaForPrune) pruneSupersededRunIndices(stateDir, createdMetaForPrune);
      }
    } catch (err) {
      if (transIdxReg || transMetaWrite) {
        if (action === "init" && !hadDbBefore) cleanupFailedInitDb(dataDir, scope);
        rollbackClaimAndIndex(claim, transIdxReg, transMetaWrite);
        claim = null;
      }
      throw err;
    }
    return redactDeep({
      ok: res.code === 0 && res.json?.ok !== false,
      exit_code: res.code,
      run_id: runId,
      data_dir: dataDir,
      target: "stage",
      action,
      result: res.json,
      error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || `exit ${res.code}`,
      ...(stageBackfillWarning ? { warning: stageBackfillWarning } : {}),
    }).value;
    } finally {
      claim?.release();
      dataLock.release();
    }
  });
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
    requireExisting: true,
  });
  const dataDir = target.dataDir;
  assertSafeDataDir(dataDir);
  let dirLst;
  try {
    dirLst = lstatSync(dataDir);
  } catch {
    throw new UsageError(`No run directory found at "${dataDir}"`);
  }
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`Invalid run directory at "${dataDir}"`);
  }

  const args = [action, "--data-dir", dataDir];
  if (params.stage) args.push("--stage", assertSafeIdentifier(params.stage, "stage"));
  if (params.status) args.push("--status", assertSafeIdentifier(params.status, "status"));
  if (params.id !== undefined) args.push("--id", assertNoLeadingDash(params.id, "id"));
  if (params.ids !== undefined) {
    const idsVal = Array.isArray(params.ids)
      ? params.ids.map((v) => assertNoLeadingDash(v, "ids")).join(",")
      : assertNoLeadingDash(params.ids, "ids");
    args.push("--ids", idsVal);
  }
  if (params.answer !== undefined) args.push("--answer", assertNoLeadingDash(params.answer, "answer"));

  if (action !== "answer" && action !== "skip") {
    assertSafeDataDir(dataDir, { strictTranscripts: false });
    const qRes = queryQuestionsAction(dataDir, {
      action,
      stage: params.stage,
      status: params.status,
      ids: params.ids,
    });
    return redactDeep({
      ok: qRes.ok,
      exit_code: qRes.exitCode,
      run_id: target.runId,
      data_dir: dataDir,
      action,
      result: qRes.result,
      error: qRes.error,
    }).value;
  }

  const dataLock = claimDataDirLock({
    dataDir,
    runId: target.runId ?? "question-resolve",
    stateDir,
    unlock: params.unlock === true,
  });
  let claim = null;

  return await withTrackedMutation(async () => {
    try {
    assertSafeDataDir(dataDir);
    assertNoActiveRunLock(dataDir);
    const meta = readRunMeta(dataDir) ?? target.meta;
    const lockRunId = meta?.run_id ?? target.runId ?? null;
    if (meta?.output_path && lockRunId) {
      const outPath = assertAllowedPath(meta.output_path, allowedRoots, "output_path");
      claim = claimOutputPath({
        outputPath: outPath,
        runId: lockRunId,
        dataDir,
        stateDir,
        unlock: params.unlock === true,
      });
    }

    assertSafeDataDir(dataDir);
    const res = await execNodeAsync(QUESTIONS_CLI, args, {
      cwd: OWN_REPO_ROOT,
      env: { UWF_DATA_DIR: dataDir },
      timeoutMs: DEFAULT_METADATA_CLI_TIMEOUT_MS,
    });

    return redactDeep({
      ok: res.code === 0 && res.json?.ok !== false,
      exit_code: res.code,
      run_id: lockRunId,
      data_dir: dataDir,
      action,
      result: res.json,
      error: res.code === 0 ? null : res.json?.error || res.stderr.trim() || null,
    }).value;
    } finally {
      claim?.release();
      dataLock.release();
    }
  });
}
