/**
 * UWF grokbot adapter — file-based handoff to an external agent (e.g. Grok Bot).
 *
 * The runner still owns the stage loop, gates, retries and state. This adapter only
 * hands ONE stage attempt to an out-of-process agent and waits for it to finish:
 *
 *   1. writes  <dataDir>/grokbot/requests/<id>.json   (machine-readable request)
 *              <dataDir>/grokbot/requests/<id>.md     (same request, human/agent readable)
 *              <dataDir>/grokbot/pending.json         (pointer to the open request)
 *   2. polls for <dataDir>/grokbot/responses/<id>.json written by the agent:
 *        { "ok": true, "summary": "<final message / transcript text>", "sessionId"?: "..." }
 *      "ok": false (+ "error") reports a failed attempt.
 *   3. returns the usual InvokeStageResult; the runner then evaluates the gate itself.
 *
 * Env: UWF_GROKBOT_POLL_MS (default 2000). timeoutMs (runner --timeout-ms) bounds the wait
 * (default: no timeout). The agent's stdout text may carry the standard question block,
 * which the runner parses exactly as for claude-code.
 * Never throws, never evaluates gates, never writes workflow state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir, writeTranscript, buildSystemPrompt } from "./index.mjs";

export const name = "grokbot";

function nextId(dir) {
  const f = join(dir, "counter.json");
  let n = 0;
  try { n = JSON.parse(readFileSync(f, "utf8")).n ?? 0; } catch { /* first */ }
  writeFileSync(f, JSON.stringify({ n: n + 1 }));
  return String(n + 1).padStart(4, "0");
}

// The runner passes the stage name; the prompt is only a last resort (it starts with user goal text).
function stageOf(stage, prompt) {
  if (stage) return String(stage).replace(/[^\w-]/g, "-");
  const m = /^Run the ([\w-]+) stage/m.exec(prompt ?? "");
  return m ? m[1] : "stage";
}

/** @param {import("./index.mjs").InvokeStageOptions} opts */
export async function invokeStage(opts) {
  const { prompt, stage: stageName, cwd, inputs = [], outputs = [], sessionId, timeoutMs, env, permissions, maxTurns, model } = opts;
  const dataDir = resolveDataDir(opts.dataDir ?? env?.UWF_DATA_DIR);
  const fail = (error) => ({ ok: false, sessionId: sessionId ?? null, transcriptPath: null, stdout: "", exitCode: null, usage: null, error });
  let systemPrompt;
  try { systemPrompt = buildSystemPrompt(opts.agentFile, opts.systemPrompt); } catch (e) { return fail(`grokbot adapter: ${e.message}`); }

  const root = join(dataDir, "grokbot");
  const reqDir = join(root, "requests");
  const resDir = join(root, "responses");
  mkdirSync(reqDir, { recursive: true });
  mkdirSync(resDir, { recursive: true });
  const stage = stageOf(stageName, prompt);
  const id = `${nextId(root)}-${stage}`;
  const sid = sessionId ?? `grokbot-session-${id}`;
  const responsePath = join(resDir, `${id}.json`);
  const request = { id, stage, cwd, permissions: permissions ?? "edit", model: model ?? null, maxTurns: maxTurns ?? null,
    sessionId: sid, resumed: Boolean(sessionId), inputs, outputs, systemPrompt, prompt, responsePath, createdAt: new Date().toISOString() };
  const md = [`# UWF stage request ${id}`, "", `- stage: ${request.stage}`, `- cwd: ${cwd}`, `- permissions: ${request.permissions}`,
    `- session: ${sid}${request.resumed ? " (resumed: this is a retry; previous work is in place)" : ""}`,
    `- inputs: ${inputs.join(", ") || "(none)"}`, `- required outputs: ${outputs.join(", ") || "(none)"}`,
    `- when done write: ${responsePath}  ->  {"ok": true, "summary": "..."}`, "",
    "## Agent instructions (system prompt)", "", systemPrompt || "(none)", "", "## Stage prompt", "", prompt].join("\n");
  writeFileSync(join(reqDir, `${id}.json`), JSON.stringify(request, null, 2));
  writeFileSync(join(reqDir, `${id}.md`), md);
  writeFileSync(join(root, "pending.json"), JSON.stringify({ id, stage: request.stage, request: join(reqDir, `${id}.md`), responsePath }, null, 2));
  process.stderr.write(`[grokbot] waiting for ${responsePath} (request ${join(reqDir, `${id}.md`)})\n`);

  const poll = Number(env?.UWF_GROKBOT_POLL_MS ?? process.env.UWF_GROKBOT_POLL_MS ?? 2000);
  const start = Date.now();
  let resp = null;
  const deadline = timeoutMs ? start + timeoutMs : Infinity;
  const timedOut = () => { rmSync(join(root, "pending.json"), { force: true }); return fail(`timeout after ${timeoutMs}ms waiting for ${responsePath}`); };
  while (!resp) {
    if (existsSync(responsePath)) {
      try { resp = JSON.parse(readFileSync(responsePath, "utf8")); } catch { /* partially written; retry */ }
      // The deadline applies to when the agent finished (the file's mtime), not to when this loop
      // happened to look: a response completed in time is accepted even if observed at the final wake-up.
      if (resp && statSync(responsePath).mtimeMs > deadline) return timedOut();
    }
    if (resp) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timedOut();
    await new Promise((r) => setTimeout(r, Math.min(poll, remaining)));
  }
  rmSync(join(root, "pending.json"), { force: true });
  const ok = resp.ok !== false;
  const stdout = String(resp.summary ?? resp.stdout ?? "");
  const outSid = resp.sessionId ?? sid;
  const transcriptPath = writeTranscript(dataDir, { adapter: name, requestId: id, prompt, systemPrompt, sessionId: outSid, exitCode: ok ? 0 : 1, stdout });
  const res = { ok, sessionId: outSid, transcriptPath, stdout, exitCode: ok ? 0 : 1, usage: null };
  if (!ok) res.error = `grokbot agent reported failure: ${resp.error ?? "unspecified"}`;
  return res;
}
