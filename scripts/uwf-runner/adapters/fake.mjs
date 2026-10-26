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

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { writeTranscript } from "./index.mjs";

export const name = "fake";

/** Returns attempts[n] for this fixture path and bumps the persisted counter. */
function pickAttempt(fx, fixturePath, dataDir) {
  const file = join(dataDir, "fake-attempts.json");
  let counts = {};
  try { counts = JSON.parse(readFileSync(file, "utf8")); } catch { /* first call */ }
  const n = counts[fixturePath] ?? 0;
  counts[fixturePath] = n + 1;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(counts));
  return fx.attempts[Math.min(n, fx.attempts.length - 1)];
}

/** Next unique "fake-session-NNNN" (counter persisted in <dataDir>/fake-sessions.json). */
function mintSession(dataDir) {
  if (!dataDir) return "fake-session-0001";
  const file = join(dataDir, "fake-sessions.json");
  let n = 0;
  try { n = JSON.parse(readFileSync(file, "utf8")).n ?? 0; } catch { /* first call */ }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ n: n + 1 }));
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
    fx = { ...fx, ...pickAttempt(fx, fixturePath, dataDir) };
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
      const target = resolve(cwd, rel);
      const back = relative(resolve(cwd), target);
      if (isAbsolute(rel) || back.startsWith("..")) throw new Error(`path escapes cwd: ${rel}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  } catch (e) {
    return fail(`fake adapter: ${e.message}`);
  }

  // Continuity: a given sessionId is returned unchanged (resume). Without one the fixture's fixed id
  // is used if it has one, otherwise a new unique id is minted, so a "fresh" session is observable.
  const sid = sessionId ?? fx.sessionId ?? mintSession(dataDir);
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
