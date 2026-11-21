#!/usr/bin/env node
/**
 * UWF Question Protocol — SQLite-backed CLI for question logging and dependency tracking.
 *
 * Schema is defined by questions-schema.yaml in this directory.
 * Database: .github/skills/uwf-question-protocol/uwf-questions.db
 *
 * Usage:
 *   node .github/skills/uwf-question-protocol/questions.mjs <command> [options]
 *
 * Commands:
 *   log    --stage <s> --question <text>   Log a question; returns a numeric ID
 *          [--group <g>] [--proposed <text>] [--required true|false]
 *   answer --id <n> --answer <text>        Record the user's answer
 *   skip   --id <n>                        Mark a question skipped (unblocks gate)
 *   list   [--stage <s>] [--status <s>]    List questions (default: all)
 *   check  --stage <s>                     Gate check: are all required questions answered?
 *          [--ids <n,n,…>]                 Optionally scope to specific question IDs
 *   clear  --stage <s>                     Delete all questions for a stage (reset)
 *
 * Exit codes:
 *   0  success / gate pass
 *   1  gate fail (pending required questions remain) / operational error
 *   2  usage error (unknown command, missing required flag)
 *
 * All output is JSON to stdout.
 */

import { openDatabase } from "../uwf-state-manager/sqlite.mjs";
import yaml from "js-yaml";
import { resolveDbPath } from "../uwf-state-manager/data-dir.mjs";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolveDbPath(process.argv.slice(2), "uwf-questions.db", __dirname);
const SCHEMA_PATH = join(__dirname, "questions-schema.yaml");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

/** @type {Record<string, string | boolean>} */
const flags = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function succeed(data) {
  console.log(JSON.stringify({ ok: true, ...data }, null, 2));
  process.exit(0);
}

function fail(message, code = 1) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

function usageError(message) {
  fail(message, 2);
}

function requireFlag(name, cmd) {
  if (!flags[name]) usageError(`--${name} is required for ${cmd}`);
}

// ---------------------------------------------------------------------------
// Schema + DB init
// ---------------------------------------------------------------------------

function buildCreateTable(tableName, columns) {
  const colDefs = columns.map((col) => {
    let def = `  "${col.name}" ${col.type}`;
    if (col.primary_key) def += " PRIMARY KEY";
    if (col.autoincrement) def += " AUTOINCREMENT";
    if (col.not_null) def += " NOT NULL";
    if (col.default !== undefined) def += ` DEFAULT ${JSON.stringify(col.default)}`;
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${colDefs.join(",\n")}\n);`;
}

function initTable(db) {
  const schema = yaml.load(readFileSync(SCHEMA_PATH, "utf8"));
  db.exec(buildCreateTable(schema.table, schema.columns));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Log a question. Returns the assigned numeric ID so the caller can store it
 * in workflow state as an unanswered dependency.
 */
function cmdLog(db) {
  requireFlag("stage", "log");
  requireFlag("question", "log");

  const required = flags["required"] !== "false" ? 1 : 0;
  const now = new Date().toISOString();

  const info = db.prepare(
    `INSERT INTO questions
       (stage, group_name, question, proposed, required, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    flags["stage"],
    flags["group"] ?? null,
    flags["question"],
    flags["proposed"] ?? null,
    required,
    now
  );

  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(info.lastInsertRowid);
  succeed({ procedure: "log", question_id: row.id, question: row });
}

const VALID_EXPECTED_STATUSES = new Set(["pending", "answered", "skipped"]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Fail-closed check: only explicit false/0/"0"/"false"/"no" are optional. */
function isOptionalRequiredValue(val) {
  if (val === 0 || val === false) return true;
  if (typeof val === "string") {
    const norm = val.trim().toLowerCase();
    return norm === "0" || norm === "false" || norm === "no";
  }
  return false;
}

function parseCasFlags() {
  const expectedStatus = flags["expected-status"];
  if (expectedStatus !== undefined) {
    if (typeof expectedStatus !== "string" || !VALID_EXPECTED_STATUSES.has(expectedStatus)) {
      usageError(
        `--expected-status must be one of: ${[...VALID_EXPECTED_STATUSES].join(", ")}`,
      );
    }
  }
  const expectedQuestionSha256 = flags["expected-question-sha256"];
  if (expectedQuestionSha256 !== undefined) {
    if (typeof expectedQuestionSha256 !== "string" || !SHA256_HEX_RE.test(expectedQuestionSha256)) {
      usageError("--expected-question-sha256 must be a 64-character lowercase hex SHA-256 digest");
    }
  }
  return { expectedStatus, expectedQuestionSha256 };
}

function runImmediateQuestionCas(db, id, { expectedStatus, expectedQuestionSha256 }, mutateFn) {
  const failRolledBack = (msg) => {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    fail(msg);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
    if (!row) failRolledBack(`Question ${id} not found.`);
    if (expectedStatus !== undefined && row.status !== expectedStatus) {
      failRolledBack(`Question ${id} status is "${row.status}", expected "${expectedStatus}".`);
    }
    if (expectedQuestionSha256 !== undefined) {
      const actualHash = createHash("sha256")
        .update(String(row.question ?? ""), "utf8")
        .digest("hex");
      if (actualHash !== expectedQuestionSha256) {
        failRolledBack(`Question ${id} text changed (expected SHA-256 mismatch).`);
      }
    }
    const updated = mutateFn(row, failRolledBack);
    db.exec("COMMIT");
    return updated;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Record a user's answer. Sets status → "answered".
 */
function cmdAnswer(db) {
  requireFlag("id", "answer");
  requireFlag("answer", "answer");

  const id = Number(flags["id"]);
  const cas = parseCasFlags();
  const question = runImmediateQuestionCas(db, id, cas, (row, failRolledBack) => {
    if (row.status === "answered") {
      failRolledBack(`Question ${id} is already answered.`);
    }
    const now = new Date().toISOString();
    const info = cas.expectedStatus !== undefined
      ? db.prepare(
          `UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = ?`
        ).run(flags["answer"], now, id, cas.expectedStatus)
      : db.prepare(
          `UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`
        ).run(flags["answer"], now, id);
    if (info.changes !== 1) {
      failRolledBack(`Question ${id} could not be updated atomically (status changed concurrently).`);
    }
    return db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
  });

  succeed({ procedure: "answer", question });
}

/**
 * Skip a question (unblocks the gate for non-critical questions marked required=false,
 * or when the orchestrator decides to proceed anyway).
 */
function cmdSkip(db) {
  requireFlag("id", "skip");

  const id = Number(flags["id"]);
  const cas = parseCasFlags();
  const rejectRequired = flags["reject-required"] === true;
  const question = runImmediateQuestionCas(db, id, cas, (row, failRolledBack) => {
    if (rejectRequired && !isOptionalRequiredValue(row.required)) {
      failRolledBack(`Question ${id} is required and cannot be skipped.`);
    }
    const info = cas.expectedStatus !== undefined
      ? db.prepare(
          `UPDATE questions SET status = 'skipped' WHERE id = ? AND status = ?`
        ).run(id, cas.expectedStatus)
      : db.prepare(
          `UPDATE questions SET status = 'skipped' WHERE id = ?`
        ).run(id);
    if (info.changes !== 1) {
      failRolledBack(`Question ${id} could not be skipped atomically (status changed concurrently).`);
    }
    return db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
  });

  succeed({ procedure: "skip", question });
}

/**
 * List questions with optional filters.
 */
function cmdList(db) {
  let query = "SELECT * FROM questions WHERE 1=1";
  const params = [];

  if (flags["stage"])  { query += " AND stage = ?";  params.push(flags["stage"]); }
  if (flags["status"]) { query += " AND status = ?"; params.push(flags["status"]); }

  query += " ORDER BY id ASC";
  const questions = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: questions.length, questions });
}

/**
 * Gate check: exit 0 if all required questions for the stage (or given IDs) are
 * answered/skipped; exit 1 if any are still pending.
 */
function cmdCheck(db) {
  requireFlag("stage", "check");

  let pending;

  if (flags["ids"]) {
    const ids = String(flags["ids"]).split(",").map(Number).filter(Boolean);
    if (ids.length === 0) fail("--ids must be a comma-separated list of integers.");

    const placeholders = ids.map(() => "?").join(", ");
    pending = db.prepare(
      `SELECT * FROM questions
       WHERE id IN (${placeholders})
         AND required = 1
         AND status = 'pending'`
    ).all(...ids);
  } else {
    pending = db.prepare(
      `SELECT * FROM questions
       WHERE stage = ?
         AND required = 1
         AND status = 'pending'`
    ).all(flags["stage"]);
  }

  if (pending.length === 0) {
    succeed({ procedure: "check", gate: "pass", pending_count: 0, pending: [] });
  } else {
    // exit code 1 — gate fail
    console.log(
      JSON.stringify(
        { ok: false, procedure: "check", gate: "fail", pending_count: pending.length, pending },
        null, 2
      )
    );
    process.exit(1);
  }
}

/**
 * Clear all questions for a stage (useful for re-runs / reset).
 */
function cmdClear(db) {
  requireFlag("stage", "clear");

  const info = db.prepare("DELETE FROM questions WHERE stage = ?").run(flags["stage"]);
  succeed({ procedure: "clear", stage: flags["stage"], deleted: info.changes });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command) usageError("No command given. Expected: log | answer | skip | list | check | clear");

const db = openDatabase(DB_PATH, { wal: true, foreignKeys: true });

initTable(db);

function cmdReset(db) {
  db.close();
  unlinkSync(DB_PATH);
  succeed({ procedure: "reset", deleted: DB_PATH });
}

switch (command) {
  case "log":    cmdLog(db);    break;
  case "answer": cmdAnswer(db); break;
  case "skip":   cmdSkip(db);   break;
  case "list":   cmdList(db);   break;
  case "check":  cmdCheck(db);  break;
  case "clear":  cmdClear(db);  break;
  case "reset":  cmdReset(db);  break;
  default:
    usageError(`Unknown command: "${command}". Expected: log | answer | skip | list | check | clear | reset`);
}
