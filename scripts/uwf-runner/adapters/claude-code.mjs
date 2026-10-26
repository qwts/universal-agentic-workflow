/**
 * UWF Claude Code adapter — runs one stage through `claude -p`.
 *
 * Flags used (verified against claude 2.1.x --help):
 *   -p <prompt> --output-format json --append-system-prompt <text>
 *   --resume <id> (when sessionId)   --model <m> (when model)
 *   --permission-mode dontAsk --allowedTools <list>   (from `permissions`)
 *   --setting-sources project  (help: "Comma-separated list of setting sources
 *     to load (user, project, local)"; a stage never inherits ~/.claude settings)
 *   --strict-mcp-config --mcp-config <json>  (default `{"mcpServers":{}}`; a stage never inherits the
 *     user's claude.ai connectors or MCP servers, which cost ~50k tokens of tool schemas per stage.
 *     Opt in with InvokeStageOptions.mcpConfig: a file path or inline JSON, passed verbatim.)
 * There is no --cwd flag; the working directory is set on the child process.
 *
 * Permission mapping (dontAsk denies anything not allow-listed):
 *   read-only  -> Read,Grep,Glob
 *   edit       -> + Edit,Write
 *   edit+exec  -> + Bash
 *   read-only+review -> Read,Grep,Glob + Bash restricted to `allowedCommands` (default
 *                      `node .github/skills/uwf-review/reviews.mjs`) + Write restricted to the stage's `outputs`
 */

import { spawn } from "node:child_process";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, writeTranscript } from "./index.mjs";

export const name = "claude-code";

const TOOLS = {
  "read-only": ["Read", "Grep", "Glob"],
  edit: ["Read", "Grep", "Glob", "Edit", "Write"],
  "edit+exec": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  "read-only+review": ["Read", "Grep", "Glob", "Bash", "Write"],
};

const UWF_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_REVIEW_COMMAND = "node .github/skills/uwf-review/reviews.mjs";

/**
 * --allowedTools entries for `read-only+review`: the reviewer gets Bash and Write, but only the review
 * script's bookkeeping command(s) and the stage's required output files are pre-approved (dontAsk denies
 * everything else, so the reviewed source stays read-only).
 */
export function reviewAllowed({ allowedCommands, outputs, skillsRoot }) {
  // The prompt points the agent at the same script under the skills root (or this checkout) when the
  // target repo lacks it, so approve those absolute forms too.
  const rel = ".github/skills/uwf-review/reviews.mjs";
  const roots = [skillsRoot, UWF_CHECKOUT].filter(Boolean);
  const cmds = [...new Set([
    ...(allowedCommands?.length ? allowedCommands : [DEFAULT_REVIEW_COMMAND]),
    DEFAULT_REVIEW_COMMAND,
    ...roots.map((r) => `node ${join(r, rel)}`),
  ])];
  // Write path rules: `//abs/path` is absolute, a bare path is relative to the working directory.
  const rule = (p) => (isAbsolute(p) ? `/${p}` : p.replace(/^\.\//, ""));
  return ["Read", "Grep", "Glob", ...cmds.map((c) => `Bash(${c}:*)`), ...(outputs ?? []).map((o) => `Write(${rule(o)})`)];
}

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
  args.push("--permission-mode", "dontAsk", "--setting-sources", "project", "--tools", toolList, "--allowedTools", (permissions === "read-only+review" ? reviewAllowed(opts) : TOOLS[permissions]).join(","));

  // --setting-sources does not exclude claude.ai connectors, and --tools only filters built-ins.
  args.push("--strict-mcp-config", "--mcp-config", opts.mcpConfig ?? '{"mcpServers":{}}');

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
