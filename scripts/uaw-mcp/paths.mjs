/**
 * paths.mjs — Workspace root allowlists, UAW state directory, durable run metadata,
 * and run-ID index for uaw-mcp/v1.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * Canonicalize a path even if the leaf does not yet exist:
 * resolves symlinks on the deepest existing ancestor and re-appends remaining segments.
 */
export function canonicalizePath(targetPath) {
  const abs = resolve(targetPath);
  const trailing = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    trailing.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  let base = cur;
  try {
    base = realpathSync(cur);
  } catch {
    base = cur;
  }
  return trailing.length ? join(base, ...trailing) : base;
}

/**
 * Verify that `targetPath` lies within at least one configured workspace root.
 * When `allowedRoots` is empty/unset, no root restriction is applied (local stdio mode).
 */
export function assertAllowedPath(targetPath, allowedRoots, label = "path") {
  if (!targetPath || typeof targetPath !== "string") {
    throw new UsageError(`${label} must be a non-empty string`);
  }
  const canonicalTarget = canonicalizePath(targetPath);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return canonicalTarget;
  }
  const allowed = allowedRoots.some((root) => {
    const canonicalRoot = canonicalizePath(root);
    if (canonicalTarget === canonicalRoot) return true;
    const rel = relative(canonicalRoot, canonicalTarget);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!allowed) {
    throw new UsageError(
      `${label} "${targetPath}" is outside the configured workspace root allowlist`,
    );
  }
  return canonicalTarget;
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

export function readRunMeta(dataDir) {
  const metaPath = join(resolve(dataDir), RUN_META_FILE);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRunMeta(dataDir, meta) {
  const absDir = resolve(dataDir);
  mkdirSync(absDir, { recursive: true });
  const metaPath = join(absDir, RUN_META_FILE);
  const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    renameSync(tmpPath, metaPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return metaPath;
}

function runIndexPath(stateDir, runId) {
  const key = createHash("sha256").update(String(runId)).digest("hex");
  return join(resolveUawStateDir(stateDir), "runs", `${key}.json`);
}

export function registerRunIndex(stateDir, meta) {
  if (!meta?.run_id || !meta?.data_dir) return null;
  const idxPath = runIndexPath(stateDir, meta.run_id);
  mkdirSync(dirname(idxPath), { recursive: true });
  const tmpPath = `${idxPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    renameSync(tmpPath, idxPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
  return idxPath;
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

export function listRegisteredRuns(stateDir) {
  const dir = join(resolveUawStateDir(stateDir), "runs");
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (parsed?.run_id && parsed?.data_dir) runs.push(parsed);
    } catch {
      /* ignore corrupt index entry */
    }
  }
  return runs;
}

/**
 * Resolve a run target from either `run_id`, `data_dir`, or `UWF_DATA_DIR`,
 * validating against `allowedRoots` when configured.
 */
export function resolveRunTarget({ run_id, data_dir, stateDir, allowedRoots, requireExisting = false } = {}) {
  const resolvedStateDir = resolveUawStateDir(stateDir);
  let resolvedDataDir = null;
  let meta = null;

  if (data_dir) {
    resolvedDataDir = assertAllowedPath(data_dir, allowedRoots, "data_dir");
    meta = readRunMeta(resolvedDataDir);
  } else if (run_id) {
    const indexed = lookupRunById(resolvedStateDir, run_id);
    if (indexed?.data_dir) {
      resolvedDataDir = assertAllowedPath(indexed.data_dir, allowedRoots, "data_dir");
      meta = readRunMeta(resolvedDataDir) ?? indexed;
    } else if (!requireExisting) {
      const safeRun = String(run_id).replace(/[^A-Za-z0-9._-]+/g, "_");
      const candidate = join(resolvedStateDir, "runs-data", safeRun);
      resolvedDataDir = assertAllowedPath(candidate, allowedRoots, "data_dir");
      meta = readRunMeta(resolvedDataDir);
    } else {
      throw new UsageError(`Unknown run_id "${run_id}" (no registered data_dir found)`);
    }
  } else if (process.env.UWF_DATA_DIR) {
    resolvedDataDir = assertAllowedPath(process.env.UWF_DATA_DIR, allowedRoots, "data_dir");
    meta = readRunMeta(resolvedDataDir);
  } else {
    throw new UsageError("Either run_id or data_dir is required");
  }

  if (run_id && meta?.run_id && meta.run_id !== run_id) {
    throw new UsageError(
      `run_id mismatch for data_dir ${resolvedDataDir}: persisted "${meta.run_id}", requested "${run_id}"`,
    );
  }

  return {
    runId: meta?.run_id ?? run_id ?? null,
    dataDir: resolvedDataDir,
    meta,
    stateDir: resolvedStateDir,
  };
}
