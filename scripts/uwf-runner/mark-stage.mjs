#!/usr/bin/env node
/**
 * mark-stage.mjs — Stage-completion event marker & immutable snapshotter for the UAW monolith
 * control condition (`docs/research/cli-offload-design.md` §3.1, issue #102).
 *
 * When the model completes a stage in monolith mode, it runs:
 *   node <path>/mark-stage.mjs <stageName>
 *
 * This script copies every gate-visible path (`outputPath` artifacts and configured `{{cwd}}`
 * paths such as `docs/adr`, plus the repo workspace when `run_script` gates apply) into an
 * immutable per-event snapshot under `<dataDir>/monolith-snapshots/` and appends the event to
 * `<dataDir>/monolith-events.json`.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS_FILE = "monolith-events.json";
const SNAPSHOTS_DIR = "monolith-snapshots";
const VALID_STAGE_RE = /^[A-Za-z0-9_-]+$/;

export function parseCwdPaths(raw) {
  if (!raw) return ["docs/adr"];
  if (Array.isArray(raw)) return raw.filter((p) => typeof p === "string" && p.trim());
  const trimmed = String(raw).trim();
  if (!trimmed) return ["docs/adr"];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === "string" && p.trim());
    } catch {
      /* fall through to delimiter split */
    }
  }
  return trimmed.split(/[,\n:]/).map((s) => s.trim()).filter(Boolean);
}

function parseList(raw) {
  if (!raw) return new Set();
  return new Set(String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

function sanitizeRelPath(relPath) {
  const s = String(relPath ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s || isAbsolute(s) || s.startsWith("..") || s.split("/").includes("..")) {
    throw new Error(`Invalid cwd snapshot path "${relPath}": must be a safe relative path inside repoRoot`);
  }
  return s;
}

function atomicWriteJson(filePath, obj) {
  mkdirSync(join(filePath, ".."), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readMarkEvents(dataDir) {
  if (!dataDir) return [];
  const eventsPath = join(resolve(dataDir), EVENTS_FILE);
  if (!existsSync(eventsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(eventsPath, "utf8"));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

function isInsideOrEqual(candidate, targetDir) {
  const rel = relative(resolve(targetDir), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withMarkLock(absDataDir, fn) {
  mkdirSync(absDataDir, { recursive: true });
  const lockPath = join(absDataDir, "mark-stage.lock");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        // Reclaim stale lock only if holder PID is dead or unreadable/old.
        let reclaim = false;
        try {
          const holder = JSON.parse(readFileSync(lockPath, "utf8"));
          try { process.kill(holder.pid, 0); } catch (ke) { if (ke.code === "ESRCH") reclaim = true; }
        } catch {
          reclaim = true;
        }
        if (reclaim) {
          rmSync(lockPath, { force: true });
          continue;
        }
        throw new Error(`Timed out waiting for mark-stage lock at ${lockPath}`);
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function copyWorkspaceTree(repoRoot, repoSnapshotDir, { dataDir, outputPath }) {
  const absRepo = resolve(repoRoot);
  const absDataDir = resolve(dataDir);
  const absOutput = resolve(absRepo, outputPath);
  const absTmp = join(absRepo, "tmp");

  function walkCopy(srcDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name === ".git" || name === "node_modules") continue;
      const src = join(srcDir, name);
      if (isInsideOrEqual(src, absDataDir) || isInsideOrEqual(src, absOutput) || isInsideOrEqual(src, absTmp)) {
        continue;
      }
      let lst;
      try { lst = lstatSync(src); } catch { continue; }
      if (lst.isSymbolicLink()) continue;
      const dest = join(destDir, name);
      if (lst.isDirectory()) {
        walkCopy(src, dest);
      } else if (lst.isFile()) {
        copyFileSync(src, dest);
      }
    }
  }

  walkCopy(absRepo, repoSnapshotDir);

  const repoNodeModules = join(absRepo, "node_modules");
  const snapNodeModules = join(repoSnapshotDir, "node_modules");
  if (existsSync(repoNodeModules) && !existsSync(snapNodeModules)) {
    try {
      symlinkSync(repoNodeModules, snapNodeModules, "dir");
    } catch {
      /* optional symlink for npm test execution */
    }
  }
}

/**
 * Capture an immutable snapshot of `outputPath` and `cwdPaths` (plus workspace source files when
 * `snapshotWorkspace` is true) for `stageName`, and record the completion event in `monolith-events.json`.
 */
export function markStage(
  stageName,
  {
    dataDir,
    outputPath,
    repoRoot = process.cwd(),
    cwdPaths = ["docs/adr"],
    snapshotWorkspace = false,
  } = {},
) {
  if (!stageName || typeof stageName !== "string" || !VALID_STAGE_RE.test(stageName)) {
    throw new Error(`Invalid stage name "${stageName}": expected [A-Za-z0-9_-]+`);
  }
  if (!dataDir) {
    throw new Error("markStage requires dataDir (pass --data-dir or set UWF_MONOLITH_DATA_DIR / UWF_DATA_DIR)");
  }

  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  const resolvedOutput = outputPath
    ? (isAbsolute(outputPath) ? outputPath : resolve(absRepoRoot, outputPath))
    : join(absDataDir, "workflow-artifacts");

  return withMarkLock(absDataDir, () => {
    const snapshotsRoot = join(absDataDir, SNAPSHOTS_DIR);
    mkdirSync(snapshotsRoot, { recursive: true });

    const existing = readMarkEvents(absDataDir);
    let seq = existing.length + 1;
    const attempt = existing.filter((e) => e.stage === stageName).length + 1;
    let snapshotDir;
    while (true) {
      const snapName = `${String(seq).padStart(4, "0")}-${stageName}-attempt-${attempt}`;
      snapshotDir = join(snapshotsRoot, snapName);
      try {
        // Exclusive non-recursive mkdir guarantees distinct snapshot directories per event.
        mkdirSync(snapshotDir);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        seq++;
      }
    }

    const artifactsDir = join(snapshotDir, "artifacts");
    const repoSnapshotDir = join(snapshotDir, "repo");

    try {
      mkdirSync(artifactsDir, { recursive: true });
      mkdirSync(repoSnapshotDir, { recursive: true });

      if (existsSync(resolvedOutput)) {
        cpSync(resolvedOutput, artifactsDir, {
          recursive: true,
          dereference: false,
          filter: (src) => {
            try { return !lstatSync(src).isSymbolicLink(); } catch { return false; }
          },
        });
      }

      if (snapshotWorkspace && existsSync(absRepoRoot)) {
        copyWorkspaceTree(absRepoRoot, repoSnapshotDir, { dataDir: absDataDir, outputPath: resolvedOutput });
      }

      const safeCwdPaths = [];
      const realRepoRoot = existsSync(absRepoRoot) ? realpathSync(absRepoRoot) : absRepoRoot;
      for (const rel of cwdPaths ?? []) {
        const cleanRel = sanitizeRelPath(rel);
        safeCwdPaths.push(cleanRel);
        const src = resolve(absRepoRoot, cleanRel);
        const dest = resolve(repoSnapshotDir, cleanRel);
        if (!isInsideOrEqual(dest, repoSnapshotDir)) {
          throw new Error(`Snapshot destination escapes repo snapshot: ${cleanRel}`);
        }
        if (existsSync(src)) {
          if (lstatSync(src).isSymbolicLink() || !isInsideOrEqual(realpathSync(src), realRepoRoot)) {
            continue;
          }
          mkdirSync(join(dest, ".."), { recursive: true });
          cpSync(src, dest, {
            recursive: true,
            dereference: false,
            filter: (p) => {
              try { return !lstatSync(p).isSymbolicLink(); } catch { return false; }
            },
          });
        }
      }

      const event = {
        seq,
        stage: stageName,
        attempt,
        timestamp: new Date().toISOString(),
        snapshotDir,
        artifactsDir,
        repoSnapshotDir,
        cwdPaths: safeCwdPaths,
        snapshotWorkspace: Boolean(snapshotWorkspace),
      };

      atomicWriteJson(join(absDataDir, EVENTS_FILE), {
        events: [...existing, event],
      });

      return event;
    } catch (err) {
      rmSync(snapshotDir, { recursive: true, force: true });
      throw err;
    }
  });
}

function parseCliArgs(argv) {
  const flags = { "cwd-path": [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      positional.push(t);
      continue;
    }
    const key = t.slice(2);
    if (key === "workspace") {
      flags.workspace = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    if (key === "cwd-path") flags["cwd-path"].push(next);
    else flags[key] = next;
    i++;
  }
  return { stageName: positional[0], flags };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`Usage error: ${err.message}\n`);
    return 2;
  }
  const { stageName, flags } = parsed;
  if (!stageName) {
    process.stderr.write(
      "Usage: mark-stage.mjs <stageName> [--data-dir <d>] [--output-path <p>] [--repo-root <r>] [--cwd-path <rel>]... [--workspace]\n",
    );
    return 2;
  }
  const dataDir = flags["data-dir"] ?? process.env.UWF_MONOLITH_DATA_DIR ?? process.env.UWF_DATA_DIR;
  const outputPath = flags["output-path"] ?? process.env.UWF_MONOLITH_OUTPUT_PATH;
  const repoRoot = flags["repo-root"] ?? process.env.UWF_MONOLITH_REPO_ROOT ?? process.cwd();
  const cwdPaths = flags["cwd-path"].length
    ? flags["cwd-path"]
    : parseCwdPaths(process.env.UWF_MONOLITH_CWD_PATHS);
  const runScriptStages = parseList(process.env.UWF_MONOLITH_RUN_SCRIPT_STAGES);
  const snapshotWorkspace = flags.workspace === true || runScriptStages.has(stageName);

  try {
    const ev = markStage(stageName, {
      dataDir,
      outputPath,
      repoRoot,
      cwdPaths,
      snapshotWorkspace,
    });
    process.stdout.write(JSON.stringify({ ok: true, ...ev }, null, 2) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`[mark-stage] ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
