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

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  assertRegularFileInDir,
  canonicalPathKey,
  defaultOutputPath,
  isSameOrAncestorPath,
  pathsOverlap,
  resolveUawStateDir,
  UsageError,
} from "./paths.mjs";

const UNREADABLE_LOCK_WAIT_MS = 100;
const REGISTRY_LOCK_WAIT_MS = 300;
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
  return createHash("sha256").update(canonicalPathKey(outputPath)).digest("hex");
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
  const reclaimPath = `${lockPath}.reclaim`;
  const deadline = Date.now() + UNREADABLE_LOCK_WAIT_MS;
  let allowUnlock = unlock === true;

  try {
    writeFileSync(lockTmp, JSON.stringify(lockPayload, null, 2) + "\n", "utf8");
    while (true) {
      try {
        linkSync(lockTmp, lockPath);
        const linkedIno = statSync(lockPath).ino;
        const release = () => {
          try {
            if (statSync(lockPath).ino === linkedIno && readJsonQuiet(lockPath)?.token === lockToken) {
              unlinkSync(lockPath);
            }
          } catch {
            /* already removed */
          }
        };
        if (beforeReturn) {
          try {
            beforeReturn();
          } catch (err) {
            release();
            throw err;
          }
        }
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
      if ((!other || !Number.isInteger(other.pid)) && !isStale) {
        if (Date.now() >= deadline) {
          throw new UsageError(waitMessage);
        }
        sleepMs(10);
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
      let holdingReclaim = false;
      try {
        linkSync(lockTmp, reclaimPath);
        holdingReclaim = true;
      } catch (reclaimErr) {
        if (reclaimErr.code === "EEXIST") {
          try {
            const rst = statSync(reclaimPath);
            if (Date.now() - rst.mtimeMs > 1_000) {
              rmSync(reclaimPath, { force: true });
            }
          } catch {
            /* reclaim released */
          }
        }
      }
      if (holdingReclaim) {
        try {
          const stNow = statSync(lockPath);
          const cur = readJsonQuiet(lockPath);
          if (stNow.ino === st.ino && (!other?.token || cur?.token === other.token)) {
            unlinkSync(lockPath);
          }
        } catch {
          /* lock already gone */
        } finally {
          rmSync(reclaimPath, { force: true });
        }
        allowUnlock = false;
        continue;
      }
      sleepMs(20);
    }
  } finally {
    rmSync(lockTmp, { force: true });
  }
}

export function dataDirLockPath(dataDir, stateDir) {
  const locksDir = join(resolveUawStateDir(stateDir), "data-locks");
  const key = createHash("sha256").update(canonicalPathKey(dataDir)).digest("hex");
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
  const canonicalDataDir = canonicalPathKey(dataDir);
  const canonicalStateDir = canonicalPathKey(resolveUawStateDir(stateDir));
  if (pathsOverlap(canonicalDataDir, canonicalStateDir)) {
    throw new UsageError(
      `data_dir "${canonicalDataDir}" cannot overlap UAW state directory "${canonicalStateDir}"`,
    );
  }
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

function withOwnersRegistryLock(ownersDir, fn) {
  const lockPath = join(ownersDir, ".registry.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const tmpPath = `${lockPath}.${token}.tmp`;
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  let linkedIno = null;

  try {
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, token }) + "\n", { encoding: "utf8", flag: "wx" });
    while (true) {
      try {
        linkSync(tmpPath, lockPath);
        linkedIno = statSync(lockPath).ino;
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }

      let st;
      try {
        st = statSync(lockPath);
      } catch {
        continue;
      }
      const other = readJsonQuiet(lockPath);
      const deadPid = Boolean(other && Number.isInteger(other.pid) && !pidAlive(other.pid));
      const corruptStale = (!other || !Number.isInteger(other.pid)) && Date.now() - st.mtimeMs > 1_000;
      if (deadPid || corruptStale) {
        let holdingReclaim = false;
        try {
          linkSync(tmpPath, reclaimPath);
          holdingReclaim = true;
        } catch (reclaimErr) {
          if (reclaimErr.code === "EEXIST") {
            try {
              const rst = statSync(reclaimPath);
              if (Date.now() - rst.mtimeMs > 1_000) {
                rmSync(reclaimPath, { force: true });
              }
            } catch {
              /* reclaim released */
            }
          }
        }
        if (holdingReclaim) {
          try {
            const stNow = statSync(lockPath);
            const cur = readJsonQuiet(lockPath);
            if (stNow.ino === st.ino && (!other?.token || cur?.token === other.token)) {
              unlinkSync(lockPath);
            }
          } catch {
            /* lock already gone */
          } finally {
            rmSync(reclaimPath, { force: true });
          }
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new UsageError("Could not acquire output ownership registry lock; retry shortly.");
      }
      sleepMs(5);
    }
  } finally {
    rmSync(tmpPath, { force: true });
  }

  try {
    return fn();
  } finally {
    try {
      if (statSync(lockPath).ino === linkedIno && readJsonQuiet(lockPath)?.token === token) {
        unlinkSync(lockPath);
      }
    } catch {
      /* already removed */
    }
  }
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

  const canonicalOutput = canonicalPathKey(outputPath);
  const canonicalDataDir = canonicalPathKey(dataDir);
  const canonicalStateDir = canonicalPathKey(resolveUawStateDir(stateDir));

  if (pathsOverlap(canonicalDataDir, canonicalStateDir)) {
    throw new UsageError(
      `data_dir "${canonicalDataDir}" cannot overlap UAW state directory "${canonicalStateDir}"`,
    );
  }
  if (pathsOverlap(canonicalOutput, canonicalStateDir)) {
    throw new UsageError(
      `output_path "${canonicalOutput}" cannot overlap UAW state directory "${canonicalStateDir}"`,
    );
  }
  if (isSameOrAncestorPath(canonicalOutput, canonicalDataDir)) {
    throw new UsageError(
      `output_path "${canonicalOutput}" cannot equal or contain data_dir "${canonicalDataDir}"`,
    );
  }
  const canonicalDefaultOut = canonicalPathKey(defaultOutputPath(canonicalDataDir));
  if (isSameOrAncestorPath(canonicalDataDir, canonicalOutput) && !isSameOrAncestorPath(canonicalDefaultOut, canonicalOutput)) {
    throw new UsageError(
      `output_path "${canonicalOutput}" inside data_dir "${canonicalDataDir}" must be under "${canonicalDefaultOut}"`,
    );
  }

  const { ownersDir, recordPath, lockPath } = outputOwnerPaths(canonicalOutput, stateDir);
  mkdirSync(ownersDir, { recursive: true });

  const assertNoOverlappingOwner = () => {
    const myRecordName = basename(recordPath);
    for (const file of readdirSync(ownersDir)) {
      if (!file.endsWith(".json")) continue;
      const other = readJsonQuiet(join(ownersDir, file));
      if (!other?.output_path) continue;
      let sameDataDir = false;
      let otherDataDir = null;
      if (other.data_dir) {
        try {
          otherDataDir = canonicalPathKey(other.data_dir);
          sameDataDir = otherDataDir === canonicalDataDir;
        } catch {
          otherDataDir = null;
        }
      }
      if (file === myRecordName && sameDataDir) continue;
      let otherOut;
      try {
        otherOut = canonicalPathKey(other.output_path);
      } catch {
        continue;
      }
      const sameRun = Boolean(other.run_id) && other.run_id === runId;
      if (otherDataDir && !sameDataDir) {
        if (pathsOverlap(canonicalOutput, otherDataDir)) {
          throw new UsageError(
            `Output path "${canonicalOutput}" overlaps with run "${other.run_id ?? "unknown"}" data_dir "${otherDataDir}".`,
          );
        }
        if (pathsOverlap(canonicalDataDir, otherOut)) {
          throw new UsageError(
            `data_dir "${canonicalDataDir}" overlaps with output_path "${otherOut}" owned by run "${other.run_id ?? "unknown"}".`,
          );
        }
      }
      if (file === myRecordName) continue;
      if (!pathsOverlap(canonicalOutput, otherOut)) continue;
      if (!sameDataDir || (!sameRun && !force)) {
        throw new UsageError(
          `Output path "${canonicalOutput}" overlaps with "${otherOut}" owned by run "${other.run_id ?? "unknown"}" (data_dir: ${other.data_dir ?? "unknown"}).`,
        );
      }
      const otherLockPath = join(ownersDir, file.replace(/\.json$/, ".lock"));
      if (existsSync(otherLockPath)) {
        let otherSt = null;
        try {
          otherSt = statSync(otherLockPath);
        } catch {
          otherSt = null;
        }
        if (otherSt) {
          const otherLock = readJsonQuiet(otherLockPath);
          if (otherLock && Number.isInteger(otherLock.pid) && pidAlive(otherLock.pid)) {
            throw new UsageError(
              `Output path "${otherOut}" execution lock is held by run "${otherLock.run_id ?? "unknown"}" (pid ${otherLock.pid}).`,
            );
          }
          if (!otherLock && Date.now() - otherSt.mtimeMs <= LOCK_UNREADABLE_STALE_MS) {
            throw new UsageError(
              `Could not acquire execution lock for "${otherOut}"; another process is starting.`,
            );
          }
          if (!unlock) {
            throw new UsageError(
              `Output path "${otherOut}" has a stale execution lock; pass unlock=true to clear.`,
            );
          }
        }
      }
    }
  };
  assertNoOverlappingOwner();

  // Acquire the paired execution lock BEFORE linking/updating the durable .json record,
  // so lock contention or stale-lock refusal never leaves an orphaned .json ownership record behind.
  const recordPayload = {
    run_id: runId,
    data_dir: canonicalDataDir,
    output_path: canonicalOutput,
    claimed_at: new Date().toISOString(),
  };
  const recordTmp = `${recordPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const lockToken = `${runId}-${process.pid}-${Date.now()}-${randomUUID()}`;
  const lockPayload = {
    run_id: runId,
    data_dir: canonicalDataDir,
    output_path: canonicalOutput,
    token: lockToken,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  let createdRecord = false;
  let previousRecordRaw = null;
  let updatedRecord = false;
  const retiredRecords = [];

  const undoRecords = () => {
    if (createdRecord) {
      rmSync(recordPath, { force: true });
      createdRecord = false;
    } else if (updatedRecord && previousRecordRaw !== null) {
      const restoreTmp = `${recordPath}.${process.pid}.${Date.now()}.${randomUUID()}.restore.tmp`;
      try {
        writeFileSync(restoreTmp, previousRecordRaw, "utf8");
        renameSync(restoreTmp, recordPath);
      } finally {
        rmSync(restoreTmp, { force: true });
      }
      updatedRecord = false;
    }
    for (const ret of retiredRecords.splice(0)) {
      const restoreTmp = `${ret.path}.${process.pid}.${Date.now()}.${randomUUID()}.restore.tmp`;
      try {
        writeFileSync(restoreTmp, ret.raw, "utf8");
        renameSync(restoreTmp, ret.path);
      } finally {
        rmSync(restoreTmp, { force: true });
      }
    }
  };

  try {
    writeFileSync(recordTmp, JSON.stringify(recordPayload, null, 2) + "\n", "utf8");
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
        withOwnersRegistryLock(ownersDir, () => {
          assertNoOverlappingOwner();
          try {
            try {
              linkSync(recordTmp, recordPath);
              createdRecord = true;
            } catch (e) {
              if (e.code !== "EEXIST") throw e;
              const existing = readJsonQuiet(recordPath);
              const sameDataDir = Boolean(existing?.data_dir) && canonicalPathKey(existing.data_dir) === canonicalDataDir;
              const sameRun = Boolean(existing?.run_id) && existing.run_id === runId;
              if (!existing || !sameDataDir || (!sameRun && !force)) {
                const ownerDesc = existing?.run_id
                  ? `run "${existing.run_id}" (data_dir: ${existing.data_dir})`
                  : "another run (unreadable ownership record)";
                throw new UsageError(
                  `Output path "${canonicalOutput}" is already owned by ${ownerDesc}; refusing run "${runId}" (data_dir: ${canonicalDataDir}).`,
                );
              }
              if (!sameRun && force) {
                try {
                  previousRecordRaw = readFileSync(recordPath, "utf8");
                } catch {
                  previousRecordRaw = null;
                }
                renameSync(recordTmp, recordPath);
                updatedRecord = true;
              }
            }
            // Retire superseded overlapping same-data_dir ownership records atomically so subsequent
            // non-forced uaw_resume calls do not trip over stale sibling records.
            const myRecordName = basename(recordPath);
            const toRetire = [];
            for (const file of readdirSync(ownersDir)) {
              if (file === myRecordName || !file.endsWith(".json")) continue;
              const otherPath = join(ownersDir, file);
              const other = readJsonQuiet(otherPath);
              if (!other?.output_path || !other?.data_dir) continue;
              let otherDataDir;
              let otherOut;
              try {
                otherDataDir = canonicalPathKey(other.data_dir);
                otherOut = canonicalPathKey(other.output_path);
              } catch {
                continue;
              }
              if (otherDataDir !== canonicalDataDir) continue;
              if (!pathsOverlap(canonicalOutput, otherOut)) continue;
              const sameRun = Boolean(other.run_id) && other.run_id === runId;
              if (!sameRun && !force) continue;
              const otherLockPath = join(ownersDir, file.replace(/\.json$/, ".lock"));
              let raw = null;
              try {
                raw = readFileSync(otherPath, "utf8");
              } catch {
                raw = null;
              }
              toRetire.push({ otherPath, otherLockPath, raw });
            }
            for (const item of toRetire) {
              if (item.raw !== null) {
                retiredRecords.push({ path: item.otherPath, raw: item.raw });
              }
              rmSync(item.otherPath, { force: true });
            }
            if (unlock) {
              for (const item of toRetire) {
                const otherLock = readJsonQuiet(item.otherLockPath);
                if (!otherLock || !Number.isInteger(otherLock.pid) || !pidAlive(otherLock.pid)) {
                  rmSync(item.otherLockPath, { force: true });
                }
              }
            }
          } catch (err) {
            try {
              undoRecords();
            } catch {
              /* best-effort rollback on partial failure */
            }
            throw err;
          }
        });
      },
    });
    return {
      recordPath,
      lockPath: acquired.lockPath,
      release: acquired.release,
      rollback() {
        if (existsSync(ownersDir)) {
          withOwnersRegistryLock(ownersDir, undoRecords);
        } else {
          undoRecords();
        }
      },
    };
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
