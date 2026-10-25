/**
 * UWF Claude Code adapter — runs one stage through `claude -p`.
 *
 * Flags used (verified against claude 2.1.x --help):
 *   -p <prompt> --output-format json --append-system-prompt <text>
 *   --resume <id> (when sessionId)   --model <m> (when model)
 *   --permission-mode dontAsk --allowedTools <list>   (from `permissions`)
 * There is no --cwd flag; the working directory is set on the child process.
 *
 * Permission mapping (dontAsk denies anything not allow-listed):
 *   read-only  -> Read,Grep,Glob
 *   edit       -> + Edit,Write
 *   edit+exec  -> + Bash
 */

import { spawn } from "node:child_process";
import { buildSystemPrompt, writeTranscript } from "./index.mjs";

export const name = "claude-code";

const TOOLS = {
  "read-only": ["Read", "Grep", "Glob"],
  edit: ["Read", "Grep", "Glob", "Edit", "Write"],
  "edit+exec": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
};

/** @param {import("./index.mjs").InvokeStageOptions} opts @returns {Promise<import("./index.mjs").InvokeStageResult>} */
export async function invokeStage(opts) {
  const { prompt, cwd, model, sessionId, timeoutMs, env, dataDir } = opts;
  const permissions = opts.permissions ?? "read-only";
  const fail = (error, extra = {}) => ({
    ok: false, sessionId: sessionId ?? null, transcriptPath: null,
    stdout: "", exitCode: null, usage: null, error, ...extra,
  });
  if (!TOOLS[permissions]) return fail(`Unknown permissions "${permissions}"`);

  let system;
  try {
    system = buildSystemPrompt(opts.agentFile, opts.systemPrompt);
  } catch (e) {
    return fail(`Cannot read agentFile: ${e.message}`);
  }

  const args = ["-p", prompt, "--output-format", "json"];
  if (system) args.push("--append-system-prompt", system);
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  // --tools restricts what exists; --allowedTools pre-approves it. Both are
  // needed: dontAsk keeps the user's own pre-approved tools unless --tools
  // narrows the set, so a read-only stage must not depend on ambient settings.
  const toolList = TOOLS[permissions].join(",");
  args.push("--permission-mode", "dontAsk", "--tools", toolList, "--allowedTools", toolList);

  return new Promise((done) => {
    let out = "", err = "", timedOut = false, settled = false;
    let child;
    try {
      // detached: the child leads its own process group, so a timeout can
      // kill every descendant (tool subprocesses under edit+exec) at once.
      child = spawn("claude", args, {
        cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
    } catch (e) {
      return done(fail(`spawn failed: ${e.message}`));
    }
    const killTree = () => {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    // On timeout, settle immediately rather than waiting for "close": a
    // surviving descendant holding the pipes must not extend the deadline.
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; killTree(); finish(null); }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* non-JSON output */ }
      const u = parsed?.usage;
      const usage = u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)
        ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : null;
      const text = typeof parsed?.result === "string" ? parsed.result : out;
      const sid = parsed?.session_id ?? sessionId ?? null;
      let error;
      if (timedOut) error = `timeout after ${timeoutMs}ms`;
      else if (spawnError) error = `spawn failed: ${spawnError.message}`;
      else if (exitCode !== 0) error = `claude exited ${exitCode}: ${(err || parsed?.result || out).slice(0, 500)}`;
      else if (!parsed) error = "claude output was not valid JSON";
      else if (parsed.is_error) error = `claude reported error: ${String(parsed.result).slice(0, 500)}`;
      const transcriptPath = writeTranscript(dataDir, {
        adapter: name, args: args.filter((a) => a !== system), prompt, sessionId: sid,
        exitCode, stdout: out, stderr: err, error: error ?? null,
      });
      const res = { ok: !error, sessionId: sid, transcriptPath, stdout: text, exitCode, usage };
      if (typeof parsed?.total_cost_usd === "number") res.costUsd = parsed.total_cost_usd;
      if (error) res.error = error;
      done(res);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
