/**
 * SQLite driver for uwf-bench: better-sqlite3 from the orchestration engine skill (the same driver
 * stage-tracker.mjs uses), so the harness runs on Node 20 like the rest of the scripts.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const Database = createRequire(join(ROOT, ".github", "skills", "uwf-orchestration-engine", "package.json"))("better-sqlite3");

/** @param {string} path @param {{readOnly?: boolean}} [opts] */
export function openSqlite(path, { readOnly = false } = {}) {
  return new Database(path, { readonly: readOnly });
}
