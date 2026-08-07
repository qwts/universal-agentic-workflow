#!/usr/bin/env node
/**
 * UWF Review — SQLite-backed CLI for review runs and findings.
 *
 * Schema is defined by review-schema.yaml in this directory.
 * Database: .github/skills/uwf-review/uwf-reviews.db
 *
 * Usage:
 *   node .github/skills/uwf-review/reviews.mjs <command> [options]
 *
 * Commands:
 *   start          --role <r> --stage <s> [--notes <text>]
 *                  Open a new review run; returns review_id
 *   finding        --review-id <n> --description <text>
 *                  [--severity critical|major|minor]
 *                  [--file-path <path>]
 *                  Add a finding to a review; returns finding_id
 *   verdict        --review-id <n> --verdict approved|changes_requested|rejected
 *                  [--notes <text>]
 *                  Set the final verdict on a review
 *   get            --review-id <n>
 *                  Get a review record with all its findings
 *   list           [--role <r>] [--stage <s>] [--verdict <v>]
 *                  List review runs
 *   list-findings  --review-id <n> [--severity <s>] [--status <s>]
 *                  List findings for a review (use for gate checks)
 *   close-finding  --id <n>
 *                  Mark a finding as fixed
 *   reopen         --id <n>
 *                  Reopen a finding (e.g. fix was incomplete)
 *
 * Exit codes:
 *   0  success / gate pass (list-findings returns zero open critical/major)
 *   1  operational error or gate fail
 *   2  usage error
 *
 * All output is JSON to stdout.
 */

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "uwf-reviews.db");
const SCHEMA_PATH = join(__dirname, "review-schema.yaml");

const VALID_SEVERITIES = ["critical", "major", "minor"];
const VALID_VERDICTS   = ["approved", "changes_requested", "rejected", "pending"];
const VALID_STATUSES   = ["open", "fixed", "wontfix"];

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

function initTables(db) {
  const schema = yaml.load(readFileSync(SCHEMA_PATH, "utf8"));
  for (const t of schema.tables) {
    db.exec(buildCreateTable(t.table, t.columns));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdStart(db) {
  requireFlag("role", "start");
  requireFlag("stage", "start");

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO reviews (role, stage, verdict, notes, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`
    )
    .run(flags["role"], flags["stage"], flags["notes"] ?? null, now, now);

  succeed({
    procedure: "start",
    review_id: info.lastInsertRowid,
    review: db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid),
  });
}

function cmdFinding(db) {
  requireFlag("review-id", "finding");
  requireFlag("description", "finding");

  const reviewId = Number(flags["review-id"]);
  if (!db.prepare("SELECT id FROM reviews WHERE id = ?").get(reviewId))
    fail(`Review ${reviewId} not found.`);

  const severity = flags["severity"] ?? "major";
  if (!VALID_SEVERITIES.includes(severity))
    fail(`--severity must be one of: ${VALID_SEVERITIES.join(", ")}`);

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO findings (review_id, severity, status, file_path, description, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(reviewId, severity, flags["file-path"] ?? null, flags["description"], now, now);

  succeed({
    procedure: "finding",
    finding_id: info.lastInsertRowid,
    finding: db.prepare("SELECT * FROM findings WHERE id = ?").get(info.lastInsertRowid),
  });
}

function cmdVerdict(db) {
  requireFlag("review-id", "verdict");
  requireFlag("verdict", "verdict");

  const reviewId = Number(flags["review-id"]);
  const verdict = flags["verdict"];

  if (!db.prepare("SELECT id FROM reviews WHERE id = ?").get(reviewId))
    fail(`Review ${reviewId} not found.`);

  if (!VALID_VERDICTS.includes(verdict))
    fail(`--verdict must be one of: ${VALID_VERDICTS.join(", ")}`);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE reviews SET verdict = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`
  ).run(verdict, flags["notes"] ?? null, now, reviewId);

  succeed({
    procedure: "verdict",
    review: db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId),
  });
}

function cmdGet(db) {
  requireFlag("review-id", "get");
  const reviewId = Number(flags["review-id"]);
  const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId);
  if (!review) fail(`Review ${reviewId} not found.`);

  const findings = db
    .prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY severity ASC, id ASC")
    .all(reviewId);

  succeed({ procedure: "get", review, findings });
}

function cmdList(db) {
  let query = "SELECT * FROM reviews WHERE 1=1";
  const params = [];

  if (flags["role"])    { query += " AND role = ?";    params.push(flags["role"]);    }
  if (flags["stage"])   { query += " AND stage = ?";   params.push(flags["stage"]);   }
  if (flags["verdict"]) { query += " AND verdict = ?"; params.push(flags["verdict"]); }

  query += " ORDER BY id DESC";
  const rows = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: rows.length, reviews: rows });
}

function cmdListFindings(db) {
  requireFlag("review-id", "list-findings");
  const reviewId = Number(flags["review-id"]);

  if (!db.prepare("SELECT id FROM reviews WHERE id = ?").get(reviewId))
    fail(`Review ${reviewId} not found.`);

  let query = "SELECT * FROM findings WHERE review_id = ?";
  const params = [reviewId];

  if (flags["severity"]) { query += " AND severity = ?"; params.push(flags["severity"]); }
  if (flags["status"])   { query += " AND status = ?";   params.push(flags["status"]);   }

  query += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id ASC";
  const rows = db.prepare(query).all(...params);

  // Gate semantics: exit 1 if any open critical or major findings remain
  const blockers = rows.filter(
    (r) => r.status === "open" && (r.severity === "critical" || r.severity === "major")
  );

  if (blockers.length > 0) {
    console.log(
      JSON.stringify({ ok: false, gate: "fail", blocker_count: blockers.length, findings: rows }, null, 2)
    );
    process.exit(1);
  }

  succeed({ procedure: "list-findings", gate: "pass", count: rows.length, findings: rows });
}

function cmdCloseFinding(db) {
  requireFlag("id", "close-finding");
  const id = Number(flags["id"]);
  if (!db.prepare("SELECT id FROM findings WHERE id = ?").get(id))
    fail(`Finding ${id} not found.`);

  db.prepare(
    `UPDATE findings SET status = 'fixed', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);

  succeed({
    procedure: "close-finding",
    finding: db.prepare("SELECT * FROM findings WHERE id = ?").get(id),
  });
}

function cmdReopen(db) {
  requireFlag("id", "reopen");
  const id = Number(flags["id"]);
  if (!db.prepare("SELECT id FROM findings WHERE id = ?").get(id))
    fail(`Finding ${id} not found.`);

  db.prepare(
    `UPDATE findings SET status = 'open', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);

  succeed({
    procedure: "reopen",
    finding: db.prepare("SELECT * FROM findings WHERE id = ?").get(id),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command)
  usageError(
    "No command given. Expected: start | finding | verdict | get | list | list-findings | close-finding | reopen"
  );

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

initTables(db);

function cmdReset(db) {
  db.close();
  unlinkSync(DB_PATH);
  succeed({ procedure: "reset", deleted: DB_PATH });
}

switch (command) {
  case "start":         cmdStart(db);        break;
  case "finding":       cmdFinding(db);      break;
  case "verdict":       cmdVerdict(db);      break;
  case "get":           cmdGet(db);          break;
  case "list":          cmdList(db);         break;
  case "list-findings": cmdListFindings(db); break;
  case "close-finding": cmdCloseFinding(db); break;
  case "reopen":        cmdReopen(db);       break;
  case "reset":         cmdReset(db);        break;
  default:
    usageError(
      `Unknown command: "${command}". Expected: start | finding | verdict | get | list | list-findings | close-finding | reopen | reset`
    );
}
