#!/usr/bin/env node
/**
 * uwf-bench: benchmark harness around scripts/uwf-runner/runner.mjs.
 *
 * Usage:
 *   node scripts/uwf-bench/bench.mjs run --matrix <matrix.yaml> [--db results.db] [--work <dir>] [--resume] [--keep-repos]
 *   node scripts/uwf-bench/bench.mjs export --db results.db --out <dir>
 *   node scripts/uwf-bench/bench.mjs rate --db results.db --run <id> --rater <name> --dimension <d> --score <n>
 *     [--score-final n] [--reconciliation none|averaged|discussed|third_rater] [--cell-guess c] [--run-label l]
 *
 * Every (cell x fixture x run_index) is one runner invocation with its own UWF_DATA_DIR. A failed
 * run is recorded and never stops the matrix. Exit codes: 0 ok | 2 usage or config error.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRun, insertRating, insertRun, openDb, tableCsv } from "./db.mjs";
import { openSqlite } from "./sqlite.mjs";
import { loadMatrix, planRuns } from "./matrix.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const RUNNER = join(ROOT, "scripts", "uwf-runner", "runner.mjs");
const SKILLS = join(ROOT, ".github", "skills");
const TABLES = ["runs", "stage_outcomes", "ratings"];
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.|test_[^/]*\.py$/;
const MISSING = /missing|not found|does not exist|no such file/i;

class UsageError extends Error {}
const log = (s) => process.stderr.write(s + "\n");

function parseArgs(argv) {
  const flags = {};
  const bool = new Set(["resume", "keep-repos"]);
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new UsageError(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (bool.has(key)) { flags[key] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new UsageError(`--${key} requires a value`);
    flags[key] = argv[++i];
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const sha256 = (path) => { try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; } };
const isGitDir = (p) => existsSync(join(p, ".git"));
const isRemote = (repo) => /^[a-z][a-z0-9+.-]*:\/\/|^git@/i.test(repo);
/** Paths with uncommitted changes (NUL-delimited porcelain, untrimmed so a leading-space status survives). */
function changedPaths(cwd) {
  const r = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\0").filter(Boolean).map((e) => e.slice(3));
}

const cliVersions = new Map();
/** `claude --version` output for claude-code, else the adapter name (cached per adapter). */
function cliVersion(adapter) {
  if (adapter !== "claude-code") return adapter;
  if (!cliVersions.has(adapter)) {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15000 });
    cliVersions.set(adapter, r.status === 0 ? r.stdout.trim() : null);
  }
  return cliVersions.get(adapter);
}

// ---------------------------------------------------------------------------
// Fixture copy
// ---------------------------------------------------------------------------

/** Fresh copy of the fixture at `dest`: git clone (+ checkout ref) for repos and URLs, plain copy otherwise. */
export function prepareRepo(fixture, dest, baseDir, workflow) {
  const remote = isRemote(fixture.repo);
  const src = remote ? fixture.repo : resolve(baseDir, fixture.repo);
  mkdirSync(dirname(dest), { recursive: true });
  if (remote || isGitDir(src)) {
    const c = spawnSync("git", ["clone", "--quiet", src, dest], { encoding: "utf8" });
    if (c.status !== 0) throw new Error(`git clone failed: ${c.stderr.trim()}`);
    if (fixture.ref) {
      const k = spawnSync("git", ["checkout", "--quiet", fixture.ref], { cwd: dest, encoding: "utf8" });
      if (k.status !== 0) throw new Error(`git checkout ${fixture.ref} failed: ${k.stderr.trim()}`);
    }
  } else {
    if (!existsSync(src)) throw new Error(`fixture repo not found: ${src}`);
    cpSync(src, dest, { recursive: true });
  }
  // The runner reads agents and the workflow skill from the repo root; add them when the fixture lacks them.
  for (const rel of [join(".github", "agents"), join(".github", "skills", `uwf-${workflow}`)]) {
    if (!existsSync(join(dest, rel))) cpSync(join(ROOT, rel), join(dest, rel), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Reading what the runner left behind
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * Token and cost fields from one adapter transcript record. claude-code transcripts keep the CLI's
 * JSON in `stdout` (usage, total_cost_usd, modelUsage); fake and codex transcripts carry none, so every field is null.
 */
export function extractUsage(record) {
  let j = null;
  try { j = JSON.parse(record.stdout); } catch { /* not CLI JSON */ }
  const u = j?.usage ?? {};
  return {
    tokens_input: num(u.input_tokens), tokens_output: num(u.output_tokens),
    tokens_cache_read: num(u.cache_read_input_tokens), tokens_cache_write: num(u.cache_creation_input_tokens),
    cost_usd: num(j?.total_cost_usd), model: j?.modelUsage ? Object.keys(j.modelUsage)[0] ?? null : null,
  };
}

/** Transcripts in invocation order, tagged with the stage named in their prompt. */
export function readTranscripts(dataDir) {
  const dir = join(dataDir, "transcripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const stage = String(rec.prompt ?? "").match(/Run the (\S+) stage for the/)?.[1] ?? null;
    return { stage, sessionId: rec.sessionId ?? null, prompt: String(rec.prompt ?? ""), usage: extractUsage(rec) };
  });
}

/** stage_runs rows (read-only) from the stage tracker db in the data dir. */
export function readStageRuns(dataDir, workflow) {
  const path = join(dataDir, "uwf-stages.db");
  if (!existsSync(path)) return [];
  const db = openSqlite(path, { readOnly: true });
  try { return db.prepare("SELECT * FROM stage_runs WHERE workflow = ? ORDER BY id").all(workflow).map((r) => ({ ...r })); } finally { db.close(); }
}

/** Stage names whose gate has at least one check (stages.yaml); all stages when it cannot be read. */
function gatedStages(workflow) {
  try {
    const yaml = createRequire(join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs"))("js-yaml");
    const doc = yaml.load(readFileSync(join(SKILLS, `uwf-${workflow}`, "stages.yaml"), "utf8"));
    return new Set((doc.stages ?? []).filter((s) => (s.gate?.checks ?? []).length).map((s) => s.name));
  } catch { return null; }
}

/** Gate failure text the runner put into attempt N+1's retry prompt for attempt N. */
const retryReason = (prompt) => prompt.match(/did not pass\.\n([\s\S]*?)\n\nWhat happens next/)?.[1].replace(/^- /gm, "").replace(/\n/g, " | ") ?? null;

/**
 * One stage_outcomes row per invocation. The tracker keeps a single row per stage, so only the last
 * attempt has a recorded status; earlier attempts of the same stage failed their gate by construction.
 */
export function buildOutcomes(stageRuns, transcripts, gated) {
  const out = [];
  for (const sr of stageRuns) {
    const ts = transcripts.filter((t) => t.stage === sr.stage);
    const isGated = gated ? gated.has(sr.stage) : true;
    if (!ts.length) {
      if (sr.status === "skipped") out.push({ stage: sr.stage, attempt: 1, skipped: true, gated: false, passed: false, first_try_pass: false, never_passed: false, gate_failure_reason: sr.notes });
      continue;
    }
    ts.forEach((t, i) => {
      const last = i === ts.length - 1;
      const status = last ? sr.status : "failed";
      const { model, ...usage } = t.usage;
      out.push({
        stage: sr.stage, attempt: i + 1, skipped: last && status === "skipped", gated: isGated, passed: status === "passed",
        first_try_pass: i === 0 && status === "passed", never_passed: last && status !== "passed",
        gate_failure_reason: status === "passed" ? null : last ? sr.notes : retryReason(ts[i + 1].prompt),
        ...usage, wall_seconds: null, prompt_tokens: null, session_id: t.sessionId,
      });
    });
  }
  return out;
}

const sum = (rows, k) => (rows.some((r) => r[k] != null) ? rows.reduce((a, r) => a + (r[k] ?? 0), 0) : null);

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const FAILURE = { 0: "none", 1: "model_failure", 2: "harness_error", 3: "harness_error" };
const STATE = { 0: "complete", 1: "gate_blocked", 2: "usage_error", 3: "questions_pending" };

/** Execute one planned run and return { run, outcomes } ready for insertRun. Never throws. */
export function executeRun(matrix, entry, ctx) {
  const { cell, fixture, run_index, block } = entry;
  const base = {
    cell: cell.name, workflow: matrix.workflow, adapter: cell.adapter, model: cell.model ?? null, state_location: cell.state_location,
    fixture: fixture.name, run_index, block, seed: null, claude_cli_version: cliVersion(cell.adapter), runner_sha: ctx.runnerSha,
    stages_yaml_sha: ctx.stagesYamlSha, started_at: new Date().toISOString(), usage_incomplete: true, notes: null,
  };
  if (cell.state_location === "nocli") {
    return { run: { ...base, ended_at: base.started_at, wall_seconds: 0, terminal_state: "not_implemented", failure_class: null,
      notes: "no-CLI protocol is not implemented (later issue); run skipped" }, outcomes: [] };
  }
  const dir = join(ctx.work, cell.name, fixture.name, String(run_index));
  const repo = join(dir, "repo");
  const dataDir = join(dir, "data");
  const t0 = Date.now();
  let run;
  let outcomes = [];
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    prepareRepo(fixture, repo, ctx.baseDir, matrix.workflow);
    base.fixture_sha = git(repo, ["rev-parse", "HEAD"]);
    const args = [RUNNER, "run", "--workflow", matrix.workflow, "--goal", fixture.goal, "--adapter", cell.adapter,
      ...(cell.model ? ["--model", cell.model] : []), "--data-dir", dataDir, "--repo-root", repo, "--non-interactive",
      "--timeout-ms", String(matrix.timeout_ms)];
    const env = { ...process.env, UWF_DATA_DIR: "" };
    if (cell.fake_fixture_dir) env.UWF_FAKE_FIXTURE_DIR = resolve(ctx.baseDir, cell.fake_fixture_dir);
    const r = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: matrix.timeout_ms * 30 });
    if (r.error && r.status === null && r.signal === null) throw r.error;
    const code = r.status;
    const transcripts = readTranscripts(dataDir);
    outcomes = buildOutcomes(readStageRuns(dataDir, matrix.workflow), transcripts, ctx.gated);
    const first = outcomes.filter((o) => o.gated && !o.skipped && o.attempt === 1);
    const attempts = transcripts.map((t) => t.usage);
    const status = code === null ? "ambiguous" : FAILURE[code] ?? "harness_error";
    const changed = isGitDir(repo) ? changedPaths(repo) : null;
    run = {
      ...base, model: attempts.find((a) => a.model)?.model ?? base.model, exit_code: code, stderr_tail: r.stderr.slice(-2000),
      tokens_input: sum(attempts, "tokens_input"), tokens_output: sum(attempts, "tokens_output"),
      tokens_cache_read: sum(attempts, "tokens_cache_read"), tokens_cache_write: sum(attempts, "tokens_cache_write"),
      cost_usd: sum(attempts, "cost_usd"), max_prompt_tokens: null,
      usage_incomplete: !attempts.length || attempts.some((a) => ["tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "cost_usd"].some((k) => a[k] == null)),
      terminal_state: code === null ? "timeout" : STATE[code] ?? "unknown", failure_class: status,
      test_file_modified: changed ? changed.some((f) => TEST_FILE.test(f)) : null,
      first_try_pass_rate: first.length ? first.filter((o) => o.first_try_pass).length / first.length : null,
      retries_total: outcomes.filter((o) => o.attempt > 1).length,
      artifact_missing: outcomes.filter((o) => o.never_passed && MISSING.test(o.gate_failure_reason ?? "")).length,
      acceptance_pass: fixture.acceptance_cmd ? acceptance(fixture.acceptance_cmd, repo, ctx.acceptanceTimeoutMs) : null,
    };
  } catch (e) {
    run = { ...base, terminal_state: "harness_error", failure_class: "harness_error", notes: String(e.message ?? e).slice(0, 1000) };
  }
  run.ended_at = new Date().toISOString();
  run.wall_seconds = (Date.now() - t0) / 1000;
  if (!ctx.keepRepos) rmSync(repo, { recursive: true, force: true });
  return { run, outcomes };
}

/** Run the fixture's acceptance command (shell) in the copy; true when it exits 0. */
function acceptance(cmd, cwd, timeout) {
  return spawnSync(cmd, { cwd, shell: true, timeout, stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdRun(flags) {
  if (!flags.matrix) throw new UsageError("--matrix is required");
  const matrixPath = resolve(flags.matrix);
  if (!existsSync(matrixPath)) throw new UsageError(`matrix not found: ${matrixPath}`);
  let matrix;
  try { matrix = loadMatrix(readFileSync(matrixPath, "utf8")); } catch (e) { throw new UsageError(e.message); }
  const baseDir = dirname(matrixPath);
  const out = resolve(baseDir, matrix.output_path);
  const db = openDb(resolve(flags.db ?? join(out, "results.db")));
  const ctx = {
    baseDir, work: resolve(flags.work ?? join(out, "work")), keepRepos: flags["keep-repos"] === true, acceptanceTimeoutMs: 120000,
    runnerSha: git(ROOT, ["rev-parse", "HEAD"]), gated: gatedStages(matrix.workflow),
    stagesYamlSha: sha256(join(SKILLS, `uwf-${matrix.workflow}`, "stages.yaml")),
  };
  const plan = planRuns(matrix);
  const counts = {};
  plan.forEach((entry, i) => {
    const { cell, fixture, run_index } = entry;
    const tag = `[${i + 1}/${plan.length}] ${cell.name} ${fixture.name} #${run_index}`;
    if (flags.resume === true && hasRun(db, cell.name, fixture.name, run_index)) { log(`${tag}: already in db, skipped (--resume)`); return; }
    const { run, outcomes } = executeRun(matrix, entry, ctx);
    insertRun(db, run, outcomes);
    const key = run.failure_class ?? run.terminal_state;
    counts[key] = (counts[key] ?? 0) + 1;
    log(`${tag}: ${run.terminal_state} (${run.failure_class ?? "-"}) ${(run.wall_seconds ?? 0).toFixed(1)}s`);
  });
  db.close();
  log(`[bench] done: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "nothing to run"}`);
  return 0;
}

function cmdExport(flags) {
  if (!flags.db || !flags.out) throw new UsageError("--db and --out are required");
  if (!existsSync(flags.db)) throw new UsageError(`db not found: ${flags.db}`);
  const db = openDb(resolve(flags.db));
  mkdirSync(resolve(flags.out), { recursive: true });
  for (const t of TABLES) writeFileSync(join(resolve(flags.out), `${t}.csv`), tableCsv(db, t), "utf8");
  db.close();
  log(`[bench] wrote ${TABLES.map((t) => `${t}.csv`).join(", ")} to ${resolve(flags.out)}`);
  return 0;
}

function cmdRate(flags) {
  for (const k of ["db", "run", "rater", "dimension", "score"]) if (flags[k] === undefined) throw new UsageError(`--${k} is required`);
  if (!existsSync(flags.db)) throw new UsageError(`db not found: ${flags.db}`);
  const db = openDb(resolve(flags.db));
  try {
    const id = insertRating(db, { run_id: Number(flags.run), rater: flags.rater, dimension: flags.dimension, score: Number(flags.score),
      score_final: flags["score-final"] === undefined ? undefined : Number(flags["score-final"]), reconciliation: flags.reconciliation,
      cell_guess: flags["cell-guess"], run_label: flags["run-label"] });
    log(`[bench] rating ${id} recorded`);
  } catch (e) { throw new UsageError(e.message); } finally { db.close(); }
  return 0;
}

const HELP = `uwf-bench: benchmark harness for the UWF runner
  bench.mjs run --matrix <matrix.yaml> [--db results.db] [--work <dir>] [--resume] [--keep-repos]
  bench.mjs export --db results.db --out <dir>
  bench.mjs rate --db results.db --run <id> --rater <name> --dimension <d> --score <n> [--score-final n] [--reconciliation r] [--cell-guess c] [--run-label l]
`;

function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { process.stdout.write(HELP); return 0; }
  const flags = parseArgs(argv);
  const fn = { run: cmdRun, export: cmdExport, rate: cmdRate }[cmd];
  if (!fn) throw new UsageError(`unknown command "${cmd}"\n${HELP}`);
  return fn(flags);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    log(`[bench] ${e instanceof UsageError ? e.message : `internal error: ${e.stack ?? e}`}`);
    process.exitCode = 2;
  }
}
