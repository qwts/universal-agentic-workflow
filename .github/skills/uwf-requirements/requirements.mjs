#!/usr/bin/env node
/**
 * UWF Requirements — SQLite-backed CLI for requirements management.
 *
 * Schema is defined by requirements-schema.yaml in this directory.
 * Database: .github/skills/uwf-requirements/uwf-requirements.db
 *
 * Usage:
 *   node .github/skills/uwf-requirements/requirements.mjs <command> [options]
 *
 * Commands:
 *   add       --role <r> --title <text>           Add a requirement; returns assigned id and number
 *             [--type functional|non_functional|data|acceptance_criteria|risk]
 *             [--description <text>]
 *             [--priority must|should|could|wont]
 *             [--source <text>]
 *             [--stage <s>]
 *   update    --id <n> [field flags…]             Update fields on an existing requirement
 *   get       --id <n>                            Get a single requirement record
 *   list      [--role <r>] [--type <t>]           List with optional filters
 *             [--status <s>] [--priority <p>]
 *   accept    --id <n>                            Mark requirement as accepted
 *   defer     --id <n>                            Mark requirement as deferred
 *   reject    --id <n>                            Mark requirement as rejected
 *
 * Exit codes:
 *   0  success
 *   1  operational error (not found, conflict …)
 *   2  usage error (unknown command, missing required flag)
 *
 * All output is JSON to stdout.
 */

import Database from "better-sqlite3";
import yaml from "js-yaml";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "uwf-requirements.db");
const SCHEMA_PATH = join(__dirname, "requirements-schema.yaml");

const VALID_TYPES = ["functional", "non_functional", "data", "acceptance_criteria", "risk"];
const VALID_PRIORITIES = ["must", "should", "could", "wont"];
const VALID_STATUSES = ["draft", "accepted", "deferred", "rejected"];

/** Prefix map for auto-numbering by type. */
const TYPE_PREFIX = {
  functional: "FR",
  non_functional: "NFR",
  data: "DR",
  acceptance_criteria: "AC",
  risk: "RK",
};

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
// Helpers
// ---------------------------------------------------------------------------

/** Return the next number for a given type+role, e.g. "FR-003". */
function nextNumber(db, type, role) {
  const prefix = TYPE_PREFIX[type] ?? "REQ";
  const row = db
    .prepare(
      `SELECT number FROM requirements
       WHERE role = ? AND type = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(role, type);

  if (!row) return `${prefix}-001`;
  const current = Number(row.number.split("-")[1] ?? 0);
  return `${prefix}-${String(current + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdAdd(db) {
  requireFlag("role", "add");
  requireFlag("title", "add");

  const type = flags["type"] ?? "functional";
  if (!VALID_TYPES.includes(type))
    fail(`--type must be one of: ${VALID_TYPES.join(", ")}`);

  const priority = flags["priority"] ?? "must";
  if (!VALID_PRIORITIES.includes(priority))
    fail(`--priority must be one of: ${VALID_PRIORITIES.join(", ")}`);

  const number = nextNumber(db, type, flags["role"]);
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO requirements
         (role, number, type, title, description, priority, status, source, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
    )
    .run(
      flags["role"],
      number,
      type,
      flags["title"],
      flags["description"] ?? null,
      priority,
      flags["source"] ?? null,
      flags["stage"] ?? null,
      now,
      now
    );

  succeed({
    procedure: "add",
    requirement_id: info.lastInsertRowid,
    number,
    requirement: db
      .prepare("SELECT * FROM requirements WHERE id = ?")
      .get(info.lastInsertRowid),
  });
}

function cmdUpdate(db) {
  requireFlag("id", "update");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) fail(`Requirement ${id} not found.`);

  const fieldMap = {
    title: "title",
    type: "type",
    description: "description",
    priority: "priority",
    status: "status",
    source: "source",
    stage: "stage",
  };

  const updates = {};
  for (const [flag, col] of Object.entries(fieldMap)) {
    if (flag in flags) updates[col] = flags[flag];
  }

  if (Object.keys(updates).length === 0)
    fail("No fields to update. Provide at least one flag.");

  if (updates.type && !VALID_TYPES.includes(updates.type))
    fail(`--type must be one of: ${VALID_TYPES.join(", ")}`);
  if (updates.priority && !VALID_PRIORITIES.includes(updates.priority))
    fail(`--priority must be one of: ${VALID_PRIORITIES.join(", ")}`);
  if (updates.status && !VALID_STATUSES.includes(updates.status))
    fail(`--status must be one of: ${VALID_STATUSES.join(", ")}`);

  updates.updated_at = new Date().toISOString();
  const keys = Object.keys(updates);
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  db.prepare(`UPDATE requirements SET ${setClauses} WHERE id = ?`).run(
    ...keys.map((k) => updates[k]),
    id
  );

  succeed({
    procedure: "update",
    requirement: db.prepare("SELECT * FROM requirements WHERE id = ?").get(id),
  });
}

function cmdGet(db) {
  requireFlag("id", "get");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) fail(`Requirement ${id} not found.`);
  succeed({ procedure: "get", requirement: row });
}

function cmdList(db) {
  let query = "SELECT * FROM requirements WHERE 1=1";
  const params = [];

  if (flags["role"])     { query += " AND role = ?";     params.push(flags["role"]);     }
  if (flags["type"])     { query += " AND type = ?";     params.push(flags["type"]);     }
  if (flags["status"])   { query += " AND status = ?";   params.push(flags["status"]);   }
  if (flags["priority"]) { query += " AND priority = ?"; params.push(flags["priority"]); }

  query += " ORDER BY type ASC, number ASC";
  const rows = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: rows.length, requirements: rows });
}

function cmdSetStatus(db, status, procedure) {
  requireFlag("id", procedure);
  const id = Number(flags["id"]);
  if (!db.prepare("SELECT id FROM requirements WHERE id = ?").get(id))
    fail(`Requirement ${id} not found.`);

  db.prepare(
    `UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?`
  ).run(status, new Date().toISOString(), id);

  succeed({
    procedure,
    requirement: db.prepare("SELECT * FROM requirements WHERE id = ?").get(id),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command)
  usageError(
    "No command given. Expected: add | update | get | list | accept | defer | reject"
  );

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

initTable(db);

function cmdReset(db) {
  db.close();
  unlinkSync(DB_PATH);
  succeed({ procedure: "reset", deleted: DB_PATH });
}

switch (command) {
  case "add":    cmdAdd(db);                        break;
  case "update": cmdUpdate(db);                     break;
  case "get":    cmdGet(db);                        break;
  case "list":   cmdList(db);                       break;
  case "accept": cmdSetStatus(db, "accepted", "accept"); break;
  case "defer":  cmdSetStatus(db, "deferred", "defer");  break;
  case "reject": cmdSetStatus(db, "rejected", "reject"); break;
  case "reset":  cmdReset(db); break;
  default:
    usageError(
      `Unknown command: "${command}". Expected: add | update | get | list | accept | defer | reject | reset`
    );
}
