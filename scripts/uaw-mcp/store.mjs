/**
 * store.mjs — Strictly read-only CQRS queries across UAW SQLite stores,
 * runner-routing.json, and secret-scrubbed transcripts.
 *
 * Invariants (ADR-0008):
 *   - Opens every SQLite database with `{ readonly: true, fileMustExist: true }`
 *     and executes `PRAGMA query_only = ON` immediately.
 *   - Never creates directories or `.db` files and never issues SQLite writes
 *     (SQLite's WAL read path may still map transient `-shm` memory on active DBs).
 *   - Scrubs every free-text field and transcript payload through `redactSecrets()`
 *     in `scripts/hooks/secret-patterns.mjs` before returning.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../hooks/secret-patterns.mjs";
import { assertRegularFileInDir, readRegularFileBounded, readRunMeta, UsageError } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SKILLS_DIR = join(REPO_ROOT, ".github", "skills");

let cachedDatabaseCtor = null;

function loadDatabaseCtor() {
  if (cachedDatabaseCtor) return cachedDatabaseCtor;
  const candidates = [
    join(SKILLS_DIR, "uwf-state-manager", "package.json"),
    join(SKILLS_DIR, "uwf-orchestration-engine", "package.json"),
    join(SKILLS_DIR, "uwf-question-protocol", "package.json"),
  ];
  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      const req = createRequire(pkgPath);
      const mod = req("better-sqlite3");
      cachedDatabaseCtor = mod?.default ?? mod;
      return cachedDatabaseCtor;
    } catch {
      /* try next skill install */
    }
  }
  throw new Error(
    "better-sqlite3 not found; run npm ci in .github/skills/uwf-state-manager",
  );
}

/**
 * Recursively redact all secret-shaped substrings in any JSON-serializable value.
 * Returns `{ value, redactions }`.
 */
export function redactDeep(value) {
  let redactions = 0;
  function walk(v) {
    if (typeof v === "string") {
      const res = redactSecrets(v);
      redactions += res.count;
      return res.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const keyRes = redactSecrets(k);
        redactions += keyRes.count;
        let safeKey = keyRes.text;
        if (Object.hasOwn(out, safeKey)) {
          let suffix = 2;
          while (Object.hasOwn(out, `${safeKey}#${suffix}`)) suffix++;
          safeKey = `${safeKey}#${suffix}`;
        }
        Object.defineProperty(out, safeKey, {
          value: walk(val),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    return v;
  }
  return { value: walk(value), redactions };
}

/**
 * Open a SQLite database strictly read-only (`readonly: true`, `PRAGMA query_only = ON`).
 * Returns `null` if the database file does not exist (zero side effects).
 */
function withReadOnlyDb(dbPath, fn) {
  const absDb = resolve(dbPath);
  const absDir = dirname(absDb);
  const base = basename(absDb);
  const realDb = assertRegularFileInDir(absDir, base, base);
  if (!realDb) return null;
  assertRegularFileInDir(absDir, `${base}-wal`, `${base}-wal`);
  assertRegularFileInDir(absDir, `${base}-shm`, `${base}-shm`);
  assertRegularFileInDir(absDir, `${base}-journal`, `${base}-journal`);
  const inoBefore = statSync(realDb).ino;
  const Database = loadDatabaseCtor();
  const db = new Database(realDb, { readonly: true, fileMustExist: true });
  try {
    const realAfter = assertRegularFileInDir(absDir, base, base);
    if (!realAfter || statSync(realAfter).ino !== inoBefore) {
      throw new UsageError(`${base} changed concurrently while opening read-only`);
    }
    assertRegularFileInDir(absDir, `${base}-wal`, `${base}-wal`);
    assertRegularFileInDir(absDir, `${base}-shm`, `${base}-shm`);
    assertRegularFileInDir(absDir, `${base}-journal`, `${base}-journal`);
    db.pragma("query_only = ON");
    return fn(db);
  } finally {
    db.close();
  }
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function safeJsonParse(raw) {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function assertOptionalFilter(val, label) {
  if (val !== undefined && val !== null && typeof val !== "string" && typeof val !== "number") {
    throw new UsageError(`${label} filter must be a string or number`);
  }
  return val;
}

/**
 * Read `uwf-state.db` (`workflow_state` + `workflow_history`) + `run-meta.json`.
 */
export function readState(dataDir) {
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-state.db");
  const snapshot = withReadOnlyDb(dbPath, (db) => {
    const row = tableExists(db, "workflow_state")
      ? db.prepare("SELECT * FROM workflow_state WHERE id = 1").get()
      : null;
    const history = tableExists(db, "workflow_history")
      ? db
          .prepare("SELECT id, ts, from_phase, to_phase, agent, note FROM workflow_history ORDER BY id ASC")
          .all()
      : [];
    if (!row) return { exists: true, state: null, history };
    return {
      exists: true,
      state: {
        phase: row.phase,
        mode: row.mode ?? null,
        status: row.status,
        current_agent: row.current_agent ?? null,
        artifact_path: row.artifact_path,
        ready_for_implementation: Boolean(row.ready_for_implementation),
        model_profile: row.model_profile ?? null,
        model_name: row.model_name ?? null,
        history,
      },
    };
  });

  const payload = {
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    run_meta: meta,
    exists: snapshot !== null,
    state: snapshot?.state ?? null,
  };
  return redactDeep(payload).value;
}

/**
 * Read `uwf-stages.db` (`stage_runs` + `stage_history`) + `runner-routing.json`.
 */
export function readStages(dataDir, { workflow } = {}) {
  assertOptionalFilter(workflow, "workflow");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const wf = workflow ?? meta?.workflow ?? null;
  const dbPath = join(absDir, "uwf-stages.db");

  const snapshot = withReadOnlyDb(dbPath, (db) => {
    let stageRuns = [];
    if (tableExists(db, "stage_runs")) {
      stageRuns = wf
        ? db.prepare("SELECT * FROM stage_runs WHERE workflow = ? ORDER BY id ASC").all(wf)
        : db.prepare("SELECT * FROM stage_runs ORDER BY id ASC").all();
    }
    let stageHistory = [];
    if (tableExists(db, "stage_history")) {
      stageHistory = wf
        ? db.prepare("SELECT * FROM stage_history WHERE workflow = ? ORDER BY id ASC").all(wf)
        : db.prepare("SELECT * FROM stage_history ORDER BY id ASC").all();
    }
    return {
      stage_runs: stageRuns.map((r) => ({
        ...r,
        run_as_subagent: Boolean(r.run_as_subagent),
        gate_result: safeJsonParse(r.gate_result),
      })),
      stage_history: stageHistory,
    };
  });

  let routing = { trips: {}, findings: {} };
  const rawRouting = readRegularFileBounded(absDir, "runner-routing.json", {
    maxBytes: 4 * 1024 * 1024,
    label: "runner-routing.json",
  });
  if (rawRouting !== null) {
    try {
      const parsed = JSON.parse(rawRouting);
      routing = {
        trips: parsed?.trips ?? {},
        findings: parsed?.findings ?? {},
      };
    } catch {
      /* ignore unreadable routing file */
    }
  }

  const payload = {
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    workflow: wf,
    exists: snapshot !== null,
    stage_runs: snapshot?.stage_runs ?? [],
    stage_history: snapshot?.stage_history ?? [],
    routing,
  };
  return redactDeep(payload).value;
}

/**
 * Read gate verdict, retry count, and routing details for a specific stage.
 */
export function readGate(dataDir, stageName, { workflow } = {}) {
  if (!stageName || typeof stageName !== "string") {
    throw new UsageError("stage is required");
  }
  const stagesData = readStages(dataDir, { workflow });
  const stageRun = stagesData.stage_runs.find((s) => s.stage === stageName) ?? null;
  const stageHistory = stagesData.stage_history.filter((h) => h.stage === stageName);
  const trips = Object.fromEntries(
    Object.entries(stagesData.routing.trips ?? {}).filter(([k]) => k.startsWith(`${stageName}|`)),
  );
  const findings = stagesData.routing.findings?.[stageName] ?? null;
  return {
    run_id: stagesData.run_id,
    data_dir: stagesData.data_dir,
    workflow: stagesData.workflow,
    stage: stageName,
    found: stageRun !== null,
    status: stageRun?.status ?? null,
    retry_count: stageRun?.retry_count ?? 0,
    session_id: stageRun?.session_id ?? null,
    gate_result: stageRun?.gate_result ?? null,
    notes: stageRun?.notes ?? null,
    history: stageHistory,
    routing: { trips, findings },
  };
}

/**
 * Read `uwf-requirements.db` (`requirements`).
 */
export function readRequirements(dataDir, { role, type, status, priority } = {}) {
  assertOptionalFilter(role, "role");
  assertOptionalFilter(type, "type");
  assertOptionalFilter(status, "status");
  assertOptionalFilter(priority, "priority");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-requirements.db");
  const rows = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "requirements")) return [];
    let sql = "SELECT * FROM requirements WHERE 1=1";
    const params = [];
    if (role) { sql += " AND role = ?"; params.push(role); }
    if (type) { sql += " AND type = ?"; params.push(type); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (priority) { sql += " AND priority = ?"; params.push(priority); }
    sql += " ORDER BY type ASC, number ASC";
    return db.prepare(sql).all(...params);
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: rows !== null,
    count: rows?.length ?? 0,
    requirements: rows ?? [],
  }).value;
}

/**
 * Read `uwf-adrs.db` (`adrs`).
 */
export function readAdrs(dataDir, { status, impact } = {}) {
  assertOptionalFilter(status, "status");
  assertOptionalFilter(impact, "impact");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-adrs.db");
  const rows = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "adrs")) return [];
    let sql = "SELECT * FROM adrs WHERE 1=1";
    const params = [];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (impact) { sql += " AND impact = ?"; params.push(impact); }
    sql += " ORDER BY number ASC";
    return db.prepare(sql).all(...params);
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: rows !== null,
    count: rows?.length ?? 0,
    adrs: rows ?? [],
  }).value;
}

/**
 * Read `uwf-discoveries.db` (`discoveries`).
 */
export function readDiscoveries(dataDir, { role, category, status, impact, gaps_only } = {}) {
  assertOptionalFilter(role, "role");
  assertOptionalFilter(category, "category");
  assertOptionalFilter(status, "status");
  assertOptionalFilter(impact, "impact");
  if (gaps_only !== undefined && typeof gaps_only !== "boolean") {
    throw new UsageError("gaps_only filter must be a boolean");
  }
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-discoveries.db");
  const rows = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "discoveries")) return [];
    let sql = "SELECT * FROM discoveries WHERE 1=1";
    const params = [];
    if (role) { sql += " AND role = ?"; params.push(role); }
    if (gaps_only) {
      sql += " AND category = 'gap' AND status = 'open'";
    } else {
      if (category) { sql += " AND category = ?"; params.push(category); }
      if (status) { sql += " AND status = ?"; params.push(status); }
    }
    if (impact) { sql += " AND impact = ?"; params.push(impact); }
    sql += " ORDER BY id ASC";
    return db.prepare(sql).all(...params);
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: rows !== null,
    count: rows?.length ?? 0,
    discoveries: rows ?? [],
  }).value;
}

/**
 * Read `uwf-issues.db` (`issues`).
 */
export function readIssues(dataDir, { status, milestone, sprint } = {}) {
  assertOptionalFilter(status, "status");
  assertOptionalFilter(milestone, "milestone");
  assertOptionalFilter(sprint, "sprint");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-issues.db");
  const rows = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "issues")) return [];
    let sql = "SELECT * FROM issues WHERE 1=1";
    const params = [];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (milestone) { sql += " AND milestone = ?"; params.push(milestone); }
    if (sprint) { sql += " AND sprint = ?"; params.push(sprint); }
    sql += " ORDER BY created_at ASC";
    return db.prepare(sql).all(...params);
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: rows !== null,
    count: rows?.length ?? 0,
    issues: rows ?? [],
  }).value;
}

/**
 * Read `uwf-reviews.db` (`reviews` + `findings`).
 */
export function readReviews(dataDir, { role, stage, verdict, severity, status } = {}) {
  assertOptionalFilter(role, "role");
  assertOptionalFilter(stage, "stage");
  assertOptionalFilter(verdict, "verdict");
  assertOptionalFilter(severity, "severity");
  assertOptionalFilter(status, "status");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-reviews.db");
  const snapshot = withReadOnlyDb(dbPath, (db) => {
    let reviews = [];
    if (tableExists(db, "reviews")) {
      let sql = "SELECT * FROM reviews WHERE 1=1";
      const params = [];
      if (role) { sql += " AND role = ?"; params.push(role); }
      if (stage) { sql += " AND stage = ?"; params.push(stage); }
      if (verdict) { sql += " AND verdict = ?"; params.push(verdict); }
      sql += " ORDER BY id DESC";
      reviews = db.prepare(sql).all(...params);
    }
    const reviewFiltered = Boolean(role || stage || verdict);
    let findings = [];
    if (tableExists(db, "findings")) {
      if (reviewFiltered && reviews.length === 0) {
        findings = [];
      } else {
        let sql = "SELECT * FROM findings WHERE 1=1";
        const params = [];
        if (reviewFiltered) {
          const ids = reviews.map((r) => r.id);
          sql += ` AND review_id IN (${ids.map(() => "?").join(", ")})`;
          params.push(...ids);
        }
        if (severity) { sql += " AND severity = ?"; params.push(severity); }
        if (status) { sql += " AND status = ?"; params.push(status); }
        sql += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id ASC";
        findings = db.prepare(sql).all(...params);
      }
    }
    return { reviews, findings };
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: snapshot !== null,
    count: snapshot?.reviews?.length ?? 0,
    reviews: snapshot?.reviews ?? [],
    findings: snapshot?.findings ?? [],
  }).value;
}

/**
 * Read `uwf-questions.db` (`questions`).
 */
export function readQuestions(dataDir, { stage, status } = {}) {
  assertOptionalFilter(stage, "stage");
  assertOptionalFilter(status, "status");
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dbPath = join(absDir, "uwf-questions.db");
  const rows = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "questions")) return [];
    let sql = "SELECT * FROM questions WHERE 1=1";
    const params = [];
    if (stage) { sql += " AND stage = ?"; params.push(stage); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY id ASC";
    return db.prepare(sql).all(...params).map((r) => ({
      ...r,
      required: Boolean(r.required),
    }));
  });
  return redactDeep({
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    exists: rows !== null,
    count: rows?.length ?? 0,
    questions: rows ?? [],
  }).value;
}

/**
 * Pure read-only execution of `uaw_question_resolve` query actions (`list` and `check`).
 * Never executes WAL writes or `CREATE TABLE` against `uwf-questions.db`.
 */
export function queryQuestionsAction(dataDir, { action, stage, status, ids } = {}) {
  assertOptionalFilter(stage, "stage");
  assertOptionalFilter(status, "status");
  const absDir = resolve(dataDir);

  if (action === "check" && !stage) {
    throw new UsageError('Command "check" requires --stage.');
  }

  const rawIds = Array.isArray(ids)
    ? ids.map((v) => String(v).trim()).filter(Boolean).join(",")
    : ids == null ? "" : String(ids).trim();
  let parsedIds = null;
  if (action === "check" && rawIds) {
    parsedIds = rawIds
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (parsedIds.length === 0) {
      return {
        ok: false,
        exitCode: 1,
        result: { ok: false, error: "--ids must be a comma-separated list of integers." },
        error: "--ids must be a comma-separated list of integers.",
      };
    }
  }

  const dbPath = join(absDir, "uwf-questions.db");
  assertRegularFileInDir(absDir, "uwf-questions.db", "uwf-questions.db");
  assertRegularFileInDir(absDir, "uwf-questions.db-wal", "uwf-questions.db-wal");
  assertRegularFileInDir(absDir, "uwf-questions.db-shm", "uwf-questions.db-shm");
  assertRegularFileInDir(absDir, "uwf-questions.db-journal", "uwf-questions.db-journal");

  if (action === "list") {
    const rows = withReadOnlyDb(dbPath, (db) => {
      if (!tableExists(db, "questions")) return [];
      let sql = "SELECT * FROM questions WHERE 1=1";
      const params = [];
      if (stage) { sql += " AND stage = ?"; params.push(stage); }
      if (status) { sql += " AND status = ?"; params.push(status); }
      sql += " ORDER BY id ASC";
      return db.prepare(sql).all(...params);
    });
    const questions = rows ?? [];
    return {
      ok: true,
      exitCode: 0,
      result: { ok: true, procedure: "list", count: questions.length, questions },
      error: null,
    };
  }

  const pending = withReadOnlyDb(dbPath, (db) => {
    if (!tableExists(db, "questions")) return [];
    if (parsedIds) {
      const placeholders = parsedIds.map(() => "?").join(", ");
      return db
        .prepare(
          `SELECT * FROM questions WHERE id IN (${placeholders}) AND required = 1 AND status = 'pending'`,
        )
        .all(...parsedIds);
    }
    return db
      .prepare("SELECT * FROM questions WHERE stage = ? AND required = 1 AND status = 'pending'")
      .all(stage);
  }) ?? [];

  if (pending.length === 0) {
    return {
      ok: true,
      exitCode: 0,
      result: { ok: true, procedure: "check", gate: "pass", pending_count: 0, pending: [] },
      error: null,
    };
  }
  return {
    ok: false,
    exitCode: 1,
    result: { ok: false, procedure: "check", gate: "fail", pending_count: pending.length, pending },
    error: null,
  };
}

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const OPEN_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * List transcripts under `<data-dir>/transcripts/*.json`.
 */
export function listTranscriptRecords(dataDir) {
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dir = join(absDir, "transcripts");
  if (!existsSync(dir)) {
    return {
      run_id: meta?.run_id ?? null,
      data_dir: absDir,
      count: 0,
      transcripts: [],
    };
  }
  const dirLst = lstatSync(dir);
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`Invalid transcripts directory at ${dir}`);
  }
  const realDir = realpathSync(dir);
  const transcripts = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const full = join(dir, file);
    let fd;
    try {
      const lst = lstatSync(full);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const realFile = realpathSync(full);
      if (!realFile.startsWith(realDir + "/") && !realFile.startsWith(realDir + "\\")) continue;
      fd = openSync(full, OPEN_NOFOLLOW_FLAGS);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) continue;
      const id = file.slice(0, -5);
      transcripts.push({
        id,
        file,
        size_bytes: st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch {
      continue;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return {
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    count: transcripts.length,
    transcripts,
  };
}

/**
 * Read one transcript by ID (filename with or without `.json`) and scrub every string
 * through `redactSecrets()`. Rejects path traversal and symlinks with UsageError (exit 2).
 */
export function readTranscriptRecord(dataDir, transcriptId) {
  if (!transcriptId || typeof transcriptId !== "string" || transcriptId.includes("\0")) {
    throw new UsageError("transcript_id is required");
  }
  const cleanId = transcriptId.endsWith(".json") ? transcriptId.slice(0, -5) : transcriptId;
  if (!/^[A-Za-z0-9._-]+$/.test(cleanId) || cleanId.includes("..")) {
    throw new UsageError(`Invalid transcript_id "${transcriptId}"`);
  }
  const absDir = resolve(dataDir);
  const meta = readRunMeta(absDir);
  const dir = resolve(absDir, "transcripts");
  if (!existsSync(dir)) {
    throw new UsageError(`Transcript "${cleanId}" not found in ${dir}`);
  }
  if (lstatSync(dir).isSymbolicLink()) {
    throw new UsageError(`Transcripts directory must not be a symlink: "${dir}"`);
  }
  const rawText = readRegularFileBounded(dir, `${cleanId}.json`, {
    maxBytes: MAX_TRANSCRIPT_BYTES,
    label: `Transcript "${cleanId}"`,
  });
  if (rawText === null) {
    throw new UsageError(`Transcript "${cleanId}" not found in ${dir}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const scrubbed = redactSecrets(rawText);
    return {
      run_id: meta?.run_id ?? null,
      data_dir: absDir,
      id: cleanId,
      redactions: scrubbed.count,
      transcript: { raw: scrubbed.text },
    };
  }
  const { value, redactions } = redactDeep(parsed);
  return {
    run_id: meta?.run_id ?? null,
    data_dir: absDir,
    id: cleanId,
    redactions,
    transcript: value,
  };
}
