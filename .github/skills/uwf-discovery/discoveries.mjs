#!/usr/bin/env node
/**
 * UWF Discovery — SQLite-backed CLI for workspace discovery logging.
 *
 * Schema is defined by discovery-schema.yaml in this directory.
 * Database: .github/skills/uwf-discovery/uwf-discoveries.db
 *
 * Usage:
 *   node .github/skills/uwf-discovery/discoveries.mjs <command> [options]
 *
 * Commands:
 *   log       --role <r> --title <text>          Log a new discovery; returns assigned id
 *             [--category workspace_structure|dependency|code_pattern|gap|unknown|recommendation]
 *             [--description <text>]
 *             [--evidence <text>]
 *             [--impact low|medium|high]
 *             [--stage <s>]
 *   update    --id <n> [field flags…]            Update fields on an existing discovery
 *   get       --id <n>                           Get a single discovery record
 *   list      [--role <r>] [--category <c>]      List discoveries with optional filters
 *             [--status <s>] [--impact <i>]
 *   gaps      [--role <r>]                       Shorthand: list category=gap, status=open
 *   close     --id <n>                           Mark a discovery as addressed
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
const DB_PATH = join(__dirname, "uwf-discoveries.db");
const SCHEMA_PATH = join(__dirname, "discovery-schema.yaml");

const VALID_CATEGORIES = [
  "workspace_structure",
  "dependency",
  "code_pattern",
  "gap",
  "unknown",
  "recommendation",
];
const VALID_IMPACTS = ["low", "medium", "high"];
const VALID_STATUSES = ["open", "addressed", "deferred", "wontfix"];

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

function cmdLog(db) {
  requireFlag("role", "log");
  requireFlag("title", "log");

  const category = flags["category"] ?? "gap";
  if (!VALID_CATEGORIES.includes(category))
    fail(`--category must be one of: ${VALID_CATEGORIES.join(", ")}`);

  const impact = flags["impact"] ?? "medium";
  if (!VALID_IMPACTS.includes(impact))
    fail(`--impact must be one of: ${VALID_IMPACTS.join(", ")}`);

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO discoveries
         (role, stage, category, title, description, evidence, impact, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(
      flags["role"],
      flags["stage"] ?? null,
      category,
      flags["title"],
      flags["description"] ?? null,
      flags["evidence"] ?? null,
      impact,
      now,
      now
    );

  succeed({
    procedure: "log",
    discovery_id: info.lastInsertRowid,
    discovery: db
      .prepare("SELECT * FROM discoveries WHERE id = ?")
      .get(info.lastInsertRowid),
  });
}

function cmdUpdate(db) {
  requireFlag("id", "update");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM discoveries WHERE id = ?").get(id);
  if (!row) fail(`Discovery ${id} not found.`);

  const fieldMap = {
    role: "role",
    stage: "stage",
    category: "category",
    title: "title",
    description: "description",
    evidence: "evidence",
    impact: "impact",
    status: "status",
  };

  const updates = {};
  for (const [flag, col] of Object.entries(fieldMap)) {
    if (flag in flags) updates[col] = flags[flag];
  }

  if (Object.keys(updates).length === 0)
    fail("No fields to update. Provide at least one flag.");

  if (updates.category && !VALID_CATEGORIES.includes(updates.category))
    fail(`--category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  if (updates.impact && !VALID_IMPACTS.includes(updates.impact))
    fail(`--impact must be one of: ${VALID_IMPACTS.join(", ")}`);
  if (updates.status && !VALID_STATUSES.includes(updates.status))
    fail(`--status must be one of: ${VALID_STATUSES.join(", ")}`);

  updates.updated_at = new Date().toISOString();
  const keys = Object.keys(updates);
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  db.prepare(`UPDATE discoveries SET ${setClauses} WHERE id = ?`).run(
    ...keys.map((k) => updates[k]),
    id
  );

  succeed({
    procedure: "update",
    discovery: db.prepare("SELECT * FROM discoveries WHERE id = ?").get(id),
  });
}

function cmdGet(db) {
  requireFlag("id", "get");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM discoveries WHERE id = ?").get(id);
  if (!row) fail(`Discovery ${id} not found.`);
  succeed({ procedure: "get", discovery: row });
}

function cmdList(db) {
  let query = "SELECT * FROM discoveries WHERE 1=1";
  const params = [];

  if (flags["role"])     { query += " AND role = ?";     params.push(flags["role"]);     }
  if (flags["category"]) { query += " AND category = ?"; params.push(flags["category"]); }
  if (flags["status"])   { query += " AND status = ?";   params.push(flags["status"]);   }
  if (flags["impact"])   { query += " AND impact = ?";   params.push(flags["impact"]);   }

  query += " ORDER BY id ASC";
  const rows = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: rows.length, discoveries: rows });
}

function cmdGaps(db) {
  let query =
    "SELECT * FROM discoveries WHERE category = 'gap' AND status = 'open'";
  const params = [];
  if (flags["role"]) { query += " AND role = ?"; params.push(flags["role"]); }
  query += " ORDER BY impact DESC, id ASC";
  const rows = db.prepare(query).all(...params);
  succeed({ procedure: "gaps", count: rows.length, discoveries: rows });
}

function cmdClose(db) {
  requireFlag("id", "close");
  const id = Number(flags["id"]);
  if (!db.prepare("SELECT id FROM discoveries WHERE id = ?").get(id))
    fail(`Discovery ${id} not found.`);

  db.prepare(
    `UPDATE discoveries SET status = 'addressed', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);

  succeed({
    procedure: "close",
    discovery: db.prepare("SELECT * FROM discoveries WHERE id = ?").get(id),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command)
  usageError(
    "No command given. Expected: log | update | get | list | gaps | close"
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
  case "log":    cmdLog(db);    break;
  case "update": cmdUpdate(db); break;
  case "get":    cmdGet(db);    break;
  case "list":   cmdList(db);   break;
  case "gaps":   cmdGaps(db);   break;
  case "close":  cmdClose(db);  break;
  case "reset":  cmdReset(db);  break;
  default:
    usageError(
      `Unknown command: "${command}". Expected: log | update | get | list | gaps | close | reset`
    );
}
