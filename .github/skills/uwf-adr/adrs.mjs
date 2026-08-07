#!/usr/bin/env node
/**
 * UWF ADR — SQLite-backed CLI for Architecture Decision Record management.
 *
 * Schema is defined by adr-schema.yaml in this directory.
 * Database: .github/skills/uwf-adr/uwf-adrs.db
 *
 * Usage:
 *   node .github/skills/uwf-adr/adrs.mjs <command> [options]
 *
 * Commands:
 *   create  --title <text> --decision <text>   Register a new ADR; scaffolds docs/adr/ADR-####-<slug>.md
 *           [--impact low|medium|high]
 *           [--stage <s>]
 *           [--output-path <path>]             Default: docs/adr
 *   update  --id <n> [field flags…]            Update fields on an existing ADR
 *   get     --id <n>                           Get a single ADR record
 *   list    [--status <s>] [--impact <s>]      List ADRs with optional filters
 *   supersede --id <n> --by <n>               Mark an ADR as superseded by another
 *   deprecate --id <n>                        Mark an ADR as deprecated
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
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "uwf-adrs.db");
const SCHEMA_PATH = join(__dirname, "adr-schema.yaml");
const TEMPLATE_PATH = join(__dirname, "templates", "adr.template.md");

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

/** Convert a title to a URL-safe kebab slug. */
function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Return the next zero-padded ADR number string (e.g. "0004"). */
function nextNumber(db) {
  const row = db.prepare("SELECT number FROM adrs ORDER BY id DESC LIMIT 1").get();
  if (!row) return "0001";
  return String(Number(row.number) + 1).padStart(4, "0");
}

/** Scaffold the markdown file from the template. */
function scaffoldFile(outputDir, number, title, decision, today) {
  const slug = toSlug(title);
  const fileName = `ADR-${number}-${slug}.md`;
  const filePath = join(outputDir, fileName);

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const template = existsSync(TEMPLATE_PATH)
    ? readFileSync(TEMPLATE_PATH, "utf8")
    : DEFAULT_TEMPLATE;

  const content = template
    .replace(/ADR-####/g, `ADR-${number}`)
    .replace(/<Title>/g, title)
    .replace(/<YYYY-MM-DD>/g, today)
    .replace(/Status: Proposed \| Accepted \| Deprecated \| Superseded/g, "Status: Proposed")
    .replace(/- The decision, stated crisply\./g, `- ${decision}`);

  writeFileSync(filePath, content, "utf8");
  return { filePath: join(outputDir, fileName).replace(/\\/g, "/"), slug };
}

// Fallback if template file is missing
const DEFAULT_TEMPLATE = `# ADR-####: <Title>

Date: <YYYY-MM-DD>
Status: Proposed | Accepted | Deprecated | Superseded

## Context
- What problem are we solving?
- What constraints exist?
- What is the current state?

## Decision
- The decision, stated crisply.

## Alternatives considered
1) <alt 1>
2) <alt 2>
3) <alt 3>

## Consequences
- Positive
- Negative
- Follow-ups

## Security / Privacy / Compliance notes
- Trust boundaries
- Data classification
- Credential/secrets approach

## Verification
- How we prove this works (tests, load, security checks)

## Appendix A — ADR-300 Checklist
> Add checkbox sections by domain; mark N/A explicitly.
`;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCreate(db) {
  requireFlag("title", "create");
  requireFlag("decision", "create");

  const impact = flags["impact"] ?? "medium";
  const validImpacts = ["low", "medium", "high"];
  if (!validImpacts.includes(impact)) fail(`--impact must be one of: ${validImpacts.join(", ")}`);

  const number = nextNumber(db);
  const slug = toSlug(flags["title"]);
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const outputDir = flags["output-path"] ?? "docs/adr";
  const { filePath } = scaffoldFile(outputDir, number, flags["title"], flags["decision"], today);

  const info = db.prepare(
    `INSERT INTO adrs
       (number, slug, title, status, impact, stage, decision, file_path, created_at, updated_at)
     VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`
  ).run(
    number,
    slug,
    flags["title"],
    impact,
    flags["stage"] ?? null,
    flags["decision"],
    filePath,
    now, now
  );

  succeed({
    procedure: "create",
    adr: db.prepare("SELECT * FROM adrs WHERE id = ?").get(info.lastInsertRowid),
  });
}

function cmdUpdate(db) {
  requireFlag("id", "update");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM adrs WHERE id = ?").get(id);
  if (!row) fail(`ADR ${id} not found.`);

  const fieldMap = {
    title: "title", status: "status", impact: "impact",
    stage: "stage", decision: "decision", "file-path": "file_path",
    "superseded-by": "superseded_by",
  };

  const updates = {};
  for (const [flag, col] of Object.entries(fieldMap)) {
    if (flag in flags) updates[col] = flags[flag];
  }

  if (Object.keys(updates).length === 0) fail("No fields to update. Provide at least one flag.");

  updates.updated_at = new Date().toISOString();
  const keys = Object.keys(updates);
  const setClauses = keys.map((k) => `"${k}" = ?`).join(", ");
  db.prepare(`UPDATE adrs SET ${setClauses} WHERE id = ?`).run(...keys.map((k) => updates[k]), id);

  succeed({ procedure: "update", adr: db.prepare("SELECT * FROM adrs WHERE id = ?").get(id) });
}

function cmdGet(db) {
  requireFlag("id", "get");
  const id = Number(flags["id"]);
  const row = db.prepare("SELECT * FROM adrs WHERE id = ?").get(id);
  if (!row) fail(`ADR ${id} not found.`);
  succeed({ procedure: "get", adr: row });
}

function cmdList(db) {
  let query = "SELECT * FROM adrs WHERE 1=1";
  const params = [];

  if (flags["status"]) { query += " AND status = ?"; params.push(flags["status"]); }
  if (flags["impact"]) { query += " AND impact = ?"; params.push(flags["impact"]); }

  query += " ORDER BY number ASC";
  const adrs = db.prepare(query).all(...params);
  succeed({ procedure: "list", count: adrs.length, adrs });
}

function cmdSupersede(db) {
  requireFlag("id", "supersede");
  requireFlag("by", "supersede");

  const id = Number(flags["id"]);
  const byId = Number(flags["by"]);

  const row = db.prepare("SELECT * FROM adrs WHERE id = ?").get(id);
  if (!row) fail(`ADR ${id} not found.`);

  const byRow = db.prepare("SELECT * FROM adrs WHERE id = ?").get(byId);
  if (!byRow) fail(`ADR ${byId} (the superseding ADR) not found.`);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE adrs SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`
  ).run(byRow.number, now, id);

  succeed({ procedure: "supersede", adr: db.prepare("SELECT * FROM adrs WHERE id = ?").get(id) });
}

function cmdDeprecate(db) {
  requireFlag("id", "deprecate");
  const id = Number(flags["id"]);

  if (!db.prepare("SELECT id FROM adrs WHERE id = ?").get(id)) fail(`ADR ${id} not found.`);

  db.prepare(
    `UPDATE adrs SET status = 'deprecated', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);

  succeed({ procedure: "deprecate", adr: db.prepare("SELECT * FROM adrs WHERE id = ?").get(id) });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!command) usageError("No command given. Expected: create | update | get | list | supersede | deprecate");

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
  case "create":    cmdCreate(db);    break;
  case "update":    cmdUpdate(db);    break;
  case "get":       cmdGet(db);       break;
  case "list":      cmdList(db);      break;
  case "supersede": cmdSupersede(db); break;
  case "deprecate": cmdDeprecate(db); break;
  case "reset":     cmdReset(db);     break;
  default:
    usageError(`Unknown command: "${command}". Expected: create | update | get | list | supersede | deprecate | reset`);
}
