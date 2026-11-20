#!/usr/bin/env node
/**
 * provenance.mjs — Content-addressed UAW Run Provenance Manifest & Post-Commit Seal (ADR-0009).
 *
 * Usage:
 *   node scripts/uwf-runner/provenance.mjs materialize --workflow <w> --data-dir <d>
 *     [--output-path <p>] [--repo-root <r>] [--skills-root <s>] [--phase snapshot|closed]
 *     [--defer-seal] [--base-commit <sha>] [--pr-url <u>] [--release-tag <t>] [--artifact-uri <u>]
 *
 *   node scripts/uwf-runner/provenance.mjs seal --workflow <w> --data-dir <d>
 *     [--output-path <p>] [--repo-root <r>] [--skills-root <s>]
 *     [--head-commit <sha>] [--base-commit <sha>] [--pr-url <u>] [--release-tag <t>] [--artifact-uri <u>]
 *
 *   node scripts/uwf-runner/provenance.mjs scrub --data-dir <d>
 *     [--workflow <w>] [--output-path <p>] [--repo-root <r>] [--skills-root <s>]
 *
 *   node scripts/uwf-runner/provenance.mjs verify --data-dir <d> [--repo-root <r>]
 *   node scripts/uwf-runner/provenance.mjs read --data-dir <d>
 *
 * Exit codes: 0 success | 1 operational / verification / strict-sink failure | 2 usage error
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  buildSinkEnvelope,
  canonicalizeJcs,
  compareUtf16,
  computeIdempotencyKey,
  dispatchToContextHub,
  scrubDeep,
  sha256Hex,
} from "./context-hub-sink.mjs";
import { redactSecrets } from "../hooks/secret-patterns.mjs";
import { listTranscripts, transcriptRow } from "./cost.mjs";
import { inferTranscriptStage, matchPromptStage, normalizeStageName } from "./stage-match.mjs";

export { canonicalizeJcs, compareUtf16, computeIdempotencyKey, inferTranscriptStage, matchPromptStage, normalizeStageName, scrubDeep, sha256Hex };

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = resolve(HERE, "..", "..");
const SKILLS_DIR = join(OWN_ROOT, ".github", "skills");

const MANIFEST_FILE = "uaw-manifest.json";
const RUN_META_FILE = "run-meta.json";
const GOAL_FILE = "runner-goal.md";
const ROUTING_FILE = "runner-routing.json";
const SCHEMA_VERSION = "1.0.0";
const MAX_DATA_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STAGE_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Write UTF-8 text or Buffer atomically via a unique sibling temp file, fsync, mode preservation, and `renameSync`.
 */
export function writeFileAtomic(filePath, content) {
  const absPath = resolve(filePath);
  const inspectRegularTarget = () => {
    try {
      const st = lstatSync(absPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`Refusing unsafe or symlinked file at ${absPath}`);
      }
      return st.mode & 0o7777;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return null;
    }
  };
  const prevMode = inspectRegularTarget();
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(absPath)}.tmp-${process.pid}-${randomUUID()}`);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  let fd = null;
  try {
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, prevMode ?? 0o666);
    try {
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      fd = null;
    }
    if (prevMode !== null) {
      chmodSync(tmpPath, prevMode);
    }
    inspectRegularTarget();
    renameSync(tmpPath, absPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore close error */ }
    }
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

// Load better-sqlite3 and js-yaml from the skill packages (or fallback to local node_modules).
function loadDatabaseCtor() {
  const candidates = [
    join(SKILLS_DIR, "uwf-state-manager", "state.mjs"),
    join(SKILLS_DIR, "uwf-orchestration-engine", "stage-tracker.mjs"),
    import.meta.url,
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req("better-sqlite3");
    } catch { /* try next */ }
  }
  throw new Error("better-sqlite3 could not be resolved from skill packages or node_modules");
}

function loadYamlLib() {
  const candidates = [
    join(SKILLS_DIR, "uwf-orchestration-engine", "stage-tracker.mjs"),
    join(SKILLS_DIR, "uwf-state-manager", "state.mjs"),
    import.meta.url,
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req("js-yaml");
    } catch { /* try next */ }
  }
  throw new Error("js-yaml could not be resolved from skill packages or node_modules");
}

// ---------------------------------------------------------------------------
// Durable Run Metadata (<data-dir>/run-meta.json)
// ---------------------------------------------------------------------------

function resolveHeadSha(repoRoot) {
  if (!repoRoot || !isGitRepo(repoRoot)) return null;
  try {
    return gitExec(repoRoot, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

function recoverPersistedRunIdentity(absDataDir) {
  const out = {
    runId: null,
    workflow: null,
    modeHint: null,
    outputPath: null,
    baseCommitSha: null,
    hasRunnerHistory: false,
  };
  let realDataDir = absDataDir;
  try {
    const dirLst = lstatSync(absDataDir);
    if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) return out;
    realDataDir = realpathSync(absDataDir);
  } catch {
    return out;
  }

  let Database = null;
  try {
    Database = loadDatabaseCtor();
  } catch {
    Database = null;
  }

  let stageLedgerWorkflow = null;
  if (Database) {
    const stagesChecked = assertSafeDbPath(join(absDataDir, "uwf-stages.db"), absDataDir);
    const stagesDb = stagesChecked.exists ? openReadOnly(Database, stagesChecked.path) : null;
    if (stagesDb) {
      try {
        if (tableExists(stagesDb, "stage_history")) {
          const sh = stagesDb.prepare("SELECT workflow FROM stage_history ORDER BY id DESC LIMIT 1").get();
          if (sh && typeof sh.workflow === "string" && sh.workflow.trim()) {
            stageLedgerWorkflow = sh.workflow.trim();
          }
        }
        if (!stageLedgerWorkflow && tableExists(stagesDb, "stage_runs")) {
          const sr = stagesDb
            .prepare(
              "SELECT workflow FROM stage_runs ORDER BY CASE WHEN completed_at IS NOT NULL OR started_at IS NOT NULL THEN 1 ELSE 0 END DESC, COALESCE(completed_at, started_at) DESC, id DESC LIMIT 1",
            )
            .get();
          if (sr && typeof sr.workflow === "string" && sr.workflow.trim()) {
            stageLedgerWorkflow = sr.workflow.trim();
          }
        }
      } finally {
        stagesDb.close();
      }
    }
  }

  let historyWorkflow = null;
  if (Database) {
    const stateChecked = assertSafeDbPath(join(absDataDir, "uwf-state.db"), absDataDir);
    const stateDb = stateChecked.exists ? openReadOnly(Database, stateChecked.path) : null;
    if (stateDb) {
      try {
        if (tableExists(stateDb, "workflow_state")) {
          const ws = stateDb.prepare("SELECT * FROM workflow_state WHERE id = 1").get();
          if (ws) {
            if (typeof ws.run_id === "string" && ws.run_id.trim()) out.runId = ws.run_id.trim();
            if (typeof ws.mode === "string" && ws.mode.trim()) out.modeHint = ws.mode.trim();
            if (typeof ws.artifact_path === "string" && ws.artifact_path.trim()) out.outputPath = ws.artifact_path.trim();
          }
        }
        if (tableExists(stateDb, "workflow_history")) {
          out.hasRunnerHistory = Boolean(
            stateDb
              .prepare("SELECT 1 FROM workflow_history WHERE note LIKE 'runner start:%' OR note LIKE 'runner resume:%' LIMIT 1")
              .get()
          );
          const startHist = stateDb
            .prepare("SELECT note FROM workflow_history WHERE note LIKE 'runner start: workflow=%' ORDER BY id DESC LIMIT 1")
            .get();
          const wfMatch =
            typeof startHist?.note === "string" ? startHist.note.match(/^runner start:\s+workflow=(\S+)/) : null;
          if (wfMatch && wfMatch[1]) {
            historyWorkflow = wfMatch[1].trim();
          }
        }
        if (tableExists(stateDb, "run_manifests")) {
          const ledgerWf = historyWorkflow ?? stageLedgerWorkflow;
          let rm = null;
          if (out.runId) {
            rm = stateDb
              .prepare("SELECT run_id, workflow, manifest_json FROM run_manifests WHERE run_id = ?")
              .get(out.runId);
          } else if (ledgerWf) {
            rm = stateDb
              .prepare("SELECT run_id, workflow, manifest_json FROM run_manifests WHERE workflow = ? ORDER BY finalized_at DESC, rowid DESC LIMIT 1")
              .get(ledgerWf);
          }
          if (rm) {
            if (!out.runId && typeof rm.run_id === "string" && rm.run_id.trim()) out.runId = rm.run_id.trim();
            if (!out.workflow && typeof rm.workflow === "string" && rm.workflow.trim()) out.workflow = rm.workflow.trim();
            if (!out.baseCommitSha && typeof rm.manifest_json === "string") {
              try {
                const parsedRm = JSON.parse(rm.manifest_json);
                const base = parsedRm?.deliverable?.base_commit_sha;
                if (typeof base === "string" && base.trim()) out.baseCommitSha = base.trim();
              } catch { /* ignore */ }
            }
          }
        }
      } finally {
        stateDb.close();
      }
    }
  }
  if (!out.workflow) {
    out.workflow = historyWorkflow ?? stageLedgerWorkflow ?? null;
  }

  let rawMan = null;
  try {
    rawMan = readContainedDataFile(absDataDir, MANIFEST_FILE, "Manifest").toString("utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (rawMan !== null) {
    try {
      const parsedMan = JSON.parse(rawMan);
      if (parsedMan && typeof parsedMan === "object" && !Array.isArray(parsedMan)) {
        const manRunId =
          typeof parsedMan.run_id === "string" && parsedMan.run_id.trim() ? parsedMan.run_id.trim() : null;
        const manWorkflow =
          typeof parsedMan.workflow === "string" && parsedMan.workflow.trim() ? parsedMan.workflow.trim() : null;
        const targetWorkflow = out.workflow ?? historyWorkflow ?? stageLedgerWorkflow;
        const runMatches = Boolean(out.runId && manRunId === out.runId && (!targetWorkflow || !manWorkflow || manWorkflow === targetWorkflow));
        const workflowMatches = Boolean(!out.runId && targetWorkflow && manWorkflow === targetWorkflow);
        if (runMatches || workflowMatches) {
          if (!out.runId && manRunId) {
            out.runId = manRunId;
          }
          if (!out.workflow && manWorkflow) {
            out.workflow = manWorkflow;
          }
          const base = parsedMan.deliverable?.base_commit_sha;
          if (!out.baseCommitSha && typeof base === "string" && base.trim()) {
            out.baseCommitSha = base.trim();
          }
        }
      }
    } catch { /* ignore corrupt manifest fallback JSON */ }
  }

  return out;
}

/**
 * Read or initialize `<data-dir>/run-meta.json` so `run_id` stays durable across
 * resume, replay, and post-commit seal invocations, and rotates cleanly on forced fresh runs.
 */
export function ensureRunMeta(
  dataDir,
  { workflow = null, outputPath = null, runId = null, baseCommitSha = null, repoRoot = null, forceNew = false, persist = true } = {}
) {
  const absDataDir = resolve(dataDir);
  try {
    const dirLst = lstatSync(absDataDir);
    if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
      throw new Error(`Refusing unsafe or symlinked directory at ${absDataDir}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (persist) {
    mkdirSync(absDataDir, { recursive: true });
  }
  const metaPath = join(absDataDir, RUN_META_FILE);
  let metaFileExisted = false;
  try {
    const metaLst = lstatSync(metaPath);
    if (metaLst.isSymbolicLink() || !metaLst.isFile()) {
      throw new Error(`Refusing unsafe or symlinked run metadata at ${metaPath}`);
    }
    metaFileExisted = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let existing = null;
  let metaFileCorrupt = false;
  if (metaFileExisted) {
    const rawMeta = readContainedDataFile(absDataDir, RUN_META_FILE, "Run metadata").toString("utf8");
    try {
      const parsed = JSON.parse(rawMeta);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.run_id === "string" && parsed.run_id.trim().length > 0) {
        existing = parsed;
      } else {
        metaFileCorrupt = true;
      }
    } catch {
      metaFileCorrupt = true;
    }
  }

  const explicitRunId = runId || process.env.UAW_RUN_ID || null;
  if (!forceNew && existing) {
    if (explicitRunId && existing.run_id !== explicitRunId) {
      throw new Error(
        `Run ID mismatch for ${absDataDir}: run-meta.json records "${existing.run_id}", requested "${explicitRunId}"`,
      );
    }
    let existingWorkflow =
      typeof existing.workflow === "string" && existing.workflow.trim() ? existing.workflow.trim() : null;
    if (!existingWorkflow) {
      const recovered = recoverPersistedRunIdentity(absDataDir);
      if (recovered.runId && recovered.runId === existing.run_id && recovered.workflow) {
        existingWorkflow = recovered.workflow;
      }
    }
    if (workflow && existingWorkflow && workflow !== existingWorkflow) {
      throw new Error(
        `Workflow mismatch for ${absDataDir}: run-meta.json records "${existingWorkflow}", requested "${workflow}"`,
      );
    }
    let dirty = false;
    const resolvedWf = existingWorkflow ?? workflow;
    if ((typeof existing.workflow !== "string" || !existing.workflow.trim()) && resolvedWf) {
      existing.workflow = resolvedWf;
      dirty = true;
    }
    if (!existing.output_path && outputPath) { existing.output_path = outputPath; dirty = true; }
    if (!existing.base_commit_sha) {
      const resolvedBase = baseCommitSha ?? resolveHeadSha(repoRoot);
      if (resolvedBase) { existing.base_commit_sha = resolvedBase; dirty = true; }
    }
    if (dirty && persist) writeFileAtomic(metaPath, JSON.stringify(existing, null, 2) + "\n");
    return existing;
  }

  if (!forceNew && (!existing || metaFileCorrupt)) {
    const recovered = recoverPersistedRunIdentity(absDataDir);
    if (recovered.runId) {
      if (explicitRunId && explicitRunId !== recovered.runId) {
        throw new Error(`Run ID mismatch for ${absDataDir}: persisted state records "${recovered.runId}", requested "${explicitRunId}"`);
      }
      if (workflow && recovered.workflow && workflow !== recovered.workflow) {
        throw new Error(`Workflow mismatch for ${absDataDir}: persisted state records "${recovered.workflow}", requested "${workflow}"`);
      }
      const recoveredWorkflow = recovered.workflow ?? workflow ?? recovered.modeHint ?? "sw_dev";
      const recoveredBase = baseCommitSha ?? recovered.baseCommitSha ?? resolveHeadSha(repoRoot);
      const recoveredMeta = {
        run_id: recovered.runId,
        workflow: recoveredWorkflow,
        output_path: outputPath ?? recovered.outputPath ?? join(absDataDir, "workflow-artifacts"),
        created_at: new Date().toISOString(),
        ...(recoveredBase ? { base_commit_sha: recoveredBase } : {}),
      };
      if (persist) {
        writeFileAtomic(metaPath, JSON.stringify(recoveredMeta, null, 2) + "\n");
      }
      return recoveredMeta;
    }
    if (metaFileCorrupt) {
      throw new Error(`Corrupt run metadata at ${metaPath} and no persisted run_id found in uwf-state.db`);
    }
    if (recovered.hasRunnerHistory) {
      throw new Error(`Missing run metadata at ${metaPath} for existing runner run in ${absDataDir} with no persisted run_id in uwf-state.db`);
    }
  }

  const defaultWorkflow = workflow ?? "sw_dev";
  const resolvedBase = baseCommitSha ?? resolveHeadSha(repoRoot);
  const priorTranscripts = forceNew
    ? listTranscripts(absDataDir).map((f) => basename(f))
    : Array.isArray(existing?.prior_transcripts)
      ? existing.prior_transcripts
      : [];
  const preservedPointers = existing
    ? {
        ...(existing.data_dir ? { data_dir: existing.data_dir } : {}),
        ...(existing.repo_root ? { repo_root: existing.repo_root } : {}),
        ...(existing.skills_root ? { skills_root: existing.skills_root } : {}),
      }
    : {};
  const meta = {
    ...preservedPointers,
    run_id: explicitRunId || `${defaultWorkflow}-${randomUUID()}`,
    workflow: defaultWorkflow,
    output_path: outputPath ?? join(absDataDir, "workflow-artifacts"),
    created_at: new Date().toISOString(),
    ...(resolvedBase ? { base_commit_sha: resolvedBase } : {}),
    ...(priorTranscripts.length ? { prior_transcripts: priorTranscripts } : {}),
  };
  if (persist) {
    writeFileAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Git & Deliverable Identity Helpers
// ---------------------------------------------------------------------------

function gitExec(repoRoot, args, { env, encoding = "utf8", input } = {}) {
  const safeEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
  }
  if (env) Object.assign(safeEnv, env);
  return execFileSync(
    "git",
    [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat",
      "-c", "core.sshCommand=false",
      "-c", "core.attributesFile=/dev/null",
      "-c", "core.gitProxy=",
      "-c", "core.askPass=",
      "-c", "core.alternateRefsCommand=",
      "-c", "credential.helper=",
      "-c", "diff.external=",
      "-c", "http.proxy=",
      "-c", "protocol.allow=never",
      "-C", repoRoot,
      ...args,
    ],
    {
      encoding,
      env: safeEnv,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      ...(input !== undefined ? { input } : {}),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

export function isGitRepo(repoRoot) {
  try {
    const out = gitExec(repoRoot, ["rev-parse", "--is-inside-work-tree"]).trim();
    return out === "true";
  } catch {
    return false;
  }
}

function isValidGitObjectStore(gitDir) {
  try {
    gitExec(gitDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function assertSafeGitConfig(repoRoot) {
  try {
    const matched = gitExec(repoRoot, [
      "config",
      "--show-scope",
      "--includes",
      "--name-only",
      "--get-regexp",
      "^(include\\.|includeif\\.|extensions\\.partialclone$|filter\\.|diff\\..*\\.(textconv|command|external)|diff\\.external$|merge\\..*\\.driver|remote\\..*\\.(uploadpack|receivepack|proxy|promisor|partialclonefilter)|core\\.(gitproxy|askpass|alternaterefscommand)$|uploadpack\\.packobjectshook$)",
    ]);
    const badKeys = matched
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("command\t"))
      .map((line) => line.split("\t").slice(1).join("\t"));
    if (badKeys.length > 0) {
      throw new Error(`Refusing unsafe git config keys in ${repoRoot}: ${badKeys.join(", ")}`);
    }
  } catch (err) {
    if (err?.status === 1 && !String(err?.stderr ?? "").trim()) {
      return;
    }
    throw err;
  }
}

/** Normalize git remote URL into `owner/repo` when possible, else trimmed URL or local dir basename. */
export function normalizeRepositoryName(repoRoot) {
  try {
    const remote = gitExec(repoRoot, ["remote", "get-url", "origin"]).trim();
    if (remote) {
      const cleaned = remote.replace(/\.git$/i, "");
      const scp = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
      if (scp) return scp[1];
      try {
        const u = new URL(cleaned);
        const path = u.pathname.replace(/^\/+/, "");
        if (path) return path;
      } catch {
        return cleaned;
      }
    }
  } catch { /* no origin remote */ }
  return basename(resolve(repoRoot)) || null;
}

function toPosix(p) {
  return p.split(sep).join("/");
}

/**
 * Compute the git tree SHA of the tracked worktree state in `repoRoot`,
 * excluding `<data-dir>`, `tmp/`, `.git/`, and `.gitignore`-excluded paths.
 * Uses a temporary `GIT_INDEX_FILE` so `.git/index` is never mutated.
 */
export function computeWorktreeTreeSha(repoRoot, { dataDir = null, rawBlobs = false } = {}) {
  if (!isGitRepo(repoRoot)) return null;
  const absRepo = resolve(repoRoot);
  assertSafeGitConfig(absRepo);
  let relDataDir = null;
  if (dataDir) {
    const rel = toPosix(relative(absRepo, resolve(dataDir)));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      relDataDir = rel.replace(/\/+$/, "");
    }
  }

  const isExcluded = (p) => {
    const norm = toPosix(p).replace(/^\/+/, "");
    if (norm === "tmp" || norm.startsWith("tmp/")) return true;
    if (norm === ".git" || norm.startsWith(".git/")) return true;
    if (relDataDir && (norm === relDataDir || norm.startsWith(`${relDataDir}/`))) return true;
    return false;
  };

  const gitDirRaw = gitExec(absRepo, ["rev-parse", "--git-dir"]).trim();
  const gitDir = resolve(absRepo, gitDirRaw);
  const tempIdxDir = mkdtempSync(join(tmpdir(), "uaw-idx-"));
  const tempIndex = join(tempIdxDir, "index");
  const env = { GIT_INDEX_FILE: tempIndex };
  const gitBlobSha1 = (buf) =>
    createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

  try {
    let hasHead = true;
    try {
      gitExec(absRepo, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      gitExec(absRepo, ["read-tree", "HEAD"], { env });
    } else if (existsSync(join(gitDir, "index"))) {
      const idxPath = join(gitDir, "index");
      if (lstatSync(idxPath).isSymbolicLink()) {
        throw new Error(`Refusing symlinked git index at ${idxPath}`);
      }
      copyFileSync(idxPath, tempIndex);
    }

    const changes = new Map();
    if (hasHead) {
      const diffBuf = gitExec(
        absRepo,
        ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", "HEAD"],
        { encoding: "buffer" },
      );
      const fields = diffBuf.toString("utf8").split("\0").filter(Boolean);
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i];
        const filePath = fields[i + 1];
        changes.set(filePath, { path: filePath, deleted: status.startsWith("D") });
      }
    }
    const untrackedBuf = gitExec(absRepo, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
    for (const p of untrackedBuf.toString("utf8").split("\0").filter(Boolean)) {
      changes.set(p, { path: p, deleted: false });
    }

    const indexLines = [];
    for (const c of changes.values()) {
      if (isExcluded(c.path)) continue;
      const full = join(absRepo, c.path);
      let st = null;
      if (!c.deleted) {
        try { st = lstatSync(full); } catch { st = null; }
      }
      if (c.deleted || !st) {
        indexLines.push(`0 ${"0".repeat(40)}\t${c.path}\0`);
        continue;
      }
      if (st.isSymbolicLink()) {
        const targetBuf = Buffer.from(readlinkSync(full), "utf8");
        indexLines.push(`120000 ${gitBlobSha1(targetBuf)}\t${c.path}\0`);
      } else if (st.isFile()) {
        const mode = rawBlobs
          ? ((st.mode & 0o111) ? "100755" : "100644")
          : ((st.mode & 0o100) ? "100755" : "100644");
        const fileBuf = readFileSync(full);
        const blobSha = rawBlobs
          ? gitBlobSha1(fileBuf)
          : gitExec(absRepo, ["hash-object", "--stdin", "--path", c.path], {
              input: fileBuf,
            }).trim();
        indexLines.push(`${mode} ${blobSha}\t${c.path}\0`);
      }
    }
    if (indexLines.length > 0) {
      gitExec(absRepo, ["update-index", "-z", "--index-info"], {
        env,
        input: Buffer.from(indexLines.join(""), "utf8"),
      });
    }

    return gitExec(absRepo, ["write-tree", "--missing-ok"], { env }).trim();
  } finally {
    rmSync(tempIdxDir, { recursive: true, force: true });
  }
}

export function getCommitTreeSha(repoRoot, ref = "HEAD") {
  if (!isValidGitObjectStore(repoRoot)) return null;
  try {
    return gitExec(repoRoot, ["rev-parse", `${ref}^{tree}`]).trim();
  } catch {
    return null;
  }
}

export function collectGitDeliverable(repoRoot, { dataDir = null, overrides = {} } = {}) {
  const inGit = isGitRepo(repoRoot);
  const explicitHead = Object.hasOwn(overrides, "head_commit_sha") ? overrides.head_commit_sha : undefined;
  let headSha = explicitHead ?? null;
  let currentHead = null;
  let branch = overrides.branch ?? null;
  let repository = overrides.repository ?? null;

  if (inGit) {
    try { currentHead = gitExec(repoRoot, ["rev-parse", "HEAD"]).trim(); } catch { currentHead = null; }
    if (!branch) {
      try {
        const b = gitExec(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        branch = b && b !== "HEAD" ? b : null;
      } catch { branch = null; }
    }
    if (!repository) {
      repository = normalizeRepositoryName(repoRoot);
    }
  } else if (!repository) {
    repository = basename(resolve(repoRoot)) || null;
  }

  const baseCommitSha = overrides.base_commit_sha ?? currentHead ?? headSha ?? null;
  let gitTreeSha =
    overrides.git_tree_sha ??
    (inGit ? computeWorktreeTreeSha(repoRoot, { dataDir }) : null);

  if (explicitHead === undefined) {
    const headTree = inGit && currentHead ? getCommitTreeSha(repoRoot, currentHead) : null;
    if (headTree && gitTreeSha && headTree === gitTreeSha) {
      headSha = currentHead;
    } else if (
      headTree &&
      overrides.git_tree_sha === undefined &&
      inGit &&
      headTree === computeWorktreeTreeSha(repoRoot, { dataDir, rawBlobs: true })
    ) {
      gitTreeSha = headTree;
      headSha = currentHead;
    } else {
      headSha = null;
    }
  }

  const artifactUris = Array.isArray(overrides.artifact_uris)
    ? overrides.artifact_uris.filter((u) => typeof u === "string" && u.length > 0)
    : [];

  return {
    repository: repository ?? null,
    base_commit_sha: baseCommitSha,
    head_commit_sha: headSha,
    git_tree_sha: gitTreeSha,
    branch: branch ?? null,
    pr_url: overrides.pr_url ?? null,
    release_tag: overrides.release_tag ?? null,
    artifact_uris: artifactUris,
  };
}

/**
 * 5-tier total fallback chain for `deliverable_key` (ADR-0009):
 *   (1) ${pr_url}@${head_commit_sha}
 *   (2) ${repository}@${release_tag}@${head_commit_sha}
 *   (3) artifact_uris[0]
 *   (4) ${repository}@${head_commit_sha}
 *   (5) tree:${git_tree_sha} (or run:${run_id} outside git)
 */
export function resolveDeliverableKey(deliverable, runId) {
  const d = deliverable ?? {};
  if (d.pr_url && d.head_commit_sha) {
    return `${d.pr_url}@${d.head_commit_sha}`;
  }
  if (d.repository && d.release_tag && d.head_commit_sha) {
    return `${d.repository}@${d.release_tag}@${d.head_commit_sha}`;
  }
  if (Array.isArray(d.artifact_uris) && d.artifact_uris.length > 0 && d.artifact_uris[0]) {
    return d.artifact_uris[0];
  }
  if (d.repository && d.head_commit_sha) {
    return `${d.repository}@${d.head_commit_sha}`;
  }
  if (d.git_tree_sha) {
    return `tree:${d.git_tree_sha}`;
  }
  return `run:${runId}`;
}

// ---------------------------------------------------------------------------
// Stage Output Digest Capture
// ---------------------------------------------------------------------------

function compileGlobSegment(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      tokens.push({ type: "star" });
    } else if (ch === "?") {
      tokens.push({ type: "any" });
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        tokens.push({ type: "lit", ch: "[" });
      } else {
        let body = pattern.slice(i + 1, close);
        let negate = false;
        if (body.startsWith("!") || body.startsWith("^")) {
          negate = true;
          body = body.slice(1);
        }
        const ranges = [];
        for (let k = 0; k < body.length; k++) {
          if (k + 2 < body.length && body[k + 1] === "-") {
            const a = body.charCodeAt(k);
            const b = body.charCodeAt(k + 2);
            ranges.push([Math.min(a, b), Math.max(a, b)]);
            k += 2;
          } else {
            const c = body.charCodeAt(k);
            ranges.push([c, c]);
          }
        }
        tokens.push({ type: "class", negate, ranges });
        i = close;
      }
    } else {
      tokens.push({ type: "lit", ch });
    }
  }
  return tokens;
}

function matchGlobSegment(pattern, name) {
  const tokens = compileGlobSegment(pattern);
  const n = name.length;
  let dp = new Uint8Array(n + 1);
  dp[0] = 1;
  for (const tok of tokens) {
    const next = new Uint8Array(n + 1);
    if (tok.type === "star") {
      let matched = false;
      for (let j = 0; j <= n; j++) {
        if (dp[j]) matched = true;
        if (matched) next[j] = 1;
        if (j < n && name.charCodeAt(j) === 47) matched = false;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (!dp[j]) continue;
        const code = name.charCodeAt(j);
        if (code === 47) continue;
        if (tok.type === "any") {
          next[j + 1] = 1;
        } else if (tok.type === "lit") {
          if (name[j] === tok.ch) next[j + 1] = 1;
        } else if (tok.type === "class") {
          const inRange = tok.ranges.some(([lo, hi]) => code >= lo && code <= hi);
          if (tok.negate ? !inRange : inRange) next[j + 1] = 1;
        }
      }
    }
    dp = next;
  }
  return dp[n] === 1;
}

function isOutsideRel(rel) {
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

function readRegularFileNoFollow(filePath, label = "Declared output", { maxBytes = MAX_STAGE_OUTPUT_BYTES, allowedRealRoots = null } = {}) {
  let fd;
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  try {
    fd = openSync(filePath, openFlags);
  } catch (err) {
    const wrapped = err.code === "ELOOP" || err.code === "EFTYPE"
      ? new Error(`${label} "${filePath}" must not be a symlink`)
      : new Error(`Failed to open ${label.toLowerCase()} "${filePath}": ${err.message}`);
    wrapped.code = err.code;
    throw wrapped;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      const err = new Error(`${label} "${filePath}" must be a regular file`);
      err.code = "EINVAL";
      throw err;
    }
    if (st.size > maxBytes) {
      const err = new Error(`${label} "${filePath}" exceeds size limit (${st.size} > ${maxBytes})`);
      err.code = "EFBIG";
      throw err;
    }
    if (Array.isArray(allowedRealRoots)) {
      let realAfterOpen;
      let postSt;
      try {
        realAfterOpen = realpathSync(filePath);
        postSt = lstatSync(realAfterOpen);
      } catch (err) {
        const wrapped = new Error(`Failed post-open verification for ${label.toLowerCase()} "${filePath}": ${err.message}`);
        wrapped.code = "EINVAL";
        throw wrapped;
      }
      if (!allowedRealRoots.some((r) => isInsideOrEqual(realAfterOpen, r))) {
        const err = new Error(`Refusing ${label.toLowerCase()} escaping allowed roots: ${filePath}`);
        err.code = "EACCES";
        throw err;
      }
      if (postSt.dev !== st.dev || postSt.ino !== st.ino) {
        const err = new Error(`Concurrent path swap detected on ${label.toLowerCase()} "${filePath}"`);
        err.code = "EINVAL";
        throw err;
      }
    }
    const chunks = [];
    let total = 0;
    const chunkSize = 65536;
    const scratch = Buffer.allocUnsafe(chunkSize);
    while (true) {
      const maxRead = Number.isFinite(maxBytes) ? Math.min(chunkSize, Math.max(1, maxBytes - total + 1)) : chunkSize;
      let n;
      while (true) {
        try {
          n = readSync(fd, scratch, 0, maxRead, null);
          break;
        } catch (err) {
          if (err.code === "EINTR") continue;
          throw err;
        }
      }
      if (n === 0) break;
      total += n;
      if (total > maxBytes) {
        const err = new Error(`${label} "${filePath}" exceeds size limit (${total} > ${maxBytes})`);
        err.code = "EFBIG";
        throw err;
      }
      chunks.push(Buffer.from(scratch.subarray(0, n)));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  } finally {
    try { closeSync(fd); } catch { /* ignore close errors */ }
  }
}

export function readContainedDataFile(dataDir, relName, label = "Data file", { maxBytes = MAX_DATA_FILE_BYTES } = {}) {
  const absDataDir = resolve(dataDir);
  const filePath = join(absDataDir, relName);
  const rel = relative(absDataDir, filePath);
  if (!rel || isOutsideRel(rel)) {
    const err = new Error(`Refusing ${label.toLowerCase()} path escaping ${absDataDir}: ${filePath}`);
    err.code = "EINVAL";
    throw err;
  }
  let dirLst;
  try {
    dirLst = lstatSync(absDataDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      const notFound = new Error(`${label} not found at ${filePath}`);
      notFound.code = "ENOENT";
      throw notFound;
    }
    throw err;
  }
  if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
    const err = new Error(`Refusing unsafe or symlinked directory at ${absDataDir}`);
    err.code = "ELOOP";
    throw err;
  }
  const realDataDir = realpathSync(absDataDir);

  let cur = absDataDir;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch (err) {
      if (err.code === "ENOENT") {
        const notFound = new Error(`${label} not found at ${filePath}`);
        notFound.code = "ENOENT";
        throw notFound;
      }
      throw err;
    }
    const isLeaf = i === parts.length - 1;
    if (lst.isSymbolicLink() || (isLeaf ? !lst.isFile() : !lst.isDirectory())) {
      const detail = lst.isSymbolicLink() ? " (must not be a symlink)" : "";
      const err = new Error(`Refusing unsafe or symlinked ${label.toLowerCase()}${detail} at ${cur}`);
      err.code = "ELOOP";
      throw err;
    }
  }

  const realFile = realpathSync(filePath);
  if (!isInsideOrEqual(realFile, realDataDir)) {
    const err = new Error(`Refusing ${label.toLowerCase()} escaping ${absDataDir}: ${filePath}`);
    err.code = "EINVAL";
    throw err;
  }

  return readRegularFileNoFollow(filePath, label, { maxBytes, allowedRealRoots: [realDataDir] });
}

/**
 * Safely read `<data-dir>/uaw-manifest.json` after verifying regular/contained non-symlink paths.
 */
export function readManifestRaw(dataDir, { maxBytes = MAX_DATA_FILE_BYTES } = {}) {
  return readContainedDataFile(dataDir, MANIFEST_FILE, "Manifest", { maxBytes }).toString("utf8");
}

function assertSafeOutputAncestors(targetPath, { outputPath, repoRoot, skillsRoot }) {
  const absRepo = resolve(repoRoot);
  const absOut = resolve(absRepo, outputPath);
  const roots = [absOut, absRepo, ...(skillsRoot ? [resolve(skillsRoot)] : [])];
  const dirToCheck = dirname(targetPath);
  const sepPrefix = (r) => (r.endsWith(sep) ? r : r + sep);
  if (dirToCheck === absOut || dirToCheck.startsWith(sepPrefix(absOut))) {
    let outSt = null;
    try {
      outSt = lstatSync(absOut);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw new Error(`Cannot inspect declared output root "${absOut}": ${err.message}`);
      }
    }
    if (outSt && (outSt.isSymbolicLink() || !outSt.isDirectory())) {
      throw new Error(`Declared output root "${absOut}" must be a regular directory`);
    }
  }
  const matched = roots
    .filter((r) => dirToCheck === r || dirToCheck.startsWith(sepPrefix(r)))
    .sort((a, b) => a.length - b.length);
  const root = matched[0];
  if (!root) return;
  const rel = relative(root, dirToCheck);
  if (!rel || isOutsideRel(rel)) return;
  let cur = root;
  for (const seg of rel.split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err.code === "ENOENT") break;
      throw new Error(`Cannot inspect declared output ancestor "${cur}": ${err.message}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Declared output ancestor "${cur}" must not be a symlink`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Declared output ancestor "${cur}" is not a directory`);
    }
  }
}

function expandOutputTemplate(template, { outputPath, repoRoot, skillsRoot }) {
  const expanded = String(template)
    .replace(/\{\{output_path\}\}/g, () => outputPath)
    .replace(/\{\{cwd\}\}/g, () => repoRoot)
    .replace(/\{\{skills_root\}\}/g, () => skillsRoot ?? repoRoot);

  const absPattern = isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
  assertSafeOutputAncestors(absPattern, { outputPath, repoRoot, skillsRoot });
  if (!/[*?[\]]/.test(basename(absPattern))) {
    let st = null;
    try {
      st = lstatSync(absPattern);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw new Error(`Cannot inspect declared output "${absPattern}": ${err.message}`);
      }
      return [];
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Declared output "${absPattern}" must not be a symlink`);
    }
    if (!st.isFile()) {
      throw new Error(`Declared output "${absPattern}" must be a regular file`);
    }
    return [absPattern];
  }
  const dir = dirname(absPattern);
  const basePattern = basename(absPattern);
  let dirSt = null;
  try {
    dirSt = lstatSync(dir);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Cannot inspect declared output directory "${dir}": ${err.message}`);
    }
    return [];
  }
  if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new Error(`Declared output directory "${dir}" must be a regular directory`);
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(`Cannot read declared output directory "${dir}": ${err.message}`);
  }
  const matches = [];
  for (const name of entries) {
    if (!matchGlobSegment(basePattern, name)) continue;
    const entryPath = join(dir, name);
    let st;
    try {
      st = lstatSync(entryPath);
    } catch (err) {
      throw new Error(`Cannot inspect declared output "${entryPath}": ${err.message}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Declared output "${entryPath}" must not be a symlink`);
    }
    if (!st.isFile()) {
      throw new Error(`Declared output "${entryPath}" must be a regular file`);
    }
    matches.push(entryPath);
  }
  return matches;
}

function normalizeArtifactPath(absPath, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel && !isOutsideRel(rel)) {
    return toPosix(rel);
  }
  return toPosix(resolve(absPath));
}

export function hashFileEntry(absPath, repoRoot) {
  const buf = readRegularFileNoFollow(absPath);
  return {
    path: normalizeArtifactPath(absPath, repoRoot),
    sha256: sha256Hex(buf),
    bytes: buf.length,
  };
}

/**
 * Capture `{ path, sha256, bytes }[]` (sorted by UTF-16 path) for a stage's declared outputs.
 */
export function captureStageOutputs(stageOutputs, { outputPath, repoRoot, skillsRoot }) {
  const seen = new Map();
  for (const tmpl of stageOutputs ?? []) {
    for (const absPath of expandOutputTemplate(tmpl, { outputPath, repoRoot, skillsRoot })) {
      const entry = hashFileEntry(absPath, repoRoot);
      seen.set(entry.path, entry);
    }
  }
  return [...seen.values()].sort((a, b) => compareUtf16(a.path, b.path));
}

// ---------------------------------------------------------------------------
// Domain Store Readers (Read-Only)
// ---------------------------------------------------------------------------

function openReadOnly(Database, dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null;
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma("query_only = ON");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    throw new Error(`Failed to open SQLite store at ${dbPath}: ${err.message}`);
  }
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function queryAll(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function bumpCount(obj, key) {
  const cur = Object.hasOwn(obj, key) ? obj[key] : 0;
  Object.defineProperty(obj, key, { value: cur + 1, enumerable: true, configurable: true, writable: true });
}

function pushToArrayProp(obj, key, val) {
  if (!Object.hasOwn(obj, key)) {
    Object.defineProperty(obj, key, { value: [], enumerable: true, configurable: true, writable: true });
  }
  obj[key].push(val);
}

function isInsideOrEqual(candidate, parentDir) {
  const rel = relative(resolve(parentDir), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function resolveDomainDb(dataDir, skillDirName, dbFileName, repoRoot) {
  if (dataDir) {
    const checked = assertSafeDbPath(join(dataDir, dbFileName), dataDir);
    return checked.exists ? checked.path : null;
  }
  if (repoRoot) {
    const checked = assertSafeDbPath(join(repoRoot, ".github", "skills", skillDirName, dbFileName), repoRoot);
    return checked.exists ? checked.path : null;
  }
  return null;
}

function readRequirementsStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-requirements", "uwf-requirements.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "requirements")) return null;
    const rows = scrubDeep(queryAll(db, "SELECT * FROM requirements ORDER BY id ASC"));
    const byStatus = {};
    const byPrefix = { FR: [], NFR: [], DR: [], AC: [], RK: [] };
    for (const r of rows) {
      const st = String(r.status ?? "unknown");
      bumpCount(byStatus, st);
      const num = String(r.number ?? "");
      const m = num.match(/^([A-Z]+)-/);
      const prefix = m ? m[1] : String(r.type ?? "OTHER").toUpperCase();
      pushToArrayProp(byPrefix, prefix, num || String(r.id));
    }
    for (const k of Object.keys(byPrefix)) {
      byPrefix[k].sort(compareUtf16);
    }
    return {
      sha256: sha256Hex(canonicalizeJcs(rows)),
      total: rows.length,
      by_status: byStatus,
      by_prefix: byPrefix,
    };
  } finally {
    db.close();
  }
}

function readAdrsStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-adr", "uwf-adrs.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "adrs")) return null;
    const rows = scrubDeep(queryAll(db, "SELECT * FROM adrs ORDER BY number ASC, id ASC"));
    const realRepo = repoRoot && existsSync(repoRoot) ? realpathSync(repoRoot) : null;
    const realData = dataDir && existsSync(dataDir) ? realpathSync(dataDir) : null;
    const records = rows.map((r) => {
      let fileSha = null;
      if (r.file_path && typeof r.file_path === "string") {
        const abs = isAbsolute(r.file_path) ? resolve(r.file_path) : resolve(repoRoot, r.file_path);
        try {
          if (existsSync(abs) && lstatSync(abs).isFile()) {
            const realAbs = realpathSync(abs);
            if ((realRepo && isInsideOrEqual(realAbs, realRepo)) || (realData && isInsideOrEqual(realAbs, realData))) {
              fileSha = sha256Hex(readFileSync(realAbs));
            }
          }
        } catch { /* ignore unreadable or escaping ADR path */ }
      }
      return {
        number: String(r.number ?? ""),
        slug: String(r.slug ?? ""),
        status: String(r.status ?? "proposed"),
        superseded_by: r.superseded_by ?? null,
        file_path: r.file_path ?? null,
        file_sha256: fileSha,
      };
    });
    return {
      sha256: sha256Hex(canonicalizeJcs({ rows, records })),
      total: records.length,
      records,
    };
  } finally {
    db.close();
  }
}

function readDiscoveriesStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-discovery", "uwf-discoveries.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "discoveries")) return null;
    const rows = scrubDeep(queryAll(db, "SELECT * FROM discoveries ORDER BY id ASC"));
    const byCategory = {};
    const unresolvedGapIds = [];
    for (const r of rows) {
      const cat = String(r.category ?? "unknown");
      bumpCount(byCategory, cat);
      if (cat === "gap" && r.status !== "resolved" && r.status !== "closed") {
        unresolvedGapIds.push(Number(r.id));
      }
    }
    unresolvedGapIds.sort((a, b) => a - b);
    return {
      sha256: sha256Hex(canonicalizeJcs(rows)),
      total: rows.length,
      by_category: byCategory,
      unresolved_gap_ids: unresolvedGapIds,
    };
  } finally {
    db.close();
  }
}

function readReviewsStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-review", "uwf-reviews.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "reviews")) return null;
    const reviews = scrubDeep(queryAll(db, "SELECT * FROM reviews ORDER BY id ASC"));
    const findings = tableExists(db, "findings")
      ? scrubDeep(queryAll(db, "SELECT * FROM findings ORDER BY id ASC"))
      : [];
    const verdicts = reviews.map((r) => ({
      stage: String(r.stage ?? ""),
      verdict: String(r.verdict ?? "pending"),
    }));
    const findingsBySeverity = { critical: {}, major: {}, minor: {} };
    for (const f of findings) {
      const sev = String(f.severity ?? "major");
      const st = String(f.status ?? "open");
      if (!Object.hasOwn(findingsBySeverity, sev)) {
        Object.defineProperty(findingsBySeverity, sev, { value: {}, enumerable: true, configurable: true, writable: true });
      }
      bumpCount(findingsBySeverity[sev], st);
    }
    return {
      sha256: sha256Hex(canonicalizeJcs({ reviews, findings })),
      total_reviews: reviews.length,
      verdicts,
      findings_by_severity: findingsBySeverity,
    };
  } finally {
    db.close();
  }
}

function readIssuesStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-local-tracking", "uwf-issues.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "issues")) return null;
    const rows = scrubDeep(queryAll(db, "SELECT * FROM issues ORDER BY id ASC"));
    const byStatus = {};
    for (const r of rows) {
      const st = String(r.status ?? "open");
      bumpCount(byStatus, st);
    }
    return {
      sha256: sha256Hex(canonicalizeJcs(rows)),
      total: rows.length,
      by_status: byStatus,
    };
  } finally {
    db.close();
  }
}

function readQuestionsStore(Database, dataDir, repoRoot) {
  const dbPath = resolveDomainDb(dataDir, "uwf-question-protocol", "uwf-questions.db", repoRoot);
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    if (!tableExists(db, "questions")) return null;
    const rows = scrubDeep(queryAll(db, "SELECT * FROM questions ORDER BY id ASC"));
    const byStatus = {};
    for (const r of rows) {
      const st = String(r.status ?? "pending");
      bumpCount(byStatus, st);
    }
    return {
      sha256: sha256Hex(canonicalizeJcs(rows)),
      total: rows.length,
      by_status: byStatus,
    };
  } finally {
    db.close();
  }
}

function assertSafeDbPath(candidatePath, allowedRoot) {
  const absCandidate = resolve(candidatePath);
  if (!allowedRoot) return { exists: existsSync(absCandidate), path: absCandidate };
  const absRoot = resolve(allowedRoot);
  let rootLst;
  try {
    rootLst = lstatSync(absRoot);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, path: absCandidate };
    }
    throw err;
  }
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
    throw new Error(`Refusing unsafe or symlinked directory at ${absRoot}`);
  }
  const realRoot = realpathSync(absRoot);

  const rel = relative(absRoot, absCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing database path escaping ${absRoot}: ${absCandidate}`);
  }
  let cur = absRoot;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch (err) {
      if (err.code === "ENOENT") break;
      throw err;
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing symlinked database path at ${cur}`);
    }
  }

  let present = false;
  let realDb = absCandidate;
  try {
    const dbLst = lstatSync(absCandidate);
    if (dbLst.isSymbolicLink() || !dbLst.isFile()) {
      throw new Error(`Refusing unsafe or symlinked database at ${absCandidate}`);
    }
    realDb = realpathSync(absCandidate);
    if (!isInsideOrEqual(realDb, realRoot)) {
      throw new Error(`Refusing database escaping ${absRoot}: ${absCandidate}`);
    }
    present = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${absCandidate}${suffix}`;
    try {
      const sLst = lstatSync(sidecar);
      if (sLst.isSymbolicLink() || !sLst.isFile()) {
        throw new Error(`Refusing unsafe or symlinked SQLite sidecar at ${sidecar}`);
      }
      if (!isInsideOrEqual(realpathSync(sidecar), realRoot)) {
        throw new Error(`Refusing SQLite sidecar escaping ${absRoot}: ${sidecar}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  return { exists: present, path: present ? realDb : absCandidate };
}

/**
 * Canonical Build Spec store: `<data-dir>/uwf-cbs.db` or `.github/skills/uwf-cbs/uwf-cbs.db`.
 * Returns `null` when `blueprint` did not run or the DB does not exist.
 */
function readCbsStore(Database, dataDir, repoRoot, blueprintRan) {
  if (!blueprintRan) return null;
  const candidates = [
    { path: dataDir ? join(dataDir, "uwf-cbs.db") : null, root: dataDir },
    { path: repoRoot ? join(repoRoot, ".github", "skills", "uwf-cbs", "uwf-cbs.db") : null, root: repoRoot },
  ];
  let dbPath = null;
  for (const c of candidates) {
    if (!c.path) continue;
    const checked = assertSafeDbPath(c.path, c.root);
    if (checked.exists) {
      dbPath = checked.path;
      break;
    }
  }
  const db = openReadOnly(Database, dbPath);
  if (!db) return null;
  try {
    const components = tableExists(db, "components")
      ? scrubDeep(queryAll(db, "SELECT * FROM components ORDER BY id ASC"))
      : [];
    const interfaces = tableExists(db, "interfaces")
      ? scrubDeep(queryAll(db, "SELECT * FROM interfaces ORDER BY id ASC"))
      : [];
    const dependencies = tableExists(db, "dependencies")
      ? scrubDeep(queryAll(db, "SELECT * FROM dependencies ORDER BY id ASC"))
      : [];
    const sequencing = tableExists(db, "sequencing")
      ? scrubDeep(queryAll(db, "SELECT * FROM sequencing ORDER BY step_number ASC, id ASC"))
      : [];
    const constraints = tableExists(db, "constraints")
      ? scrubDeep(queryAll(db, "SELECT * FROM constraints ORDER BY id ASC"))
      : [];

    const constraintsBySeverity = {};
    const constraintsByStatus = {};
    for (const c of constraints) {
      const sev = String(c.severity ?? "medium");
      const st = String(c.status ?? "open");
      bumpCount(constraintsBySeverity, sev);
      bumpCount(constraintsByStatus, st);
    }

    const canonicalPayload = { components, interfaces, dependencies, sequencing, constraints };
    return {
      sha256: sha256Hex(canonicalizeJcs(canonicalPayload)),
      components_count: components.length,
      interfaces_count: interfaces.length,
      dependencies_count: dependencies.length,
      sequencing_count: sequencing.length,
      constraints_by_severity: constraintsBySeverity,
      constraints_by_status: constraintsByStatus,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Architecture Strata (DRS, BR, Changelog [SNAPSHOT])
// ---------------------------------------------------------------------------

function assertSafeIdentifierSegment(value, label) {
  const s = String(value ?? "");
  if (!s || s === "." || s === ".." || /[\\/]/.test(s) || !/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`Unsafe ${label} identifier: "${s}"`);
  }
  return s;
}

function resolveArtifactPrefix(workflow, skillsRoot, repoRoot) {
  const safeWorkflow = assertSafeIdentifierSegment(workflow, "workflow");
  const yaml = loadYamlLib();
  const candidates = [
    skillsRoot ? join(skillsRoot, ".github", "skills", `uwf-${safeWorkflow}`, "stages.yaml") : null,
    join(repoRoot, ".github", "skills", `uwf-${safeWorkflow}`, "stages.yaml"),
    join(SKILLS_DIR, `uwf-${safeWorkflow}`, "stages.yaml"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const doc = yaml.load(readFileSync(p, "utf8"));
        if (doc?.artifact_prefix) {
          return assertSafeIdentifierSegment(doc.artifact_prefix, "artifact_prefix");
        }
      } catch { /* try next */ }
    }
  }
  return "issues";
}

function resolveContainedRegularFile(absOut, realOut, relName) {
  if (!realOut) return null;
  const candidate = join(absOut, relName);
  try {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const realFile = realpathSync(candidate);
    if (!isInsideOrEqual(realFile, realOut)) return null;
    return { absPath: candidate, realPath: realFile };
  } catch {
    return null;
  }
}

function readArchitectureStrata({ outputPath, repoRoot, artifactPrefix }) {
  const safePrefix = assertSafeIdentifierSegment(artifactPrefix, "artifact_prefix");
  const absOut = isAbsolute(outputPath) ? outputPath : resolve(repoRoot, outputPath);
  let realOut = null;
  try {
    const outStat = lstatSync(absOut);
    if (!outStat.isSymbolicLink() && outStat.isDirectory()) {
      realOut = realpathSync(absOut);
    }
  } catch {
    realOut = null;
  }

  let drs = null;
  const drsFile = resolveContainedRegularFile(absOut, realOut, `${safePrefix}-drs.json`);
  if (drsFile) {
    const raw = readFileSync(drsFile.realPath);
    const sha256 = sha256Hex(raw);
    try {
      const parsed = scrubDeep(JSON.parse(raw.toString("utf8")));
      const components = Array.isArray(parsed.components) ? parsed.components : [];
      const edges = Array.isArray(parsed.dependency_graph?.edges) ? parsed.dependency_graph.edges : [];
      const gapLog = Array.isArray(parsed.gap_log) ? parsed.gap_log : [];
      const divergenceLog = Array.isArray(parsed.divergence_log) ? parsed.divergence_log : [];
      drs = {
        path: normalizeArtifactPath(drsFile.absPath, repoRoot),
        sha256,
        schema_version: parsed.schema_version ?? null,
        summary: {
          components_count: components.length,
          dependency_edges_count: edges.length,
          gap_log_count: gapLog.length,
          divergence_log_count: divergenceLog.length,
          divergence_log: divergenceLog,
          exit_criteria: parsed.exit_criteria && typeof parsed.exit_criteria === "object" ? parsed.exit_criteria : null,
        },
      };
    } catch {
      drs = {
        path: normalizeArtifactPath(drsFile.absPath, repoRoot),
        sha256,
        schema_version: null,
        summary: {
          components_count: 0,
          dependency_edges_count: 0,
          gap_log_count: 0,
          divergence_log_count: 0,
          divergence_log: [],
          exit_criteria: null,
        },
      };
    }
  }

  let br = null;
  const brFile = resolveContainedRegularFile(absOut, realOut, `${safePrefix}-br.json`);
  if (brFile) {
    const raw = readFileSync(brFile.realPath);
    const sha256 = sha256Hex(raw);
    try {
      const parsed = scrubDeep(JSON.parse(raw.toString("utf8")));
      const strataOut = {};
      const srcStrata = parsed.strata && typeof parsed.strata === "object" ? parsed.strata : {};
      for (const key of Object.keys(srcStrata).sort(compareUtf16)) {
        const s = srcStrata[key] ?? {};
        Object.defineProperty(strataOut, key, {
          value: {
            label: s.label ?? null,
            entry_count: Array.isArray(s.entries) ? s.entries.length : 0,
            closed_at: s.closed_at ?? null,
          },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      br = {
        path: normalizeArtifactPath(brFile.absPath, repoRoot),
        sha256,
        schema_version: parsed.version ?? parsed.schema_version ?? null,
        strata: strataOut,
      };
    } catch {
      br = {
        path: normalizeArtifactPath(brFile.absPath, repoRoot),
        sha256,
        schema_version: null,
        strata: {},
      };
    }
  }

  let changelogSnapshot = null;
  const changelogFile = resolveContainedRegularFile(absOut, realOut, "uwf-changelog.md");
  if (changelogFile) {
    const raw = readFileSync(changelogFile.realPath);
    const text = raw.toString("utf8");
    const matches = [...text.matchAll(/^##\s+\[SNAPSHOT\][^\r\n]*/gm)];
    let heading = null;
    let entrySha256 = null;
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      heading = scrubDeep(last[0].trim());
      const startIdx = last.index;
      const rest = text.slice(startIdx + last[0].length);
      const nextHeading = rest.search(/^##\s+/m);
      const section = nextHeading === -1 ? text.slice(startIdx) : text.slice(startIdx, startIdx + last[0].length + nextHeading);
      entrySha256 = sha256Hex(section.trim());
    }
    changelogSnapshot = {
      path: normalizeArtifactPath(changelogFile.absPath, repoRoot),
      sha256: sha256Hex(raw),
      heading,
      entry_sha256: entrySha256,
    };
  }

  return {
    drs,
    br,
    changelog_snapshot: changelogSnapshot,
  };
}

// ---------------------------------------------------------------------------
// Manifest Schema Validation (Draft-07 Schema Enforcer against uaw-manifest.schema.json)
// ---------------------------------------------------------------------------

const MANIFEST_SCHEMA_PATH = join(OWN_ROOT, "schemas", "uaw-manifest.schema.json");
let cachedManifestSchema = null;
const compiledPatternCache = new Map();

function getManifestSchema() {
  if (!cachedManifestSchema) {
    cachedManifestSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf8"));
  }
  return cachedManifestSchema;
}

function getCompiledRegex(pattern) {
  let re = compiledPatternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    compiledPatternCache.set(pattern, re);
  }
  return re;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function matchesSchemaType(val, typeName) {
  switch (typeName) {
    case "object": return isPlainObject(val);
    case "array": return Array.isArray(val);
    case "string": return typeof val === "string";
    case "integer": return Number.isInteger(val);
    case "number": return typeof val === "number" && Number.isFinite(val);
    case "boolean": return typeof val === "boolean";
    case "null": return val === null;
    default: return true;
  }
}

function resolveSchemaRef(schema, rootSchema) {
  if (!schema || !schema.$ref) return schema;
  const m = String(schema.$ref).match(/^#\/definitions\/([^/]+)$/);
  if (!m) throw new Error(`Unsupported manifest schema $ref: ${schema.$ref}`);
  const def = rootSchema.definitions?.[m[1]];
  if (!def) throw new Error(`Missing manifest schema definition: ${m[1]}`);
  return def;
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "definitions",
  "$ref",
  "type",
  "const",
  "enum",
  "minLength",
  "pattern",
  "minimum",
  "required",
  "properties",
  "additionalProperties",
  "items",
]);

function validateAgainstSchema(val, rawSchema, rootSchema, ptr, errs) {
  const schema = resolveSchemaRef(rawSchema, rootSchema);
  if (!schema) return;
  const label = ptr || "/";
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(k)) {
      throw new Error(`Unsupported JSON Schema keyword "${k}" at ${label}`);
    }
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesSchemaType(val, t))) {
      errs.push(`${label} must have type ${allowed.join("|")}`);
      return;
    }
  }

  if ("const" in schema && val !== schema.const) {
    errs.push(`${label} must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(val)) {
    errs.push(`${label} must be one of ${schema.enum.join("|")}`);
  }

  if (typeof val === "string") {
    if (typeof schema.minLength === "number" && val.length < schema.minLength) {
      errs.push(`${label} must have length >= ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string" && !getCompiledRegex(schema.pattern).test(val)) {
      errs.push(`${label} must match pattern ${schema.pattern}`);
    }
  }

  if (typeof val === "number") {
    if (typeof schema.minimum === "number" && val < schema.minimum) {
      errs.push(`${label} must be >= ${schema.minimum}`);
    }
  }

  if (isPlainObject(val)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(val, reqKey)) {
          errs.push(`${ptr}/${reqKey} is required`);
        }
      }
    }
    const props = isPlainObject(schema.properties) ? schema.properties : null;
    if (props) {
      for (const k of Object.keys(props)) {
        if (Object.hasOwn(val, k)) {
          validateAgainstSchema(val[k], props[k], rootSchema, `${ptr}/${k}`, errs);
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(val)) {
        if (!props || !Object.hasOwn(props, k)) {
          errs.push(`${ptr}/${k} is not an allowed property`);
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const k of Object.keys(val)) {
        if (!props || !Object.hasOwn(props, k)) {
          validateAgainstSchema(val[k], schema.additionalProperties, rootSchema, `${ptr}/${k}`, errs);
        }
      }
    }
  }

  if (Array.isArray(val) && schema.items) {
    val.forEach((item, i) => {
      validateAgainstSchema(item, schema.items, rootSchema, `${ptr}/${i}`, errs);
    });
  }
}

/**
 * Validate a manifest object against the ADR-0009 `uaw-manifest.schema.json` contract.
 * Returns an array of error strings (empty array = valid).
 */
export function validateManifest(manifest) {
  if (!isPlainObject(manifest)) return ["/ must be an object"];
  const errs = [];
  try {
    const schema = getManifestSchema();
    validateAgainstSchema(manifest, schema, schema, "", errs);
  } catch (err) {
    errs.push(`Manifest schema validation failed: ${err.message}`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// State DB (`run_manifests`) Helpers
// ---------------------------------------------------------------------------

function ensureRunManifestsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "run_manifests" (
      "run_id" TEXT PRIMARY KEY,
      "workflow" TEXT NOT NULL,
      "phase" TEXT NOT NULL,
      "manifest_sha256" TEXT NOT NULL,
      "deliverable_key" TEXT NOT NULL,
      "manifest_json" TEXT NOT NULL,
      "sink_status" TEXT NOT NULL DEFAULT 'disabled',
      "finalized_at" TEXT NOT NULL
    )
  `);
}

function readPersistedManifestRow(Database, dataDir, runId) {
  const checked = assertSafeDbPath(join(dataDir, "uwf-state.db"), dataDir);
  if (!checked.exists) return null;
  const db = openReadOnly(Database, checked.path);
  if (!db) return null;
  try {
    if (!tableExists(db, "run_manifests")) return null;
    if (runId) {
      return db.prepare("SELECT * FROM run_manifests WHERE run_id = ?").get(runId) ?? null;
    }
    return db.prepare("SELECT * FROM run_manifests ORDER BY finalized_at DESC LIMIT 1").get() ?? null;
  } finally {
    db.close();
  }
}

function upsertRunManifest(Database, dataDir, { runId, workflow, phase, manifestSha256, deliverableKey, manifestJson, sinkStatus, finalizedAt }) {
  try {
    const dirLst = lstatSync(dataDir);
    if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
      throw new Error(`Refusing unsafe or symlinked directory at ${dataDir}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  mkdirSync(dataDir, { recursive: true });
  const checked = assertSafeDbPath(join(dataDir, "uwf-state.db"), dataDir);
  const db = new Database(checked.path);
  try {
    db.pragma("journal_mode = WAL");
    ensureRunManifestsTable(db);
    db.prepare(`
      INSERT INTO run_manifests
        (run_id, workflow, phase, manifest_sha256, deliverable_key, manifest_json, sink_status, finalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow = excluded.workflow,
        phase = excluded.phase,
        manifest_sha256 = excluded.manifest_sha256,
        deliverable_key = excluded.deliverable_key,
        manifest_json = excluded.manifest_json,
        sink_status = excluded.sink_status,
        finalized_at = excluded.finalized_at
    `).run(runId, workflow, phase, manifestSha256, deliverableKey, manifestJson, sinkStatus, finalizedAt);
    if (tableExists(db, "workflow_state")) {
      const cols = db.prepare("PRAGMA table_info(workflow_state)").all().map((c) => c.name);
      if (cols.includes("run_id")) {
        db.prepare("UPDATE workflow_state SET run_id = ? WHERE id = 1 AND (run_id IS NULL OR run_id = '')").run(runId);
      }
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Core Manifest Builder
// ---------------------------------------------------------------------------

function extractGateVerdict(status, gateResultJson) {
  if (status === "skipped") return null;
  if (!gateResultJson) return status === "passed" ? "passed" : null;
  try {
    const parsed = JSON.parse(gateResultJson);
    if (typeof parsed.verdict === "string" && parsed.verdict.length > 0) return parsed.verdict;
    if (typeof parsed.passed === "boolean") return parsed.passed ? "passed" : "failed";
  } catch { /* ignore */ }
  return status === "passed" ? "passed" : null;
}

function collectTranscriptTelemetry(dataDir, priorTranscripts = [], { maxTranscriptBytes = MAX_STAGE_OUTPUT_BYTES } = {}) {
  const skip = new Set(Array.isArray(priorTranscripts) ? priorTranscripts : []);
  const perStage = new Map();
  const costSummary = {
    turns: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const transcriptsDir = join(dataDir, "transcripts");
  let realTranscriptsDir = null;
  let dirLst = null;
  try {
    dirLst = lstatSync(transcriptsDir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (dirLst) {
    if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
      throw new Error(`Refusing unsafe or symlinked transcripts directory at ${transcriptsDir}`);
    }
    if (existsSync(dataDir)) {
      const dataLst = lstatSync(dataDir);
      if (dataLst.isSymbolicLink() || !dataLst.isDirectory()) {
        throw new Error(`Refusing unsafe or symlinked directory at ${dataDir}`);
      }
    }
    const realData = existsSync(dataDir) ? realpathSync(dataDir) : null;
    realTranscriptsDir = realpathSync(transcriptsDir);
    if (realData && !isInsideOrEqual(realTranscriptsDir, realData)) {
      throw new Error(`Refusing escaping transcripts directory at ${transcriptsDir}`);
    }
  }
  for (const f of listTranscripts(dataDir).sort(compareUtf16)) {
    if (skip.has(basename(f))) continue;
    let lst;
    try {
      lst = lstatSync(f);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (lst.isSymbolicLink() || !lst.isFile()) continue;
    const raw = readRegularFileNoFollow(f, "Transcript", {
      maxBytes: maxTranscriptBytes,
      allowedRealRoots: realTranscriptsDir ? [realTranscriptsDir] : null,
    });
    const digest = sha256Hex(raw);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const row = transcriptRow(f, parsed);
    if (row) {
      costSummary.turns += row.turns ?? 0;
      costSummary.input_tokens += row.input ?? 0;
      costSummary.cache_read_tokens += row.read ?? 0;
      costSummary.cache_write_tokens += row.write ?? 0;
      costSummary.output_tokens += row.output ?? 0;
      costSummary.cost_usd += row.cost ?? 0;
    }
    const effectiveStage = inferTranscriptStage(parsed) ?? (row?.stage && row.stage !== "?" ? row.stage : null);
    if (effectiveStage) {
      perStage.set(effectiveStage, digest);
    }
  }
  costSummary.cost_usd = Number(costSummary.cost_usd.toFixed(6));
  return { perStage, costSummary };
}

export function readRoutingState(dataDir) {
  const routingPath = join(resolve(dataDir), ROUTING_FILE);
  let rawText;
  try {
    rawText = readContainedDataFile(dataDir, ROUTING_FILE, "Routing telemetry", { maxBytes: MAX_DATA_FILE_BYTES }).toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { trips: {}, findings: {} };
    throw err;
  }
  let saved;
  try {
    saved = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Corrupt routing telemetry at ${routingPath}: ${err.message}`);
  }
  if (!isPlainObject(saved)) {
    throw new Error(`Corrupt routing telemetry at ${routingPath}: expected JSON object`);
  }
  const tripsObj = saved.trips === undefined || saved.trips === null ? {} : saved.trips;
  if (!isPlainObject(tripsObj)) {
    throw new Error(`Corrupt routing telemetry at ${routingPath}: trips must be an object`);
  }
  for (const [k, v] of Object.entries(tripsObj)) {
    const stage = k.split("|")[0];
    if (!stage || typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`Corrupt routing telemetry at ${routingPath}: invalid entry "${k}"`);
    }
  }
  const findingsObj = saved.findings === undefined || saved.findings === null ? {} : saved.findings;
  if (!isPlainObject(findingsObj)) {
    throw new Error(`Corrupt routing telemetry at ${routingPath}: findings must be an object`);
  }
  for (const [k, f] of Object.entries(findingsObj)) {
    if (
      !k.trim() ||
      !isPlainObject(f) ||
      !Array.isArray(f.files) ||
      !f.files.every((p) => typeof p === "string") ||
      typeof f.note !== "string" ||
      (f.from !== undefined && f.from !== null && typeof f.from !== "string")
    ) {
      throw new Error(`Corrupt routing telemetry at ${routingPath}: invalid finding entry "${k}"`);
    }
  }
  return { trips: tripsObj, findings: findingsObj };
}

function readRoundTrips(dataDir) {
  const saved = readRoutingState(dataDir);
  const byStage = new Map();
  for (const [k, v] of Object.entries(saved.trips)) {
    const stage = k.split("|")[0];
    byStage.set(stage, (byStage.get(stage) ?? 0) + v);
  }
  return byStage;
}

function readExistingRunMeta(absDataDir) {
  let raw;
  try {
    raw = readContainedDataFile(absDataDir, RUN_META_FILE, "Run metadata").toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.run_id === "string" && parsed.run_id.trim().length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseStageOutputsJson(rawOutputsJson, stageName, status) {
  if (rawOutputsJson === undefined) return [];
  if (rawOutputsJson === null) {
    if (status === "passed") {
      throw new Error(`Corrupt outputs_json for passed stage "${stageName}": expected JSON array, got null`);
    }
    return [];
  }
  if (typeof rawOutputsJson !== "string") {
    throw new Error(`Corrupt outputs_json for stage "${stageName}": expected JSON string`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawOutputsJson);
  } catch (err) {
    throw new Error(`Corrupt outputs_json for stage "${stageName}": invalid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Corrupt outputs_json for stage "${stageName}": expected JSON array`);
  }
  if (status === "skipped") {
    if (parsed.length > 0) {
      throw new Error(`Corrupt outputs_json for skipped stage "${stageName}": expected empty array`);
    }
    return [];
  }
  const outputs = [];
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i];
    if (
      !isPlainObject(o) ||
      !Object.keys(o).every((k) => k === "path" || k === "sha256" || k === "bytes") ||
      typeof o.path !== "string" ||
      o.path.length === 0 ||
      typeof o.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(o.sha256) ||
      !Number.isInteger(o.bytes) ||
      o.bytes < 0
    ) {
      throw new Error(`Corrupt outputs_json entry for stage "${stageName}" at index ${i}`);
    }
    outputs.push({ path: o.path, sha256: o.sha256, bytes: o.bytes });
  }
  return outputs.sort((a, b) => compareUtf16(a.path, b.path));
}

/**
 * Build the complete UAW provenance manifest object (not yet written to disk).
 */
export function buildManifest({
  dataDir,
  workflow = null,
  repoRoot = OWN_ROOT,
  skillsRoot = null,
  outputPath = null,
  phase = "closed",
  deliverableOverrides = {},
  persistMeta = true,
  maxTranscriptBytes = MAX_STAGE_OUTPUT_BYTES,
  now = new Date().toISOString(),
}) {
  const Database = loadDatabaseCtor();
  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  const existingMeta = readExistingRunMeta(absDataDir);

  let modelProfile = null;
  let modelName = null;
  let stateModeHint = null;
  let stateRunId = null;
  let stateArtifactPath = null;
  let firstHistTs = null;
  const stateChecked = assertSafeDbPath(join(absDataDir, "uwf-state.db"), absDataDir);
  const stateDb = stateChecked.exists ? openReadOnly(Database, stateChecked.path) : null;
  if (stateDb) {
    try {
      if (tableExists(stateDb, "workflow_state")) {
        const ws = stateDb.prepare("SELECT * FROM workflow_state WHERE id = 1").get();
        if (ws) {
          modelProfile = ws.model_profile ?? null;
          modelName = ws.model_name ?? null;
          stateModeHint = typeof ws.mode === "string" && ws.mode.trim() ? ws.mode.trim() : null;
          stateRunId = typeof ws.run_id === "string" && ws.run_id.trim() ? ws.run_id.trim() : null;
          stateArtifactPath = ws.artifact_path ?? null;
        }
      }
      if (tableExists(stateDb, "workflow_history")) {
        const firstHist = stateDb.prepare("SELECT ts FROM workflow_history ORDER BY id ASC LIMIT 1").get();
        if (firstHist?.ts) firstHistTs = firstHist.ts;
      }
    } finally {
      stateDb.close();
    }
  }

  let persistedManifestWorkflow = null;
  const targetRunId = existingMeta?.run_id ?? stateRunId ?? null;
  if (targetRunId) {
    const persistedForRun = readPersistedManifestRow(Database, absDataDir, targetRunId);
    if (persistedForRun && typeof persistedForRun.workflow === "string" && persistedForRun.workflow.trim()) {
      persistedManifestWorkflow = persistedForRun.workflow.trim();
    }
  }
  const recovered = !existingMeta ? recoverPersistedRunIdentity(absDataDir) : null;
  const authoritativeWorkflow = existingMeta?.workflow ?? persistedManifestWorkflow ?? recovered?.workflow ?? null;
  if (workflow && authoritativeWorkflow && workflow !== authoritativeWorkflow) {
    throw new Error(
      `Workflow mismatch for ${absDataDir}: persisted state records "${authoritativeWorkflow}", requested "${workflow}"`,
    );
  }
  const effectiveWorkflow = workflow ?? authoritativeWorkflow ?? stateModeHint ?? null;
  const meta = ensureRunMeta(absDataDir, {
    workflow: effectiveWorkflow,
    outputPath: outputPath ?? existingMeta?.output_path ?? stateArtifactPath ?? null,
    runId: phase === "sealed" && existingMeta?.run_id ? existingMeta.run_id : null,
    repoRoot: absRepoRoot,
    baseCommitSha: deliverableOverrides.base_commit_sha ?? null,
    persist: persistMeta,
  });
  const runId = meta.run_id;
  const resolvedWorkflow = workflow ?? meta.workflow ?? "sw_dev";
  const resolvedOutputPath =
    outputPath ?? meta.output_path ?? stateArtifactPath ?? join(absDataDir, "workflow-artifacts");
  const resolvedSkillsRoot = skillsRoot ?? meta.skills_root ?? null;
  const startedAt = firstHistTs ?? meta.created_at ?? null;

  let goalSha256 = null;
  try {
    goalSha256 = sha256Hex(readContainedDataFile(absDataDir, GOAL_FILE, "Runner goal"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const stages = [];
  const auditStages = [];
  const roundTrips = readRoundTrips(absDataDir);
  const { perStage: transcriptDigests, costSummary } = collectTranscriptTelemetry(absDataDir, meta.prior_transcripts, {
    maxTranscriptBytes,
  });
  let blueprintRan = false;

  const stagesChecked = assertSafeDbPath(join(absDataDir, "uwf-stages.db"), absDataDir);
  const stagesDb = stagesChecked.exists ? openReadOnly(Database, stagesChecked.path) : null;
  if (stagesDb) {
    try {
      if (tableExists(stagesDb, "stage_runs")) {
        const rows = queryAll(stagesDb, "SELECT * FROM stage_runs WHERE workflow = ? ORDER BY id ASC", resolvedWorkflow);
        for (const row of rows) {
          if (row.stage === "blueprint" && row.status === "passed") blueprintRan = true;
          const outputs = parseStageOutputsJson(row.outputs_json, row.stage, row.status);
          stages.push({
            stage: row.stage,
            status: row.status,
            gate_verdict: extractGateVerdict(row.status, row.gate_result),
            outputs,
          });
          auditStages.push({
            stage: row.stage,
            started_at: row.started_at ?? null,
            completed_at: row.completed_at ?? null,
            retry_count: Number(row.retry_count ?? 0),
            round_trips: roundTrips.get(row.stage) ?? 0,
            session_id: row.session_id ?? null,
            transcript_sha256: transcriptDigests.get(row.stage) ?? null,
          });
        }
      }
    } finally {
      stagesDb.close();
    }
  }

  const stores = {
    requirements: readRequirementsStore(Database, absDataDir, absRepoRoot),
    adrs: readAdrsStore(Database, absDataDir, absRepoRoot),
    discoveries: readDiscoveriesStore(Database, absDataDir, absRepoRoot),
    reviews: readReviewsStore(Database, absDataDir, absRepoRoot),
    issues: readIssuesStore(Database, absDataDir, absRepoRoot),
    questions: readQuestionsStore(Database, absDataDir, absRepoRoot),
    cbs: readCbsStore(Database, absDataDir, absRepoRoot, blueprintRan),
  };

  const artifactPrefix = resolveArtifactPrefix(resolvedWorkflow, resolvedSkillsRoot, absRepoRoot);
  const architecture = readArchitectureStrata({
    outputPath: resolvedOutputPath,
    repoRoot: absRepoRoot,
    artifactPrefix,
  });

  const deliverable = scrubDeep(
    collectGitDeliverable(absRepoRoot, {
      dataDir: absDataDir,
      overrides: {
        base_commit_sha: meta.base_commit_sha ?? undefined,
        ...deliverableOverrides,
      },
    })
  );
  const deliverableKey = resolveDeliverableKey(deliverable, runId);

  const contentPayload = scrubDeep({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    workflow: resolvedWorkflow,
    goal_sha256: goalSha256,
    phase,
    deliverable_key: deliverableKey,
    deliverable,
    stages,
    stores,
    architecture,
  });
  const manifestSha256 = sha256Hex(canonicalizeJcs(contentPayload));

  let executionAudit = scrubDeep({
    started_at: startedAt,
    finalized_at: now,
    model_profile: modelProfile,
    model_name: modelName,
    cost_summary: costSummary,
    stages: auditStages,
  });

  const persisted = readPersistedManifestRow(Database, absDataDir, runId);
  if (persisted && persisted.manifest_sha256 === manifestSha256 && persisted.manifest_json) {
    try {
      const prev = JSON.parse(persisted.manifest_json);
      const prevAudit = prev?.execution_audit;
      const sameStageTelemetry =
        canonicalizeJcs(prevAudit?.stages ?? null) === canonicalizeJcs(executionAudit.stages ?? null);
      const sameModel =
        (prevAudit?.model_profile ?? null) === (executionAudit.model_profile ?? null) &&
        (prevAudit?.model_name ?? null) === (executionAudit.model_name ?? null);
      const sameCostSummary =
        canonicalizeJcs(prevAudit?.cost_summary ?? null) === canonicalizeJcs(executionAudit.cost_summary ?? null);
      if (prevAudit && sameStageTelemetry && sameModel && sameCostSummary) {
        executionAudit = prevAudit;
      } else if (prevAudit) {
        executionAudit = {
          ...executionAudit,
          started_at: prevAudit.started_at ?? executionAudit.started_at,
          finalized_at: prevAudit.finalized_at ?? executionAudit.finalized_at,
        };
      }
    } catch { /* use fresh executionAudit */ }
  }

  const manifest = {
    ...contentPayload,
    manifest_sha256: manifestSha256,
    execution_audit: executionAudit,
  };

  return {
    manifest,
    canonicalJson: canonicalizeJcs(manifest),
    runId,
    outputPath: resolvedOutputPath,
    manifestSha256,
    deliverableKey,
  };
}

// ---------------------------------------------------------------------------
// Materialize, Seal & Verify Operations
// ---------------------------------------------------------------------------

const SEAL_CALLER_TOKEN = Symbol("sealManifest");

/**
 * Materialize `<data-dir>/uaw-manifest.json` (NEVER inside `output_path`!),
 * upsert into `run_manifests` in `uwf-state.db`, and optionally dispatch to Context Hub Sink.
 */
export async function materializeManifest({
  dataDir,
  workflow = null,
  repoRoot = OWN_ROOT,
  skillsRoot = null,
  outputPath = null,
  phase = "closed",
  deferSeal = false,
  deliverableOverrides = {},
  dispatchSink = true,
  sinkOptions = {},
  now = new Date().toISOString(),
  _sealToken = null,
}) {
  if (phase === "sealed" && _sealToken !== SEAL_CALLER_TOKEN) {
    throw new Error('phase="sealed" requires sealManifest()');
  }
  const Database = loadDatabaseCtor();
  const absDataDir = resolve(dataDir);
  const built = buildManifest({
    dataDir: absDataDir,
    workflow,
    repoRoot,
    skillsRoot,
    outputPath,
    phase,
    deliverableOverrides,
    now,
  });

  const validationErrors = validateManifest(built.manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Generated manifest failed schema validation: ${validationErrors.join("; ")}`);
  }

  const outCheck = verifyManifestStageOutputs(built.manifest, {
    dataDir: absDataDir,
    repoRoot: resolve(repoRoot),
    outputPath: outputPath ?? built.outputPath ?? null,
  });
  if (!outCheck.ok) {
    throw new Error(`Stage output integrity verification failed: ${outCheck.errors.join("; ")}`);
  }

  mkdirSync(absDataDir, { recursive: true });
  const manifestPath = join(absDataDir, MANIFEST_FILE);
  writeFileAtomic(manifestPath, built.canonicalJson);

  const isStageEvent = phase === "snapshot";
  const suppressForDefer = Boolean(deferSeal && !isStageEvent);
  let sinkResult = { ok: true, status: suppressForDefer ? "deferred" : "disabled", exitCode: 0 };
  if (dispatchSink && !suppressForDefer) {
    const snapStage = isStageEvent
      ? (built.manifest.stages ?? []).find((s) => s.stage === "snapshot")
      : null;
    const eventSha256 = isStageEvent
      ? sha256Hex(canonicalizeJcs(snapStage?.outputs ?? []))
      : built.manifestSha256;
    const envelope = buildSinkEnvelope({
      event: isStageEvent ? "stage.completed" : "run.finalized",
      runId: built.runId,
      workflow: built.manifest.workflow,
      stage: isStageEvent ? "snapshot" : phase === "sealed" ? "seal" : "retro",
      sha256: eventSha256,
      deliverableKey: built.deliverableKey,
      payload: built.manifest,
    });
    sinkResult = await dispatchToContextHub(envelope, sinkOptions);
  }

  upsertRunManifest(Database, absDataDir, {
    runId: built.runId,
    workflow: built.manifest.workflow,
    phase,
    manifestSha256: built.manifestSha256,
    deliverableKey: built.deliverableKey,
    manifestJson: built.canonicalJson,
    sinkStatus: sinkResult.status,
    finalizedAt: built.manifest.execution_audit.finalized_at,
  });

  return {
    ok: sinkResult.exitCode === 0,
    exitCode: sinkResult.exitCode,
    manifestPath,
    manifest: built.manifest,
    canonicalJson: built.canonicalJson,
    manifestSha256: built.manifestSha256,
    deliverableKey: built.deliverableKey,
    sink: sinkResult,
  };
}

/**
 * Verify un-superseded stage output files recorded in `manifest.stages` still exist as
 * regular files inside allowed roots and match their recorded `sha256` and `bytes`.
 */
export function verifyManifestStageOutputs(manifest, { dataDir, repoRoot = OWN_ROOT, outputPath = null } = {}) {
  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  const errors = [];

  const latestByPath = new Map();
  for (const st of manifest?.stages ?? []) {
    if (st.status === "skipped") {
      if (Array.isArray(st.outputs) && st.outputs.length > 0) {
        errors.push(`Skipped stage "${st.stage}" must have empty outputs[]`);
      }
      continue;
    }
    for (const out of st.outputs ?? []) {
      latestByPath.set(out.path, { stage: st.stage, ...out });
    }
  }

  let meta = null;
  try {
    meta = readExistingRunMeta(absDataDir);
  } catch (err) {
    return {
      ok: false,
      errors: [err.message],
      checkedOutputs: 0,
    };
  }
  const realRepo = existsSync(absRepoRoot) ? realpathSync(absRepoRoot) : absRepoRoot;
  const realData = existsSync(absDataDir) ? realpathSync(absDataDir) : absDataDir;
  const rawOut = outputPath ?? meta?.output_path ?? null;
  const metaOut = rawOut
    ? (isAbsolute(rawOut) ? resolve(rawOut) : resolve(absRepoRoot, rawOut))
    : null;
  const realMetaOut = metaOut && existsSync(metaOut) ? realpathSync(metaOut) : metaOut;

  for (const [relPath, expected] of latestByPath.entries()) {
    const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(absRepoRoot, relPath);
    if (!isInsideOrEqual(abs, absRepoRoot) && !isInsideOrEqual(abs, absDataDir) && !(metaOut && isInsideOrEqual(abs, metaOut))) {
      errors.push(`Stage "${expected.stage}" output escapes allowed roots: ${relPath}`);
      continue;
    }
    let lst;
    try {
      lst = lstatSync(abs);
    } catch {
      errors.push(`Stage "${expected.stage}" output missing on disk: ${relPath}`);
      continue;
    }
    if (lst.isSymbolicLink() || !lst.isFile()) {
      errors.push(`Stage "${expected.stage}" output must be a regular file (not symlink): ${relPath}`);
      continue;
    }
    const realAbs = realpathSync(abs);
    const allowedOutRoots = [realRepo, realData, ...(realMetaOut ? [realMetaOut] : [])];
    if (!allowedOutRoots.some((r) => isInsideOrEqual(realAbs, r))) {
      errors.push(`Stage "${expected.stage}" output escapes allowed roots: ${relPath}`);
      continue;
    }
    let buf;
    try {
      buf = readRegularFileNoFollow(abs, `Stage "${expected.stage}" output`, {
        maxBytes: MAX_STAGE_OUTPUT_BYTES,
        allowedRealRoots: allowedOutRoots,
      });
    } catch (err) {
      if (err.code === "EACCES") {
        errors.push(`Stage "${expected.stage}" output escapes allowed roots: ${relPath}`);
      } else if (err.code === "EFBIG") {
        errors.push(`Stage "${expected.stage}" output exceeds size limit: ${relPath} (${err.message})`);
      } else if (err.code === "ELOOP" || err.code === "EFTYPE") {
        errors.push(`Stage "${expected.stage}" output must be a regular file (not symlink): ${relPath}`);
      } else {
        errors.push(`Stage "${expected.stage}" output failed safe read verification: ${relPath} (${err.message})`);
      }
      continue;
    }
    const actualSha = sha256Hex(buf);
    if (actualSha !== expected.sha256 || buf.length !== expected.bytes) {
      errors.push(
        `Unexpected post-stage mutation on "${relPath}" (stage "${expected.stage}"): expected sha256=${expected.sha256} (${expected.bytes}B), actual sha256=${actualSha} (${buf.length}B)`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checkedOutputs: latestByPath.size,
  };
}

function verifyManifestFileIntegrity(manifestPath, absDataDir = dirname(manifestPath)) {
  let rawText;
  try {
    rawText = readContainedDataFile(absDataDir, basename(manifestPath), "Manifest").toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ELOOP" || err.code === "EFTYPE" || err.code === "EINVAL" || err.code === "EFBIG" || err.code === "EACCES") {
      return { manifest: null, errors: [err.message] };
    }
    return { manifest: null, errors: [`Cannot stat manifest at ${manifestPath}: ${err.message}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(rawText);
  } catch (err) {
    return { manifest: null, errors: [`Invalid JSON in ${manifestPath}: ${err.message}`] };
  }

  const errors = validateManifest(manifest);
  if (isPlainObject(manifest)) {
    const { manifest_sha256: recordedSha, execution_audit: _audit, ...contentOnly } = manifest;
    const computedSha = sha256Hex(canonicalizeJcs(contentOnly));
    if (recordedSha !== computedSha) {
      errors.push(`manifest_sha256 mismatch: recorded ${recordedSha}, computed ${computedSha}`);
    }
    if (rawText !== canonicalizeJcs(manifest)) {
      errors.push("Manifest on disk is not canonical RFC 8785 JCS");
    }
  }
  return { manifest, errors };
}

/**
 * Verify `<data-dir>/uaw-manifest.json` integrity and un-superseded stage output digests on disk.
 */
export function verifyManifest({ dataDir, repoRoot = OWN_ROOT }) {
  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  const manifestPath = join(absDataDir, MANIFEST_FILE);
  const { manifest, errors } = verifyManifestFileIntegrity(manifestPath, absDataDir);
  if (!manifest) {
    return { ok: false, errors };
  }

  const outCheck = verifyManifestStageOutputs(manifest, { dataDir: absDataDir, repoRoot: absRepoRoot });
  errors.push(...outCheck.errors);

  return {
    ok: errors.length === 0,
    errors,
    manifestPath,
    manifestSha256: manifest.manifest_sha256,
    checkedOutputs: outCheck.checkedOutputs,
  };
}

/**
 * Post-commit / working-tree seal (`provenance.mjs seal` / `uaw_manifest_seal`):
 * - By default (`allowDirtyWorktree: false`), verifies committed `git_tree_sha` matches post-retro tracked worktree state
 *   (excluding `<data-dir>`, `tmp/`, and `.gitignore`-excluded paths; allows
 *   `head_commit_sha == base_commit_sha` when no tracked files changed).
 * - When `allowDirtyWorktree: true` (used by local `runner.mjs` runs without `--defer-seal` or explicit commit/PR/release bindings),
 *   seals uncommitted tracked working-tree changes directly against `git_tree_sha` (`head_commit_sha: null`).
 * - Verifies no un-superseded stage artifact was unexpectedly mutated on disk.
 * - Binds `head_commit_sha` / `pr_url` / `release_tag` / `artifact_uris[]`,
 *   seals `run_manifests` (`phase: "sealed"`), and dispatches terminal `run.finalized` sink event.
 */
export async function sealManifest({
  dataDir,
  workflow = null,
  repoRoot = OWN_ROOT,
  skillsRoot = null,
  outputPath = null,
  headCommitSha = null,
  baseCommitSha = null,
  prUrl = null,
  releaseTag = null,
  artifactUris = [],
  commitGitDir = null,
  allowDirtyWorktree = false,
  sinkOptions = {},
  now = new Date().toISOString(),
}) {
  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  const manifestPath = join(absDataDir, MANIFEST_FILE);

  let hasManifestFile = true;
  try {
    lstatSync(manifestPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      hasManifestFile = false;
    } else {
      throw err;
    }
  }

  if (hasManifestFile) {
    const fileCheck = verifyManifestFileIntegrity(manifestPath, absDataDir);
    if (fileCheck.errors.length > 0) {
      return {
        ok: false,
        exitCode: 1,
        error: `Pre-seal verification failed: ${fileCheck.errors.join("; ")}`,
        errors: fileCheck.errors,
      };
    }
  }

  let preBuilt;
  try {
    preBuilt = buildManifest({
      dataDir: absDataDir,
      workflow,
      repoRoot: absRepoRoot,
      skillsRoot,
      outputPath,
      phase: "closed",
      deliverableOverrides: {
        ...(baseCommitSha ? { base_commit_sha: baseCommitSha } : {}),
      },
      persistMeta: false,
      now,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Refusing unsafe")) {
      throw err;
    }
    return {
      ok: false,
      exitCode: 1,
      error: `Pre-seal verification failed: ${err.message}`,
      errors: [err.message],
    };
  }
  const preErrors = validateManifest(preBuilt.manifest);
  const outCheck = verifyManifestStageOutputs(preBuilt.manifest, {
    dataDir: absDataDir,
    repoRoot: absRepoRoot,
    outputPath: outputPath ?? preBuilt.outputPath ?? null,
  });
  preErrors.push(...outCheck.errors);
  if (preErrors.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      error: `Pre-seal verification failed: ${preErrors.join("; ")}`,
      errors: preErrors,
    };
  }

  let commitRepo = absRepoRoot;
  if (commitGitDir) {
    const absCommitDir = resolve(commitGitDir);
    let cLst;
    try {
      cLst = lstatSync(absCommitDir);
    } catch {
      return {
        ok: false,
        exitCode: 1,
        error: `Commit git dir not found: "${commitGitDir}"`,
      };
    }
    if (cLst.isSymbolicLink() || !cLst.isDirectory() || !isValidGitObjectStore(absCommitDir)) {
      return {
        ok: false,
        exitCode: 1,
        error: `Invalid commit git dir "${commitGitDir}"`,
      };
    }
    assertSafeGitConfig(absCommitDir);
    commitRepo = absCommitDir;
  }

  const canSealDirty = Boolean(
    allowDirtyWorktree &&
    !headCommitSha &&
    !commitGitDir &&
    !prUrl &&
    !releaseTag
  );
  let resolvedHead = headCommitSha;
  let committedTreeSha = null;
  let hasExplicitHeadOverride = false;
  if (resolvedHead && (String(resolvedHead).startsWith("-") || /[\s\0]/.test(String(resolvedHead)))) {
    return {
      ok: false,
      exitCode: 1,
      error: `Invalid git commit ref "${resolvedHead}"`,
    };
  }
  if (!isGitRepo(absRepoRoot)) {
    if (commitGitDir || headCommitSha) {
      return {
        ok: false,
        exitCode: 1,
        error: `Cannot verify git commit against non-git repoRoot "${absRepoRoot}"`,
      };
    }
  } else {
    const ref = resolvedHead || "HEAD";
    let headResolveErr = null;
    try {
      resolvedHead = gitExec(commitRepo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    } catch (err) {
      headResolveErr = err;
      resolvedHead = null;
    }
    const worktreeTreeSha = computeWorktreeTreeSha(absRepoRoot, { dataDir: absDataDir });
    if (headResolveErr) {
      if (!canSealDirty) {
        return {
          ok: false,
          exitCode: 1,
          error: `Cannot resolve git commit "${ref}": ${headResolveErr.message}`,
        };
      }
      committedTreeSha = worktreeTreeSha;
    } else {
      committedTreeSha = getCommitTreeSha(commitRepo, resolvedHead);
      const rawWorktreeTreeSha =
        committedTreeSha !== worktreeTreeSha
          ? computeWorktreeTreeSha(absRepoRoot, { dataDir: absDataDir, rawBlobs: true })
          : worktreeTreeSha;
      if (!committedTreeSha || (committedTreeSha !== worktreeTreeSha && committedTreeSha !== rawWorktreeTreeSha)) {
        if (!canSealDirty) {
          return {
            ok: false,
            exitCode: 1,
            error: `Committed git_tree_sha (${committedTreeSha}) does not match post-retro tracked worktree state (${worktreeTreeSha})`,
          };
        }
        resolvedHead = null;
        committedTreeSha = worktreeTreeSha;
      }
    }
    hasExplicitHeadOverride = true;
  }

  return await materializeManifest({
    dataDir: absDataDir,
    workflow,
    repoRoot: absRepoRoot,
    skillsRoot,
    outputPath,
    phase: "sealed",
    deferSeal: false,
    _sealToken: SEAL_CALLER_TOKEN,
    deliverableOverrides: {
      ...(baseCommitSha ? { base_commit_sha: baseCommitSha } : {}),
      // Preserve explicit null override when local working-tree/unborn seal intentionally unbinds HEAD.
      ...(hasExplicitHeadOverride || resolvedHead ? { head_commit_sha: resolvedHead } : {}),
      ...(committedTreeSha ? { git_tree_sha: committedTreeSha } : {}),
      ...(prUrl ? { pr_url: prUrl } : {}),
      ...(releaseTag ? { release_tag: releaseTag } : {}),
      ...(artifactUris?.length ? { artifact_uris: artifactUris } : {}),
    },
    dispatchSink: true,
    sinkOptions,
    now,
  });
}

const MAX_SCRUB_BYTES = MAX_STAGE_OUTPUT_BYTES;

function scrubTextFileInRoots(absPath, allowedRealRoots) {
  let lst;
  try {
    lst = lstatSync(absPath);
  } catch {
    return { scrubbed: false, redacted: 0, buf: null };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return { scrubbed: false, redacted: 0, buf: null };
  let buf;
  try {
    const realFile = realpathSync(absPath);
    if (!allowedRealRoots.some((r) => isInsideOrEqual(realFile, r))) {
      return { scrubbed: false, redacted: 0, buf: null };
    }
    buf = readRegularFileNoFollow(absPath, "Scrub target", {
      maxBytes: MAX_SCRUB_BYTES,
      allowedRealRoots,
    });
  } catch {
    return { scrubbed: false, redacted: 0, buf: null };
  }
  if (buf.subarray(0, 8192).includes(0)) return { scrubbed: false, redacted: 0, buf };
  const { text, count } = redactSecrets(buf.toString("utf8"));
  if (count <= 0) return { scrubbed: false, redacted: 0, buf };
  const nextBuf = Buffer.from(text, "utf8");
  let currentRealDir;
  try {
    currentRealDir = realpathSync(dirname(absPath));
  } catch {
    return { scrubbed: false, redacted: 0, buf: null };
  }
  if (!allowedRealRoots.some((r) => isInsideOrEqual(currentRealDir, r))) {
    return { scrubbed: false, redacted: 0, buf: null };
  }
  // Note: Node fs lacks openat; writeFileAtomic guards leaf symlinks/FIFOs via O_EXCL|O_NOFOLLOW temp files, while concurrent parent-dir swaps in this window remain an OS/runtime limitation.
  writeFileAtomic(join(currentRealDir, basename(absPath)), nextBuf);
  return { scrubbed: true, redacted: count, buf: nextBuf };
}

/**
 * Scrub secret-shaped strings across un-superseded declared stage outputs (only inside
 * `dataDir` or `outputPath`, never tracked repo files) plus `runner-goal.md` and
 * `transcripts/*.json`, updating `uwf-stages.db` (`outputs_json`) only when pre-scrub
 * file bytes match the recorded stage digest so tamper detection stays fail-closed.
 * If an unsealed (`snapshot` or `closed`) `uaw-manifest.json` already exists and was
 * valid prior to scrubbing, refreshes it in-place without sealing or dispatching the sink.
 */
export async function scrubProvenanceOutputs({
  dataDir,
  workflow = null,
  repoRoot = OWN_ROOT,
  skillsRoot = null,
  outputPath = null,
} = {}) {
  const absDataDir = resolve(dataDir);
  const absRepoRoot = resolve(repoRoot);
  if (!existsSync(absDataDir)) {
    return { ok: true, updatedStages: 0, scrubbedFiles: 0, redactions: 0 };
  }
  if (lstatSync(absDataDir).isSymbolicLink()) {
    throw new Error(`Refusing symlinked data_dir at ${absDataDir}`);
  }

  const existingMeta = readExistingRunMeta(absDataDir);
  const Database = loadDatabaseCtor();

  let stateArtifactPath = null;
  const stateChecked = assertSafeDbPath(join(absDataDir, "uwf-state.db"), absDataDir);
  if (stateChecked.exists) {
    const stateDb = openReadOnly(Database, stateChecked.path);
    if (stateDb) {
      try {
        if (tableExists(stateDb, "workflow_state")) {
          const ws = stateDb.prepare("SELECT artifact_path FROM workflow_state WHERE id = 1").get();
          stateArtifactPath = ws?.artifact_path ?? null;
        }
      } finally {
        stateDb.close();
      }
    }
  }

  const recovered = !existingMeta ? recoverPersistedRunIdentity(absDataDir) : null;
  const authoritativeWorkflow = existingMeta?.workflow ?? recovered?.workflow ?? null;
  if (workflow && authoritativeWorkflow && workflow !== authoritativeWorkflow) {
    throw new Error(
      `Workflow mismatch for ${absDataDir}: ${existingMeta?.workflow ? "run-meta.json" : "persisted state"} records "${authoritativeWorkflow}", requested "${workflow}"`,
    );
  }
  const effectiveWorkflow = workflow ?? authoritativeWorkflow ?? "sw_dev";
  const rawOut = outputPath ?? existingMeta?.output_path ?? stateArtifactPath ?? join(absDataDir, "workflow-artifacts");
  const absOut = rawOut ? (isAbsolute(rawOut) ? resolve(rawOut) : resolve(absRepoRoot, rawOut)) : null;

  const realData = realpathSync(absDataDir);
  let realOut = null;
  if (absOut && existsSync(absOut)) {
    const outLst = lstatSync(absOut);
    if (!outLst.isSymbolicLink() && outLst.isDirectory()) {
      realOut = realpathSync(absOut);
    }
  }
  const scrubRealRoots = [realData, ...(realOut ? [realOut] : [])];

  const manifestPath = join(absDataDir, MANIFEST_FILE);
  let hadManifest = false;
  let preManifestValid = false;
  let prevManifest = null;
  try {
    const manLst = lstatSync(manifestPath);
    if (manLst.isSymbolicLink() || !manLst.isFile()) {
      throw new Error(`Refusing unsafe or symlinked manifest at ${manifestPath}`);
    }
    hadManifest = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (hadManifest) {
    const fileCheck = verifyManifestFileIntegrity(manifestPath, absDataDir);
    if (fileCheck.manifest && fileCheck.errors.length === 0) {
      const outCheck = verifyManifestStageOutputs(fileCheck.manifest, { dataDir: absDataDir, repoRoot: absRepoRoot });
      if (outCheck.ok) {
        preManifestValid = true;
        prevManifest = fileCheck.manifest;
      }
    }
  }

  let updatedStages = 0;
  let scrubbedFiles = 0;
  let redactions = 0;

  const stagesChecked = assertSafeDbPath(join(absDataDir, "uwf-stages.db"), absDataDir);
  if (stagesChecked.exists) {
    const db = new Database(stagesChecked.path);
    try {
      if (tableExists(db, "stage_runs")) {
        const rows = db
          .prepare("SELECT id, stage, status, outputs_json FROM stage_runs WHERE workflow = ? ORDER BY id ASC")
          .all(effectiveWorkflow);
        const parsedRows = new Map();
        const latestByPath = new Map();

        for (const row of rows) {
          const arr = parseStageOutputsJson(row.outputs_json, row.stage, row.status);
          if (row.status === "skipped" || arr.length === 0) continue;
          const info = { row, arr, changed: false };
          parsedRows.set(row.id, info);
          for (const item of arr) {
            latestByPath.set(item.path, { rowId: row.id, item });
          }
        }

        for (const [relPath, latest] of latestByPath.entries()) {
          const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(absRepoRoot, relPath);
          if (!isInsideOrEqual(abs, absDataDir) && !(absOut && isInsideOrEqual(abs, absOut))) {
            continue;
          }
          let lst;
          try {
            lst = lstatSync(abs);
          } catch {
            continue;
          }
          if (lst.isSymbolicLink() || !lst.isFile()) continue;
          let buf;
          try {
            const realAbs = realpathSync(abs);
            if (!scrubRealRoots.some((r) => isInsideOrEqual(realAbs, r))) continue;
            buf = readRegularFileNoFollow(abs, "Stage output", {
              maxBytes: MAX_SCRUB_BYTES,
              allowedRealRoots: scrubRealRoots,
            });
          } catch {
            continue;
          }
          // Fail closed: never re-sign outputs that were already mutated post-stage.
          if (sha256Hex(buf) !== latest.item.sha256 || buf.length !== latest.item.bytes) {
            continue;
          }
          if (buf.subarray(0, 8192).includes(0)) continue;

          const { text, count } = redactSecrets(buf.toString("utf8"));
          if (count <= 0) continue;

          const nextBuf = Buffer.from(text, "utf8");
          let currentRealDir;
          try {
            currentRealDir = realpathSync(dirname(abs));
          } catch {
            continue;
          }
          if (!scrubRealRoots.some((r) => isInsideOrEqual(currentRealDir, r))) continue;
          // Note: Node fs lacks openat; writeFileAtomic guards leaf symlinks/FIFOs via O_EXCL|O_NOFOLLOW temp files, while concurrent parent-dir swaps in this window remain an OS/runtime limitation.
          writeFileAtomic(join(currentRealDir, basename(abs)), nextBuf);
          latest.item.sha256 = sha256Hex(nextBuf);
          latest.item.bytes = nextBuf.length;
          parsedRows.get(latest.rowId).changed = true;
          scrubbedFiles += 1;
          redactions += count;
        }

        const changedRows = [...parsedRows.values()].filter((r) => r.changed);
        if (changedRows.length > 0) {
          const updateStmt = db.prepare("UPDATE stage_runs SET outputs_json = ? WHERE id = ?");
          db.transaction(() => {
            for (const info of changedRows) {
              info.arr.sort((a, b) => compareUtf16(String(a?.path ?? ""), String(b?.path ?? "")));
              updateStmt.run(JSON.stringify(info.arr), info.row.id);
              updatedStages += 1;
            }
          })();
        }
      }
    } finally {
      db.close();
    }
  }

  const goalRes = scrubTextFileInRoots(join(absDataDir, GOAL_FILE), [realData]);
  if (goalRes.scrubbed) {
    scrubbedFiles += 1;
    redactions += goalRes.redacted;
  }

  const transcriptsDir = join(absDataDir, "transcripts");
  if (existsSync(transcriptsDir)) {
    const tLst = lstatSync(transcriptsDir);
    if (!tLst.isSymbolicLink() && tLst.isDirectory()) {
      const realTranscripts = realpathSync(transcriptsDir);
      if (isInsideOrEqual(realTranscripts, realData)) {
        for (const f of readdirSync(realTranscripts)) {
          if (!f.endsWith(".json")) continue;
          const res = scrubTextFileInRoots(join(realTranscripts, f), [realTranscripts]);
          if (res.scrubbed) {
            scrubbedFiles += 1;
            redactions += res.redacted;
          }
        }
      }
    }
  }

  if (
    hadManifest &&
    preManifestValid &&
    prevManifest &&
    (prevManifest.phase === "snapshot" || prevManifest.phase === "closed")
  ) {
    await materializeManifest({
      dataDir: absDataDir,
      workflow: effectiveWorkflow,
      repoRoot: absRepoRoot,
      skillsRoot: skillsRoot ?? existingMeta?.skills_root ?? null,
      outputPath: rawOut,
      phase: prevManifest.phase,
      deferSeal: true,
      dispatchSink: false,
      deliverableOverrides: prevManifest.deliverable ?? {},
      now: prevManifest.execution_audit?.finalized_at ?? new Date().toISOString(),
    });
  }

  return {
    ok: true,
    updatedStages,
    scrubbedFiles,
    redactions,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const flags = { "artifact-uri": [] };
  const positional = [];
  const boolFlags = new Set(["defer-seal", "no-sink"]);
  const valueFlags = new Set([
    "data-dir",
    "workflow",
    "repo-root",
    "skills-root",
    "output-path",
    "phase",
    "base-commit",
    "head-commit",
    "commit-git-dir",
    "pr-url",
    "release-tag",
    "artifact-uri",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      positional.push(t);
      if (positional.length > 1) {
        throw new Error(`Unexpected positional argument "${t}"`);
      }
      continue;
    }
    const key = t.slice(2);
    if (boolFlags.has(key)) { flags[key] = true; continue; }
    if (!valueFlags.has(key)) {
      throw new Error(`Unknown flag "--${key}"`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    if (key === "artifact-uri") flags["artifact-uri"].push(next);
    else flags[key] = next;
    i++;
  }
  return { command: positional[0], flags };
}

async function runCliMain(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`Usage error: ${err.message}\n`);
    return 2;
  }
  const { command, flags } = parsed;
  const dataDir = flags["data-dir"] ?? process.env.UWF_DATA_DIR;
  if (!command || !dataDir) {
    process.stderr.write("Usage: provenance.mjs materialize|seal|scrub|verify|read --data-dir <dir> [--workflow <w>] [options]\n");
    return 2;
  }
  const workflow = flags.workflow ?? null;
  const repoRoot = flags["repo-root"] ?? process.cwd();
  const skillsRoot = flags["skills-root"] ?? process.env.UWF_SKILLS_ROOT ?? null;
  const outputPath = flags["output-path"] ?? null;

  if (command === "read") {
    try {
      const raw = readManifestRaw(dataDir);
      process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
      return 0;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
      return 1;
    }
  }

  if (command === "verify") {
    const res = verifyManifest({ dataDir, repoRoot });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return res.ok ? 0 : 1;
  }

  if (command === "materialize") {
    const phase = flags.phase ?? "closed";
    if (phase !== "snapshot" && phase !== "closed") {
      process.stderr.write('Usage error: materialize --phase must be "snapshot" or "closed" (use "provenance.mjs seal" to seal)\n');
      return 2;
    }
    const res = await materializeManifest({
      dataDir,
      workflow,
      repoRoot,
      skillsRoot,
      outputPath,
      phase,
      deferSeal: flags["defer-seal"] === true,
      dispatchSink: flags["no-sink"] !== true,
      deliverableOverrides: {
        ...(flags["base-commit"] ? { base_commit_sha: flags["base-commit"] } : {}),
        ...(flags["head-commit"] ? { head_commit_sha: flags["head-commit"] } : {}),
        ...(flags["pr-url"] ? { pr_url: flags["pr-url"] } : {}),
        ...(flags["release-tag"] ? { release_tag: flags["release-tag"] } : {}),
        ...(flags["artifact-uri"].length ? { artifact_uris: flags["artifact-uri"] } : {}),
      },
    });
    process.stdout.write(
      JSON.stringify({
        ok: res.ok,
        manifest_path: res.manifestPath,
        manifest_sha256: res.manifestSha256,
        deliverable_key: res.deliverableKey,
        phase: res.manifest.phase,
        sink: res.sink,
      }, null, 2) + "\n"
    );
    return res.exitCode;
  }

  if (command === "scrub") {
    const res = await scrubProvenanceOutputs({
      dataDir,
      workflow,
      repoRoot,
      skillsRoot,
      outputPath,
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return res.ok ? 0 : 1;
  }

  if (command === "seal") {
    const res = await sealManifest({
      dataDir,
      workflow,
      repoRoot,
      skillsRoot,
      outputPath,
      headCommitSha: flags["head-commit"] ?? null,
      baseCommitSha: flags["base-commit"] ?? null,
      prUrl: flags["pr-url"] ?? null,
      releaseTag: flags["release-tag"] ?? null,
      artifactUris: flags["artifact-uri"],
      commitGitDir: flags["commit-git-dir"] ?? null,
    });
    process.stdout.write(
      JSON.stringify({
        ok: res.ok,
        ...(res.error ? { error: res.error } : {}),
        ...(res.manifestPath ? { manifest_path: res.manifestPath } : {}),
        ...(res.manifestSha256 ? { manifest_sha256: res.manifestSha256 } : {}),
        ...(res.deliverableKey ? { deliverable_key: res.deliverableKey } : {}),
        ...(res.manifest ? { phase: res.manifest.phase } : {}),
        ...(res.sink ? { sink: res.sink } : {}),
      }, null, 2) + "\n"
    );
    return res.exitCode;
  }

  process.stderr.write(`Usage error: unknown command "${command}"\n`);
  return 2;
}

function isDirectCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliEntry()) {
  runCliMain(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`[provenance] ${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    }
  );
}
