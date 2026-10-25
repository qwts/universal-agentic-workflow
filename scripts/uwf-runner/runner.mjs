#!/usr/bin/env node
/**
 * UWF Runner — deterministic stage loop (ADR-0007: the runtime owns the loop).
 *
 * Usage:
 *   node scripts/uwf-runner/runner.mjs run --workflow <w> --goal <file|text>
 *     [--adapter claude-code|fake] [--model <m>] [--data-dir <d>] [--output-path <p>]
 *     [--from-stage <s>] [--force] [--non-interactive] [--dry-run] [--timeout-ms <n>]
 *   node scripts/uwf-runner/runner.mjs resume --workflow <w>
 *     [--adapter] [--model] [--data-dir] [--output-path] [--non-interactive] [--timeout-ms]
 *
 * Exit codes: 0 complete | 1 gate blocked / abort | 2 usage or config error | 3 questions pending
 *
 * The runner only sequences. State lives in the existing stores (stage-tracker, state-manager,
 * question-protocol); gates are evaluated by `uwf-<workflow>/run.mjs --check-gate`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapter, ADAPTERS } from "./adapters/index.mjs";
import { materializePrompt } from "./prompt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = resolve(HERE, "..", "..");
const SKILLS = join(OWN_ROOT, ".github", "skills");
const STATE = join(SKILLS, "uwf-state-manager", "state.mjs");
const TRACKER = join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs");
const QUESTIONS = join(SKILLS, "uwf-question-protocol", "questions.mjs");
const AGENT_ID = "uwf-runner";
const GOAL_FILE = "runner-goal.md";
// Mirrors VALID_PHASES in uwf-state-manager/state.mjs (used to roll the phase back on --from-stage).
const PHASES = ["idea", "intake", "discovery", "planning", "execution", "acceptance", "closed"];
const isDone = (status) => status === "passed" || status === "skipped";

const EXIT = { OK: 0, GATE: 1, USAGE: 2, QUESTIONS: 3 };

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

/** Run one of the existing CLIs (no shell). Returns { ok, data, error, code }. */
export function runCli(scriptPath, args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  let data = null;
  try { data = JSON.parse(r.stdout); } catch { /* non-JSON output */ }
  const code = r.status ?? 1;
  const ok = code === 0 && data?.ok !== false;
  let error = null;
  if (!ok) {
    error = data?.error
      ?? (Array.isArray(data?.failures) ? data.failures.join("; ") : null)
      ?? (data?.gate === "fail" ? `${data.pending_count} pending required question(s)` : null)
      ?? (r.stderr || r.error?.message || `exit ${code}`).trim();
  }
  return { ok, data, error, code };
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const bool = new Set(["non-interactive", "dry-run", "force"]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) { positional.push(t); continue; }
    const key = t.slice(2);
    if (bool.has(key)) { flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`--${key} requires a value`);
    flags[key] = next;
    i++;
  }
  return { flags, positional };
}

const log = (s) => process.stderr.write(s + "\n");

/** Parse a QUESTIONS_NEEDED block (format: uwf-question-protocol/SKILL.md). */
export function parseQuestions(text) {
  const idx = text.indexOf("QUESTIONS_NEEDED");
  if (idx < 0) return [];
  const out = [];
  let group = null;
  let cur = null;
  for (const raw of text.slice(idx + "QUESTIONS_NEEDED".length).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\[(.+)\]$/))) { group = m[1]; cur = null; }
    else if ((m = line.match(/^Q:\s*(.+)$/))) { cur = { group, question: m[1], proposed: null, required: true }; out.push(cur); }
    else if (cur && (m = line.match(/^Proposed:\s*(.*)$/))) cur.proposed = m[1];
    else if (cur && (m = line.match(/^Required:\s*(\w+)/i))) cur.required = m[1].toLowerCase() !== "false";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  if (command !== "run" && command !== "resume") throw new UsageError("Usage: runner.mjs run|resume --workflow <w> [--goal <file|text>] [options]");
  if (!flags.workflow) throw new UsageError("--workflow is required");
  if (command === "run" && !flags.goal) throw new UsageError("--goal is required");
  if (command === "resume") {
    for (const k of ["goal", "from-stage", "dry-run", "force"]) {
      if (flags[k] !== undefined) throw new UsageError(`--${k} is not valid with resume`);
    }
  }

  const workflow = flags.workflow;
  const runScript = join(SKILLS, `uwf-${workflow}`, "run.mjs");
  if (!existsSync(runScript)) throw new UsageError(`Unknown workflow "${workflow}" (no ${runScript})`);

  const adapterName = flags.adapter ?? (process.env.UWF_FAKE_FIXTURE_DIR ? "fake" : "claude-code");
  if (!ADAPTERS.includes(adapterName)) throw new UsageError(`Unknown adapter "${adapterName}". Available: ${ADAPTERS.join(", ")}`);
  const fixtureDir = process.env.UWF_FAKE_FIXTURE_DIR;
  if (adapterName === "fake" && !fixtureDir) throw new UsageError("fake adapter requires UWF_FAKE_FIXTURE_DIR");

  let timeoutMs;
  if (flags["timeout-ms"] !== undefined) {
    timeoutMs = Number(flags["timeout-ms"]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError("--timeout-ms must be a positive number");
  }

  const dryRun = flags["dry-run"] === true;
  const nonInteractive = flags["non-interactive"] === true;
  const repoRoot = resolve(flags["repo-root"] ?? OWN_ROOT); // hidden: tests run in a scratch root
  const outputPath = flags["output-path"] ?? "./tmp/workflow-artifacts";

  // Dry run must write nothing: point every store at a throwaway dir.
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), "uwf-dry-")) : null;
  const dataDir = scratch ?? resolve(flags["data-dir"] ?? process.env.UWF_DATA_DIR ?? "./tmp/uwf");
  process.env.UWF_DATA_DIR = dataDir;

  // The goal text is persisted on `run` so `resume` can rebuild prompts from the data dir alone.
  const goalPath = join(dataDir, GOAL_FILE);
  let goal;
  if (command === "run") goal = existsSync(flags.goal) ? readFileSync(flags.goal, "utf8").trim() : flags.goal;
  else if (!existsSync(goalPath)) throw new UsageError(`No goal recorded at ${goalPath}; start with "runner.mjs run --goal ..." first`);
  else goal = readFileSync(goalPath, "utf8").trim();

  const cliEnv = { UWF_DATA_DIR: dataDir };
  const common = ["--data-dir", dataDir];
  const withOut = ["--output-path", outputPath, ...common];
  const cli = (script, args, extra = common) => runCli(script, [...args, ...extra], { cwd: repoRoot, env: cliEnv });
  const note = (text) => cli(STATE, ["note", "--agent", AGENT_ID, "--note", text], withOut);

  try {
    const listed = cli(runScript, ["--list-stages"], withOut);
    if (!listed.ok || !Array.isArray(listed.data)) throw new UsageError(`Cannot list stages: ${listed.error}`);
    const stages = listed.data;
    let start = 0;
    if (flags["from-stage"]) {
      start = stages.findIndex((s) => s.name === flags["from-stage"]);
      if (start < 0) throw new UsageError(`--from-stage "${flags["from-stage"]}" not in: ${stages.map((s) => s.name).join(", ")}`);
    }

    if (dryRun) return await dryRunReport({ workflow, stages: stages.slice(start), total: stages.length, start, repoRoot, outputPath, dataDir, goal, flags });

    const readTracker = () => {
      const r = cli(TRACKER, ["read", "--workflow", workflow], withOut);
      return r.ok && Array.isArray(r.data?.state) ? r.data.state : [];
    };
    const readPhase = () => cli(STATE, ["read"], withOut).data?.state?.phase ?? null;
    const tableRows = (tracked) => stages.map((st) => {
      const t = tracked.find((x) => x.stage === st.name);
      return { stage: st.name, attempts: t && t.status === "passed" ? t.retry_count + 1 : "-", result: t?.status ?? "pending" };
    });
    const resetFrom = (idx) => {
      const r = cli(TRACKER, ["reset-from", "--workflow", workflow, "--stage", stages[idx].name], withOut);
      if (!r.ok) throw new UsageError(`reset-from failed: ${r.error}`);
    };
    // Roll the phase back to what the last earlier stage with advances_phase_to had reached
    // (the very first phase when there is none, so a full rerun starts from scratch).
    const rollbackPhase = (idx) => {
      const target = stages.slice(0, idx).map((s) => s.advancesTo).filter((p) => PHASES.includes(p)).pop() ?? PHASES[0];
      const cur = readPhase();
      if (!PHASES.includes(cur) || PHASES.indexOf(cur) <= PHASES.indexOf(target)) return;
      const a = cli(STATE, ["rollback", "--to", target, "--agent", AGENT_ID, "--note", `runner: reset from ${stages[idx].name}`], withOut);
      if (!a.ok) log(`[runner] phase rollback to "${target}" not applied: ${a.error}`);
    };

    // The phase must match the completed-stage prefix before resuming. A crash between a stage
    // passing and its phase advance leaves the phase behind; a crash between reset-from and the
    // phase rollback (--from-stage) leaves it ahead. Catch up one legal step at a time, or roll back.
    const reconcilePhase = (tracked) => {
      const doneStages = [];
      for (const st of stages) { if (!isDone(tracked.find((x) => x.stage === st.name)?.status)) break; doneStages.push(st); }
      const reached = doneStages.map((st) => st.advancesTo).filter((p) => PHASES.includes(p)).pop() ?? PHASES[0];
      let cur = readPhase();
      if (!PHASES.includes(cur)) return;
      if (PHASES.indexOf(cur) > PHASES.indexOf(reached)) {
        const a = cli(STATE, ["rollback", "--to", reached, "--agent", AGENT_ID, "--note", `runner resume: phase reconciled to ${reached}`], withOut);
        if (!a.ok) log(`[runner] phase reconcile to "${reached}" not applied: ${a.error}`);
        return;
      }
      while (PHASES.indexOf(cur) < PHASES.indexOf(reached)) {
        const next = PHASES[PHASES.indexOf(cur) + 1];
        const a = cli(STATE, ["advance", "--to", next, "--agent", AGENT_ID, "--note", `runner resume: phase reconciled to ${next}`], withOut);
        if (!a.ok) { log(`[runner] phase reconcile to "${next}" not applied: ${a.error}`); return; }
        cur = next;
      }
    };

    let priorRows = [];
    if (command === "resume") {
      const tracked = readTracker();
      if (!tracked.length) throw new UsageError(`No stage records in ${dataDir}; nothing to resume (use "run")`);
      reconcilePhase(tracked);
      start = stages.findIndex((st) => !isDone(tracked.find((x) => x.stage === st.name)?.status));
      if (start < 0) {
        process.stdout.write(formatTable(tableRows(tracked)));
        return EXIT.OK;
      }
      const status = tracked.find((x) => x.stage === stages[start].name)?.status;
      const reason = status === "active" || status === "failed" ? status : "pending";
      // A failed stage restarts with retries reset (resume is an explicit human action).
      // An active one (crash) is simply re-invoked: the loop's attempt counter starts at 1 anyway.
      if (reason === "failed") resetFrom(start);
      priorRows = tableRows(tracked).slice(0, start);
      const n = note(`runner resume: from=${stages[start].name} reason=${reason}`);
      if (!n.ok) log(`[runner] note not recorded: ${n.error}`);
    } else {
      if (!flags["from-stage"] && flags.force !== true) {
        const tracked = readTracker();
        if (tracked.length && stages.every((st) => isDone(tracked.find((x) => x.stage === st.name)?.status)) && readPhase() === "closed") {
          log("[runner] workflow already complete; nothing to do (use --force to start over)");
          process.stdout.write(formatTable(tableRows(tracked)));
          return EXIT.OK;
        }
      }
      if (!flags["from-stage"]) {
        for (const [script, args] of [[TRACKER, ["init", "--workflow", workflow]], [STATE, ["init"]]]) {
          const r = cli(script, args, withOut);
          if (!r.ok) throw new UsageError(`Store init failed (${args[0]}): ${r.error}`);
        }
        // A fresh start also forgets questions from earlier attempts in this data dir.
        const qr = cli(QUESTIONS, ["reset"]);
        if (!qr.ok) log(`[runner] questions reset not applied: ${qr.error}`);
      } else {
        resetFrom(start);
        rollbackPhase(start);
      }
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(goalPath, goal + "\n");
      const noted = note(`runner start: workflow=${workflow} adapter=${adapterName} from=${stages[start].name}`);
      if (!noted.ok) log(`[runner] note not recorded: ${noted.error}`);
    }

    const adapter = await loadAdapter(adapterName);
    const rows = command === "resume" ? priorRows : [];
    return await stageLoop({ stages, start, rows, workflow, runScript, adapter, adapterName, fixtureDir, flags, goal,
      repoRoot, outputPath, dataDir, timeoutMs, nonInteractive, cli, note, withOut });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The one stage loop, shared by `run` and `resume`. Executes stages[start..] in order and
 * returns an exit code. ctx carries everything resolved by main().
 */
async function stageLoop(ctx) {
  const { stages, start, rows, workflow, runScript, adapter, adapterName, fixtureDir, flags, goal, repoRoot,
    outputPath, dataDir, timeoutMs, nonInteractive, cli, note, withOut } = ctx;
  let first = true;
  for (let i = start; i < stages.length; i++) {
    const st = stages[i];
    const tag = `[${i + 1}/${stages.length}] ${st.name}`;
    const row = { stage: st.name, attempts: 0, result: "" };
    rows.push(row);

    // 1. pending required questions block the stage
    const q = cli(QUESTIONS, ["check", "--stage", st.name]);
    if (!q.ok) {
      if (q.data?.gate !== "fail") throw new UsageError(`questions check failed: ${q.error}`);
      if (nonInteractive) {
        const pend = cli(QUESTIONS, ["list", "--stage", st.name, "--status", "pending"]);
        const ids = (pend.data?.questions ?? []).map((x) => x.id);
        for (const id of ids) cli(QUESTIONS, ["skip", "--id", String(id)]);
        log(`${tag}: --non-interactive: skipped ${ids.length} pending question(s) (ids ${ids.join(",")}) and continuing`);
      } else {
        row.result = "blocked: questions pending";
        return finish(EXIT.QUESTIONS, rows, `${tag}: ${q.data.pending_count} pending required question(s); answer with questions.mjs answer --id <n> --answer ..., then rerun with --from-stage ${st.name}`, note);
      }
    }

    // Conditional stages whose condition is not met auto-pass in the gate; do not invoke them.
    if (st.conditional) {
      const g = cli(runScript, ["--check-gate", st.name], withOut);
      if (g.ok && /not required/.test(g.data?.note ?? "")) {
        cli(TRACKER, ["stage-skip", "--workflow", workflow, "--stage", st.name, "--note", "condition not met"], withOut);
        log(`${tag} → skipped (${g.data.note})`);
        row.result = "skipped (not required)";
        continue;
      }
    }

    // 2. claim the token, mark the stage active
    cli(STATE, ["set-agent", "--agent", AGENT_ID, "--force"], withOut);
    const started = cli(TRACKER, ["stage-start", "--workflow", workflow, "--stage", st.name], withOut);
    if (!started.ok) throw new UsageError(`stage-start failed: ${started.error}`);

    // 3. materialize the prompt (goal goes first on the first stage of this run)
    const answered = cli(QUESTIONS, ["list", "--stage", st.name, "--status", "answered"]);
    const extraContext = { goal, answeredQuestions: answered.ok ? (answered.data?.questions ?? answered.data?.items ?? []) : [] };
    const mp = await materializePrompt({ workflow, stage: st.name, repoRoot, outputPath, dataDir, extraContext });
    if (mp.inputsMissing?.length) log(`${tag}: inputs not found: ${mp.inputsMissing.join(", ")}`);
    const basePrompt = first ? `Goal:\n${goal}\n\n${mp.prompt}` : mp.prompt;
    first = false;
    const model = flags.model ?? mp.model ?? undefined;
    const maxAttempts = st.maxRetries + 1;

    let sessionId;
    let prompt = basePrompt;
    for (let attempt = 1; ; attempt++) {
      row.attempts = attempt;
      log(`${tag} → ${adapterName} (attempt ${attempt}/${maxAttempts})`);
      if (attempt > 1) cli(STATE, ["set-agent", "--agent", AGENT_ID, "--force"], withOut);

      const env = { UWF_DATA_DIR: dataDir };
      if (fixtureDir) env.UWF_FAKE_FIXTURE = join(fixtureDir, `${st.name}.json`);
      const res = await adapter.invokeStage({
        systemPrompt: mp.systemPrompt, prompt, cwd: repoRoot, inputs: st.inputs, outputs: mp.outputsRequired,
        model, sessionId, timeoutMs, env, permissions: mp.permissions, dataDir,
      });
      sessionId = res.sessionId ?? sessionId;
      cli(STATE, ["release-agent"], withOut); // 4.

      // 5. questions
      const text = res.stdout || transcriptText(res.transcriptPath);
      const asked = parseQuestions(text);
      if (asked.length) {
        const ids = [];
        for (const k of asked) {
          const args = ["log", "--stage", st.name, "--question", k.question, "--required", String(k.required)];
          if (k.group) args.push("--group", k.group);
          if (k.proposed) args.push("--proposed", k.proposed);
          const l = cli(QUESTIONS, args);
          if (l.ok) ids.push(l.data.question_id);
        }
        const blocking = asked.some((k) => k.required);
        if (blocking && !nonInteractive) {
          row.result = "blocked: questions pending";
          return finish(EXIT.QUESTIONS, rows, `${tag}: ${asked.length} question(s) logged (ids ${ids.join(",")}); answer them, then rerun with --from-stage ${st.name}`, note);
        }
        if (nonInteractive) {
          for (const id of ids) cli(QUESTIONS, ["skip", "--id", String(id)]);
          log(`${tag}: --non-interactive: recorded ${ids.length} question(s) (ids ${ids.join(",")}) as skipped and continuing`);
        }
      }

      // 6. gate
      let failures;
      if (!res.ok) {
        failures = [`adapter error: ${res.error ?? "unknown"}`];
        log(`${tag} gate: NOT RUN (${failures[0]})`);
      } else {
        const g = cli(runScript, ["--check-gate", st.name], withOut);
        if (g.ok) {
          log(`${tag} gate: PASS`);
          cli(TRACKER, ["stage-complete", "--workflow", workflow, "--stage", st.name], withOut);
          row.result = "passed";
          const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name) : null;
          if (adv) row.result += ` (${adv})`;
          break;
        }
        failures = g.data?.failures ?? [g.error];
        log(`${tag} gate: FAIL — ${failures.join("; ")}`);
      }

      if (st.onGateFailure === "skip") {
        cli(TRACKER, ["stage-skip", "--workflow", workflow, "--stage", st.name, "--note", `gate failed: ${failures.join("; ")}`], withOut);
        row.result = "skipped (gate failed)";
        // A skipped stage still moves the workflow forward, as stage-tracker does.
        const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name) : null;
        if (adv) row.result += ` (${adv})`;
        break;
      }
      if (st.onGateFailure === "abort" || attempt >= maxAttempts) {
        cli(TRACKER, ["stage-fail", "--workflow", workflow, "--stage", st.name, "--note", failures.join("; ")], withOut);
        row.result = st.onGateFailure === "abort" ? "failed (abort)" : "failed";
        return finish(EXIT.GATE, rows, `${tag}: gate blocked after ${attempt} attempt(s): ${failures.join("; ")}`, note);
      }
      prompt = `${basePrompt}\n\nGate failure (retry ${attempt} of ${st.maxRetries}): ${failures.join("; ")}`;
    }
  }
  return finish(EXIT.OK, rows, "workflow complete", note);

  function advancePhase(target, stageName) {
    const cur = cli(STATE, ["read"], withOut);
    if (cur.ok && cur.data?.state?.phase === target) return null;
    const a = cli(STATE, ["advance", "--to", target, "--agent", AGENT_ID, "--note", `stage ${stageName} passed`], withOut);
    if (a.ok) return `phase→${target}`;
    log(`[runner] phase "${target}" not applied after ${stageName}: ${a.error}`);
    return `phase ${target} not applied`;
  }
}

function transcriptText(path) {
  try { return path ? (JSON.parse(readFileSync(path, "utf8")).stdout ?? "") : ""; } catch { return ""; }
}

function formatTable(rows) {
  const w = Math.max(5, ...rows.map((r) => r.stage.length));
  const lines = [`${"stage".padEnd(w)}  attempts  result`, ...rows.map((r) => `${r.stage.padEnd(w)}  ${String(r.attempts).padEnd(8)}  ${r.result}`)];
  return lines.join("\n") + "\n";
}

function finish(code, rows, message, note) {
  if (code === EXIT.OK) {
    process.stdout.write(formatTable(rows));
  } else {
    log(`[runner] ${message}`);
    log(rows.map((r) => `  ${r.stage}: ${r.result || "-"} (attempts ${r.attempts})`).join("\n"));
  }
  const n = note(`runner end: ${code === EXIT.OK ? "complete" : message}`);
  if (!n.ok) log(`[runner] note not recorded: ${n.error}`);
  return code;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRunReport({ workflow, stages, total, start, repoRoot, outputPath, dataDir, goal, flags }) {
  let gateChecks = {};
  try {
    const req = createRequire(join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs"));
    const doc = req("js-yaml").load(readFileSync(join(SKILLS, `uwf-${workflow}`, "stages.yaml"), "utf8"));
    gateChecks = Object.fromEntries((doc.stages ?? []).map((s) => [s.name, s.gate?.checks ?? []]));
  } catch (e) {
    log(`[dry-run] gate checks unavailable: ${e.message}`);
  }
  const out = [`workflow: ${workflow}  stages: ${total}  starting at: ${stages[0]?.name}  output-path: ${outputPath}`, ""];
  for (const [j, st] of stages.entries()) {
    const mp = await materializePrompt({ workflow, stage: st.name, repoRoot, outputPath, dataDir, extraContext: { goal } });
    out.push(`[${start + j + 1}/${total}] ${st.name}  (agent: ${mp.agentName})`);
    out.push(`  permissions: ${mp.permissions}   model: ${flags.model ?? mp.model ?? "(adapter default)"}`);
    out.push(`  retries: ${st.maxRetries}   on_gate_failure: ${st.onGateFailure}   gated: ${st.gated}${st.conditional ? "   conditional" : ""}`);
    out.push(`  required outputs: ${mp.outputsRequired.length ? mp.outputsRequired.join(", ") : "(none)"}`);
    if (mp.inputsMissing.length) out.push(`  inputs not present yet: ${mp.inputsMissing.join(", ")}`);
    const checks = gateChecks[st.name] ?? [];
    out.push(`  gate checks:${checks.length ? "" : " (none)"}`);
    for (const c of checks) {
      const { type, label, ...rest } = c;
      out.push(`    - ${type} ${JSON.stringify(rest)}`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
  return EXIT.OK;
}

// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      log(`[runner] ${err instanceof UsageError ? err.message : `internal error: ${err.stack ?? err}`}`);
      process.exitCode = EXIT.USAGE;
    },
  );
}
