/**
 * ownership.mjs — Out-of-tree output_path ownership registry and run.lock guards.
 *
 * Implements ADR-0008 invariants:
 *   - NEVER writes lock or ownership dotfiles inside `output_path`.
 *   - Persists durable ownership metadata in:
 *       <uaw-state-dir>/output-owners/<sha256(realpath(output_path))>.json
 *   - Acquires a paired atomic execution lock during active execution:
 *       <uaw-state-dir>/output-owners/<sha256(realpath(output_path))>.lock
 *   - Rejects any different `run_id` / `data_dir` with exit code 2 (UsageError)
 *     even after a paused or completed run releases the execution lock.
 *   - Inspects `<data-dir>/run.lock` before direct state/stage/question mutations.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { assertRegularFileInDir, canonicalizePath, resolveUawStateDir, UsageError } from "./paths.mjs";

const LOCK_WAIT_MS = 3_000;
const LOCK_UNREADABLE_STALE_MS = 10_000;

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function outputOwnerKey(outputPath) {
  return createHash("sha256").update(canonicalizePath(outputPath)).digest("hex");
}

export function outputOwnerPaths(outputPath, stateDir) {
  const ownersDir = join(resolveUawStateDir(stateDir), "output-owners");
  const key = outputOwnerKey(outputPath);
  return {
    key,
    ownersDir,
    recordPath: join(ownersDir, `${key}.json`),
    lockPath: join(ownersDir, `${key}.lock`),
  };
}

function readJsonQuiet(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function acquireFileLock({
  lockPath,
  lockPayload,
  lockToken,
  heldMessage,
  waitMessage,
  stalePrefix,
  unlock = false,
  beforeReturn = null,
}) {
  const lockTmp = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let allowUnlock = unlock === true;

  try {
    writeFileSync(lockTmp, JSON.stringify(lockPayload, null, 2) + "\n", "utf8");
    while (true) {
      try {
        linkSync(lockTmp, lockPath);
        if (beforeReturn) beforeReturn();
        const release = () => {
          try {
            if (readJsonQuiet(lockPath)?.token === lockToken) {
              rmSync(lockPath, { force: true });
            }
          } catch {
            /* already removed */
          }
        };
        return { lockPath, release };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }

      let st;
      try {
        st = statSync(lockPath);
      } catch {
        continue; // released between link and stat
      }
      const other = readJsonQuiet(lockPath);
      if (other && Number.isInteger(other.pid) && pidAlive(other.pid)) {
        throw new UsageError(heldMessage(other));
      }
      const isStale = Date.now() - st.mtimeMs > LOCK_UNREADABLE_STALE_MS;
      if (!other && !isStale) {
        if (Date.now() >= deadline) {
          throw new UsageError(waitMessage);
        }
        sleepMs(50);
        continue;
      }
      if (!allowUnlock) {
        const left = other
          ? `left by run "${other.run_id}" (pid ${other.pid}, not running)`
          : "unreadable and older than 10s";
        throw new UsageError(
          `${stalePrefix} ${left}: ${lockPath}. Retry with unlock=true to clear it.`,
        );
      }
      rmSync(lockPath, { force: true });
      allowUnlock = false;
    }
  } finally {
    rmSync(lockTmp, { force: true });
  }
}

export function dataDirLockPath(dataDir, stateDir) {
  const locksDir = join(resolveUawStateDir(stateDir), "data-locks");
  const key = createHash("sha256").update(canonicalizePath(dataDir)).digest("hex");
  return {
    key,
    locksDir,
    lockPath: join(locksDir, `${key}.lock`),
  };
}

/**
 * Acquire an atomic out-of-tree serialization lock for a `data_dir` before reading/updating
 * durable metadata or spawning child runners/CLIs.
 */
export function claimDataDirLock({ dataDir, runId = "mcp", stateDir, unlock = false }) {
  if (!dataDir) throw new UsageError("dataDir is required for data_dir lock");
  const canonicalDataDir = canonicalizePath(dataDir);
  const { locksDir, lockPath } = dataDirLockPath(canonicalDataDir, stateDir);
  mkdirSync(locksDir, { recursive: true });

  const lockToken = `data-${runId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockPayload = {
    run_id: runId,
    data_dir: canonicalDataDir,
    token: lockToken,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  return acquireFileLock({
    lockPath,
    lockPayload,
    lockToken,
    heldMessage: (other) =>
      `Data dir "${canonicalDataDir}" execution lock is held by run "${other.run_id}" (pid ${other.pid}).`,
    waitMessage: `Could not acquire execution lock for data_dir "${canonicalDataDir}"; another process is starting.`,
    stalePrefix: `Data dir "${canonicalDataDir}" has a stale execution lock`,
    unlock,
  });
}

/**
 * Claim durable out-of-tree ownership of `outputPath` for `(runId, dataDir)` and
 * acquire the paired atomic execution lock for the duration of a mutating operation.
 *
 * Returns `{ recordPath, lockPath, release }` where `release()` removes ONLY the
 * `.lock` file (preserving `.json` ownership across pauses and completions).
 */
export function claimOutputPath({ outputPath, runId, dataDir, stateDir, unlock = false, force = false }) {
  if (!outputPath) throw new UsageError("outputPath is required for ownership claim");
  if (!runId) throw new UsageError("runId is required for ownership claim");
  if (!dataDir) throw new UsageError("dataDir is required for ownership claim");

  const canonicalOutput = canonicalizePath(outputPath);
  const canonicalDataDir = canonicalizePath(dataDir);
  const { ownersDir, recordPath, lockPath } = outputOwnerPaths(canonicalOutput, stateDir);
  mkdirSync(ownersDir, { recursive: true });

  // 1. Atomic first-claim durable ownership record (<sha256>.json) & paired execution lock (<sha256>.lock)
  const recordPayload = {
    run_id: runId,
    data_dir: canonicalDataDir,
    output_path: canonicalOutput,
    claimed_at: new Date().toISOString(),
  };
  const recordTmp = `${recordPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const lockToken = `${runId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockPayload = {
    run_id: runId,
    data_dir: canonicalDataDir,
    output_path: canonicalOutput,
    token: lockToken,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  let needsOwnershipUpdate = false;

  try {
    writeFileSync(recordTmp, JSON.stringify(recordPayload, null, 2) + "\n", "utf8");
    try {
      linkSync(recordTmp, recordPath);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const existing = readJsonQuiet(recordPath);
      const sameDataDir = Boolean(existing?.data_dir) && canonicalizePath(existing.data_dir) === canonicalDataDir;
      const sameRun = Boolean(existing?.run_id) && existing.run_id === runId;
      if (!existing || !sameDataDir || (!sameRun && !force)) {
        const ownerDesc = existing?.run_id
          ? `run "${existing.run_id}" (data_dir: ${existing.data_dir})`
          : "another run (unreadable ownership record)";
        throw new UsageError(
          `Output path "${canonicalOutput}" is already owned by ${ownerDesc}; refusing run "${runId}" (data_dir: ${canonicalDataDir}).`,
        );
      }
      if (!sameRun && force) needsOwnershipUpdate = true;
    }

    const acquired = acquireFileLock({
      lockPath,
      lockPayload,
      lockToken,
      heldMessage: (other) =>
        `Output path "${canonicalOutput}" execution lock is held by run "${other.run_id}" (pid ${other.pid}).`,
      waitMessage: `Could not acquire execution lock for "${canonicalOutput}"; another process is starting.`,
      stalePrefix: `Output path "${canonicalOutput}" has a stale execution lock`,
      unlock,
      beforeReturn: () => {
        if (needsOwnershipUpdate) {
          renameSync(recordTmp, recordPath);
        }
      },
    });
    return { recordPath, lockPath: acquired.lockPath, release: acquired.release };
  } finally {
    rmSync(recordTmp, { force: true });
  }
}

/**
 * Inspect `<data-dir>/run.lock` and refuse mutation with exit code 2 (UsageError)
 * if an active lock is held by another process.
 */
export function assertNoActiveRunLock(dataDir) {
  const lockPath = assertRegularFileInDir(dataDir, "run.lock", "run.lock");
  if (!lockPath) return;
  let st;
  try {
    st = statSync(lockPath);
  } catch {
    return;
  }
  const info = readJsonQuiet(lockPath);
  if (info && Number.isInteger(info.pid) && pidAlive(info.pid)) {
    throw new UsageError(
      `Data dir ${dataDir} has an active run.lock held by run "${info.runId ?? "unknown"}" (pid ${info.pid}); refusing mutation.`,
    );
  }
  if (!info && Date.now() - st.mtimeMs <= LOCK_UNREADABLE_STALE_MS) {
    throw new UsageError(
      `Data dir ${dataDir} has a run.lock currently being written; refusing mutation.`,
    );
  }
}
