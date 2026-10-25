/**
 * data-dir.mjs — Shared resolution of the UWF data directory.
 *
 * Precedence for a SQLite database path (highest first):
 *   1. --db-path <file>     explicit database file
 *   2. --data-dir <dir>     directory, joined with the database file name
 *   3. UWF_DATA_DIR env     directory, joined with the database file name
 *   4. defaultDir           the caller's own directory (__dirname)
 *
 * `flagsOrArgv` is either an already-parsed flags object or a raw argv array
 * (`process.argv.slice(2)`); raw argv is parsed with the same `--key value`
 * rules the CLIs use.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function normalizeFlags(flagsOrArgv) {
  if (!Array.isArray(flagsOrArgv)) return flagsOrArgv ?? {};
  const flags = {};
  for (let i = 0; i < flagsOrArgv.length; i++) {
    const token = flagsOrArgv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = flagsOrArgv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function stringFlag(flags, key) {
  const value = flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the data directory from `--data-dir` or `UWF_DATA_DIR`, else
 * `defaultDir`. Returns an absolute path, or undefined when none applies.
 * Does not create the directory.
 */
export function resolveDataDir(flagsOrArgv, defaultDir) {
  const flags = normalizeFlags(flagsOrArgv);
  const envDir = process.env.UWF_DATA_DIR;
  const dir =
    stringFlag(flags, "data-dir") ??
    (envDir && envDir.length > 0 ? envDir : undefined) ??
    defaultDir;
  return dir === undefined ? undefined : resolve(dir);
}

/**
 * Resolve the full database path for `dbFileName` following the precedence
 * above. When a data directory is used it is created recursively first.
 */
export function resolveDbPath(flagsOrArgv, dbFileName, defaultDir) {
  const flags = normalizeFlags(flagsOrArgv);
  const explicit = stringFlag(flags, "db-path");
  if (explicit) return resolve(explicit);

  const dataDir = resolveDataDir(flags, undefined);
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    return join(dataDir, dbFileName);
  }
  return join(defaultDir, dbFileName);
}
