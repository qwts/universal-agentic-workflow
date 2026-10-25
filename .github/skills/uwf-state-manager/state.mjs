/**
 * UWF State Manager — SQLite-backed CLI for workflow state operations.
 *
 * Schema is defined by workflow-schema.yaml in this directory.
 * Issue management lives in uwf-local-tracking/issues.mjs.
 *
 * Database: .github/skills/uwf-state-manager/uwf-state.db
 *
 * Usage:
 *   node .github/skills/uwf-state-manager/state.mjs <command> [options]
 *
 * Commands:
 *   read                                   Read state; print JSON
 *   init [--mode <mode>]                   Initialize fresh DB (clears all data)
 *   advance  --to <phase> --agent <id>     Advance to the next phase
 *            [--note <text>] [--force]
 *   rollback --to <phase> --agent <id>     Roll back to an earlier phase
 *            [--note <text>]
 *   set-agent --agent <id> [--force]       Claim the agent token
 *   release-agent                          Release the agent token
 *   check-ready                            Mark ready_for_implementation
 *   set-status --status <s> --agent <id>   Set status (idle|active|blocked)
 *   set-model-profile --profile <p>        Store resolved model profile
 *                     [--model <model_name>]
 *   sync                                   Derive workflow status from issues.mjs list
 *   note --agent <id> --note <text>        Append a history entry
 *
 * Global options:
 *   --output-path <path>   Default: ./tmp/workflow-artifacts
 *
 * Exit codes:
 *   0  success
 *   1  operational error (validation failure, conflict, missing prereq …)
 *   2  usage error (unknown command, missing required flag)
 *
 * All output is JSON to stdout.
 */

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveDataDir, resolveDbPath } from "./data-dir.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolveDbPath(process.argv.slice(2), "uwf-state.db", __dirname);
const WORKFLOW_SCHEMA_PATH = join(__dirname, "workflow-schema.yaml");

const VALID_PHASES = ["idea", "intake", "discovery", "planning", "execution", "acceptance", "snapshot", "closed"];
const VALID_STATUSES = ["idle", "active", "blocked"];
const PHASE_ORDER = Object.fromEntries(VALID_PHASES.map((p, i) => [p, i]));

// Same rule as stage-tracker.mjs: artifacts live under <data-dir>/workflow-artifacts
// when a data dir is chosen, else the shared ./tmp/workflow-artifacts.
const DATA_DIR = resolveDataDir(process.argv.slice(2), undefined);
const DEFAULT_OUTPUT_PATH = DATA_DIR ? join(DATA_DIR, "workflow-artifacts") : "./tmp/workflow-artifacts";
const CHILD_ENV = { ...process.env, ...(DATA_DIR ? { UWF_DATA_DIR: DATA_DIR } : {}) };

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const [command, ...restArgs] = rawArgs;

const flags = parseFlags(restArgs);
const outputPath = flags["output-path"] ?? DEFAULT_OUTPUT_PATH;

if (!command) {
  usageError("No command provided.");
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  initTables(db);
  return db;
}

/**
 * Read workflow-schema.yaml and CREATE TABLE IF NOT EXISTS for each table.
 * Seeds the single workflow_state row (id=1) if absent.
 * Also applies lightweight migrations for columns added after initial schema.
 */
function initTables(db) {
  const workflowSchema = yaml.load(readFileSync(WORKFLOW_SCHEMA_PATH, "utf8"));

  db.transaction(() => {
    for (const [tableName, tableDef] of Object.entries(workflowSchema.tables)) {
      db.exec(buildCreateTable(tableName, tableDef.columns));
    }

    // Lightweight migration: add new columns to existing workflow_state tables.
    // PRAGMA table_info returns one row per column; we check for absence and ALTER TABLE.
    const existingCols = new Set(
      db.prepare("PRAGMA table_info(workflow_state)").all().map((c) => c.name)
    );
    const allCols = workflowSchema.tables.workflow_state.columns;
    for (const col of allCols) {
      if (!existingCols.has(col.name) && !col.primary_key) {
        let colDef = `${col.type}`;
        if (col.default !== undefined) {
          const val = typeof col.default === "string" ? `'${col.default}'` : col.default;
          colDef += ` DEFAULT ${val}`;
        }
        db.exec(`ALTER TABLE workflow_state ADD COLUMN "${col.name}" ${colDef}`);
      }
    }

    const row = db.prepare("SELECT id FROM workflow_state WHERE id = 1").get();
    if (!row) {
      db.prepare(
        `INSERT INTO workflow_state
           (id, phase, mode, status, current_agent, artifact_path, ready_for_implementation)
         VALUES (1, 'idea', NULL, 'idle', NULL, './tmp/workflow-artifacts', 0)`
      ).run();
    }
  })();
}

function buildCreateTable(tableName, columns) {
  const colDefs = columns.map((col) => {
    let def = `"${col.name}" ${col.type}`;
    if (col.primary_key && col.autoincrement) def += " PRIMARY KEY AUTOINCREMENT";
    else if (col.primary_key) def += " PRIMARY KEY";
    if (col.not_null) def += " NOT NULL";
    if (col.default !== undefined) {
      const val = typeof col.default === "string" ? `'${col.default}'` : col.default;
      def += ` DEFAULT ${val}`;
    }
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function readState(db) {
  const row = db.prepare("SELECT * FROM workflow_state WHERE id = 1").get();
  const history = db
    .prepare("SELECT ts, from_phase, to_phase, agent, note FROM workflow_history ORDER BY id ASC")
    .all();
  return {
    phase: row.phase,
    mode: row.mode,
    status: row.status,
    current_agent: row.current_agent,
    artifact_path: row.artifact_path,
    ready_for_implementation: !!row.ready_for_implementation,
    model_profile: row.model_profile ?? null,
    model_name: row.model_name ?? null,
    history,
  };
}

function updateState(db, fields) {
  const keys = Object.keys(fields);
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  db.prepare(`UPDATE workflow_state SET ${setClauses} WHERE id = 1`).run(...keys.map((k) => fields[k]));
}

function appendHistory(db, fromPhase, toPhase, agent, note) {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_history (ts, from_phase, to_phase, agent, note) VALUES (?, ?, ?, ?, ?)`
  ).run(ts, fromPhase, toPhase, agent, note ?? "");
  return { ts, from_phase: fromPhase, to_phase: toPhase, agent, note: note ?? "" };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
  const db = openDb();
  switch (command) {
    case "read":          cmdRead(db); break;
    case "init":          cmdInit(db); break;
    case "advance":       cmdAdvance(db); break;
    case "rollback":      cmdRollback(db); break;
    case "set-agent":     cmdSetAgent(db); break;
    case "release-agent": cmdReleaseAgent(db); break;
    case "check-ready":   cmdCheckReady(db); break;
    case "set-status":    cmdSetStatus(db); break;
    case "set-model-profile": cmdSetModelProfile(db); break;
    case "sync":          cmdSync(db); break;
    case "note":          cmdNote(db); break;
    case "reset":         cmdReset(db); break;
    default:
      usageError(`Unknown command: "${command}"`);
  }
} catch (err) {
  fail(err.message);
}

// ---------------------------------------------------------------------------
// Commands — workflow state
// ---------------------------------------------------------------------------

function cmdRead(db) {
  const state = readState(db);
  succeed({ procedure: "read", state });
}

function cmdInit(db) {
  const mode = flags["mode"] ?? null;
  db.transaction(() => {
    db.prepare("DELETE FROM workflow_history").run();
    db.prepare(
      `UPDATE workflow_state
       SET phase = 'idea', mode = ?, status = 'idle', current_agent = NULL,
           artifact_path = ?, ready_for_implementation = 0
       WHERE id = 1`
    ).run(mode, outputPath);
  })();
  succeed({ procedure: "init", mode, state: readState(db) });
}

function cmdAdvance(db) {
  requireFlag("to", "advance");
  requireFlag("agent", "advance");

  const toPhase = flags["to"];
  const agent = flags["agent"];
  const note = flags["note"] ?? "";
  const force = "force" in flags;

  validatePhase(toPhase);

  const state = readState(db);
  const fromPhase = state.phase ?? "idea";

  if (!force) {
    const fromIdx = PHASE_ORDER[fromPhase] ?? -1;
    const toIdx = PHASE_ORDER[toPhase];
    if (toIdx !== fromIdx + 1) {
      fail(
        `Illegal phase advance: "${fromPhase}" → "${toPhase}". ` +
        `Expected: "${VALID_PHASES[fromIdx + 1] ?? "(none)"}". Use --force to override.`
      );
    }
  }

  const entry = db.transaction(() => {
    updateState(db, { phase: toPhase, status: "active" });
    return appendHistory(db, fromPhase, toPhase, agent, note);
  })();

  succeed({ procedure: "advance", from_phase: fromPhase, to_phase: toPhase, agent, history_entry: entry, state: readState(db) });
}

function cmdRollback(db) {
  requireFlag("to", "rollback");
  requireFlag("agent", "rollback");

  const toPhase = flags["to"];
  const agent = flags["agent"];
  const rawNote = flags["note"] ?? "";

  validatePhase(toPhase);

  const state = readState(db);
  const fromPhase = state.phase ?? "idea";

  if (PHASE_ORDER[toPhase] >= PHASE_ORDER[fromPhase]) {
    fail(`Rollback target "${toPhase}" is not earlier than current phase "${fromPhase}".`);
  }

  const note = `ROLLBACK: ${rawNote}`.trimEnd();
  const entry = db.transaction(() => {
    updateState(db, { phase: toPhase, status: "active" });
    return appendHistory(db, fromPhase, toPhase, agent, note);
  })();

  succeed({
    procedure: "rollback",
    from_phase: fromPhase,
    to_phase: toPhase,
    agent,
    history_entry: entry,
    artifacts_to_regenerate: artifactsForPhase(toPhase, outputPath),
    state: readState(db),
  });
}

function cmdSetAgent(db) {
  requireFlag("agent", "set-agent");
  const agent = flags["agent"];
  const force = "force" in flags;

  const state = readState(db);
  const prev = state.current_agent;

  if (prev && prev !== agent && !force) {
    fail(`Token conflict: "${prev}" currently holds the agent token. Use --force to override.`);
  }

  updateState(db, { current_agent: agent });
  succeed({ procedure: "set-agent", previous: prev, current_agent: agent, state: readState(db) });
}

function cmdReleaseAgent(db) {
  const state = readState(db);
  const prev = state.current_agent;
  updateState(db, { current_agent: null });
  succeed({ procedure: "release-agent", previous: prev, current_agent: null, state: readState(db) });
}

function cmdCheckReady(db) {
  const state = readState(db);
  const phaseIdx = PHASE_ORDER[state.phase ?? "idea"] ?? 0;
  const missing = [];

  const intakePath = join(outputPath, "issues-intake.md");
  const planPath = join(outputPath, "issues-plan.md");

  if (!fileNonEmpty(intakePath)) missing.push(intakePath);
  if (!fileNonEmpty(planPath)) missing.push(planPath);
  if (phaseIdx < PHASE_ORDER["planning"]) {
    missing.push(`phase must be "planning" or later (current: "${state.phase}")`);
  }

  if (missing.length > 0) fail("ready_for_implementation prerequisites not met", { missing });

  updateState(db, { ready_for_implementation: 1 });
  succeed({ procedure: "check-ready", ready_for_implementation: true, state: readState(db) });
}

function cmdSetStatus(db) {
  requireFlag("status", "set-status");
  requireFlag("agent", "set-status");

  const newStatus = flags["status"];
  const agent = flags["agent"];

  if (!VALID_STATUSES.includes(newStatus)) {
    fail(`Invalid status "${newStatus}". Must be one of: ${VALID_STATUSES.join(", ")}.`);
  }

  const state = readState(db);
  const prevStatus = state.status;

  db.transaction(() => {
    if (prevStatus !== newStatus) appendHistory(db, state.phase, state.phase, agent, `status → ${newStatus}`);
    updateState(db, { status: newStatus });
  })();

  succeed({ procedure: "set-status", previous_status: prevStatus, status: newStatus, state: readState(db) });
}

function cmdSetModelProfile(db) {
  requireFlag("profile", "set-model-profile");

  const profile = flags["profile"];
  const modelName = flags["model"] ?? null;

  const VALID_PROFILES = ["compact", "balanced", "reasoning"];
  if (!VALID_PROFILES.includes(profile)) {
    fail(`Invalid profile "${profile}". Must be one of: ${VALID_PROFILES.join(", ")}.`);
  }

  updateState(db, { model_profile: profile, model_name: modelName });
  succeed({ procedure: "set-model-profile", model_profile: profile, model_name: modelName, state: readState(db) });
}

function cmdSync(db) {
  // Read the issues store of the same run: forward the data dir to the child.
  const issuesCli = join(__dirname, "..", "uwf-local-tracking", "issues.mjs");
  const raw = execFileSync(process.execPath, [issuesCli, "list"], { encoding: "utf8", env: CHILD_ENV });
  const { issues } = JSON.parse(raw);
  const counts = { open: 0, active: 0, closed: 0 };
  for (const iss of (issues ?? [])) {
    if (iss.status === "open")        counts.open++;
    else if (iss.status === "active") counts.active++;
    else if (iss.status === "closed") counts.closed++;
  }

  const state = readState(db);
  const before = { status: state.status, phase: state.phase, ready_for_implementation: state.ready_for_implementation };
  let changed = false;

  db.transaction(() => {
    if (counts.active > 0) {
      if (state.status !== "active") { updateState(db, { status: "active" }); changed = true; }
    } else if (counts.open === 0 && counts.active === 0 && counts.closed > 0) {
      if (state.status !== "idle") { updateState(db, { status: "idle" }); changed = true; }
      if (state.phase === "execution") {
        updateState(db, { phase: "acceptance" });
        appendHistory(db, "execution", "acceptance", "sync", "All issues closed; auto-advancing to acceptance.");
        changed = true;
      }
    }

    const intakePath = join(outputPath, "issues-intake.md");
    const planPath = join(outputPath, "issues-plan.md");
    const phaseIdx = PHASE_ORDER[state.phase ?? "idea"] ?? 0;
    const newReady = fileNonEmpty(intakePath) && fileNonEmpty(planPath) && phaseIdx >= PHASE_ORDER["planning"];

    if (Boolean(newReady) !== Boolean(state.ready_for_implementation)) {
      updateState(db, { ready_for_implementation: newReady ? 1 : 0 });
      changed = true;
    }
  })();

  const after = readState(db);
  succeed({
    procedure: "sync",
    changed,
    issue_counts: counts,
    before,
    after: { status: after.status, phase: after.phase, ready_for_implementation: after.ready_for_implementation },
    state: after,
  });
}

function cmdNote(db) {
  requireFlag("agent", "note");
  requireFlag("note", "note");
  const state = readState(db);
  const entry = appendHistory(db, state.phase, state.phase, flags["agent"], flags["note"]);
  succeed({ procedure: "note", history_entry: entry, state: readState(db) });
}

function cmdReset(db) {
  db.close();
  unlinkSync(DB_PATH);
  succeed({ procedure: "reset", deleted: DB_PATH });
}
// ---------------------------------------------------------------------------

function fileNonEmpty(filePath) {
  const abs = resolve(filePath);
  return existsSync(abs) && statSync(abs).size > 0;
}

function artifactsForPhase(toPhase, artPath) {
  const map = {
    idea: [],
    intake: [`${artPath}/{mode}-intake.md`],
    discovery: [`${artPath}/{mode}-intake.md`, `${artPath}/{mode}-discovery.md`],
    planning: [`${artPath}/{mode}-intake.md`, `${artPath}/{mode}-discovery.md`, `${artPath}/{mode}-plan.md`],
    execution: [],
    acceptance: [`${artPath}/{mode}-acceptance.md`],
    snapshot: [`${artPath}/{mode}-drs.json`, `${artPath}/{mode}-br.json`],
    closed: [],
  };
  return map[toPhase] ?? [];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validatePhase(phase) {
  if (!VALID_PHASES.includes(phase)) {
    usageError(`Unknown phase: "${phase}". Valid: ${VALID_PHASES.join(", ")}.`);
  }
}

function requireFlag(name, cmd) {
  if (!(name in flags) || !flags[name]) {
    usageError(`Command "${cmd}" requires --${name}.`);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function succeed(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
  process.exit(0);
}

function fail(message, extras = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extras }, null, 2) + "\n");
  process.exit(1);
}

function usageError(message) {
  process.stderr.write(`Usage error: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Flag parser  --key value  or  --flag (boolean)
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[++i];
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}
