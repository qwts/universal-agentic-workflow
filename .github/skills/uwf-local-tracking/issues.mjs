#!/usr/bin/env node
/**
 * UWF Local Tracking — SQLite-backed CLI for issue management.
 *
 * Schema is defined by issues-schema.yaml in this directory.
 * Database: .github/skills/uwf-local-tracking/uwf-issues.db
 *
 * Usage:
 *   node .github/skills/uwf-local-tracking/issues.mjs <command> [options]
 *
 * Commands:
 *   create --id <id> --title <text>        Create a new issue
 *          [--status <s>] [--phase <p>]
 *          [--milestone <m>] [--sprint <s>]
 *          [--description <text>]
 *          [--assigned-agent <id>]
 *          [--risk <text>] [--unknowns <text>]
 *          [--depends-on <ids>]
 *          [--parallel true|false]
 *          [--comments <text>]
 *   update   --id <id> [field flags…]          Update fields on an existing issue
 *   list     [--status <s>] [--milestone <m>] [--sprint <s>]
 *   close    --id <id>                         Set issue status to "closed"
 *   activate --id <id>                         Set issue status to "active"
 *   skip     --id <id> [--reason <text>]       Set issue status to "skipped"
 *   next     [--milestone <m>] [--sprint <s>]  Find next eligible open issue(s)
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
const DB_PATH = join(__dirname, "uwf-issues.db");
const SCHEMA_PATH = join(__dirname, "issues-schema.yaml");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

/** @type {Record<string,string|boolean>} */
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

/**
 * Build a CREATE TABLE IF NOT EXISTS statement from a column definition array.
 * Supports: primary_key, autoincrement, not_null, default.
 */
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
  // Migrate: add columns that may not exist in older DBs
  for (const col of schema.columns) {
    try {
      db.exec(`ALTER TABLE "${schema.table}" ADD COLUMN ${col.name} ${col.type}${col.default !== undefined ? ` DEFAULT ${col.default}` : ""}`);
    } catch { /* column already exists — ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCreate(db) {
  requireFlag("id", "create");
  requireFlag("title", "create");

  const id = flags["id"];
  if (db.prepare("SELECT id FROM issues WHERE id = ?").get(id)) {
    fail(`Issue "${id}" already exists.`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO issues
       (id, title, status, phase, milestone, sprint, description,
        assigned_agent, risk, unknowns, depends_on, parallel, comments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    flags["title"],
    flags["status"] ?? "open",
    flags["phase"] ?? null,
    flags["milestone"] ?? null,
    flags["sprint"] ?? null,
    flags["description"] ?? null,
    flags["assigned-agent"] ?? null,
    flags["risk"] ?? null,
    flags["unknowns"] ?? null,
    flags["depends-on"] ?? null,
    flags["parallel"] === "true" ? 1 : 0,
    flags["comments"] ?? null,
    now, now
  );

  succeed({ procedure: "create", issue: db.prepare("SELECT * FROM issues WHERE id = ?").get(id) });
}

function cmdUpdate(db) {
  requireFlag("id", "update");
  const id = flags["id"];

  if (!db.prepare("SELECT id FROM issues WHERE id = ?").get(id)) {
    fail(`Issue "${id}" not found.`);
  }

  const fieldMap = {
    title: "title", status: "status", phase: "phase",
    milestone: "milestone", sprint: "sprint", description: "description",
    "assigned-agent": "assigned_agent", risk: "risk",
    unknowns: "unknowns", "depends-on": "depends_on",
    parallel: "parallel", comments: "comments",
  };

  const updates = {};
  for (const [flag, col] of Object.entries(fieldMap)) {
    if (flag in flags) updates[col] = flags[flag];
  }

  if (Object.keys(updates).length === 0) fail("No fields to update. Provide at least one flag.");

  updates.updated_at = new Date().toISOString();
  const keys = Object.keys(updates);
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  db.prepare(`UPDATE issues SET ${setClauses} WHERE id = ?`).run(...keys.map((k) => updates[k]), id);

  succeed({ procedure: "update", issue: db.prepare("SELECT * FROM issues WHERE id = ?").get(id) });
}

function cmdList(db) {
  let query = "SELECT * FROM issues WHERE 1=1";
  const params = [];

  if (flags["status"])    { query += " AND status = ?";    params.push(flags["status"]); }
  if (flags["milestone"]) { query += " AND milestone = ?"; params.push(flags["milestone"]); }
  if (flags["sprint"])    { query += " AND sprint = ?";    params.push(flags["sprint"]); }

  query += " ORDER BY created_at ASC";
  const issues = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: issues.length, issues });
}

function cmdClose(db) {
  requireFlag("id", "close");
  const id = flags["id"];

  if (!db.prepare("SELECT id FROM issues WHERE id = ?").get(id)) {
    fail(`Issue "${id}" not found.`);
  }

  db.prepare(`UPDATE issues SET status = 'closed', updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(), id
  );
  succeed({ procedure: "close", issue: db.prepare("SELECT * FROM issues WHERE id = ?").get(id) });
}

function cmdActivate(db) {
  requireFlag("id", "activate");
  const id = flags["id"];
  if (!db.prepare("SELECT id FROM issues WHERE id = ?").get(id)) fail(`Issue "${id}" not found.`);
  db.prepare(`UPDATE issues SET status = 'active', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  succeed({ procedure: "activate", issue: db.prepare("SELECT * FROM issues WHERE id = ?").get(id) });
}

function cmdSkip(db) {
  requireFlag("id", "skip");
  const id = flags["id"];
  if (!db.prepare("SELECT id FROM issues WHERE id = ?").get(id)) fail(`Issue "${id}" not found.`);
  const comments = flags["reason"] ? `skip reason: ${flags["reason"]}` : "skipped";
  db.prepare(`UPDATE issues SET status = 'skipped', comments = ?, updated_at = ? WHERE id = ?`).run(
    comments, new Date().toISOString(), id
  );
  succeed({ procedure: "skip", issue: db.prepare("SELECT * FROM issues WHERE id = ?").get(id) });
}

function cmdNext(db) {
  let query = "SELECT * FROM issues WHERE status = 'open'";
  const params = [];
  if (flags["milestone"]) { query += " AND milestone = ?"; params.push(flags["milestone"]); }
  if (flags["sprint"])    { query += " AND sprint = ?";    params.push(flags["sprint"]); }
  query += " ORDER BY created_at ASC";

  const open = db.prepare(query).all(...params);
  const activeIds = new Set(
    db.prepare("SELECT id FROM issues WHERE status = 'active'").all().map((r) => r.id)
  );

  const eligible = [];
  const blocked = [];

  for (const issue of open) {
    const deps = issue.depends_on ? issue.depends_on.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const unmet = deps.filter((dep) => {
      const dep_row = db.prepare("SELECT status FROM issues WHERE id = ?").get(dep);
      return !dep_row || dep_row.status !== "closed";
    });
    if (unmet.length === 0) {
      eligible.push(issue);
    } else {
      blocked.push({ id: issue.id, title: issue.title, waiting_on: unmet });
    }
  }

  const exhausted = open.length === 0 && activeIds.size === 0;
  succeed({ procedure: "next", exhausted, eligible, blocked });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command) usageError("No command given. Expected: create | update | list | close");

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
  case "create":   cmdCreate(db);   break;
  case "update":   cmdUpdate(db);   break;
  case "list":     cmdList(db);     break;
  case "close":    cmdClose(db);    break;
  case "activate": cmdActivate(db); break;
  case "skip":     cmdSkip(db);     break;
  case "next":     cmdNext(db);     break;
  case "reset":    cmdReset(db);    break;
  default:
    usageError(`Unknown command: "${command}". Expected: create | update | list | close | activate | skip | next | reset`);
}
