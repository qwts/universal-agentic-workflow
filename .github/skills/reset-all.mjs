#!/usr/bin/env node
/**
 * reset-all.mjs — Wipe all UWF skill databases back to a clean state.
 *
 * Usage:
 *   node .github/skills/reset-all.mjs
 *   node .github/skills/reset-all.mjs --artifacts   # also delete tmp/workflow-artifacts/
 *
 * What gets deleted:
 *   - All *.db, *.db-shm, and *.db-wal files under .github/skills/
 *   - tmp/workflow-artifacts/ (only with --artifacts flag)
 *
 * Each skill will recreate its DB on next invocation (CREATE TABLE IF NOT EXISTS).
 */

import { unlinkSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./uwf-state-manager/data-dir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const skillsDir  = resolve(__dirname);
const repoRoot   = resolve(__dirname, "../../");
const withArtifacts = process.argv.includes("--artifacts");

function findDbs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") results.push(...findDbs(full));
    else if (entry.isFile() && /\.db(?:-shm|-wal)?$/.test(entry.name)) results.push(full);
  }
  return results;
}

function findDataDirDbs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.db(?:-shm|-wal)?$/.test(e.name))
    .map((e) => join(dir, e.name));
}

// When a data directory is set, reset only the databases there; otherwise the skill folders.
const dataDir = resolveDataDir(process.argv.slice(2), undefined);
const dbs = dataDir ? findDataDirDbs(dataDir) : findDbs(skillsDir);
const deleted = [];
const missing = [];

for (const db of dbs) {
  if (existsSync(db)) {
    unlinkSync(db);
    deleted.push(db);
  } else {
    missing.push(db);
  }
}

if (withArtifacts) {
  const artPath = dataDir ? join(dataDir, "workflow-artifacts") : join(repoRoot, "tmp", "workflow-artifacts");
  if (existsSync(artPath)) {
    rmSync(artPath, { recursive: true, force: true });
    deleted.push(artPath + "/ (directory)");
  }
}

console.log(JSON.stringify({
  ok: true,
  procedure: "reset-all",
  deleted,
  already_absent: missing,
  note: withArtifacts ? "DBs + artifacts cleared." : "DBs cleared. Use --artifacts to also wipe tmp/workflow-artifacts/.",
}, null, 2));
