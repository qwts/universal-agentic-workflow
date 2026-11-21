/**
 * SQLite driver for uwf-bench: built-in `node:sqlite` via the shared UWF wrapper.
 */
import { openDatabase } from "../../.github/skills/uwf-state-manager/sqlite.mjs";

/** @param {string} path @param {{readOnly?: boolean}} [opts] */
export function openSqlite(path, { readOnly = false } = {}) {
  return openDatabase(path, { readOnly });
}
