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

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const reclaimPath = `${lockPath}.reclaim`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${lockPath}.${token}.tmp`;
  const deadline = Date.now() + 5_000;
  let acquired = false;
  let linkedIno = null;

  try {
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, token, ts: Date.now() }) + "\n", "utf8");
    while (!acquired) {
      try {
        linkSync(tmpPath, lockPath);
        linkedIno = statSync(lockPath).ino;
        acquired = true;
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }

      let st;
      try {
        st = statSync(lockPath);
      } catch {
        continue;
      }
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        holder = null;
      }
      let deadPid = false;
      if (holder && Number.isInteger(holder.pid) && holder.pid > 0) {
        try {
          process.kill(holder.pid, 0);
        } catch (ke) {
          if (ke.code === "ESRCH") deadPid = true;
        }
      }
      const corruptStale = (!holder || !Number.isInteger(holder.pid)) && Date.now() - st.mtimeMs > 1_000;
      if (deadPid || corruptStale) {
        let holdingReclaim = false;
        try {
          writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, token, ts: Date.now() }) + "\n", { flag: "wx" });
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
          let reclaimed = false;
          try {
            const stNow = statSync(lockPath);
            let cur = null;
            try { cur = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* corrupt */ }
            if (stNow.ino === st.ino && (!holder?.token || cur?.token === holder.token)) {
              unlinkSync(lockPath);
              reclaimed = true;
            }
          } catch (unlinkErr) {
            if (unlinkErr.code === "ENOENT") reclaimed = true;
          } finally {
            rmSync(reclaimPath, { force: true });
          }
          if (reclaimed) continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for mark-stage lock at ${lockPath}`);
      }
      sleepSync(15);
    }
    return fn();
  } finally {
    rmSync(tmpPath, { force: true });
    if (acquired && linkedIno !== null) {
      try {
        const cur = JSON.parse(readFileSync(lockPath, "utf8"));
        if (statSync(lockPath).ino === linkedIno && cur?.token === token) {
          unlinkSync(lockPath);
        }
      } catch {
        /* lock already removed */
      }
    }
  }
}

function copyNodeModulesIsolated(
  srcNm,
  destNm,
  { realBoundaryRoot = null, absDestBoundaryRoot = null, excludedRealPaths = [] } = {},
) {
  let rootLst;
  try {
    rootLst = lstatSync(srcNm);
  } catch {
    return;
  }
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) return;

  const realSrcNm = realpathSync(srcNm);
  const absDestNm = resolve(destNm);
  const realBoundary = realBoundaryRoot ?? realSrcNm;
  const absDestBoundary = absDestBoundaryRoot ?? absDestNm;

  function walkNm(curSrc, curDest) {
    mkdirSync(curDest, { recursive: true });
    for (const entry of readdirSync(curSrc, { withFileTypes: true })) {
      const src = join(curSrc, entry.name);
      const dest = join(curDest, entry.name);
      let lst;
      try {
        lst = lstatSync(src);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        try {
          const linkTarget = readlinkSync(src);
          if (isAbsolute(linkTarget)) continue;
          const realTarget = realpathSync(src);
          if (!isInsideOrEqual(realTarget, realBoundary)) continue;
          if (excludedRealPaths.some((ex) => ex && isInsideOrEqual(realTarget, ex))) continue;
          if (!isInsideOrEqual(resolve(dirname(dest), linkTarget), absDestBoundary)) continue;
          symlinkSync(linkTarget, dest);
        } catch {
          /* skip dangling or escaping symlink */
        }
      } else if (lst.isDirectory()) {
        walkNm(src, dest);
      } else if (lst.isFile()) {
        copyFileSync(src, dest);
      }
    }
  }

  walkNm(srcNm, absDestNm);
}

function copyDataDirState(absDataDir, dataSnapshotDir, { snapshotsRoot, resolvedOutput }) {
  mkdirSync(dataSnapshotDir, { recursive: true });
  if (!existsSync(absDataDir)) return;
  const sameOutputAndData = resolve(resolvedOutput) === resolve(absDataDir);

  function walkData(srcDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name;
      if (
        name === SNAPSHOTS_DIR ||
        name === EVENTS_FILE ||
        name === "mark-stage.lock" ||
        name === "run.lock" ||
        name === "transcripts" ||
        name.endsWith(".tmp")
      ) {
        continue;
      }
      const src = join(srcDir, name);
      if (isInsideOrEqual(src, snapshotsRoot)) continue;
      if (!sameOutputAndData && isInsideOrEqual(src, resolvedOutput)) continue;
      let lst;
      try {
        lst = lstatSync(src);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      const dest = join(destDir, name);
      if (lst.isDirectory()) {
        walkData(src, dest);
      } else if (lst.isFile()) {
        copyFileSync(src, dest);
      }
    }
  }

  walkData(absDataDir, dataSnapshotDir);
}

function copyArtifactsDir(resolvedOutput, artifactsDir, { snapshotsRoot, absDataDir }) {
  mkdirSync(artifactsDir, { recursive: true });
  if (!existsSync(resolvedOutput)) return;
  const sameOutputAndData = resolve(resolvedOutput) === resolve(absDataDir);

  function walkArtifacts(srcDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const src = join(srcDir, entry.name);
      if (isInsideOrEqual(src, snapshotsRoot)) continue;
      if (!sameOutputAndData && isInsideOrEqual(src, absDataDir)) continue;
      let lst;
      try {
        lst = lstatSync(src);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      const dest = join(destDir, entry.name);
      if (lst.isDirectory()) {
        walkArtifacts(src, dest);
      } else if (lst.isFile()) {
        copyFileSync(src, dest);
      }
    }
  }

  walkArtifacts(resolvedOutput, artifactsDir);
}

function safeRealPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_INDEX_VERSION",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];
const MAX_DIRECT_OBJECTS_BYTES = 16 * 1024 * 1024;

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_OVERRIDES) delete env[k];
  return env;
}

function copySafeGitEntry(src, dest) {
  let lst;
  try {
    lst = lstatSync(src);
  } catch {
    return;
  }
  if (lst.isSymbolicLink()) return;
  const name = src.split(/[\\/]/).pop();
  if (name && name.endsWith(".lock")) return;
  if (lst.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  if (lst.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name.endsWith(".lock")) continue;
      copySafeGitEntry(join(src, entry.name), join(dest, entry.name));
    }
  }
}

function measureObjectsSize(dir, limit) {
  let total = 0;
  function walk(cur) {
    if (total > limit) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total > limit) return;
      const p = join(cur, entry.name);
      let lst;
      try {
        lst = lstatSync(p);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) walk(p);
      else if (lst.isFile()) total += lst.size;
    }
  }
  walk(dir);
  return total;
}

function snapshotGitMetadata(absRepo, repoSnapshotDir) {
  const dotGit = join(absRepo, ".git");
  let dotGitLst;
  try {
    dotGitLst = lstatSync(dotGit);
  } catch {
    return;
  }
  if (dotGitLst.isSymbolicLink() || (!dotGitLst.isDirectory() && !dotGitLst.isFile())) {
    return;
  }

  const gitEnv = cleanGitEnv();
  let rawPaths;
  try {
    rawPaths = execFileSync(
      "git",
      ["-C", absRepo, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return;
  }
  const lines = rawPaths.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return;
  let realGitDir;
  let realCommonDir;
  try {
    realGitDir = realpathSync(lines[0]);
    realCommonDir = realpathSync(lines[1]);
    if (!lstatSync(realGitDir).isDirectory() || !lstatSync(realCommonDir).isDirectory()) return;
  } catch {
    return;
  }

  const destGit = join(repoSnapshotDir, ".git");
  mkdirSync(destGit, { recursive: true });

  for (const entryName of ["HEAD", "config", "packed-refs", "shallow", "refs", "info"]) {
    copySafeGitEntry(join(realCommonDir, entryName), join(destGit, entryName));
  }
  for (const entryName of ["HEAD", "index", "ORIG_HEAD"]) {
    copySafeGitEntry(join(realGitDir, entryName), join(destGit, entryName));
  }

  const destConfig = join(destGit, "config");
  if (existsSync(destConfig)) {
    for (const key of ["core.worktree", "core.hookspath"]) {
      try {
        execFileSync("git", ["config", "--file", destConfig, "--unset-all", key], {
          env: gitEnv,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        /* exit 5 when key is absent */
      }
    }
  }

  const srcObjects = join(realCommonDir, "objects");
  try {
    const objLst = lstatSync(srcObjects);
    if (!objLst.isSymbolicLink() && objLst.isDirectory()) {
      const realObjects = realpathSync(srcObjects);
      const upstreamAlternates = join(realObjects, "info", "alternates");
      const hasUpstreamAlternates = existsSync(upstreamAlternates);
      if (!hasUpstreamAlternates && measureObjectsSize(realObjects, MAX_DIRECT_OBJECTS_BYTES) <= MAX_DIRECT_OBJECTS_BYTES) {
        copySafeGitEntry(realObjects, join(destGit, "objects"));
      } else {
        const altLines = [];
        if (hasUpstreamAlternates) {
          try {
            for (const line of readFileSync(upstreamAlternates, "utf8").split(/\r?\n/)) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) continue;
              altLines.push(resolve(realObjects, trimmed));
            }
          } catch {
            /* ignore unreadable upstream alternates */
          }
        }
        altLines.push(realObjects);
        const infoDir = join(destGit, "objects", "info");
        mkdirSync(infoDir, { recursive: true });
        writeFileSync(join(infoDir, "alternates"), [...new Set(altLines)].join("\n") + "\n", "utf8");
      }
    }
  } catch {
    /* ignore unreadable objects directory */
  }
}

function copyWorkspaceTree(repoRoot, repoSnapshotDir, { dataDir, outputPath }) {
  const absRepo = resolve(repoRoot);
  const realRepo = safeRealPath(absRepo);
  const absDataDir = resolve(dataDir);
  const absOutput = resolve(absRepo, outputPath);
  const absTmp = join(absRepo, "tmp");
  const absRepoSnap = resolve(repoSnapshotDir);
  const excludedRealPaths = [
    safeRealPath(join(absRepo, ".git")),
    safeRealPath(absDataDir),
    safeRealPath(absOutput),
    safeRealPath(absTmp),
  ];

  function walkCopy(srcDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name === ".git") continue;
      const src = join(srcDir, name);
      if (isInsideOrEqual(src, absDataDir) || isInsideOrEqual(src, absOutput) || isInsideOrEqual(src, absTmp)) {
        continue;
      }
      if (name === "node_modules") {
        copyNodeModulesIsolated(src, join(destDir, name), {
          realBoundaryRoot: realRepo,
          absDestBoundaryRoot: absRepoSnap,
          excludedRealPaths,
        });
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
  snapshotGitMetadata(absRepo, repoSnapshotDir);
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
    const dataSnapshotDir = join(snapshotDir, "data");

    try {
      mkdirSync(artifactsDir, { recursive: true });
      mkdirSync(repoSnapshotDir, { recursive: true });
      copyDataDirState(absDataDir, dataSnapshotDir, { snapshotsRoot, resolvedOutput });
      copyArtifactsDir(resolvedOutput, artifactsDir, { snapshotsRoot, absDataDir });

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
        dataSnapshotDir,
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
