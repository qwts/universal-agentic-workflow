/**
 * UWF Codex adapter — runs one stage through `codex exec`.
 *
 * Flags (verified against codex-cli 0.164.0-alpha `exec --help` / `exec resume --help`):
 *   codex exec --cd <cwd> [--model m] --json -c sandbox_mode=".." -c approval_policy="never" -
 *   codex exec resume <sessionId> [--model m] --json -c ... -        (when sessionId)
 * The prompt is sent on stdin (`-`), which avoids argv limits and leading-dash problems.
 * `exec resume` has no --sandbox or --cd flag, so the sandbox is set with `-c sandbox_mode=...`
 * on both paths and the working directory is also set on the child process (resume looks
 * sessions up by cwd).
 *
 * Permission mapping (never danger-full-access, never --dangerously-bypass-*):
 *   read-only  -> sandbox_mode="read-only"
 *   edit       -> sandbox_mode="workspace-write"
 *   edit+exec  -> sandbox_mode="workspace-write"
 * Codex has no per-tool allowlist: commands always run inside the sandbox, so `edit` and
 * `edit+exec` are identical here (see README). approval_policy="never" keeps a headless run
 * from blocking on a prompt; commands that need more than the sandbox allows simply fail.
 *
 * System prompt: Codex has no --append-system-prompt equivalent, so the agent body /
 * systemPrompt is PREPENDED to the prompt under a "# Agent instructions" heading.
 *
 * Output: --json emits JSONL events. Parsed defensively:
 *   thread.started {thread_id}, item.completed {item:{type:"agent_message",text}},
 *   turn.completed {usage:{input_tokens,output_tokens}}, turn.failed/error {message}.
 * The final message is taken from `--output-last-message <file>` when present, else the
 * last agent_message. Codex reports no cost, so costUsd is omitted.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, writeTranscript } from "./index.mjs";

export const name = "codex";

const SANDBOX = { "read-only": "read-only", edit: "workspace-write", "edit+exec": "workspace-write" };

/** @param {import("./index.mjs").InvokeStageOptions} opts @returns {Promise<import("./index.mjs").InvokeStageResult>} */
export async function invokeStage(opts) {
  const { prompt, cwd, model, sessionId, timeoutMs, env, dataDir } = opts;
  const permissions = opts.permissions ?? "read-only";
  const fail = (error, extra = {}) => ({
    ok: false, sessionId: sessionId ?? null, transcriptPath: null,
    stdout: "", exitCode: null, usage: null, error, ...extra,
  });
  if (!SANDBOX[permissions]) return fail(`Unknown permissions "${permissions}"`);

  let system;
  try {
    system = buildSystemPrompt(opts.agentFile, opts.systemPrompt);
  } catch (e) {
    return fail(`Cannot read agentFile: ${e.message}`);
  }
  const fullPrompt = system ? `# Agent instructions\n\n${system}\n\n# Task\n\n${prompt}` : prompt;

  let tmp = null, lastMsgFile = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "uwf-codex-"));
    lastMsgFile = join(tmp, "last-message.txt");
  } catch { /* fall back to JSONL parsing only */ }

  const args = ["exec"];
  if (sessionId) args.push("resume", sessionId);
  else args.push("--cd", cwd);
  if (model) args.push("--model", model);
  args.push("--json", "-c", `sandbox_mode="${SANDBOX[permissions]}"`, "-c", 'approval_policy="never"');
  args.push("--skip-git-repo-check");
  if (lastMsgFile) args.push("--output-last-message", lastMsgFile);
  args.push("-");

  const cleanup = () => { if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

  return new Promise((done) => {
    let out = "", err = "", timedOut = false, settled = false;
    let child;
    try {
      // detached: own process group so a timeout kills sandboxed descendants too.
      child = spawn("codex", args, {
        cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      });
    } catch (e) {
      cleanup();
      return done(fail(`spawn failed: ${e.message}`));
    }
    const killTree = () => {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; killTree(); finish(null); }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.on("error", () => { /* child exited before reading the prompt */ });
    child.stdin.end(fullPrompt);

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      // `error` events can be transient ("Reconnecting..."); only the ones not
      // followed by a successful turn.completed count as a failure.
      let sid = null, lastAgentText = null, usage = null, eventError = null, pendingError = null;
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let ev;
        try { ev = JSON.parse(t); } catch { continue; }
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") sid = ev.thread_id;
        else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") lastAgentText = ev.item.text;
        else if (ev.type === "turn.completed" && ev.usage) {
          const { input_tokens: i, output_tokens: o } = ev.usage;
          if (Number.isFinite(i) && Number.isFinite(o)) {
            // a multi-turn run may emit several turn.completed; sum them
            usage = { inputTokens: (usage?.inputTokens ?? 0) + i, outputTokens: (usage?.outputTokens ?? 0) + o };
          }
          pendingError = null; // the turn recovered from any earlier error event
        } else if (ev.type === "turn.failed") eventError = ev.error?.message ?? "turn failed";
        else if (ev.type === "error" && !pendingError) pendingError = ev.message ?? "error";
      }
      if (!eventError && pendingError) eventError = pendingError;
      let text = lastAgentText ?? "";
      if (lastMsgFile) { try { text = readFileSync(lastMsgFile, "utf8") || text; } catch { /* not written */ } }
      cleanup();

      sid = sid ?? sessionId ?? null;
      let error;
      if (timedOut) error = `timeout after ${timeoutMs}ms`;
      else if (spawnError) error = `spawn failed: ${spawnError.message}`;
      else if (exitCode !== 0) error = `codex exited ${exitCode}: ${(eventError || err || out).slice(0, 500)}`;
      else if (eventError) error = `codex reported error: ${eventError.slice(0, 500)}`;
      else if (!text) error = "codex produced no final message";
      const transcriptPath = writeTranscript(dataDir, {
        adapter: name, args, prompt, sessionId: sid, exitCode, stdout: out, stderr: err, error: error ?? null,
      });
      const res = { ok: !error, sessionId: sid, transcriptPath, stdout: text, exitCode, usage };
      if (error) res.error = error;
      done(res);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
