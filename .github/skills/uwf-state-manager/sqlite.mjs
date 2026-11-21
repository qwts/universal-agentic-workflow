/**
 * sqlite.mjs — Shared built-in `node:sqlite` wrapper providing the subset of
 * `better-sqlite3` semantics used by UWF skill CLIs, `uaw-mcp`, and `uwf-bench`.
 *
 * Requires Node.js >= 22.13.0 (unflagged `node:sqlite`).
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Open a SQLite database via built-in `node:sqlite` with UWF compatibility
 * defaults (`busy_timeout = 5000`, plain-object rows, numeric run metadata,
 * nested savepoint transactions, and strict `fileMustExist` read-only checks).
 *
 * @param {string} dbPath
 * @param {{
 *   readOnly?: boolean,
 *   wal?: boolean,
 *   foreignKeys?: boolean,
 *   busyTimeoutMs?: number,
 * }} [options]
 */
export function openDatabase(
  dbPath,
  {
    readOnly = false,
    wal = false,
    foreignKeys = false,
    busyTimeoutMs = 5000,
  } = {},
) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(
      `busyTimeoutMs must be a non-negative integer (got ${busyTimeoutMs})`,
    );
  }

  let raw;
  if (readOnly) {
    if (dbPath !== ":memory:" && !existsSync(dbPath)) {
      const err = new Error(`unable to open database file: ${dbPath}`);
      err.code = "ERR_SQLITE_ERROR";
      throw err;
    }
    raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      raw.exec("PRAGMA query_only = ON");
      raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    } catch (err) {
      try {
        raw.close();
      } catch {
        /* ignore close errors after failed setup */
      }
      throw err;
    }
  } else {
    raw = new DatabaseSync(dbPath);
    try {
      raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      if (wal) {
        raw.exec("PRAGMA journal_mode = WAL");
      }
      if (foreignKeys) {
        raw.exec("PRAGMA foreign_keys = ON");
      }
    } catch (err) {
      try {
        raw.close();
      } catch {
        /* ignore close errors after failed setup */
      }
      throw err;
    }
  }

  let txDepth = 0;

  return {
    exec(sql) {
      return raw.exec(sql);
    },
    pragma(statement) {
      return raw.exec(`PRAGMA ${statement}`);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run(...params) {
          const result = stmt.run(...params);
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        get(...params) {
          const row = stmt.get(...params);
          return row === undefined ? undefined : { ...row };
        },
        all(...params) {
          return stmt.all(...params).map((row) => ({ ...row }));
        },
      };
    },
    transaction(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("transaction callback must be a function");
      }
      return (...args) => {
        if (txDepth === 0) {
          raw.exec("BEGIN");
          txDepth += 1;
          try {
            const result = fn(...args);
            raw.exec("COMMIT");
            return result;
          } catch (err) {
            try {
              raw.exec("ROLLBACK");
            } catch {
              /* ignore rollback failure when rethrowing */
            }
            throw err;
          } finally {
            txDepth -= 1;
          }
        }

        const sp = `uaw_sp_${txDepth}`;
        raw.exec(`SAVEPOINT ${sp}`);
        txDepth += 1;
        try {
          const result = fn(...args);
          raw.exec(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          try {
            raw.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            raw.exec(`RELEASE SAVEPOINT ${sp}`);
          } catch {
            /* ignore savepoint rollback failure when rethrowing */
          }
          throw err;
        } finally {
          txDepth -= 1;
        }
      };
    },
    close() {
      raw.close();
    },
  };
}
