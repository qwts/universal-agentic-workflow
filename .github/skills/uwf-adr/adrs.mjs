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
 * Global options:
 *   --db-path <path>                           Override the SQLite path
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
import { resolveDbPath } from "../uwf-state-manager/data-dir.mjs";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "adr-schema.yaml");
const TEMPLATE_PATH = join(__dirname, "templates", "adr.template.md");
const VALID_IMPACTS = ["low", "medium", "high"];
const VALID_STATUSES = ["proposed", "accepted", "deprecated", "superseded"];

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
const DB_PATH = resolveDbPath(flags, "uwf-adrs.db", __dirname);

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

/** Return the next zero-padded ADR number across the DB and committed files. */
function nextNumber(db, outputDir) {
  // `next-number` runs without a DB: optional chaining would short-circuit the whole chain, but say it plainly.
  const row = db ? db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS max_number FROM adrs").get() : null;
  let maxNumber = Number(row?.max_number ?? 0);

  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir)) {
      const match = name.match(/^ADR-(\d+)(?:-|\.md$)/i);
      if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
    }
  }

  return String(maxNumber + 1).padStart(4, "0");
}

/** Render the markdown for one ADR from the template. */
function renderAdr(number, title, decision, today) {
  const template = existsSync(TEMPLATE_PATH)
    ? readFileSync(TEMPLATE_PATH, "utf8")
    : DEFAULT_TEMPLATE;

  return template
    .replace(/ADR-####/g, `ADR-${number}`)
    .replace(/<Title>/g, title)
    .replace(/<YYYY-MM-DD>/g, today)
    .replace(/Status: Proposed \| Accepted \| Deprecated \| Superseded/g, "Status: Proposed")
    .replace(/- The decision, stated crisply\./g, `- ${decision}`);
}

const CLAIM_STALE_MS = 30_000;
const RESERVE_TIMEOUT_MS = Number(process.env.UWF_ADR_RESERVE_TIMEOUT_MS) || 10_000; // env: test hook only
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readClaim = (claim) => { try { return JSON.parse(readFileSync(claim, "utf8")); } catch { return null; } };

/**
 * A claim may be reclaimed only when it is old AND its owner is gone. Age alone is not enough: a
 * paused-but-alive holder would otherwise be displaced and both callers would publish the number.
 * An unreadable claim (owner still writing it, or foreign) counts as owned until it is old.
 */
function claimReclaimable(claim) {
  let mtimeMs;
  try { mtimeMs = statSync(claim).mtimeMs; } catch { return false; } // released meanwhile
  if (Date.now() - mtimeMs <= CLAIM_STALE_MS) return false;
  const owner = readClaim(claim);
  return !(owner && Number.isInteger(owner.pid) && pidAlive(owner.pid));
}

const RECLAIM_STALE_MS = 10_000;

/**
 * Remove a dead-owner claim under a reclaim mutex (a directory: mkdir is atomic) that records its
 * owner pid, re-checking inside it that the claim is still the very one inspected (same token) and
 * still reclaimable. A delayed reclaimer can therefore never unlink a replacement claim that a live
 * caller created meanwhile. The mutex is reclaimed only when its owner pid is dead, or when it has no
 * readable owner and is older than RECLAIM_STALE_MS. Returns true when the claim was removed.
 */
function reclaimClaim(outputDir, claim) {
  if (!claimReclaimable(claim)) return false;
  const mutex = join(outputDir, ".adr-reclaim");
  const ownerFile = join(mutex, "owner");
  const ownerPid = () => { try { return Number(readFileSync(ownerFile, "utf8")); } catch { return null; } };
  try {
    mkdirSync(mutex);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = ownerPid();
    const dead = Number.isInteger(pid) && pid > 0 ? !pidAlive(pid) : false;
    let old = false;
    try { old = Date.now() - statSync(mutex).mtimeMs > RECLAIM_STALE_MS; } catch { /* vanished */ }
    if (dead || (pid === null && old)) { try { if (ownerPid() === pid) rmSync(mutex, { recursive: true, force: true }); } catch { /* vanished */ } }
    return false;
  }
  writeFileSync(ownerFile, String(process.pid));
  try {
    const seen = readClaim(claim);
    if (!claimReclaimable(claim)) return false;
    if (readClaim(claim)?.token !== seen?.token) return false; // replaced since we looked: not ours to remove
    try { unlinkSync(claim); } catch { return false; }
    return true;
  } finally {
    if (ownerPid() === process.pid) rmSync(mutex, { recursive: true, force: true });
  }
}

/**
 * Atomically reserve the next ADR number and write its scaffold. Concurrent callers (parallel
 * fronts on one repo) never receive the same number: a claim file `.adr-NNNN.claim` is created
 * with the `wx` flag and stamped {pid, token}, the directory is rescanned while holding it (a
 * caller that finished just before us has already written its file, so we see its number), the
 * claim is re-read to confirm it is still ours, and only then is the real file written. A claim
 * is reclaimed only when it is older than CLAIM_STALE_MS and its owner pid is dead; a holder only
 * ever removes its own claim.
 */
function reserveAdr(db, outputDir, title, decision, today) {
  const slug = toSlug(title);
  mkdirSync(outputDir, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + RESERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const number = nextNumber(db, outputDir);
    const claim = join(outputDir, `.adr-${number}.claim`);
    const mine = () => readClaim(claim)?.token === token;
    const release = () => { try { if (mine()) unlinkSync(claim); } catch { /* already gone */ } };
    let fd;
    try {
      fd = openSync(claim, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!reclaimClaim(outputDir, claim)) sleepMs(5 + Math.random() * 20); // a live holder is still writing: back off, then rescan
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, title, at: new Date().toISOString() }));
    } finally { closeSync(fd); }
    try {
      if (nextNumber(db, outputDir) !== number) continue; // someone took it between our scan and claim
      if (process.env.UWF_ADR_TEST_DELAY_MS) sleepMs(Number(process.env.UWF_ADR_TEST_DELAY_MS)); // test hook: force contention
      if (!mine()) continue; // displaced (only possible if our pid was judged dead): never publish over the new owner
      const filePath = join(outputDir, `ADR-${number}-${slug}.md`);
      writeFileSync(filePath, renderAdr(number, title, decision, today), { encoding: "utf8", flag: "wx" });
      return { number, slug, filePath: filePath.replace(/\\/g, "/") };
    } finally {
      release();
    }
  }
  fail(`Could not reserve an ADR number within ${RESERVE_TIMEOUT_MS / 1000}s.`);
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
  if (!VALID_IMPACTS.includes(impact)) {
    fail(`--impact must be one of: ${VALID_IMPACTS.join(", ")}`);
  }

  const outputDir = flags["output-path"] ?? "docs/adr";
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const { number, slug, filePath } = reserveAdr(db, outputDir, flags["title"], flags["decision"], today);

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

/** Reserve the next number and scaffold the file only (no DB row); prints {number, path}. */
function cmdNextNumber() {
  requireFlag("title", "next-number");
  const outputDir = flags["output-path"] ?? "docs/adr";
  const today = new Date().toISOString().slice(0, 10);
  const { number, filePath } = reserveAdr(null, outputDir, flags["title"], flags["decision"] ?? "TBD", today);
  succeed({ procedure: "next-number", number, path: filePath });
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
  if ("status" in updates && !VALID_STATUSES.includes(updates.status)) {
    fail(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  if ("impact" in updates && !VALID_IMPACTS.includes(updates.impact)) {
    fail(`--impact must be one of: ${VALID_IMPACTS.join(", ")}`);
  }

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

if (!command) usageError("No command given. Expected: create | next-number | update | get | list | supersede | deprecate");

if (command === "next-number") cmdNextNumber();

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
    usageError(`Unknown command: "${command}". Expected: create | next-number | update | get | list | supersede | deprecate | reset`);
}
