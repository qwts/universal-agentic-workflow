/**
 * paths.mjs — Workspace root allowlists, UAW state directory, durable run metadata,
 * and run-ID index for uaw-mcp/v1.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

export const RUN_META_FILE = "run-meta.json";

/**
 * Host-scoped UAW state directory outside any repository.
 * Defaults to `${XDG_STATE_HOME:-~/.local/state}/uaw` (overridable via UAW_STATE_DIR).
 */
export function resolveUawStateDir(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.UAW_STATE_DIR) return resolve(process.env.UAW_STATE_DIR);
  const xdgState = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return resolve(xdgState, "uaw");
}

const caseInsensitiveCache = new Map();

function probeNameCaseInsensitive(parentDir, name) {
  const m = name.match(/[A-Za-z]/);
  if (!m) return null;
  const ch = m[0];
  const flippedCh = ch >= "a" ? ch.toUpperCase() : ch.toLowerCase();
  const flippedName = name.slice(0, m.index) + flippedCh + name.slice(m.index + 1);
  let origSt;
  try {
    origSt = lstatSync(join(parentDir, name));
  } catch {
    return null;
  }
  try {
    const flipSt = lstatSync(join(parentDir, flippedName));
    return origSt.dev === flipSt.dev && origSt.ino === flipSt.ino;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return null;
  }
}

function isCaseInsensitiveDir(dirPath) {
  let dirSt;
  try {
    dirSt = lstatSync(dirPath);
  } catch {
    return false;
  }
  if (!dirSt.isDirectory()) return false;

  const cacheKey = `${dirSt.dev}:${dirPath}`;
  if (caseInsensitiveCache.has(cacheKey)) {
    return caseInsensitiveCache.get(cacheKey);
  }
  const remember = (value) => {
    if (caseInsensitiveCache.size >= 1024) caseInsensitiveCache.clear();
    caseInsensitiveCache.set(cacheKey, value);
    return value;
  };

  // Probe the directory itself, then walk same-volume ancestors on all platforms so empty
  // directories (including Linux output_path/data_dir) never receive transient probe dotfiles.
  let cur = dirPath;
  while (true) {
    try {
      const entries = readdirSync(cur);
      for (const name of entries) {
        const probed = probeNameCaseInsensitive(cur, name);
        if (probed !== null) return remember(probed);
      }
    } catch {
      /* ignore unreadable directory entries */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    let parentSt;
    try {
      parentSt = lstatSync(parent);
    } catch {
      break;
    }
    if (parentSt.dev !== dirSt.dev) break;
    const probedSelf = probeNameCaseInsensitive(parent, basename(cur));
    if (probedSelf !== null) return remember(probedSelf);
    cur = parent;
  }
  return process.platform === "darwin" || process.platform === "win32";
}

/**
 * Canonicalize a path even if the leaf does not yet exist or traverses a dangling symlink:
 * resolves symlinks at every existing/symlinked ancestor with hop limit.
 */
export function canonicalizePath(targetPath, _hops = 0) {
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.includes("\0")) {
    throw new UsageError("path must be a non-empty string without NUL bytes");
  }
  if (_hops > 40) {
    throw new UsageError(`Too many symbolic link levels resolving "${targetPath}"`);
  }
  const abs = resolve(targetPath);
  const realNative = realpathSync.native ?? realpathSync;
  try {
    return realNative(abs);
  } catch {
    /* leaf or intermediate component absent or dangling symlink */
  }
  const trailing = [];
  let cur = abs;
  while (true) {
    let lst = null;
    try {
      lst = lstatSync(cur);
    } catch {
      lst = null;
    }
    if (lst) {
      if (lst.isSymbolicLink()) {
        const linkTarget = readlinkSync(cur);
        const baseDir = isAbsolute(linkTarget) ? "/" : canonicalizePath(dirname(cur), _hops + 1);
        const resolvedLink = isAbsolute(linkTarget) ? linkTarget : resolve(baseDir, linkTarget);
        const canonLink = canonicalizePath(resolvedLink, _hops + 1);
        return trailing.length ? canonicalizePath(join(canonLink, ...trailing), _hops + 1) : canonLink;
      }
      let base = cur;
      try {
        base = realNative(cur);
      } catch {
        base = cur;
      }
      return trailing.length ? join(base, ...trailing) : base;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    trailing.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
}

/**
 * Stable canonical key for path equality, hashing (`outputOwnerKey`, `dataDirLockPath`),
 * and ancestor/overlap checks across both existing and not-yet-created paths.
 * On case-insensitive/Unicode-normalizing filesystems (e.g. macOS APFS), folds the entire
 * canonical path with `normalize("NFD").toLowerCase()` so pre-creation and post-creation keys match.
 */
export function canonicalPathKey(targetPath) {
  const canon = canonicalizePath(targetPath);
  const realNative = realpathSync.native ?? realpathSync;
  let probe = canon;
  while (true) {
    try {
      const lst = lstatSync(probe);
      const checkDir = lst.isDirectory() ? probe : dirname(probe);
      let realCheck = checkDir;
      try {
        realCheck = realNative(checkDir);
      } catch {
        realCheck = checkDir;
      }
      if (isCaseInsensitiveDir(realCheck)) {
        return process.platform === "darwin"
          ? canon.normalize("NFD").toLowerCase()
          : canon.toLowerCase();
      }
      return canon;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return canon;
      probe = parent;
    }
  }
}

/**
 * Verify that `targetPath` lies within at least one configured workspace root.
 * When `allowedRoots` is empty/unset, no root restriction is applied (local stdio mode).
 */
export function assertAllowedPath(targetPath, allowedRoots, label = "path") {
  if (!targetPath || typeof targetPath !== "string" || targetPath.includes("\0")) {
    throw new UsageError(`${label} must be a non-empty string without NUL bytes`);
  }
  const canonicalTarget = canonicalizePath(targetPath);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return canonicalTarget;
  }
  const allowed = allowedRoots.some((root) => isSameOrAncestorPath(root, canonicalTarget));
  if (!allowed) {
    throw new UsageError(
      `${label} "${targetPath}" is outside the configured workspace root allowlist`,
    );
  }
  return canonicalTarget;
}

export function isSameOrAncestorPath(ancestorPath, descendantPath) {
  const ca = canonicalPathKey(ancestorPath);
  const cd = canonicalPathKey(descendantPath);
  return ca === cd || (ca.endsWith(sep) ? cd.startsWith(ca) : cd.startsWith(ca + sep));
}

export function pathsOverlap(pathA, pathB) {
  return isSameOrAncestorPath(pathA, pathB) || isSameOrAncestorPath(pathB, pathA);
}

/**
 * Default output path for a run when `output_path` is omitted:
 * ALWAYS `<data-dir>/workflow-artifacts`, never shared `./tmp/workflow-artifacts`.
 */
export function defaultOutputPath(dataDir) {
  return join(resolve(dataDir), "workflow-artifacts");
}

export function generateRunId(workflow = "uaw") {
  const safeWf = String(workflow).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "uaw";
  return `uaw-${safeWf}-${randomUUID()}`;
}

export function assertRegularFileInDir(dirPath, fileName, label = fileName) {
  const absDir = resolve(dirPath);
  let dirLst;
  try {
    dirLst = lstatSync(absDir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`Invalid directory for ${label}: "${absDir}"`);
  }
  const full = join(absDir, fileName);
  let lst;
  try {
    lst = lstatSync(full);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new UsageError(`${label} must be a regular file (symlinks disallowed): "${full}"`);
  }
  const realDir = realpathSync(absDir);
  const realFull = realpathSync(full);
  const inside = realDir.endsWith(sep) ? realFull.startsWith(realDir) : realFull.startsWith(realDir + sep);
  if (!inside) {
    throw new UsageError(`${label} escapes directory "${absDir}"`);
  }
  return realFull;
}

const RUNTIME_CONTROL_FILES = new Set([
  RUN_META_FILE,
  "run.lock",
  "mark-stage.lock",
  "runner-goal.md",
  "runner-routing.json",
  "runner-finalize-pending.json",
  "uaw-manifest.json",
  "fake-attempts.json",
  "fake-sessions.json",
  "uwf-state.json",
  "runner.log",
]);

/**
 * Verify that `dataDir` (if present) is a non-symlink directory whose runtime
 * entries (SQLite stores/sidecars, control/log files, adapter state in
 * `fake-attempts.json`, `fake-sessions.json`, `grokbot/`, `monolith/`, `codex/`,
 * plus `transcripts/*`) are regular non-symlink entries contained inside `dataDir`.
 *
 * Does not recurse into `workflow-artifacts/` or unrelated scratch files.
 * Note: pre-spawn checks are defense-in-depth alongside child-CLI confinement.
 */
export function assertSafeDataDir(dataDir, { strictTranscripts = true } = {}) {
  const absDir = resolve(dataDir);
  let dirLst;
  try {
    dirLst = lstatSync(absDir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`data_dir must be a regular directory (symlinks disallowed): "${absDir}"`);
  }
  const realRoot = realpathSync(absDir);
  const insideRoot = (p) => (realRoot.endsWith(sep) ? p.startsWith(realRoot) : p.startsWith(realRoot + sep));

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const isDbEntry = /\.db(?:-wal|-shm|-journal)?$/i.test(entry.name);
    const isCtrlEntry = RUNTIME_CONTROL_FILES.has(entry.name);
    const isTranscripts = entry.name === "transcripts";
    const isAdapterDir = entry.name === "grokbot" || entry.name === "monolith" || entry.name === "codex";
    const isArtifactDir = entry.name === "workflow-artifacts";
    if (!isDbEntry && !isCtrlEntry && !isTranscripts && !isAdapterDir && !isArtifactDir) {
      continue;
    }

    const full = join(absDir, entry.name);
    let lst;
    try {
      lst = lstatSync(full);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (lst.isSymbolicLink()) {
      throw new UsageError(`Symlinks are disallowed in data_dir: "${full}"`);
    }
    const realFull = realpathSync(full);
    if (!insideRoot(realFull)) {
      throw new UsageError(`data_dir entry escapes "${absDir}": "${full}"`);
    }
    if (isArtifactDir) {
      if (!lst.isDirectory()) {
        throw new UsageError(`data_dir/workflow-artifacts must be a directory: "${full}"`);
      }
      continue;
    }
    if (isTranscripts) {
      if (!lst.isDirectory()) {
        throw new UsageError(`data_dir/transcripts must be a directory: "${full}"`);
      }
      if (strictTranscripts) {
        const insideTranscripts = (p) => (realFull.endsWith(sep) ? p.startsWith(realFull) : p.startsWith(realFull + sep));
        for (const tEntry of readdirSync(full, { withFileTypes: true })) {
          const tFull = join(full, tEntry.name);
          let tLst;
          try {
            tLst = lstatSync(tFull);
          } catch (e) {
            if (e.code === "ENOENT") continue;
            throw e;
          }
          if (tLst.isSymbolicLink() || !tLst.isFile()) {
            throw new UsageError(`data_dir/transcripts entry "${tEntry.name}" must be a regular file (symlinks disallowed): "${tFull}"`);
          }
          const realT = realpathSync(tFull);
          if (!insideTranscripts(realT)) {
            throw new UsageError(`data_dir/transcripts entry escapes "${full}": "${tFull}"`);
          }
        }
      }
      continue;
    }
    if (isAdapterDir) {
      if (!lst.isDirectory()) {
        throw new UsageError(`data_dir/${entry.name} must be a directory: "${full}"`);
      }
      assertSafeRegularTree(full, `data_dir/${entry.name}`, { rootReal: realRoot });
      continue;
    }
    if (!lst.isFile()) {
      throw new UsageError(`data_dir runtime entry "${entry.name}" must be a regular file: "${full}"`);
    }
  }
}

/**
 * Recursively verify that `dirPath` (if present) is a non-symlink directory containing only
 * non-symlink regular files and directories within `rootReal ?? realpathSync(dirPath)`.
 */
export function assertSafeRegularTree(dirPath, label = "directory", { rootReal = null, skipNodeModules = false } = {}) {
  if (!dirPath) return;
  const absDir = resolve(dirPath);
  let dirLst;
  try {
    dirLst = lstatSync(absDir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    throw new UsageError(`${label} must be a regular directory (symlinks disallowed): "${absDir}"`);
  }
  const effectiveRoot = rootReal ?? realpathSync(absDir);
  const insideRoot = (p) =>
    p === effectiveRoot || (effectiveRoot.endsWith(sep) ? p.startsWith(effectiveRoot) : p.startsWith(effectiveRoot + sep));
  const realDir = realpathSync(absDir);
  if (!insideRoot(realDir)) {
    throw new UsageError(`${label} escapes root "${effectiveRoot}": "${absDir}"`);
  }

  const stack = [absDir];
  while (stack.length > 0) {
    const curDir = stack.pop();
    for (const item of readdirSync(curDir, { withFileTypes: true })) {
      const itemPath = join(curDir, item.name);
      let itemLst;
      try {
        itemLst = lstatSync(itemPath);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (itemLst.isSymbolicLink()) {
        throw new UsageError(`${label} entry must not be a symlink: "${itemPath}"`);
      }
      const realItem = realpathSync(itemPath);
      if (!insideRoot(realItem)) {
        throw new UsageError(`${label} entry escapes root "${effectiveRoot}": "${itemPath}"`);
      }
      if (skipNodeModules && item.name === "node_modules") {
        if (!itemLst.isDirectory()) {
          throw new UsageError(`${label} node_modules must be a directory: "${itemPath}"`);
        }
        continue;
      }
      if (itemLst.isDirectory()) {
        stack.push(itemPath);
      } else if (!itemLst.isFile()) {
        throw new UsageError(`${label} entry must be a regular file or directory: "${itemPath}"`);
      }
    }
  }
}

/**
 * Reject symlinked, non-regular, or escaping resources under `<rootPath>/.uwf.json` and
 * `<rootPath>/.github/{skills,agents,instructions,prompts}` before spawning child CLIs.
 */
export function assertSafeSkillDbs(rootPath, label = "repo_root") {
  if (!rootPath) return;
  const absRoot = resolve(rootPath);
  let rootLst;
  try {
    rootLst = lstatSync(absRoot);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
    throw new UsageError(`${label} must be a regular directory: "${absRoot}"`);
  }
  const realRoot = realpathSync(absRoot);
  const insideRoot = (p) => (realRoot.endsWith(sep) ? p.startsWith(realRoot) : p.startsWith(realRoot + sep));

  const uwfCfg = join(absRoot, ".uwf.json");
  try {
    const cfgLst = lstatSync(uwfCfg);
    if (cfgLst.isSymbolicLink() || !cfgLst.isFile()) {
      throw new UsageError(`${label}/.uwf.json must be a regular file (symlinks disallowed): "${uwfCfg}"`);
    }
    if (!insideRoot(realpathSync(uwfCfg))) {
      throw new UsageError(`${label}/.uwf.json escapes root "${absRoot}": "${uwfCfg}"`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const dotGithub = join(absRoot, ".github");
  let ghLst;
  try {
    ghLst = lstatSync(dotGithub);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (ghLst.isSymbolicLink() || !ghLst.isDirectory()) {
    throw new UsageError(`${label}/.github must be a regular directory (symlinks disallowed): "${dotGithub}"`);
  }
  if (!insideRoot(realpathSync(dotGithub))) {
    throw new UsageError(`${label}/.github escapes root "${absRoot}": "${dotGithub}"`);
  }

  assertSafeRegularTree(join(dotGithub, "skills"), `${label}/.github/skills`, {
    rootReal: realRoot,
    skipNodeModules: true,
  });
  for (const sub of ["agents", "instructions", "prompts"]) {
    assertSafeRegularTree(join(dotGithub, sub), `${label}/.github/${sub}`, {
      rootReal: realRoot,
    });
  }
}

const OPEN_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Safely read a bounded regular UTF-8 file inside `dirPath` without following symlinks
 * or blocking on FIFOs, capping actual bytes read even if the file grows after `fstat`.
 * Returns `null` if missing; throws `UsageError` on symlinks, non-regular files, or oversized files.
 */
export function readRegularFileBounded(
  dirPath,
  fileName,
  { maxBytes = 16 * 1024 * 1024, label = fileName } = {},
) {
  const realFile = assertRegularFileInDir(dirPath, fileName, label);
  if (!realFile) return null;
  const full = join(resolve(dirPath), fileName);
  let fd;
  try {
    fd = openSync(full, OPEN_NOFOLLOW_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new UsageError(`${label} must be a regular file (symlinks disallowed): "${full}"`);
    }
    if (st.size > maxBytes) {
      throw new UsageError(`${label} exceeds ${maxBytes} byte limit: "${full}"`);
    }
    const chunks = [];
    let total = 0;
    const chunkBuf = Buffer.allocUnsafe(65536);
    while (true) {
      const n = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) {
        throw new UsageError(`${label} exceeds ${maxBytes} byte limit: "${full}"`);
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, n)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP") {
      throw new UsageError(`${label} must be a regular file (symlinks disallowed): "${full}"`);
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function readRunMeta(dataDir) {
  const raw = readRegularFileBounded(dataDir, RUN_META_FILE, {
    maxBytes: 1024 * 1024,
    label: "run-meta.json",
  });
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRunMeta(dataDir, meta) {
  const absDir = resolve(dataDir);
  try {
    if (lstatSync(absDir).isSymbolicLink()) {
      throw new UsageError(`data_dir must not be a symlink: "${absDir}"`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const previousRaw = readRegularFileBounded(absDir, RUN_META_FILE, {
    maxBytes: 1024 * 1024,
    label: "run-meta.json",
  });
  const existed = previousRaw !== null;
  mkdirSync(absDir, { recursive: true });
  if (lstatSync(absDir).isSymbolicLink()) {
    throw new UsageError(`data_dir must not be a symlink: "${absDir}"`);
  }
  const metaPath = join(absDir, RUN_META_FILE);
  try {
    if (lstatSync(metaPath).isSymbolicLink()) {
      throw new UsageError(`run-meta.json must not be a symlink: "${metaPath}"`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    renameSync(tmpPath, metaPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return {
    metaPath,
    rollback() {
      if (!existed) {
        rmSync(metaPath, { force: true });
        return;
      }
      const restoreTmp = `${metaPath}.${process.pid}.${Date.now()}.${randomUUID()}.restore.tmp`;
      try {
        writeFileSync(restoreTmp, previousRaw, { encoding: "utf8", flag: "wx" });
        renameSync(restoreTmp, metaPath);
      } finally {
        rmSync(restoreTmp, { force: true });
      }
    },
  };
}

function runIndexPath(stateDir, runId) {
  const key = createHash("sha256").update(String(runId)).digest("hex");
  return join(resolveUawStateDir(stateDir), "runs", `${key}.json`);
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLockJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function withRunIndexLock(stateDir, runId, fn) {
  const key = createHash("sha256").update(String(runId)).digest("hex");
  const locksDir = join(resolveUawStateDir(stateDir), "run-locks");
  const lockPath = join(locksDir, `${key}.lock`);
  const reclaimPath = `${lockPath}.reclaim`;
  mkdirSync(locksDir, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${lockPath}.${token}.tmp`;
  const deadline = Date.now() + 300;
  let acquired = false;
  let linkedIno = null;

  try {
    writeFileSync(tmpPath, JSON.stringify({ run_id: runId, pid: process.pid, token }) + "\n", "utf8");
    while (!acquired) {
      try {
        linkSync(tmpPath, lockPath);
        linkedIno = statSync(lockPath).ino;
        acquired = true;
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
      const other = readLockJson(lockPath);
      const deadPid = Boolean(other && Number.isInteger(other.pid) && !isPidAlive(other.pid));
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
            const cur = readLockJson(lockPath);
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
        throw new UsageError(
          `Could not acquire run_id "${runId}" index lock (held by pid ${other?.pid ?? "unknown"}); retry shortly.`,
        );
      }
      sleepSyncMs(10);
    }
    return fn();
  } finally {
    rmSync(tmpPath, { force: true });
    if (acquired && linkedIno !== null) {
      try {
        if (statSync(lockPath).ino === linkedIno && readLockJson(lockPath)?.token === token) {
          unlinkSync(lockPath);
        }
      } catch {
        /* lock already removed */
      }
    }
  }
}

export function pruneSupersededRunIndices(stateDir, meta) {
  if (!meta?.run_id || !meta?.data_dir) return;
  const canonicalDataDir = canonicalPathKey(meta.data_dir);
  const currentIdxPath = runIndexPath(stateDir, meta.run_id);
  const runsDir = dirname(currentIdxPath);
  if (!existsSync(runsDir)) return;
  const currentName = basename(currentIdxPath);
  for (const name of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
    if (name === currentName) continue;
    const otherPath = join(runsDir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(otherPath, "utf8"));
      if (
        !parsed?.run_id ||
        parsed.run_id === meta.run_id ||
        !parsed?.data_dir ||
        canonicalPathKey(parsed.data_dir) !== canonicalDataDir
      ) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      withRunIndexLock(stateDir, parsed.run_id, () => {
        try {
          const latest = JSON.parse(readFileSync(otherPath, "utf8"));
          if (
            latest?.run_id === parsed.run_id &&
            latest?.data_dir &&
            canonicalPathKey(latest.data_dir) === canonicalDataDir
          ) {
            rmSync(otherPath, { force: true });
          }
        } catch {
          /* ignore missing or unreadable sibling index entry */
        }
      });
    } catch {
      /* ignore transient lock/filesystem error on sibling index entry */
    }
  }
}

export function registerRunIndex(stateDir, meta, { pruneSuperseded = true } = {}) {
  if (!meta?.run_id || !meta?.data_dir) return null;
  const canonicalDataDir = canonicalPathKey(meta.data_dir);
  const reg = withRunIndexLock(stateDir, meta.run_id, () => {
    const existing = lookupRunById(stateDir, meta.run_id);
    if (existing?.data_dir && canonicalPathKey(existing.data_dir) !== canonicalDataDir) {
      throw new UsageError(
        `run_id "${meta.run_id}" is already registered to data_dir "${existing.data_dir}" (refusing to reassign to "${meta.data_dir}")`,
      );
    }
    const idxPath = runIndexPath(stateDir, meta.run_id);
    const createdNew = !existing;
    let previousRaw = null;
    if (!createdNew && existsSync(idxPath)) {
      try {
        previousRaw = readFileSync(idxPath, "utf8");
      } catch {
        previousRaw = null;
      }
    }
    const runsDir = dirname(idxPath);
    mkdirSync(runsDir, { recursive: true });
    const tmpPath = `${idxPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      renameSync(tmpPath, idxPath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
    return {
      idxPath,
      createdNew,
      rollback() {
        withRunIndexLock(stateDir, meta.run_id, () => {
          if (createdNew) {
            const cur = lookupRunById(stateDir, meta.run_id);
            if (cur?.data_dir && canonicalPathKey(cur.data_dir) === canonicalDataDir) {
              rmSync(idxPath, { force: true });
            }
            return;
          }
          if (previousRaw !== null) {
            const restoreTmp = `${idxPath}.${process.pid}.${Date.now()}.${randomUUID()}.restore.tmp`;
            try {
              writeFileSync(restoreTmp, previousRaw, { encoding: "utf8", flag: "wx" });
              renameSync(restoreTmp, idxPath);
            } finally {
              rmSync(restoreTmp, { force: true });
            }
          }
        });
      },
    };
  });
  if (pruneSuperseded) {
    pruneSupersededRunIndices(stateDir, meta);
  }
  return reg;
}

export function lookupRunById(stateDir, runId) {
  if (!runId || typeof runId !== "string") return null;
  const idxPath = runIndexPath(stateDir, runId);
  if (!existsSync(idxPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(idxPath, "utf8"));
    return parsed && parsed.run_id === runId ? parsed : null;
  } catch {
    return null;
  }
}

export function listRegisteredRuns(stateDir, { allowedRoots } = {}) {
  const dir = join(resolveUawStateDir(stateDir), "runs");
  if (!existsSync(dir)) return [];
  const hasAllowlist = Array.isArray(allowedRoots) && allowedRoots.length > 0;
  const runs = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (parsed?.run_id && parsed?.data_dir) {
        if (hasAllowlist) {
          assertAllowedPath(parsed.data_dir, allowedRoots, "data_dir");
        }
        try {
          const liveMeta = readRunMeta(parsed.data_dir);
          if (liveMeta?.run_id && liveMeta.run_id !== parsed.run_id) continue;
        } catch {
          continue;
        }
        runs.push(parsed);
      }
    } catch {
      /* ignore corrupt or disallowed index entry */
    }
  }
  return runs;
}

/**
 * Resolve a run target from either `run_id` or `data_dir`,
 * validating against `allowedRoots` when configured.
 */
export function resolveRunTarget({ run_id, data_dir, stateDir, allowedRoots, requireExisting = false } = {}) {
  const resolvedStateDir = resolveUawStateDir(stateDir);
  const canonicalStateDir = canonicalizePath(resolvedStateDir);
  if (run_id !== undefined && run_id !== null) {
    if (typeof run_id !== "string" || !run_id.trim() || run_id.includes("\0")) {
      throw new UsageError("run_id must be a non-empty string without NUL bytes");
    }
    if (run_id === "." || run_id.includes("/") || run_id.includes("\\") || run_id.includes("..")) {
      throw new UsageError(`Invalid run_id "${run_id}": path traversal sequences are disallowed`);
    }
  }
  let resolvedDataDir = null;
  let meta = null;

  const assertNotInStateDir = (dir) => {
    if (pathsOverlap(dir, canonicalStateDir)) {
      throw new UsageError(`data_dir "${dir}" cannot overlap UAW state directory "${canonicalStateDir}"`);
    }
  };

  if (data_dir) {
    resolvedDataDir = assertAllowedPath(data_dir, allowedRoots, "data_dir");
    assertNotInStateDir(resolvedDataDir);
    if (run_id) {
      const indexed = lookupRunById(resolvedStateDir, run_id);
      if (indexed?.data_dir && canonicalPathKey(indexed.data_dir) !== canonicalPathKey(resolvedDataDir)) {
        throw new UsageError(
          `run_id "${run_id}" is already registered to data_dir "${indexed.data_dir}" (refusing to reassign to "${resolvedDataDir}")`,
        );
      }
    }
    meta = readRunMeta(resolvedDataDir);
  } else if (run_id) {
    const indexed = lookupRunById(resolvedStateDir, run_id);
    if (indexed?.data_dir) {
      resolvedDataDir = assertAllowedPath(indexed.data_dir, allowedRoots, "data_dir");
      assertNotInStateDir(resolvedDataDir);
      meta = readRunMeta(resolvedDataDir) ?? indexed;
    } else if (!requireExisting) {
      const safeRun = String(run_id).replace(/[^A-Za-z0-9._-]+/g, "_");
      if (!safeRun || safeRun === "." || safeRun === "..") {
        throw new UsageError(`Invalid run_id "${run_id}"`);
      }
      const baseDir = Array.isArray(allowedRoots) && allowedRoots.length > 0
        ? join(canonicalizePath(allowedRoots[0]), ".uaw-runs")
        : (process.env.UAW_RUNS_DIR
            ? canonicalizePath(process.env.UAW_RUNS_DIR)
            : join(dirname(canonicalStateDir), "uaw-runs"));
      const candidate = join(baseDir, safeRun);
      resolvedDataDir = assertAllowedPath(candidate, allowedRoots, "data_dir");
      assertNotInStateDir(resolvedDataDir);
      meta = readRunMeta(resolvedDataDir);
    } else {
      throw new UsageError(`Unknown run_id "${run_id}" (no registered data_dir found)`);
    }
  } else {
    throw new UsageError("Either run_id or data_dir is required");
  }

  if (run_id && meta?.run_id && meta.run_id !== run_id) {
    throw new UsageError(
      `run_id mismatch for data_dir ${resolvedDataDir}: persisted "${meta.run_id}", requested "${run_id}"`,
    );
  }

  const effectiveRunId = run_id ?? meta?.run_id ?? null;
  if (effectiveRunId) {
    const indexed = lookupRunById(resolvedStateDir, effectiveRunId);
    if (indexed?.data_dir && canonicalPathKey(indexed.data_dir) !== canonicalPathKey(resolvedDataDir)) {
      throw new UsageError(
        `run_id "${effectiveRunId}" is already registered to data_dir "${indexed.data_dir}" (refusing to reassign to "${resolvedDataDir}")`,
      );
    }
  }

  return {
    runId: meta?.run_id ?? run_id ?? null,
    dataDir: resolvedDataDir,
    meta,
    stateDir: resolvedStateDir,
  };
}
