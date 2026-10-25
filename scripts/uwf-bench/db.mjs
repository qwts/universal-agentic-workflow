/**
 * results.db schema and inserts for uwf-bench (better-sqlite3 via the engine skill, see sqlite.mjs).
 * Fields follow docs/research/cli-offload-design.md section 11. Anything a run cannot fill is NULL.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite } from "./sqlite.mjs";

export const SCHEMA_VERSION = 1;
export const DIMENSIONS = ["plan_completeness", "review_accuracy", "acceptance_correctness"];
export const RECONCILIATIONS = ["none", "averaged", "discussed", "third_rater"];

export const RUN_COLUMNS = ["cell", "workflow", "adapter", "model", "state_location", "fixture", "run_index", "block", "seed",
  "claude_cli_version", "runner_sha", "stages_yaml_sha", "fixture_sha", "started_at", "ended_at", "wall_seconds",
  "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "cost_usd", "max_prompt_tokens", "usage_incomplete",
  "terminal_state", "failure_class", "acceptance_pass", "test_file_modified", "first_try_pass_rate", "retries_total",
  "artifact_missing", "exit_code", "stderr_tail", "notes"];

export const OUTCOME_COLUMNS = ["stage", "attempt", "skipped", "gated", "passed", "first_try_pass", "never_passed",
  "gate_failure_reason", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "cost_usd",
  "wall_seconds", "prompt_tokens", "session_id"];

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell TEXT NOT NULL, workflow TEXT, adapter TEXT, model TEXT, state_location TEXT NOT NULL, fixture TEXT NOT NULL,
  run_index INTEGER NOT NULL, block INTEGER, seed INTEGER, claude_cli_version TEXT, runner_sha TEXT, stages_yaml_sha TEXT,
  fixture_sha TEXT, started_at TEXT, ended_at TEXT, wall_seconds REAL, tokens_input INTEGER, tokens_output INTEGER,
  tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, max_prompt_tokens INTEGER,
  usage_incomplete INTEGER NOT NULL DEFAULT 1, terminal_state TEXT, failure_class TEXT, acceptance_pass INTEGER,
  test_file_modified INTEGER, first_try_pass_rate REAL, retries_total INTEGER, artifact_missing INTEGER,
  exit_code INTEGER, stderr_tail TEXT, notes TEXT,
  UNIQUE (cell, fixture, run_index)
);
CREATE TABLE IF NOT EXISTS stage_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(run_id), stage TEXT NOT NULL, attempt INTEGER NOT NULL,
  skipped INTEGER, gated INTEGER, passed INTEGER, first_try_pass INTEGER, never_passed INTEGER, gate_failure_reason TEXT,
  tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL,
  wall_seconds REAL, prompt_tokens INTEGER, session_id TEXT
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_label TEXT, run_id INTEGER NOT NULL REFERENCES runs(run_id), rater TEXT NOT NULL, dimension TEXT NOT NULL,
  score_initial REAL, score_final REAL, reconciliation TEXT NOT NULL DEFAULT 'none', cell_guess TEXT, rated_at TEXT
);`;

/** Open (creating) the database and ensure the schema; safe to call repeatedly. @param {string} path */
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = openSqlite(path);
  db.exec(DDL);
  if (!db.prepare("SELECT 1 FROM schema_version").get()) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}

const nul = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);

function insert(db, table, cols, row) {
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `:${c}`).join(", ")})`)
    .run(Object.fromEntries(cols.map((c) => [c, nul(row[c])])));
  return Number(r.lastInsertRowid);
}

export const hasRun = (db, cell, fixture, runIndex) =>
  !!db.prepare("SELECT 1 FROM runs WHERE cell = ? AND fixture = ? AND run_index = ?").get(cell, fixture, runIndex);

/** Insert a run and its stage outcomes atomically, replacing an earlier row for the same key. Returns run_id. */
export function insertRun(db, run, outcomes) {
  db.exec("BEGIN");
  try {
    const old = db.prepare("SELECT run_id FROM runs WHERE cell = ? AND fixture = ? AND run_index = ?").get(run.cell, run.fixture, run.run_index);
    if (old) {
      db.prepare("DELETE FROM stage_outcomes WHERE run_id = ?").run(old.run_id);
      db.prepare("DELETE FROM ratings WHERE run_id = ?").run(old.run_id);
      db.prepare("DELETE FROM runs WHERE run_id = ?").run(old.run_id);
    }
    const id = insert(db, "runs", RUN_COLUMNS, run);
    for (const o of outcomes) insert(db, "stage_outcomes", ["run_id", ...OUTCOME_COLUMNS], { ...o, run_id: id });
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Insert one human rating. Throws on an unknown run, dimension or reconciliation. */
export function insertRating(db, r) {
  if (!DIMENSIONS.includes(r.dimension)) throw new Error(`dimension must be one of ${DIMENSIONS.join(", ")}`);
  const reconciliation = r.reconciliation ?? "none";
  if (!RECONCILIATIONS.includes(reconciliation)) throw new Error(`reconciliation must be one of ${RECONCILIATIONS.join(", ")}`);
  const run = db.prepare("SELECT run_id, cell, fixture, run_index FROM runs WHERE run_id = ?").get(r.run_id);
  if (!run) throw new Error(`no run with run_id ${r.run_id}`);
  if (!Number.isFinite(r.score)) throw new Error("score must be a number");
  return insert(db, "ratings", ["run_label", "run_id", "rater", "dimension", "score_initial", "score_final", "reconciliation", "cell_guess", "rated_at"], {
    run_label: r.run_label ?? `run-${run.run_id}`, run_id: run.run_id, rater: r.rater, dimension: r.dimension, score_initial: r.score,
    score_final: r.score_final ?? r.score, reconciliation, cell_guess: r.cell_guess, rated_at: new Date().toISOString(),
  });
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text (header, LF line ends, deterministic order) for one table. */
export function tableCsv(db, table) {
  const order = { runs: "run_id", stage_outcomes: "run_id, id", ratings: "id" }[table];
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
