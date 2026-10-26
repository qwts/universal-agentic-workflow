#!/usr/bin/env node
/**
 * UWF Runner — deterministic stage loop (ADR-0007: the runtime owns the loop).
 *
 * Usage:
 *   node scripts/uwf-runner/runner.mjs run --workflow <w> --goal <file|text>
 *     [--adapter claude-code|codex|fake|grokbot] [--model <m>] [--data-dir <d>] [--output-path <p>]
 *     [--from-stage <s>] [--force] [--non-interactive] [--dry-run] [--timeout-ms <n>]
 *     [--repo-root <target repo>] [--skills-root <dir with .github/skills + .github/agents>]
 *     [--max-cost-usd <n>] [--resume-max-context <tokens>]
 *   node scripts/uwf-runner/runner.mjs resume --workflow <w>
 *     [--adapter] [--model] [--data-dir] [--output-path] [--non-interactive] [--timeout-ms]
 *     [--max-cost-usd <n>] [--resume-max-context <tokens>]
 *
 *   node scripts/uwf-runner/runner.mjs cost --data-dir <d> [--workflow <w> [--repo-root <r>]]
 *     per-stage turns, context per turn, tokens and cost from <d>/transcripts (see cost.mjs)
 *
 * Exit codes: 0 complete | 1 gate blocked / abort / on_verdict round trips exhausted | 2 usage or config error | 3 questions pending (incl. a review needing a user decision) | 4 cost cap exceeded
 *
 * Cost: after every attempt the runner sums the cost in <data-dir>/transcripts. --max-cost-usd caps the run total
 * (stages.yaml `max_cost_usd` caps one stage's attempts); exceeding either stops the run with exit 4.
 * --resume-max-context (default 100000): when an attempt's last turn held more tokens than that, the next
 * retry starts a fresh session (with an excerpt of the previous output) even under retry_mode: resume.
 *
 * Two roots: --repo-root is where the agent works (cwd, artifacts, {{cwd}} gate paths); --skills-root
 * (env UWF_SKILLS_ROOT) is where workflow definitions, agents and skill docs are read. Default: this
 * checkout; if the target repo ships .github/skills/uwf-<w>/stages.yaml, that copy is used (one log line).
 *
 * The runner only sequences. State lives in the existing stores (stage-tracker, state-manager,
 * question-protocol); gates are evaluated by `uwf-<workflow>/run.mjs --check-gate`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapter, ADAPTERS } from "./adapters/index.mjs";
import { materializePrompt, resolveSkillsRoot } from "./prompt.mjs";
import { attemptUsage, costReport, lastStageContext, listTranscripts } from "./cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_ROOT = resolve(HERE, "..", "..");
const SKILLS = join(OWN_ROOT, ".github", "skills");
const STATE = join(SKILLS, "uwf-state-manager", "state.mjs");
const TRACKER = join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs");
const QUESTIONS = join(SKILLS, "uwf-question-protocol", "questions.mjs");
const AGENT_ID = "uwf-runner";
const GOAL_FILE = "runner-goal.md";
const ROUTING_FILE = "runner-routing.json"; // on_verdict round trips + findings, so `resume` keeps them
// Mirrors VALID_PHASES in uwf-state-manager/state.mjs (canonical order; each workflow visits a subsequence of it).
const PHASES = ["idea", "intake", "discovery", "planning", "execution", "acceptance", "snapshot", "closed"];
const isDone = (status) => status === "passed" || status === "skipped";

const LOCK_FILE = "run.lock";
const LOCK_WAIT_MS = 3_000;      // how long to wait on a lock whose metadata is still being written
const LOCK_UNREADABLE_STALE_MS = 10_000; // an unreadable lock older than this has no live writer
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One run per data dir: parallel fronts share skill SQLite DBs unless each has its own --data-dir.
 * Creates <dataDir>/run.lock ({runId, pid, ...}) atomically with its contents already written
 * (a temp file hard-linked into place: link fails with EEXIST when a lock exists, and no reader
 * ever sees a half-written lock). A lock whose owner pid is dead is taken over; an unreadable lock
 * is waited on while young and treated as stale only when old; a live owner throws a UsageError.
 * Takeover runs under a mutex directory and removes only the exact inode it inspected, then
 * returns to the atomic link; a lock another run created meanwhile is never removed or overwritten.
 * Returns a release function that removes only this run's own lock.
 */
function acquireRunLock(dataDir, workflow) {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, LOCK_FILE);
  const info = { runId: `${workflow}-${process.pid}-${Date.now()}`, pid: process.pid, workflow, startedAt: new Date().toISOString() };
  const tmp = `${lockPath}.${process.pid}.tmp`;
  const readLock = () => { try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return null; } };
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    writeFileSync(tmp, JSON.stringify(info));
    while (true) {
      try {
        linkSync(tmp, lockPath);
        return () => {
          try { if (readLock()?.runId === info.runId) rmSync(lockPath, { force: true }); } catch { /* already gone */ }
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      let st;
      try { st = statSync(lockPath); } catch { continue; } // released between link and stat
      const other = readLock();
      if (other && Number.isInteger(other.pid) && pidAlive(other.pid)) {
        throw new UsageError(`Data dir ${dataDir} is in use by run ${other.runId} (pid ${other.pid}). Parallel fronts must each pass a distinct --data-dir (and --output-path); two runs sharing one would collide on the skill SQLite DBs.`);
      }
      const stale = other ? true : Date.now() - st.mtimeMs > LOCK_UNREADABLE_STALE_MS;
      if (!stale) {
        if (Date.now() >= deadline) throw new UsageError(`Could not take ${lockPath}; another run is starting on the same --data-dir. Use a distinct --data-dir per parallel front.`);
        sleepMs(50);
        continue;
      }
      // Stale: take it over under a takeover mutex, so only one runner removes a stale lock at a
      // time, and only the exact inode it inspected. Nothing is ever renamed or written over a lock:
      // after the removal we go back to the atomic link, and a runner that got in first wins.
      if (!withTakeoverMutex(lockPath, () => {
        let now;
        try { now = statSync(lockPath); } catch { return; } // already gone
        if (now.ino !== st.ino) return; // replaced since we inspected it: not ours to remove
        const owner = readLock();
        if (owner && Number.isInteger(owner.pid) && pidAlive(owner.pid)) return;
        rmSync(lockPath, { force: true });
      })) {
        if (Date.now() >= deadline) throw new UsageError(`Could not take ${lockPath}; another run is starting on the same --data-dir. Use a distinct --data-dir per parallel front.`);
        sleepMs(25 + Math.random() * 50);
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

const TAKEOVER_STALE_MS = 10_000;

/**
 * Serialize stale-lock takeover with a mutex directory (mkdir is atomic and fails with EEXIST).
 * Returns false when another runner holds it (caller backs off and re-inspects). A mutex left by
 * a crash (older than TAKEOVER_STALE_MS; the critical section is a few syscalls) is removed.
 */
function withTakeoverMutex(lockPath, fn) {
  const mutex = `${lockPath}.takeover`;
  try {
    mkdirSync(mutex);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try { if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) rmSync(mutex, { recursive: true, force: true }); } catch { /* vanished */ }
    return false;
  }
  try { fn(); return true; } finally { rmSync(mutex, { recursive: true, force: true }); }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const EXIT = { OK: 0, GATE: 1, USAGE: 2, QUESTIONS: 3, COST: 4 };
const DEFAULT_RESUME_MAX_CONTEXT = 100_000;

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

/**
 * Resolve where workflow definitions/agents/skill docs come from (see resolveSkillsRoot in prompt.mjs):
 * --skills-root > UWF_SKILLS_ROOT > the target's own copy (logged) > this checkout.
 */
function pickSkillsRoot(flags, repoRoot, workflow) {
  if (flags["skills-root"] !== undefined && typeof flags["skills-root"] !== "string") throw new UsageError("--skills-root needs a directory");
  const { root, source } = resolveSkillsRoot({ explicit: flags["skills-root"], repoRoot, workflow });
  if (source === "target") log(`[runner] using the target repo's own workflow definitions: ${join(root, ".github", "skills")}`);
  if (!existsSync(join(root, ".github", "skills"))) throw new UsageError(`skills root has no .github/skills: ${root}`);
  return root;
}

/** The run.mjs shim to invoke: this checkout's (it has the installed deps), else the skills root's copy. */
function pickRunScript(skillsRoot, workflow) {
  if (!existsSync(join(skillsRoot, ".github", "skills", `uwf-${workflow}`, "stages.yaml"))) return null;
  const own = join(SKILLS, `uwf-${workflow}`, "run.mjs");
  return existsSync(own) ? own : join(skillsRoot, ".github", "skills", `uwf-${workflow}`, "run.mjs");
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
  if (command === "gates") return gatesAudit(flags);
  if (command === "cost") return costCommand(flags);
  if (command !== "run" && command !== "resume") throw new UsageError("Usage: runner.mjs run|resume|gates|cost --workflow <w> [--goal <file|text>] [options]");
  if (!flags.workflow) throw new UsageError("--workflow is required");
  if (command === "run" && !flags.goal) throw new UsageError("--goal is required");
  if (command === "resume") {
    for (const k of ["goal", "from-stage", "dry-run", "force"]) {
      if (flags[k] !== undefined) throw new UsageError(`--${k} is not valid with resume`);
    }
  }

  const workflow = flags.workflow;
  const repoRoot = resolve(flags["repo-root"] ?? OWN_ROOT); // hidden: tests run in a scratch root
  const skillsRoot = pickSkillsRoot(flags, repoRoot, workflow);
  const runScript = pickRunScript(skillsRoot, workflow);
  if (!runScript) throw new UsageError(`Unknown workflow "${workflow}" (no uwf-${workflow}/stages.yaml under ${join(skillsRoot, ".github", "skills")})`);

  const adapterName = flags.adapter ?? (process.env.UWF_FAKE_FIXTURE_DIR ? "fake" : "claude-code");
  if (!ADAPTERS.includes(adapterName)) throw new UsageError(`Unknown adapter "${adapterName}". Available: ${ADAPTERS.join(", ")}`);
  const fixtureDir = process.env.UWF_FAKE_FIXTURE_DIR;
  if (adapterName === "fake" && !fixtureDir) throw new UsageError("fake adapter requires UWF_FAKE_FIXTURE_DIR");

  let timeoutMs;
  if (flags["timeout-ms"] !== undefined) {
    timeoutMs = Number(flags["timeout-ms"]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError("--timeout-ms must be a positive number");
  }

  const positive = (key) => {
    if (flags[key] === undefined) return undefined;
    const n = Number(flags[key]);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${key} must be a positive number`);
    return n;
  };
  const maxCostUsd = positive("max-cost-usd");
  const resumeMaxContext = positive("resume-max-context") ?? DEFAULT_RESUME_MAX_CONTEXT;

  const dryRun = flags["dry-run"] === true;
  const nonInteractive = flags["non-interactive"] === true;
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

  const releaseLock = scratch ? () => {} : acquireRunLock(dataDir, flags.workflow);

  const cliEnv = { UWF_DATA_DIR: dataDir, UWF_SKILLS_ROOT: skillsRoot };
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

    if (dryRun) return await dryRunReport({ workflow, stages: stages.slice(start), total: stages.length, start, repoRoot, skillsRoot, outputPath, dataDir, goal, flags });

    const readTracker = () => {
      const r = cli(TRACKER, ["read", "--workflow", workflow], withOut);
      return r.ok && Array.isArray(r.data?.state) ? r.data.state : [];
    };
    // The phases this workflow visits, in order (planning-only workflows have no execution phase).
    // Passed to the state manager so it accepts exactly the advances this sequence implies.
    const phaseSeq = [...new Set(stages.map((s) => s.advancesTo).filter((p) => PHASES.includes(p)))]
      .sort((a, b) => PHASES.indexOf(a) - PHASES.indexOf(b));
    const phaseFlags = phaseSeq.length ? ["--phases", phaseSeq.join(",")] : [];
    const nextPhase = (cur) => phaseSeq.find((p) => PHASES.indexOf(p) > PHASES.indexOf(cur));
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
        const next = nextPhase(cur) ?? reached;
        const a = cli(STATE, ["advance", "--to", next, "--agent", AGENT_ID, "--note", `runner resume: phase reconciled to ${next}`, ...phaseFlags], withOut);
        if (!a.ok) { log(`[runner] phase reconcile to "${next}" not applied: ${a.error}`); return; }
        cur = next;
      }
    };

    let priorRows = [];
    let resumeSessionId; // adapter session recorded on the stage being resumed (retry_mode: resume only)
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
      // Read the recorded session before reset-from clears it; a resume continues the same conversation.
      resumeSessionId = tracked.find((x) => x.stage === stages[start].name)?.session_id ?? undefined;
      if (reason === "failed") resetFrom(start);
      // reset-from cleared the row's session; write it back now so a crash during the first
      // resumed attempt still leaves the recorded session for the next resume.
      if (resumeSessionId && stages[start].retryMode !== "fresh") {
        cli(TRACKER, ["stage-session", "--workflow", workflow, "--stage", stages[start].name, "--session-id", resumeSessionId], withOut);
      }
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
        rmSync(join(dataDir, ROUTING_FILE), { force: true });
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
    return await stageLoop({ command, resumeSessionId, stages, start, rows, workflow, runScript, adapter, adapterName, fixtureDir, flags, goal,
      repoRoot, skillsRoot, outputPath, dataDir, timeoutMs, nonInteractive, cli, note, withOut, maxCostUsd, resumeMaxContext,
      resetFrom, rollbackPhase, phaseFlags, resuming: command === "resume" });
  } finally {
    releaseLock();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The one stage loop, shared by `run` and `resume`. Executes stages[start..] in order and
 * returns an exit code. ctx carries everything resolved by main().
 */
async function stageLoop(ctx) {
  const { command, resumeSessionId, stages, start, rows, workflow, runScript, adapter, adapterName, fixtureDir, flags, goal, repoRoot, skillsRoot,
    outputPath, dataDir, timeoutMs, nonInteractive, cli, note, withOut, maxCostUsd, resumeMaxContext, resetFrom, rollbackPhase, phaseFlags, resuming } = ctx;
  let first = true;
  // Run-total cost covers this run's transcripts only. A fresh `run` leaves older transcripts in the data dir untouched
  // but does not count them; `resume` and `run --from-stage` continue the same run, so what is already there counts.
  const runTranscripts = new Set(command === "resume" || flags["from-stage"] ? listTranscripts(dataDir) : []);
  const runCostSoFar = () => [...runTranscripts].reduce((a, f) => a + attemptUsage(f).cost, 0);
  const trips = new Map();     // "<stage>|<verdict>" -> round trips used
  const findings = new Map();  // stage -> { files, note, from } review findings to pass as extra input on a re-run
  // Persisted in the data dir so an interrupted run keeps its budget and findings on `resume` / `--from-stage`.
  const routingPath = join(dataDir, ROUTING_FILE);
  const saveRouting = () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(routingPath, JSON.stringify({ trips: Object.fromEntries(trips), findings: Object.fromEntries(findings) }, null, 2) + "\n");
  };
  if (resuming || flags["from-stage"]) {
    try {
      const saved = JSON.parse(readFileSync(routingPath, "utf8"));
      for (const [k, v] of Object.entries(saved.trips ?? {})) trips.set(k, v);
      for (const [k, v] of Object.entries(saved.findings ?? {})) findings.set(k, v);
    } catch { /* nothing recorded */ }
  }
  const visited = new Set();   // stages already invoked in this process (only the first visit may continue a recorded session)
  for (let i = start; i < stages.length; i++) {
    const st = stages[i];
    const tag = `[${i + 1}/${stages.length}] ${st.name}`;
    // A stage re-run after a verdict round trip keeps its row; attempts accumulate across visits.
    let row = rows.find((r) => r.stage === st.name);
    if (row) row.result = "";
    else { row = { stage: st.name, attempts: 0, result: "" }; rows.push(row); }
    const priorAttempts = Number(row.attempts) || 0;
    let routedTo = null;

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
    const fnd = findings.get(st.name);
    const mp = await materializePrompt({ workflow, stage: st.name, repoRoot, skillsRoot, outputPath, dataDir, extraContext,
      extraInputs: fnd?.files, extraNote: fnd?.note });
    if (mp.inputsMissing?.length) log(`${tag}: inputs not found: ${mp.inputsMissing.join(", ")}`);
    const basePrompt = first ? `Goal:\n${goal}\n\n${mp.prompt}` : mp.prompt;
    first = false;
    const model = flags.model ?? mp.model ?? undefined;
    const maxAttempts = st.maxRetries + 1;

    // retry_mode "resume": each retry passes the previous attempt's session id to the adapter.
    // "fresh": never pass one, so every attempt starts a new session. The first attempt of a stage
    // starts fresh too, except when `resume` continues a stage whose tracker row holds a session id.
    const keepSession = st.retryMode !== "fresh";
    let sessionId = i === start && keepSession && !visited.has(st.name) ? resumeSessionId : undefined;
    visited.add(st.name);
    let prompt = basePrompt;
    let stageCost = 0;
    let lastCtx = 0; // context size of the previous attempt's last turn
    // A recorded session being continued (resume / --from-stage): judge it by the newest transcript of this stage.
    if (sessionId) lastCtx = lastStageContext(dataDir, st.name);
    for (let attempt = 1; ; attempt++) {
      // An already-exhausted cap must not buy another attempt (e.g. `resume` after a cost-cap stop with the same cap).
      if (maxCostUsd !== undefined && runCostSoFar() > maxCostUsd) {
        row.result = "stopped: cost cap exceeded";
        cli(STATE, ["release-agent"], withOut); // the stage setup above claimed the token
        return finish(EXIT.COST, rows, `${tag}: cost cap exceeded before attempt ${attempt}: run cost $${runCostSoFar().toFixed(3)} exceeds --max-cost-usd $${maxCostUsd}; raise the cap and use "resume" to continue`, note);
      }
      if (sessionId && lastCtx > resumeMaxContext) {
        log(`${tag}: ${attempt === 1 ? "the recorded session" : `attempt ${attempt - 1}`} ended with a ${Math.round(lastCtx)}-token context (> --resume-max-context ${resumeMaxContext}); ${attempt === 1 ? "starting" : "retrying"} in a fresh session instead of resuming`);
        sessionId = undefined;
        prompt = `${prompt}\n\n## Previous output (fresh session)\nThis is a new session, so you do not remember the previous attempt. Its primary output file ${mp.outputsRequired[0] ?? "(none)"} ends with (last 40 lines):\n${outputExcerpt(mp.outputsRequired[0], repoRoot)}`;
      }
      row.attempts = priorAttempts + attempt;
      log(`${tag} → ${adapterName} (attempt ${attempt}/${maxAttempts})`);
      if (attempt > 1) cli(STATE, ["set-agent", "--agent", AGENT_ID, "--force"], withOut);

      const env = { UWF_DATA_DIR: dataDir };
      if (fixtureDir) env.UWF_FAKE_FIXTURE = join(fixtureDir, `${st.name}.json`);
      const res = await adapter.invokeStage({
        systemPrompt: mp.systemPrompt, prompt, stage: st.name, cwd: repoRoot, inputs: mp.inputs, outputs: mp.outputsRequired,
        model, sessionId, timeoutMs, env, permissions: mp.permissions, dataDir,
        maxTurns: st.maxTurns,
      });
      sessionId = res.sessionId ?? sessionId;
      // Persist right away so the session survives a crash between attempts.
      if (sessionId) cli(TRACKER, ["stage-session", "--workflow", workflow, "--stage", st.name, "--session-id", sessionId], withOut);
      cli(STATE, ["release-agent"], withOut); // 4.

      // Cost cap: checked after every attempt, before anything else can start another one.
      const used = attemptUsage(res.transcriptPath);
      lastCtx = used.ctx;
      stageCost += used.cost;
      if (res.transcriptPath) runTranscripts.add(res.transcriptPath);
      const runCost = runCostSoFar();
      const over = maxCostUsd !== undefined && runCost > maxCostUsd ? `run cost $${runCost.toFixed(3)} exceeds --max-cost-usd $${maxCostUsd}`
        : st.maxCostUsd && stageCost > st.maxCostUsd ? `stage ${st.name} cost $${stageCost.toFixed(3)} exceeds max_cost_usd $${st.maxCostUsd}` : null;
      // The attempt is recorded first (gate verdict, stage status); only then does an exceeded cap stop the run.
      const capStop = (status) => {
        row.result = `${row.result || status}; cost cap exceeded`;
        return finish(EXIT.COST, rows, `${tag}: ${status}; cost cap exceeded after attempt ${attempt}: ${over}; raise the cap and use "resume" to continue`, note);
      };

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
      let prescriptions;
      let verdict = null; // observed verdict when the gate failed on a review outcome
      let gateRan = false;
      if (hitMaxTurns(res)) {
        // The cap is a gate failure: the agent stopped before finishing, so name the cause and the fix.
        failures = [`stage hit the turn cap (max_turns ${st.maxTurns})`];
        prescriptions = [`The stage stopped after ${st.maxTurns} turns without producing ${mp.outputsRequired.join(", ") || "its outputs"}; read only the listed inputs and write the outputs directly.`];
        log(`${tag} gate: NOT RUN (${failures[0]})`);
      } else if (!res.ok) {
        failures = [`adapter error: ${res.error ?? "unknown"}`];
        prescriptions = [`Resolve the adapter error (${res.error ?? "unknown"}) and complete the stage outputs.`];
        log(`${tag} gate: NOT RUN (${failures[0]})`);
      } else {
        const g = cli(runScript, ["--check-gate", st.name], withOut);
        if (g.ok) {
          log(`${tag} gate: PASS`);
          cli(TRACKER, ["stage-complete", "--workflow", workflow, "--stage", st.name, ...sessionArgs(sessionId)], withOut);
          row.result = "passed";
          // The reviewer passing means its findings are addressed: stop feeding them to the re-run stages.
          const had = [...findings].filter(([, v]) => v.from === st.name);
          if (had.length) { for (const [k] of had) findings.delete(k); saveRouting(); }
          const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name, phaseFlags) : null;
          if (adv) row.result += ` (${adv})`;
          if (over) return capStop(`${st.name} passed`);
          break;
        }
        failures = g.data?.failures ?? [g.error];
        verdict = typeof g.data?.verdict === "string" ? g.data.verdict : null;
        gateRan = true;
        prescriptions = Array.isArray(g.data?.prescriptions) && g.data.prescriptions.length ? g.data.prescriptions : failures;
        log(`${tag} gate: FAIL — ${failures.join("; ")}`);
      }
      log(`${tag}   attempt ${attempt}/${maxAttempts}; to fix: ${prescriptions[0]}`);

      if (st.onVerdict && gateRan) {
        // A finding that needs the user's call: neither routing back nor retrying can resolve it.
        const decisions = userDecisions(mp.outputsRequired, repoRoot);
        if (decisions.length) {
          const ids = [];
          for (const d of decisions) {
            const l = cli(QUESTIONS, ["log", "--stage", st.name, "--question", d, "--required", "true"]);
            if (l.ok) ids.push(l.data.question_id);
          }
          row.result = "blocked: user decision needed";
          return finish(EXIT.QUESTIONS, rows, `${tag}: review needs a user decision (${decisions.length} item(s) logged as questions ${ids.join(",")}: ${decisions.join(" | ")}); answer them, then rerun with --from-stage ${st.name}`, note);
        }
        const rule = verdict !== null && Object.hasOwn(st.onVerdict, verdict) ? st.onVerdict[verdict] : null;
        if (rule) {
          const key = `${st.name}|${verdict}`;
          const used = trips.get(key) ?? 0;
          const target = stages.findIndex((x) => x.name === rule.routeTo);
          if (target < 0 || target >= i) throw new UsageError(`on_verdict route_to "${rule.routeTo}" is not an earlier stage than ${st.name}`);
          if (used >= rule.maxRoundTrips) {
            cli(TRACKER, ["stage-fail", "--workflow", workflow, "--stage", st.name, "--note", `verdict ${verdict}: round-trip budget exhausted`, ...sessionArgs(sessionId)], withOut);
            row.result = `failed (verdict ${verdict}, ${used} round trip(s) used)`;
            return finish(EXIT.GATE, rows, `${tag}: verdict "${verdict}" and the round-trip budget to ${rule.routeTo} is exhausted (${used}/${rule.maxRoundTrips}); stopping. Address the findings in ${mp.outputsRequired[0] ?? "the review output"} and rerun with --from-stage ${rule.routeTo}`, note);
          }
          // An exceeded cap stops here too: a routed re-run would spend more.
          if (over) return capStop(`${st.name} verdict ${verdict}; routing to ${rule.routeTo} not started`);
          trips.set(key, used + 1);
          const reviewFile = mp.outputsRequired[0];
          const noteText = `The ${st.name} stage returned verdict "${verdict}" (round trip ${used + 1} of ${rule.maxRoundTrips}). ` +
            `${reviewFile ?? "Its output"} lists review findings to address: read it, fix what it raises, and do not edit the review file itself. ` +
            `The workflow then re-runs forward to ${st.name}.`;
          for (const x of stages.slice(target, i)) findings.set(x.name, { files: reviewFile ? [reviewFile] : [], note: noteText, from: st.name });
          saveRouting();
          log(`${tag}: verdict "${verdict}" → routing back to ${rule.routeTo} (round trip ${used + 1}/${rule.maxRoundTrips}); not retrying ${st.name}`);
          row.result = `${verdict} → ${rule.routeTo} (round trip ${used + 1}/${rule.maxRoundTrips})`;
          rollbackPhase(target);
          resetFrom(target);
          routedTo = target;
          break;
        }
      }

      if (st.onGateFailure === "skip" || st.onGateFailure === "abort") {
        log(gateSummary(st, failures, prescriptions, st.onGateFailure === "skip" ? "marked the stage skipped and continued" : "marked the stage failed and stopped the run"));
      }
      if (st.onGateFailure === "skip") {
        cli(TRACKER, ["stage-skip", "--workflow", workflow, "--stage", st.name, "--note", `gate failed: ${failures.join("; ")}`, ...sessionArgs(sessionId)], withOut);
        row.result = "skipped (gate failed)";
        // A skipped stage still moves the workflow forward, as stage-tracker does.
        const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name, phaseFlags) : null;
        if (adv) row.result += ` (${adv})`;
        if (over) return capStop(`${st.name} skipped (gate failed)`);
        break;
      }
      if (st.onGateFailure === "abort" || attempt >= maxAttempts) {
        cli(TRACKER, ["stage-fail", "--workflow", workflow, "--stage", st.name, "--note", failures.join("; "), ...sessionArgs(sessionId)], withOut);
        row.result = st.onGateFailure === "abort" ? "failed (abort)" : "failed";
        if (over) return capStop(`${st.name} failed`);
        return finish(EXIT.GATE, rows, `${tag}: gate blocked after ${attempt} attempt(s): ${failures.join("; ")}`, note);
      }
      if (over) { row.result = "gate failed"; return capStop(`${st.name} gate failed, retry ${attempt} of ${st.maxRetries} not started`); }
      if (!keepSession) sessionId = undefined; // retry_mode fresh: the next attempt starts a new session
      prompt = retryPrompt({ basePrompt, stage: st.name, retry: attempt, maxRetries: st.maxRetries, prescriptions, transcript: text });
    }
    if (routedTo !== null) { i = routedTo - 1; continue; } // the loop's i++ lands on the routed-to stage
    const doneTrips = [...trips].filter(([k]) => k.startsWith(`${st.name}|`)).reduce((n, [, v]) => n + v, 0);
    if (doneTrips && row.result.startsWith("passed")) row.result += ` after ${doneTrips} round trip(s)`;
  }
  rmSync(routingPath, { force: true });
  return finish(EXIT.OK, rows, "workflow complete", note);

  function advancePhase(target, stageName, phaseFlags) {
    const cur = cli(STATE, ["read"], withOut);
    if (cur.ok && cur.data?.state?.phase === target) return null;
    const a = cli(STATE, ["advance", "--to", target, "--agent", AGENT_ID, "--note", `stage ${stageName} passed`, ...phaseFlags], withOut);
    if (a.ok) return `phase→${target}`;
    log(`[runner] phase "${target}" not applied after ${stageName}: ${a.error}`);
    return `phase ${target} not applied`;
  }
}

/**
 * Review findings that depend on a user decision. Contract: a non-empty `questions` array in a stage's
 * .json output, or a line `needs-user-decision: <text>` (or "needs user decision:") in a text/markdown output.
 */
export function userDecisions(outputs, repoRoot) {
  const found = [];
  for (const o of outputs) {
    let text;
    try { text = readFileSync(resolve(repoRoot, o), "utf8"); } catch { continue; }
    if (o.endsWith(".json")) {
      try {
        const qs = JSON.parse(text)?.questions;
        if (Array.isArray(qs)) for (const q of qs) found.push(typeof q === "string" ? q : (q?.question ?? JSON.stringify(q)));
      } catch { /* not JSON: the schema check reports it */ }
    } else {
      for (const m of text.matchAll(/^[ \t]*needs[- ]user[- ]decision:[ \t]*(.*)$/gim)) found.push(m[1].trim() || "(user decision needed; see the review output)");
    }
  }
  return found.filter((q) => q);
}

/** True when the adapter stopped the stage at its turn cap (fake: error text; claude: result subtype). */
function hitMaxTurns(res) {
  if (/max turns \(\d+\) exceeded|error_max_turns/i.test(res.error ?? "")) return true;
  try { return JSON.parse(JSON.parse(readFileSync(res.transcriptPath, "utf8")).stdout).subtype === "error_max_turns"; } catch { return false; }
}

async function costCommand(flags) {
  if (!flags["data-dir"]) throw new UsageError("--data-dir is required");
  const repoRoot = resolve(flags["repo-root"] ?? OWN_ROOT);
  const skillsRoot = flags.workflow ? pickSkillsRoot(flags, repoRoot, flags.workflow) : undefined;
  try {
    process.stdout.write(await costReport({ dataDir: resolve(flags["data-dir"]), workflow: flags.workflow, repoRoot, skillsRoot, outputPath: flags["output-path"] }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  return EXIT.OK;
}

const sessionArgs = (id) => (id ? ["--session-id", id] : []);

/** `gates --workflow <w>`: print every stage's gate checks with the prescription each would give if it failed. */
function gatesAudit(flags) {
  if (!flags.workflow) throw new UsageError("--workflow is required");
  const repoRoot = resolve(flags["repo-root"] ?? OWN_ROOT);
  const skillsRoot = pickSkillsRoot(flags, repoRoot, flags.workflow);
  const dataDir = mkdtempSync(join(tmpdir(), "uwf-gates-"));
  try {
    const r = runCli(TRACKER, ["gate-prescriptions", "--workflow", flags.workflow, "--output-path", "<output_path>", "--data-dir", dataDir],
      { cwd: repoRoot, env: { UWF_DATA_DIR: dataDir, UWF_SKILLS_ROOT: skillsRoot } });
    if (!r.ok || !Array.isArray(r.data?.stages)) throw new UsageError(`Cannot read gates: ${r.error}`);
    const out = [`workflow: ${flags.workflow} (placeholders: <output_path> = --output-path, <repo> = repo root)`];
    for (const s of r.data.stages) {
      const flagsTxt = [`on_gate_failure: ${s.on_gate_failure}`, `max_retries: ${s.max_retries}`, `retry_mode: ${s.retry_mode}`, `max_turns: ${s.max_turns}`, s.on_verdict ? `on_verdict: ${Object.entries(s.on_verdict).map(([v, r]) => `${v} -> ${r.routeTo} x${r.maxRoundTrips}`).join(", ")}` : null, s.gated ? null : "ungated", s.conditional ? "conditional" : null].filter(Boolean).join(", ");
      out.push("", `${s.stage}  (${flagsTxt})`);
      if (!s.checks.length) out.push("  (no checks)");
      for (const c of s.checks) out.push(`  - ${c.type}: ${c.prescription.split(repoRoot).join("<repo>")}`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return EXIT.OK;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** The gate failure doubles as the retry prompt, so it says exactly what to produce and what happens next. */
export function retryPrompt({ basePrompt, stage, retry, maxRetries, prescriptions, transcript }) {
  const left = maxRetries - retry;
  const next = left <= 0 ? "this is the final attempt; if the gate still fails, the stage will be marked failed and the run stops"
    : left === 1 ? "if the gate fails again you get one more attempt"
    : `if the gate fails again you get ${left} more attempts`;
  const tail = String(transcript ?? "").split(/\r?\n/).slice(-40).join("\n");
  return `${basePrompt}\n\n## Gate failure (retry ${retry} of ${maxRetries})\nThe gate for stage ${stage} did not pass.\n` +
    `${prescriptions.map((p) => `- ${p}`).join("\n")}\n\nWhat happens next: ${next}.\n\n` +
    `## Your previous attempt (last 40 lines)\n${tail}`;
}

/** Last 40 lines of a stage output file (relative paths resolve against the repo root); a note when it is missing. */
function outputExcerpt(path, repoRoot) {
  try { return readFileSync(resolve(repoRoot, path), "utf8").split(/\r?\n/).slice(-40).join("\n"); } catch { return "(file not found)"; }
}

/** One-paragraph human-readable summary for on_gate_failure abort|skip. */
function gateSummary(st, failures, prescriptions, did) {
  return `[runner] Stage ${st.name} gate failed (on_gate_failure: ${st.onGateFailure}). Failures: ${failures.join("; ")}. ` +
    `What would have fixed it: ${prescriptions.join(" ")} The runner ${did}.`;
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

async function dryRunReport({ workflow, stages, total, start, repoRoot, skillsRoot, outputPath, dataDir, goal, flags }) {
  let gateChecks = {};
  try {
    const req = createRequire(join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs"));
    const doc = req("js-yaml").load(readFileSync(join(skillsRoot, ".github", "skills", `uwf-${workflow}`, "stages.yaml"), "utf8"));
    gateChecks = Object.fromEntries((doc.stages ?? []).map((s) => [s.name, s.gate?.checks ?? []]));
  } catch (e) {
    log(`[dry-run] gate checks unavailable: ${e.message}`);
  }
  const out = [`workflow: ${workflow}  stages: ${total}  starting at: ${stages[0]?.name}  output-path: ${outputPath}`, ""];
  for (const [j, st] of stages.entries()) {
    const mp = await materializePrompt({ workflow, stage: st.name, repoRoot, skillsRoot, outputPath, dataDir, extraContext: { goal } });
    out.push(`[${start + j + 1}/${total}] ${st.name}  (agent: ${mp.agentName})`);
    out.push(`  permissions: ${mp.permissions}   model: ${flags.model ?? mp.model ?? "(adapter default)"}`);
    out.push(`  retries: ${st.maxRetries}   retry_mode: ${st.retryMode}   max_turns: ${st.maxTurns}   on_gate_failure: ${st.onGateFailure}   gated: ${st.gated}${st.conditional ? "   conditional" : ""}`);
    if (st.onVerdict) out.push(`  on_verdict: ${Object.entries(st.onVerdict).map(([v, r]) => `${v} -> ${r.routeTo} (max_round_trips ${r.maxRoundTrips})`).join(", ")}`);
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
