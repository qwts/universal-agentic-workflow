/**
 * UWF fake adapter — deterministic, offline replay for CI.
 *
 * Fixture (path in env.UWF_FAKE_FIXTURE, or second arg { fixture }):
 *   { files: { "<relative path>": "<content>" }, transcript: "<text>",
 *     sessionId?: string, exitCode?: number, delayMs?: number }
 * Files are written under `cwd`. A non-zero exitCode yields ok:false.
 * delayMs simulates a slow stage (used to exercise timeoutMs).
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { writeTranscript } from "./index.mjs";

export const name = "fake";

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

  if (fx.delayMs) {
    if (timeoutMs && fx.delayMs > timeoutMs) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      return fail(`timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, fx.delayMs));
  }

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

  const sid = sessionId ?? fx.sessionId ?? "fake-session-0001";
  const exitCode = fx.exitCode ?? 0;
  const stdout = fx.transcript ?? "";
  const transcriptPath = writeTranscript(dataDir, {
    adapter: name, prompt: opts.prompt, sessionId: sid, exitCode, stdout, files: Object.keys(fx.files ?? {}),
  });
  const res = { ok: exitCode === 0, sessionId: sid, transcriptPath, stdout, exitCode, usage: null };
  if (exitCode !== 0) res.error = `fake adapter: fixture exitCode ${exitCode}`;
  return res;
}
