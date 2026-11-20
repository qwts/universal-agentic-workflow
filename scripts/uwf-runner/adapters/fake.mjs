/**
 * UWF fake adapter — deterministic, offline replay for CI.
 *
 * Fixture (path in env.UWF_FAKE_FIXTURE, or second arg { fixture }):
 *   { files: { "<relative path>": "<content>" }, transcript: "<text>",
 *     sessionId?: string (fixed id when none is passed in; otherwise a unique one is minted), exitCode?: number, delayMs?: number,
 *     attempts?: [ { files, transcript, exitCode, delayMs }, ... ] }
 * Files are written under `cwd`. A non-zero exitCode yields ok:false.
 * turnsNeeded (optional): turns the stage would take; above opts.maxTurns the call fails with "max turns (N) exceeded".
 * delayMs simulates a slow stage (used to exercise timeoutMs).
 * claudeResult (optional): a claude-code style result ({ num_turns, usage, total_cost_usd, ... }) stored as the
 * transcript's stdout so cost.mjs can read usage from it; `stdout` returned to the runner stays the plain text.
 * attempts (optional): per-invocation variants. The Nth call for a fixture path uses
 * attempts[N-1] (the last entry repeats). The call count lives in `<dataDir>/fake-attempts.json`
 * so it survives separate adapter calls. Without `attempts` the top-level fields apply.
 */

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join, sep } from "node:path";
import { writeTranscript } from "./index.mjs";

export const name = "fake";

const WRITE_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function readFileNoFollowIfExists(filePath) {
  let fd;
  try {
    fd = openSync(filePath, READ_NOFOLLOW_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Expected regular file at ${filePath}`);
    }
    return readFileSync(fd, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writeFileNoFollow(filePath, content) {
  let fd;
  try {
    fd = openSync(filePath, WRITE_NOFOLLOW_FLAGS, 0o666);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`Expected regular file at ${filePath}`);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function assertNoSymlinkPath(rootDir, targetPath, label) {
  const absRoot = resolve(rootDir);
  const absTarget = resolve(targetPath);
  let rootExists = false;
  try {
    const rootSt = statSync(absRoot);
    if (!rootSt.isDirectory()) {
      throw new Error(`${label} root must be a directory: ${absRoot}`);
    }
    rootExists = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const rel = relative(absRoot, absTarget);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`${label} escapes root ${absRoot}: ${absTarget}`);
  }
  const parts = rel.split(sep).filter(Boolean);
  let cur = absRoot;
  let deepestExisting = rootExists ? absRoot : null;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch (e) {
      if (e.code === "ENOENT") break;
      throw e;
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`${label} must not traverse symlink: ${cur}`);
    }
    const isLeaf = i === parts.length - 1;
    if (isLeaf ? !lst.isFile() : !lst.isDirectory()) {
      throw new Error(`${label} has invalid entry type at ${cur}`);
    }
    deepestExisting = cur;
  }
  if (deepestExisting && rootExists) {
    const realRoot = realpathSync(absRoot);
    const realDeep = realpathSync(deepestExisting);
    if (realDeep !== realRoot && !realDeep.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      throw new Error(`${label} escapes root ${absRoot}: ${absTarget}`);
    }
  }
}

/** Returns attempts[n] for this fixture path and bumps the persisted counter. */
function pickAttempt(fx, fixturePath, dataDir) {
  const file = join(dataDir, "fake-attempts.json");
  assertNoSymlinkPath(dataDir, file, "fake-attempts.json");
  let counts = {};
  const raw = readFileNoFollowIfExists(file);
  if (raw !== null) {
    try { counts = JSON.parse(raw); } catch { /* corrupt counter falls back to 0 */ }
  }
  const n = counts[fixturePath] ?? 0;
  counts[fixturePath] = n + 1;
  mkdirSync(dataDir, { recursive: true });
  assertNoSymlinkPath(dataDir, file, "fake-attempts.json");
  writeFileNoFollow(file, JSON.stringify(counts));
  return fx.attempts[Math.min(n, fx.attempts.length - 1)];
}

/** Next unique "fake-session-NNNN" (counter persisted in <dataDir>/fake-sessions.json). */
function mintSession(dataDir) {
  if (!dataDir) return "fake-session-0001";
  const file = join(dataDir, "fake-sessions.json");
  assertNoSymlinkPath(dataDir, file, "fake-sessions.json");
  let n = 0;
  const raw = readFileNoFollowIfExists(file);
  if (raw !== null) {
    try { n = JSON.parse(raw).n ?? 0; } catch { /* corrupt counter falls back to 0 */ }
  }
  mkdirSync(dataDir, { recursive: true });
  assertNoSymlinkPath(dataDir, file, "fake-sessions.json");
  writeFileNoFollow(file, JSON.stringify({ n: n + 1 }));
  return `fake-session-${String(n + 1).padStart(4, "0")}`;
}

/** @param {import("./index.mjs").InvokeStageOptions} opts @param {{fixture?: string}} [extra] */
export async function invokeStage(opts, extra = {}) {
  const { cwd, sessionId, timeoutMs, env, dataDir } = opts;
  const fail = (error, exitCode = null) => ({
    ok: false, sessionId: sessionId ?? null, transcriptPath: null,
    stdout: "", exitCode, usage: null, error,
  });
  const fixturePath = extra.fixture ?? env?.UWF_FAKE_FIXTURE ?? process.env.UWF_FAKE_FIXTURE;
  if (!fixturePath) return fail("fake adapter: no fixture (env.UWF_FAKE_FIXTURE or opts.fixture)");
  let fx;
  try {
    fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (e) {
    return fail(`fake adapter: cannot read fixture: ${e.message}`);
  }
  if (Array.isArray(fx.attempts) && fx.attempts.length > 0) {
    if (!dataDir) return fail("fake adapter: attempts need a dataDir for the call counter");
    try {
      fx = { ...fx, ...pickAttempt(fx, fixturePath, dataDir) };
    } catch (e) {
      return fail(`fake adapter: ${e.message}`);
    }
  }

  if (fx.delayMs) {
    if (timeoutMs && fx.delayMs > timeoutMs) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      return fail(`timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, fx.delayMs));
  }

  if (opts.maxTurns && fx.turnsNeeded > opts.maxTurns) return fail(`max turns (${opts.maxTurns}) exceeded`);

  try {
    for (const [rel, content] of Object.entries(fx.files ?? {})) {
      if (isAbsolute(rel)) throw new Error(`path escapes cwd: ${rel}`);
      const target = resolve(cwd, rel);
      assertNoSymlinkPath(cwd, target, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileNoFollow(target, content);
    }
  } catch (e) {
    return fail(`fake adapter: ${e.message}`);
  }

  // Continuity: a given sessionId is returned unchanged (resume). Without one the fixture's fixed id
  // is used if it has one, otherwise a new unique id is minted, so a "fresh" session is observable.
  let sid;
  try {
    sid = sessionId ?? fx.sessionId ?? mintSession(dataDir);
  } catch (e) {
    return fail(`fake adapter: ${e.message}`);
  }
  const exitCode = fx.exitCode ?? 0;
  const stdout = fx.transcript ?? "";
  const transcriptPath = writeTranscript(dataDir, {
    adapter: name, prompt: opts.prompt, sessionId: sid, exitCode,
    stdout: fx.claudeResult ? JSON.stringify({ result: stdout, ...fx.claudeResult }) : stdout, files: Object.keys(fx.files ?? {}),
  });
  const res = { ok: exitCode === 0, sessionId: sid, transcriptPath, stdout, exitCode, usage: null };
  if (exitCode !== 0) res.error = `fake adapter: fixture exitCode ${exitCode}`;
  return res;
}
