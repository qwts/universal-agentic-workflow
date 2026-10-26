/**
 * Runner loop tests (fake adapter, offline).
 * Usage: node scripts/uwf-runner/test/runner.test.mjs
 *
 * Fixtures: test/fixtures/sw_dev/<stage>.json. `adr` and `security-plan` have no fixture on
 * purpose: they are conditional and the happy path asserts they are skipped, not invoked.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { transcriptRow } from "../cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RUNNER = join(ROOT, "scripts", "uwf-runner", "runner.mjs");
const SKILLS = join(ROOT, ".github", "skills");
const TRACKER = join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs");
const FIXTURES = join(HERE, "fixtures", "sw_dev");
const ALL_STAGES = ["intake", "discovery", "requirements", "adr", "risk-plan", "security-plan", "test-plan", "blueprint",
  "work-plan", "implementation", "review", "technical-writing", "acceptance", "snapshot", "retro"];
const SKIPPED = ["adr", "security-plan"];

let failures = 0;

// Every scratch base is registered here and removed on exit, including after an uncaught
// exception, so a failing run does not leave uwf-runner-test-* dirs behind in tmpdir().
const scratchBases = [];
process.on("exit", () => {
  for (const d of scratchBases) rmSync(d, { recursive: true, force: true });
});

function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "uwf-runner-test-"));
  scratchBases.push(base);
  return { base, repo: join(base, "repo"), data: join(base, "data"), fixtures: join(base, "fixtures") };
}

function run(s, extraArgs = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [RUNNER, "run", "--workflow", "sw_dev", "--goal", "Add a widget",
    "--repo-root", s.repo, "--data-dir", s.data, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, UWF_FAKE_FIXTURE_DIR: s.fixtures, UWF_DATA_DIR: "", ...extraEnv },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Same as run(), but concurrent: resolves when the runner exits. */
function runAsync(s, extraArgs = [], extraEnv = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [RUNNER, "run", "--workflow", "sw_dev", "--goal", "Add a widget",
      "--repo-root", s.repo, "--data-dir", s.data, ...extraArgs], {
      env: { ...process.env, UWF_FAKE_FIXTURE_DIR: s.fixtures, UWF_DATA_DIR: "", ...extraEnv },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => res({ code, out, err }));
  });
}

function skillJson(script, args, s) {
  const r = spawnSync(process.execPath, [join(SKILLS, script), ...args, "--data-dir", s.data], { encoding: "utf8", cwd: s.repo });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function setup() {
  const s = scratch();
  try {
    cpSync(FIXTURES, s.fixtures, { recursive: true });
    cpSync(join(ROOT, ".github", "agents"), join(s.repo, ".github", "agents"), { recursive: true });
    // This scratch repo ships its own definitions (a consumer repo that overrides them); the
    // "bare target" cases below use setupBare() instead.
    cpSync(join(SKILLS, "uwf-sw_dev"), join(s.repo, ".github", "skills", "uwf-sw_dev"), { recursive: true });
    // The implementation gate runs verify.mjs from the skills root, which here is this repo's own copy.
    mkdirSync(join(s.repo, ".github", "skills", "uwf-orchestration-engine"), { recursive: true });
    cpSync(join(SKILLS, "uwf-orchestration-engine", "verify.mjs"), join(s.repo, ".github", "skills", "uwf-orchestration-engine", "verify.mjs"));
    // Nothing to build or test in this scratch repo: an explicit empty list says so.
    writeFileSync(join(s.repo, ".uwf.json"), JSON.stringify({ verify: [] }));
  } catch (e) {
    rmSync(s.base, { recursive: true, force: true });
    throw e;
  }
  return s;
}

/** A target repo with no .github/ at all: definitions come from the runner's own root. */
function setupBare() {
  const s = scratch();
  try {
    cpSync(FIXTURES, s.fixtures, { recursive: true });
    mkdirSync(s.repo, { recursive: true });
  } catch (e) {
    rmSync(s.base, { recursive: true, force: true });
    throw e;
  }
  return s;
}

const SELF_COPY_LINE = "using the target repo's own workflow definitions";
const bumpReviewRetries = (file, n) => {
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(  - name: review\n(?:.*\n)*?    max_retries: )\d+$/m, `$1${n}`);
  if (next === text) throw new Error("review max_retries not found in " + file);
  writeFileSync(file, next);
};
const reviewRetries = (out) => out.split("\n").find((l) => l.includes("] review "))
  ? out.split("\n")[out.split("\n").findIndex((l) => l.includes("] review ")) + 2]?.match(/retries: (\d+)/)?.[1] : undefined;

function transcripts(s) {
  const dir = join(s.data, "transcripts");
  return existsSync(dir) ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
}

// 1. Happy path ---------------------------------------------------------------
{
  console.log("# happy path");
  const s = setup();
  try {
    const r = run(s);
    check("exits 0", r.code === 0, r.err.slice(-600));
    for (const st of ALL_STAGES) {
      const line = r.out.split("\n").find((l) => l.startsWith(st + " "));
      const want = SKIPPED.includes(st) ? "skipped" : "passed";
      check(`${st} ${want}`, !!line && line.includes(want), line ?? "(no row)");
    }
    check("stderr trace per stage", r.err.includes("[1/15] intake → fake (attempt 1/3)") && r.err.includes("[3/15] requirements → fake"));
    check("gate verdict line on stderr", r.err.includes("[1/15] intake gate: PASS"));
    const state = skillJson("uwf-state-manager/state.mjs", ["read"], s);
    check("state phase is closed", state?.state?.phase === "closed", JSON.stringify(state?.state));
    check("agent token released", state?.state?.current_agent === null);
    const hist = state?.state?.history ?? [];
    check("workflow_history has phase advances and runner notes",
      hist.some((h) => h.to_phase === "discovery") && hist.some((h) => /runner start/.test(h.note ?? "")) && hist.some((h) => /runner end: complete/.test(h.note ?? "")));
    const tracked = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s);
    const rowsByStage = Object.fromEntries((tracked?.state ?? []).map((r) => [r.stage, r.status]));
    check("stage tracker: 13 passed, adr + security-plan skipped",
      Object.values(rowsByStage).filter((v) => v === "passed").length === 13 && SKIPPED.every((st) => rowsByStage[st] === "skipped"), JSON.stringify(rowsByStage));
    const first = transcripts(s).find((t) => t.prompt.includes("Run the intake stage"));
    const skipLines = r.err.split("\n").filter((l) => l.includes("inputs from skipped stage adr are unavailable"));
    check("skipped-stage inputs warned once per run, not per stage", skipLines.length === 1, JSON.stringify(skipLines));
    check("no per-stage 'inputs not found' for the skipped adr output", !/inputs not found:.*docs\/adr/.test(r.err), r.err.slice(-600));
    check("goal is prepended to the first stage prompt", !!first && first.prompt.startsWith("Goal:\nAdd a widget"));
    check("goal is in the context of later stages", transcripts(s).some((t) => t.prompt.includes("Run the discovery stage") && t.prompt.includes('"goal": "Add a widget"')));
    check("goal is not prepended to later stages", transcripts(s).filter((t) => t.prompt.startsWith("Goal:")).length === 1);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 2. Gate failure exhausts retries --------------------------------------------
{
  console.log("# gate failure");
  const s = setup();
  try {
    const fxPath = join(s.fixtures, "review.json");
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    delete fx.files["tmp/workflow-artifacts/issues-review.md"];
    writeFileSync(fxPath, JSON.stringify(fx));
    const r = run(s);
    check("exits 1", r.code === 1, `${r.code} ${r.err.slice(-400)}`);
    const attempts = [...r.err.matchAll(/\[11\/15\] review → fake \(attempt (\d)\/4\)/g)].map((m) => m[1]);
    check("review attempted 1 + max_retries(3) = 4 times", attempts.join(",") === "1,2,3,4", attempts.join(","));
    check("gate FAIL line names the missing file", /\[11\/15\] review gate: FAIL — .*issues-review\.md/.test(r.err));
    check("no table on non-zero exit", !r.out.includes("attempts"));
    const rev = transcripts(s).filter((t) => t.prompt.includes("Run the review stage"));
    check("retry prompts carry 'Gate failure (retry i of N)'", rev.some((t) => t.prompt.includes("Gate failure (retry 1 of 3)")) && rev.some((t) => t.prompt.includes("Gate failure (retry 3 of 3)")));
    check("retries reuse the same sessionId", new Set(rev.map((t) => t.sessionId)).size === 1);
    check("later stages never ran", !r.err.includes("[12/15]"));
    const tracked = JSON.stringify(skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s));
    check("stage marked failed", tracked.includes("failed"));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 2b. Structured verdict: changes_requested fails the review gate ----------------
{
  console.log("# gate failure: result.json changes_requested");
  const s = setup();
  try {
    const fxPath = join(s.fixtures, "review.json");
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    fx.files["tmp/workflow-artifacts/issues-review.result.json"] =
      JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "high", summary: "x" }] });
    writeFileSync(fxPath, JSON.stringify(fx));
    const r = run(s);
    check("exits 1", r.code === 1, `${r.code} ${r.err.slice(-400)}`);
    check("gate FAIL names the pointer and observed value",
      /review gate: FAIL — .*pointer \/verdict: observed "changes_requested"/.test(r.err), r.err.slice(-500));
    check("later stages never ran", !r.err.includes("[12/15]"));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 2b. Gate fails once, retry passes ------------------------------------------
{
  console.log("# review fails once then passes");
  const s = setup();
  try {
    const fxPath = join(s.fixtures, "review.json");
    const good = JSON.parse(readFileSync(fxPath, "utf8"));
    // Attempt 1 omits the required review output; attempt 2 writes it.
    writeFileSync(fxPath, JSON.stringify({
      attempts: [
        { files: {}, transcript: "review: first pass, output not written" },
        { files: good.files, transcript: good.transcript },
      ],
    }));
    const r = run(s);
    check("exits 0", r.code === 0, `${r.code} ${r.err.slice(-600)}`);
    check("gate FAIL on attempt 1 names the missing file", /\[11\/15\] review gate: FAIL — .*issues-review\.md/.test(r.err));
    check("retry prompt carries the gate failure", transcripts(s).some((t) => t.prompt.includes("Gate failure (retry 1 of 3)")));
    const retry = transcripts(s).map((t) => t.prompt).find((p) => p?.includes("## Gate failure (retry 1 of 3)")) ?? "";
    check("retry prompt has the heading, a prescription naming issues-review.md, and the previous attempt",
      retry.includes("## Gate failure (retry 1 of 3)") && /^- .*issues-review\.md/m.test(retry) && retry.includes("## Your previous attempt")
      && retry.includes("review: first pass, output not written") && retry.includes("What happens next:"), retry.slice(-500));
    check("base prompt comes first", retry.indexOf("## Gate failure") > 200, String(retry.indexOf("## Gate failure")));
    check("trace shows attempts and the first prescription", /review → fake \(attempt 2\/4\)/.test(r.err) && /attempt 1\/4; to fix: .*issues-review\.md/.test(r.err), r.err.slice(-800));
    check("review row shows attempts=2 and passed", /^review\s+2\s+passed/m.test(r.out), r.out.split("\n").find((l) => l.startsWith("review")) ?? "(no row)");
    check("review gate PASS on attempt 2", r.err.includes("[11/15] review gate: PASS"));
    const tracked = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s);
    const review = (tracked?.state ?? []).find((x) => x.stage === "review");
    check("review stage ends passed in the tracker", review?.status === "passed", JSON.stringify(review));
    check("later stages ran", r.err.includes("[15/15] retro"));
    const state = skillJson("uwf-state-manager/state.mjs", ["read"], s);
    check("state phase is closed", state?.state?.phase === "closed", JSON.stringify(state?.state?.phase));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 3. Dry run ---------------------------------------------------------------------
{
  console.log("# dry run");
  const s = setup();
  try {
    const r = run(s, ["--dry-run"]);
    check("exits 0", r.code === 0, r.err.slice(-400));
    check("lists every stage", ALL_STAGES.every((st) => r.out.includes(`] ${st} `)));
    check("prints permissions, outputs and gate checks", r.out.includes("permissions:") && r.out.includes("required outputs:") && r.out.includes("require_contains"));
    check("invokes nothing: no data dir, no artifacts", !existsSync(s.data) && !existsSync(join(s.repo, "tmp")));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 4. Questions ----------------------------------------------------------------
{
  console.log("# questions");
  const block = "QUESTIONS_NEEDED\n\n[Goal]\nQ: Which widget?\nProposed: the blue one\nRequired: true\n";
  const s = setup();
  try {
    const fxPath = join(s.fixtures, "discovery.json");
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    fx.transcript = block;
    writeFileSync(fxPath, JSON.stringify(fx));
    const r = run(s);
    check("required question stops with exit 3", r.code === 3, `${r.code} ${r.err.slice(-300)}`);
    const list = skillJson("uwf-question-protocol/questions.mjs", ["list", "--stage", "discovery"], s);
    check("question logged", JSON.stringify(list).includes("Which widget?"));
    const pending = skillJson("uwf-question-protocol/questions.mjs", ["list", "--stage", "discovery", "--status", "pending"], s);
    const pendingQs = pending?.questions ?? [];
    check("exactly one pending required question", pendingQs.length === 1 && Boolean(pendingQs[0].required), JSON.stringify(pending));
    const tracked = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s);
    const discoveryRow = (tracked?.state ?? []).find((x) => x.stage === "discovery");
    check("discovery stage left active in the tracker", discoveryRow?.status === "active", JSON.stringify(discoveryRow));
    check("no later stage was started", !(tracked?.state ?? []).some((x) => x.stage === "requirements" && x.status !== "pending"));
    const resumed = run(s, ["--from-stage", "discovery"]);
    check("rerun without answer is blocked up front (exit 3)", resumed.code === 3 && resumed.err.includes("pending required question"), resumed.err.slice(-300));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
  const s2 = setup();
  try {
    const fxPath = join(s2.fixtures, "discovery.json");
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    fx.transcript = block;
    writeFileSync(fxPath, JSON.stringify(fx));
    const r = run(s2, ["--non-interactive"]);
    check("--non-interactive records and continues (exit 0)", r.code === 0, `${r.code} ${r.err.slice(-300)}`);
    const list = skillJson("uwf-question-protocol/questions.mjs", ["list", "--stage", "discovery"], s2);
    check("question still recorded", JSON.stringify(list).includes("Which widget?"));
  } finally { rmSync(s2.base, { recursive: true, force: true }); }
}

// 4b. Resume and idempotent re-run -----------------------------------------------
function resume(s, extraArgs = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [RUNNER, "resume", "--workflow", "sw_dev",
    "--repo-root", s.repo, "--data-dir", s.data, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, UWF_FAKE_FIXTURE_DIR: s.fixtures, UWF_DATA_DIR: "", ...extraEnv },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const trackerRows = (s) => skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s)?.state ?? [];
const byStage = (rows) => Object.fromEntries(rows.map((r) => [r.stage, r]));
const resumeNotes = (s) => (skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.history ?? []).filter((h) => /^runner resume:/.test(h.note ?? ""));
/** Make `stage` fail (fixture exits 1) or heal it again. */
function setFixtureExit(s, stage, exitCode) {
  const fxPath = join(s.fixtures, `${stage}.json`);
  const fx = JSON.parse(readFileSync(fxPath, "utf8"));
  if (exitCode === undefined) delete fx.exitCode; else fx.exitCode = exitCode;
  writeFileSync(fxPath, JSON.stringify(fx));
}

{
  console.log("# resume after a failure at stage 5");
  const s = setup();
  try {
    setFixtureExit(s, "risk-plan", 1);
    const r = run(s);
    check("run exits 1 at risk-plan", r.code === 1 && r.err.includes("[5/15] risk-plan"), `${r.code} ${r.err.slice(-300)}`);
    const before = byStage(trackerRows(s));
    check("risk-plan failed in the tracker", before["risk-plan"]?.status === "failed" && before["risk-plan"]?.retry_count > 0, JSON.stringify(before["risk-plan"]));
    check("goal persisted to runner-goal.md", existsSync(join(s.data, "runner-goal.md")) && readFileSync(join(s.data, "runner-goal.md"), "utf8").trim() === "Add a widget");

    setFixtureExit(s, "risk-plan", undefined);
    const rr = resume(s);
    check("resume exits 0", rr.code === 0, `${rr.code} ${rr.err.slice(-500)}`);
    check("resume starts at stage 5", rr.err.includes("[5/15] risk-plan →") && !rr.err.includes("[4/15]") && !rr.err.includes("[1/15]"), rr.err.slice(0, 300));
    check("resume invokes only risk-plan onward", transcripts(s).filter((t) => t.prompt.includes("Run the intake stage")).length === 1);
    const after = byStage(trackerRows(s));
    const untouched = ["intake", "discovery", "requirements", "adr"].every((st) =>
      before[st].started_at === after[st].started_at && before[st].completed_at === after[st].completed_at &&
      before[st].retry_count === after[st].retry_count && before[st].status === after[st].status);
    check("stages 1-4 stage_runs rows untouched", untouched);
    check("risk-plan retries were reset and it passed", after["risk-plan"].status === "passed" && after["risk-plan"].retry_count === 0, JSON.stringify(after["risk-plan"]));
    check("all stages passed or skipped", ALL_STAGES.every((st) => ["passed", "skipped"].includes(after[st].status)));
    check("table lists every stage", ALL_STAGES.every((st) => rr.out.split("\n").some((l) => l.startsWith(st + " "))));
    check("phase closed", skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
    const notes = resumeNotes(s);
    check("one resume note, from=risk-plan reason=failed", notes.length === 1 && notes[0].note === "runner resume: from=risk-plan reason=failed", JSON.stringify(notes));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# resume reconciles a phase left behind by a crash after a stage passed");
  const s = setup();
  try {
    setFixtureExit(s, "risk-plan", 1);
    run(s);
    // Simulate: intake and discovery passed, but the process died before their phase advances landed.
    const rb = skillJson("uwf-state-manager/state.mjs", ["rollback", "--to", "idea", "--agent", "test", "--note", "simulate crash"], s);
    check("test setup: phase rolled back to idea", rb?.state?.phase === "idea", JSON.stringify(rb).slice(0, 200));
    setFixtureExit(s, "risk-plan", undefined);
    const rr = resume(s);
    check("resume after reconcile exits 0", rr.code === 0, `${rr.code} ${rr.err.slice(-500)}`);
    const hist = skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.history ?? [];
    const rec = hist.filter((h) => /^runner resume: phase reconciled to/.test(h.note ?? "")).map((h) => h.to_phase ?? h.note);
    check("phase stepped idea→intake→discovery before resuming", rec.length === 2 && /intake/.test(rec[0]) && /discovery/.test(rec[1]), JSON.stringify(rec));
    check("phase closed at the end", skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// Phase changes the runner logged as rejected.
const rejectedPhaseLines = (err) => err.split("\n").filter((l) => /phase .*not applied/.test(l));

{
  console.log("# resume reconciles a phase left ahead by a crash between reset-from and rollback");
  const s = setup();
  try {
    check("test setup: full run exits 0", run(s).code === 0);
    // Simulate: `run --from-stage review` died after reset-from but before the phase rollback.
    const rs = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["reset-from", "--workflow", "sw_dev", "--stage", "review"], s);
    check("test setup: review reset to pending", byStage(trackerRows(s)).review?.status === "pending", JSON.stringify(rs).slice(0, 200));
    check("test setup: phase still closed", skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
    const rr = resume(s);
    check("resume exits 0", rr.code === 0, `${rr.code} ${rr.err.slice(-500)}`);
    check("no phase change was rejected", !rejectedPhaseLines(rr.err).length, rejectedPhaseLines(rr.err).join(" | "));
    const hist = skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.history ?? [];
    check("phase rolled back to execution before resuming", hist.some((h) => /runner resume: phase reconciled to execution$/.test(h.note ?? "") && h.to_phase === "execution"), JSON.stringify(hist.slice(-6)));
    check("phase closed at the end", skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# --from-stage on the first stage rolls the phase back to idea");
  const s = setup();
  try {
    check("test setup: full run exits 0", run(s).code === 0);
    const r = run(s, ["--from-stage", "intake"]);
    check("rerun from intake exits 0", r.code === 0, `${r.code} ${r.err.slice(-500)}`);
    check("no phase change was rejected", !rejectedPhaseLines(r.err).length, rejectedPhaseLines(r.err).join(" | "));
    const hist = skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.history ?? [];
    check("phase rolled back to idea first", hist.some((h) => /runner: reset from intake$/.test(h.note ?? "") && h.to_phase === "idea"), JSON.stringify(hist.filter((h) => /reset from/.test(h.note ?? ""))));
    check("phase closed at the end", skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# resume notes: one per resume, active stage re-invoked");
  const s = setup();
  try {
    setFixtureExit(s, "risk-plan", 1);
    run(s);
    const r1 = resume(s); // still broken: fails again
    check("resume with fixture still broken exits 1", r1.code === 1, `${r1.code}`);
    // Simulate a crash: the stage was left active.
    skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["stage-start", "--workflow", "sw_dev", "--stage", "risk-plan"], s);
    setFixtureExit(s, "risk-plan", undefined);
    const r2 = resume(s);
    check("resume of an active stage exits 0", r2.code === 0, `${r2.code} ${r2.err.slice(-300)}`);
    check("active stage re-invoked as attempt 1", r2.err.includes("[5/15] risk-plan → fake (attempt 1/"));
    const notes = resumeNotes(s).map((h) => h.note);
    check("workflow_history has exactly one resume note per resume",
      notes.length === 2 && notes[0] === "runner resume: from=risk-plan reason=failed" && notes[1] === "runner resume: from=risk-plan reason=active", JSON.stringify(notes));
    const again = resume(s);
    check("resume on a complete workflow is a no-op (exit 0, no note)", again.code === 0 && resumeNotes(s).length === 2);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# run on a completed data dir");
  const s = setup();
  try {
    check("first run exits 0", run(s).code === 0);
    const before = JSON.stringify(trackerRows(s));
    const r = run(s);
    check("second run exits 0 with the table", r.code === 0 && ALL_STAGES.every((st) => r.out.split("\n").some((l) => l.startsWith(st + " "))), `${r.code} ${r.err.slice(-300)}`);
    check("nothing was invoked", !r.err.includes("→ fake"));
    check("stage_runs untouched", JSON.stringify(trackerRows(s)) === before);
    const forced = run(s, ["--force"]);
    check("--force reinitializes and runs again", forced.code === 0 && forced.err.includes("[1/15] intake → fake"), forced.err.slice(0, 300));
    check("--force produced fresh rows", JSON.stringify(trackerRows(s)) !== before);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# --from-stage review");
  const s = setup();
  try {
    check("full run exits 0", run(s).code === 0);
    const before = byStage(trackerRows(s));
    const r = run(s, ["--from-stage", "review"]);
    check("rerun from review exits 0 and starts at review", r.code === 0 && r.err.includes("[11/15] review →") && !r.err.includes("[10/15]"), `${r.code} ${r.err.slice(0, 300)}`);
    const after = byStage(trackerRows(s));
    check("earlier stages untouched", ALL_STAGES.slice(0, 10).every((st) => before[st].started_at === after[st].started_at && before[st].status === after[st].status));
    check("review and later stages completed again", ALL_STAGES.slice(10).every((st) => after[st].status === "passed" && after[st].started_at !== before[st].started_at));
    const hist = JSON.stringify(skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.history ?? []);
    check("phase rolled back before re-advancing", hist.includes("ROLLBACK") && skillJson("uwf-state-manager/state.mjs", ["read"], s)?.state?.phase === "closed");
    // reset-from alone: pending + a history row per reset stage
    const rf = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["reset-from", "--workflow", "sw_dev", "--stage", "technical-writing"], s);
    check("reset-from resets the stage and every later one to pending",
      JSON.stringify(rf?.reset) === JSON.stringify(["technical-writing", "acceptance", "snapshot", "retro"]) &&
      byStage(rf.state)["retro"].status === "pending" && byStage(rf.state)["review"].status === "passed");
    // Break review's fixture; reset to review and resume must finish all of them.
    const rf2 = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["reset-from", "--workflow", "sw_dev", "--stage", "review"], s);
    check("reset-from review leaves earlier stages alone", byStage(rf2.state)["implementation"].status === "passed" && byStage(rf2.state)["review"].status === "pending");
    const rr = resume(s);
    check("resume completes review..retro", rr.code === 0 && rr.err.includes("[11/15] review →") && rr.err.includes("[15/15] retro"), `${rr.code} ${rr.err.slice(-300)}`);
    check("resume note says pending", resumeNotes(s).some((h) => h.note === "runner resume: from=review reason=pending"));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# resume without a goal file");
  const s = setup();
  try {
    setFixtureExit(s, "risk-plan", 1);
    run(s);
    rmSync(join(s.data, "runner-goal.md"));
    const r = resume(s);
    check("exits 2", r.code === 2 && r.err.includes("No goal recorded"), `${r.code} ${r.err.slice(-300)}`);
    const empty = scratch();
    const r2 = resume(empty);
    check("resume on an empty data dir exits 2", r2.code === 2);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 5. Usage errors -------------------------------------------------------------
{
  console.log("# usage");
  const s = setup();
  try {
    const noGoal = spawnSync(process.execPath, [RUNNER, "run", "--workflow", "sw_dev"], { encoding: "utf8" });
    check("missing --goal exits 2", noGoal.status === 2);
    const bad = spawnSync(process.execPath, [RUNNER, "run", "--workflow", "nope", "--goal", "x"], { encoding: "utf8" });
    check("unknown workflow exits 2", bad.status === 2);
    const badAdapter = spawnSync(process.execPath, [RUNNER, "run", "--workflow", "sw_dev", "--goal", "x", "--adapter", "bogus"], { encoding: "utf8" });
    check("unknown adapter exits 2", badAdapter.status === 2);
    const badStage = run(s, ["--from-stage", "nope"]);
    check("unknown --from-stage exits 2", badStage.code === 2);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 6. Prescriptions: every check type, plus the gates audit ----------------------
{
  console.log("# prescriptions");
  const s = scratch();
  try {
    const skillDir = join(s.repo, ".github", "skills", "uwf-rx");
    mkdirSync(skillDir, { recursive: true });
    const out = "{{output_path}}";
    const checks = [
      { type: "require_non_empty", path: `${out}/missing.md`, label: "missing.md" },
      { type: "require_contains", path: `${out}/present.md`, text: "needle", label: "present.md" },
      { type: "require_files_with_prefix", dir: `${out}/nodir`, prefix: "ADR-" },
      { type: "require_file_matching_pattern", dir: `${out}/nodir`, pattern: "\\.spec\\.mjs$" },
      { type: "run_script", cmd: process.execPath, args: ["-e", "console.error('boom line'); process.exit(3)"], label: "boom" },
      { type: "require_json_field", path: `${out}/r.json`, pointer: "/verdict", equals: "approved", schema: "stage-result" },
      { type: "require_json_field", path: `${out}/r.json`, pointer: "/verdict", in: ["approved", "x"] },
      { type: "require_json_field", path: `${out}/r.json`, pointer: "/a", exists: true },
    ];
    const yamlText = "stages:\n  - name: s1\n    max_retries: 4\n    on_gate_failure: skip\n    gated: true\n    gate:\n      checks:\n" +
      checks.map((c) => `        - ${JSON.stringify(c)}`).join("\n") + "\n";
    writeFileSync(join(skillDir, "stages.yaml"), yamlText);
    mkdirSync(join(s.repo, "out"), { recursive: true });
    writeFileSync(join(s.repo, "out", "present.md"), "no match here");
    mkdirSync(s.data, { recursive: true });
    const r = spawnSync(process.execPath, [join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs"), "check-gate", "--workflow", "rx",
      "--stage", "s1", "--output-path", join(s.repo, "out"), "--data-dir", s.data], { encoding: "utf8", cwd: s.repo });
    let g = null;
    try { g = JSON.parse(r.stdout); } catch { /* reported below */ }
    check("gate fails with JSON", r.status === 1 && g?.passed === false, r.stdout + r.stderr);
    check("prescriptions parallel failures, none empty", Array.isArray(g?.prescriptions) && g.prescriptions.length === checks.length
      && g.failures.length === checks.length && g.prescriptions.every((p) => typeof p === "string" && p.trim().length > 10), JSON.stringify(g?.prescriptions));
    check("policy exposed", g?.on_gate_failure === "skip" && g?.max_retries === 4);
    check("run_script prescription carries the output tail", /exit 0; it currently fails with: .*boom line/.test(g?.prescriptions?.[4] ?? ""), g?.prescriptions?.[4]);
    check("require_json_field variants", /\/verdict equal to "approved" \(schema: stage-result\)/.test(g?.prescriptions?.[5] ?? "")
      && /equal to one of/.test(g?.prescriptions?.[6] ?? "") && /\/a present/.test(g?.prescriptions?.[7] ?? ""), JSON.stringify(g?.prescriptions?.slice(5)));

    const a = spawnSync(process.execPath, [RUNNER, "gates", "--workflow", "sw_dev"], { encoding: "utf8" });
    check("gates audit lists review prescription", a.status === 0 && /^review /m.test(a.stdout) && /issues-review\.md/.test(a.stdout), a.stderr);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// 7. Session continuity: retry_mode, persisted session ids, old-DB migration --------
{
  console.log("# session continuity");
  const s = setup();
  try {
    const rmFixture = () => {
      const fxPath = join(s.fixtures, "review.json");
      const fx = JSON.parse(readFileSync(fxPath, "utf8"));
      delete fx.files["tmp/workflow-artifacts/issues-review.md"];
      writeFileSync(fxPath, JSON.stringify(fx));
    };
    rmFixture();
    // default (resume): one session across all attempts, recorded on the tracker row
    const r1 = run(s);
    const rev1 = transcripts(s).filter((t) => t.prompt.includes("Run the review stage"));
    check("resume mode: 4 attempts share one sessionId", r1.code === 1 && rev1.length === 4 && new Set(rev1.map((t) => t.sessionId)).size === 1, `${r1.code} ${rev1.length}`);
    const row1 = byStage(trackerRows(s)).review;
    check("tracker row carries the session_id of the failed stage", row1?.status === "failed" && row1.session_id === rev1[0].sessionId, JSON.stringify(row1));
    check("passed stages carry a session_id", byStage(trackerRows(s)).intake?.session_id?.startsWith("fake-session-"), JSON.stringify(byStage(trackerRows(s)).intake));
    check("skipped stages have no session_id", byStage(trackerRows(s)).adr?.session_id == null);

    // resume of the failed stage passes the recorded session through
    resume(s);
    const after = transcripts(s).filter((t) => t.prompt.includes("Run the review stage"));
    check("runner resume continues the recorded session", after.length > rev1.length && after.slice(rev1.length).every((t) => t.sessionId === row1.session_id), after.map((t) => t.sessionId).join(","));
    const hist = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s);
    check("tracker row keeps the session_id across the resume's reset-from", byStage(hist?.state ?? []).review?.session_id === row1.session_id, JSON.stringify(byStage(hist?.state ?? []).review));
  } finally { rmSync(s.base, { recursive: true, force: true }); }

  const f = setup();
  try {
    const yamlPath = join(f.repo, ".github", "skills", "uwf-sw_dev", "stages.yaml");
    const text = readFileSync(yamlPath, "utf8");
    const marked = text.replace("    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n", "    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n    retry_mode: fresh\n");
    check("test setup: stages.yaml patched", marked !== text);
    writeFileSync(yamlPath, marked);
    const fxPath = join(f.fixtures, "review.json");
    const fx = JSON.parse(readFileSync(fxPath, "utf8"));
    delete fx.files["tmp/workflow-artifacts/issues-review.md"];
    writeFileSync(fxPath, JSON.stringify(fx));

    const list = skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], f);
    check("--list-stages exposes retryMode (fresh set, default resume)", list?.find((x) => x.name === "review")?.retryMode === "fresh" && list?.find((x) => x.name === "intake")?.retryMode === "resume");
    const r = run(f);
    const rev = transcripts(f).filter((t) => t.prompt.includes("Run the review stage"));
    check("fresh mode: every attempt gets a different sessionId", r.code === 1 && rev.length === 4 && new Set(rev.map((t) => t.sessionId)).size === 4, rev.map((t) => t.sessionId).join(","));
    check("fresh mode: tracker keeps the last attempt's session_id", byStage(trackerRows(f)).review?.session_id === rev[3].sessionId);

    writeFileSync(yamlPath, text.replace("    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n", "    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n    retry_mode: sideways\n"));
    const bad = spawnSync(process.execPath, [join(SKILLS, "uwf-sw_dev", "run.mjs"), "--list-stages", "--data-dir", f.data], { encoding: "utf8", cwd: f.repo });
    check("invalid retry_mode is rejected", bad.status !== 0 && /retry_mode must be one of resume \| fresh/.test(bad.stdout), bad.stdout.slice(0, 200));
  } finally { rmSync(f.base, { recursive: true, force: true }); }

  const o = setup();
  try {
    // A DB created before session_id existed must still open, read, and accept --session-id.
    const req = createRequire(join(SKILLS, "uwf-orchestration-engine", "stage-tracker.mjs"));
    const Database = req("better-sqlite3");
    mkdirSync(o.data, { recursive: true });
    const db = new Database(join(o.data, "uwf-stages.db"));
    db.exec(`CREATE TABLE stage_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, run_as_subagent INTEGER NOT NULL DEFAULT 1,
      started_at TEXT, completed_at TEXT, gate_result TEXT, notes TEXT)`);
    db.prepare("INSERT INTO stage_runs (workflow, stage, status) VALUES ('sw_dev', 'intake', 'passed')").run();
    db.close();
    const rd = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], o);
    const row = rd?.state?.find((x) => x.stage === "intake");
    check("old DB without session_id: read works, column added as null", rd?.ok !== false && row?.status === "passed" && row.session_id === null, JSON.stringify(rd)?.slice(0, 200));
    const st = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["stage-start", "--workflow", "sw_dev", "--stage", "intake", "--session-id", "abc-1"], o);
    check("old DB: stage-start --session-id stores it", st?.state?.find((x) => x.stage === "intake")?.session_id === "abc-1");
  } finally { rmSync(o.base, { recursive: true, force: true }); }
}

// 8. max_turns: plumbing, cap failure, validation; cost command ---------------------
{
  console.log("# max_turns");
  const s = setup();
  try {
    const fxPath = join(s.fixtures, "review.json");
    const good = JSON.parse(readFileSync(fxPath, "utf8"));
    writeFileSync(fxPath, JSON.stringify({
      attempts: [
        { turnsNeeded: 99, files: good.files, transcript: "review: ran out of turns" },
        { turnsNeeded: 5, files: good.files, transcript: good.transcript },
      ],
    }));
    const r = run(s);
    check("exits 0 after the capped attempt is retried", r.code === 0, `${r.code} ${r.err.slice(-500)}`);
    check("cap hit is reported as a gate failure naming max_turns", /review gate: NOT RUN \(stage hit the turn cap \(max_turns 20\)\)/.test(r.err), r.err.slice(-800));
    const retry = transcripts(s).map((t) => t.prompt).find((p) => p?.includes("## Gate failure (retry 1 of 3)")) ?? "";
    check("retry prompt carries the prescriptive text",
      /The stage stopped after 20 turns without producing .*issues-review\.md.*; read only the listed inputs and write the outputs directly\./.test(retry), retry.slice(-600));
    check("review row shows attempts=2 and passed", /^review\s+2\s+passed/m.test(r.out));
    const dry = run(s, ["--dry-run"]);
    check("dry run prints max_turns (implementation 30, review 20)", /implementation[\s\S]*?max_turns: 30/.test(dry.out) && /\] review [\s\S]*?max_turns: 20/.test(dry.out), dry.out.slice(0, 300));
    const gates = spawnSync(process.execPath, [RUNNER, "gates", "--workflow", "sw_dev", "--repo-root", s.repo], { encoding: "utf8" });
    check("gates audit prints max_turns", /max_turns: 30/.test(gates.stdout) && /max_turns: 20/.test(gates.stdout), gates.stdout.slice(0, 300));
  } finally { rmSync(s.base, { recursive: true, force: true }); }

  const f = setup();
  try {
    const yamlPath = join(f.repo, ".github", "skills", "uwf-sw_dev", "stages.yaml");
    const text = readFileSync(yamlPath, "utf8");
    check("stages.yaml declares max_turns", /^    max_turns: 30$/m.test(text));
    const list = skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], f);
    check("--list-stages exposes maxTurns (implementation 30, review 20)", list?.find((x) => x.name === "implementation")?.maxTurns === 30 && list?.find((x) => x.name === "review")?.maxTurns === 20);
    const noKey = text.replace(/^    max_turns: \d+\n/gm, "");
    writeFileSync(yamlPath, noKey);
    const dflt = skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], f);
    check("omitted max_turns defaults to 20 (implementation 30)", dflt?.find((x) => x.name === "intake")?.maxTurns === 20 && dflt?.find((x) => x.name === "implementation")?.maxTurns === 30);
    for (const bad of ["0", "-3", "2.5", "many"]) {
      writeFileSync(yamlPath, text.replace(/^(  - name: review\n(?:.*\n)*?    max_turns: )\d+$/m, `$1${bad}`));
      const r = spawnSync(process.execPath, [join(SKILLS, "uwf-sw_dev", "run.mjs"), "--list-stages", "--data-dir", f.data], { encoding: "utf8", cwd: f.repo });
      check(`invalid max_turns ${bad} is rejected`, r.status !== 0 && /Stage \\"review\\": max_turns must be a positive integer/.test(r.stdout), r.stdout.slice(0, 200));
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }

  const c = scratch();
  try {
    mkdirSync(join(c.data, "transcripts"), { recursive: true });
    cpSync(join(HERE, "fixtures", "transcripts"), join(c.data, "transcripts"), { recursive: true });
    const r = spawnSync(process.execPath, [RUNNER, "cost", "--data-dir", c.data, "--workflow", "sw_dev"], { encoding: "utf8" });
    const row = (n) => r.stdout.split("\n").find((l) => l.startsWith(n)) ?? "";
    check("cost exits 0 and prints a header and TOTAL", r.status === 0 && /^stage\s+turns\s+ctx\/turn/.test(r.stdout) && row("TOTAL").length > 0, r.stderr + r.stdout.slice(0, 300));
    check("cost has a row per stage", ["review", "technical-writing", "retro"].every((n) => row(n)));
    check("review: 26 turns, 70.8K per turn, flagged !50K and !100K", /^review\s+26\s+70\.8K\s+130\.7K/.test(row("review")) && row("review").includes("!50K") && row("review").includes("!100K"), row("review"));
    check("technical-writing and retro are not flagged", !/!\d+K/.test(row("technical-writing")) && !/!\d+K/.test(row("retro")), row("technical-writing") + row("retro"));
    check("thinking tokens and cost are shown", row("review").includes("19098") && row("review").includes("$0.195"), row("review"));
    check("static prompt size column shown with --workflow", /prompt\(ch\/~tok\)/.test(r.stdout) && /\d+\/~\d+/.test(row("review")), r.stdout.slice(0, 400));
    const bare = spawnSync(process.execPath, [RUNNER, "cost", "--data-dir", c.data], { encoding: "utf8" });
    check("cost without --workflow omits the static column", bare.status === 0 && !/prompt\(ch/.test(bare.stdout));
    const none = spawnSync(process.execPath, [RUNNER, "cost", "--data-dir", join(c.base, "nope")], { encoding: "utf8" });
    check("cost on a missing data dir exits 2", none.status === 2, none.stderr);
  } finally { rmSync(c.base, { recursive: true, force: true }); }
}

// 11. Skills root vs repo root -------------------------------------------------
{
  console.log("# bare target: no .github/ in the target repo");
  const s = setupBare();
  try {
    const r = run(s);
    check("sw_dev runs end to end against a bare repo", r.code === 0, r.err.slice(-600));
    for (const st of ALL_STAGES) {
      const line = r.out.split("\n").find((l) => l.startsWith(st + " "));
      check(`bare: ${st} ${SKIPPED.includes(st) ? "skipped" : "passed"}`, !!line && line.includes(SKIPPED.includes(st) ? "skipped" : "passed"), line ?? "(no row)");
    }
    check("bare: nothing was copied into the target (.github absent)", !existsSync(join(s.repo, ".github")));
    check("bare: no target-definitions log line", !r.err.includes(SELF_COPY_LINE));
    check("bare: artifacts landed in the target repo", existsSync(join(s.repo, "tmp", "workflow-artifacts")));
    const prompts = transcripts(s).map((t) => JSON.stringify(t)).join("\n");
    check("bare: no prompt points at <repo>/.github", !prompts.includes(join(s.repo, ".github")));
    const dry = run(setupBareDry(s), ["--dry-run"]);
    check("bare: --dry-run works", dry.code === 0 && ALL_STAGES.every((st) => dry.out.includes(`] ${st} `)), dry.err.slice(-300));
    const gates = spawnSync(process.execPath, [RUNNER, "gates", "--workflow", "sw_dev", "--repo-root", s.repo], { encoding: "utf8" });
    check("bare: gates works", gates.status === 0 && gates.stdout.includes("review"), gates.stderr.slice(-300));
    const cost = spawnSync(process.execPath, [RUNNER, "cost", "--data-dir", s.data, "--workflow", "sw_dev", "--repo-root", s.repo], { encoding: "utf8" });
    check("bare: cost works", cost.status === 0 || /No claude-code transcripts/.test(cost.stderr), cost.stderr.slice(-300));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}
function setupBareDry(s) { return { ...s, data: s.data + "-dry" }; }

{
  console.log("# target ships its own stages.yaml");
  const s = setup();
  try {
    bumpReviewRetries(join(s.repo, ".github", "skills", "uwf-sw_dev", "stages.yaml"), 7);
    const r = run(s, ["--dry-run"]);
    check("target definitions override: review retries 7", r.code === 0 && reviewRetries(r.out) === "7", r.out.slice(0, 300) + r.err.slice(-300));
    check("auto-detect logs one line", r.err.split("\n").filter((l) => l.includes(SELF_COPY_LINE)).length === 1, r.err);
    const own = run(s, ["--dry-run", "--skills-root", ROOT]);
    check("explicit --skills-root beats the target's copy", own.code === 0 && reviewRetries(own.out) === "3" && !own.err.includes(SELF_COPY_LINE), own.out.slice(0, 300) + own.err.slice(-300));
    const viaEnv = run(s, ["--dry-run"], { UWF_SKILLS_ROOT: ROOT });
    check("UWF_SKILLS_ROOT beats the target's copy", viaEnv.code === 0 && reviewRetries(viaEnv.out) === "3", viaEnv.out.slice(0, 300));
    // The target is its own skills root but ships no question-protocol skill: generated commands must
    // still point at a script that exists (this checkout's), not at a missing target-local path.
    const ls = spawnSync(process.execPath, [TRACKER, "list-stages", "--workflow", "sw_dev", "--data-dir", s.data], { encoding: "utf8", cwd: s.repo, env: { ...process.env, UWF_SKILLS_ROOT: s.repo } });
    const cmds = [...ls.stdout.matchAll(/(\/\S*questions\.mjs)/g)].map((m) => m[1]);
    check("partial target: generated skill commands resolve to an existing script", ls.status === 0 && cmds.length > 0 && cmds.every((c) => existsSync(c)), (cmds[0] ?? ls.stderr.slice(-200)));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# --skills-root pointing at a copied skills tree");
  const s = setupBare();
  try {
    const tree = join(s.base, "skills-copy");
    cpSync(join(ROOT, ".github", "skills"), join(tree, ".github", "skills"), { recursive: true, filter: (src) => !src.split("/").includes("node_modules") });
    cpSync(join(ROOT, ".github", "agents"), join(tree, ".github", "agents"), { recursive: true });
    bumpReviewRetries(join(tree, ".github", "skills", "uwf-sw_dev", "stages.yaml"), 9);
    const dry = run(s, ["--dry-run", "--skills-root", tree]);
    check("copied tree: review retries 9 (definitions read from --skills-root)", dry.code === 0 && reviewRetries(dry.out) === "9", dry.out.slice(0, 300) + dry.err.slice(-300));
    const r = run(s, ["--skills-root", tree]);
    check("copied tree: full loop passes against the bare repo", r.code === 0, r.err.slice(-600));
    check("copied tree: target stays bare", !existsSync(join(s.repo, ".github")));
    const missing = run(s, ["--dry-run", "--skills-root", join(s.base, "nope")]);
    check("missing --skills-root exits 2", missing.code === 2, missing.err.slice(-300));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# cost: uncached input counts toward ctx/turn");
  const row = transcriptRow("t.json", { prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 120000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.1 }) });
  check("ctx/turn includes uncached input tokens", row?.perTurn === 60000 && row.flags.includes("!50K"), JSON.stringify(row));
}

{
  console.log("# cost cap, resume context threshold, !MISS");
  const claudeResult = (ctx, cost, extra = {}) => ({ num_turns: 2, total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, iterations: [{ input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0 }], ...extra } });
  // review fails its gate until its result.json appears (attempt 3 here), so attempts 1-2 are retried.
  const reviewFixture = (s, first, later) => {
    s.good ??= JSON.parse(readFileSync(join(s.fixtures, "review.json"), "utf8"));
    const good = s.good;
    const partial = { "tmp/workflow-artifacts/issues-review.md": "# Review\n\nline-one-of-the-first-attempt\n" };
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify({ attempts: [{ files: partial, transcript: "r1", ...first }, { files: partial, transcript: "r2", ...first }, { files: good.files, transcript: "ok", ...later }] }));
  };
  const reviewT = (s) => transcripts(s).filter((t) => t.prompt.includes("Run the review stage"));

  const a = setup();
  try {
    reviewFixture(a, { claudeResult: claudeResult(1000, 0.6) }, { claudeResult: claudeResult(1000, 0.01) });
    const r = run(a, ["--max-cost-usd", "1"]);
    check("run cost cap: exit 4 after the attempt that crosses it", r.code === 4 && reviewT(a).length === 2, `${r.code} ${reviewT(a).length} ${r.err.slice(-400)}`);
    check("run cost cap: message names the cap and the cost", /cost cap exceeded after attempt 2: run cost \$1\.200 exceeds --max-cost-usd \$1/.test(r.err), r.err.slice(-400));
    const ok = run(setup0(a), ["--max-cost-usd", "50"]);
    check("a generous cap does not stop the run", ok.code === 0, `${ok.code} ${ok.err.slice(-300)}`);
    const bad = run(a, ["--max-cost-usd", "free", "--dry-run"]);
    check("invalid --max-cost-usd exits 2", bad.code === 2 && /--max-cost-usd must be a positive number/.test(bad.err), bad.err.slice(-200));
  } finally { rmSync(a.base, { recursive: true, force: true }); }

  const b = setup();
  try {
    const yamlPath = join(b.repo, ".github", "skills", "uwf-sw_dev", "stages.yaml");
    const text = readFileSync(yamlPath, "utf8");
    const marked = text.replace("    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n", "    agent: uwf-sw_dev-reviewer\n    max_retries: 3\n    max_cost_usd: 0.5\n");
    check("test setup: stages.yaml patched with max_cost_usd", marked !== text);
    writeFileSync(yamlPath, marked);
    const list = skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], b);
    check("--list-stages exposes maxCostUsd (set on review, null elsewhere)", list?.find((x) => x.name === "review")?.maxCostUsd === 0.5 && list?.find((x) => x.name === "intake")?.maxCostUsd === null, JSON.stringify(list?.find((x) => x.name === "review")));
    reviewFixture(b, { claudeResult: claudeResult(1000, 0.3) }, {});
    const r = run(b);
    check("stage max_cost_usd: exit 4 after the second attempt (0.6 > 0.5)", r.code === 4 && reviewT(b).length === 2 && /stage review cost \$0\.600 exceeds max_cost_usd \$0\.5/.test(r.err), `${r.code} ${r.err.slice(-300)}`);
    for (const badVal of ["0", "-1", "lots"]) {
      writeFileSync(yamlPath, marked.replace("max_cost_usd: 0.5", `max_cost_usd: ${badVal}`));
      const x = spawnSync(process.execPath, [join(SKILLS, "uwf-sw_dev", "run.mjs"), "--list-stages", "--data-dir", b.data], { encoding: "utf8", cwd: b.repo });
      check(`invalid max_cost_usd ${badVal} is rejected`, x.status !== 0 && /max_cost_usd must be a positive number/.test(x.stdout), x.stdout.slice(0, 200));
    }
  } finally { rmSync(b.base, { recursive: true, force: true }); }

  const c = setup();
  try {
    reviewFixture(c, { claudeResult: claudeResult(150000, 0.01) }, { claudeResult: claudeResult(150000, 0.01) });
    const r = run(c);
    const rev = reviewT(c);
    check("big context: run still completes", r.code === 0 && rev.length === 3, `${r.code} ${rev.length} ${r.err.slice(-300)}`);
    check("big context: log line says why it switched to a fresh session", /attempt 1 ended with a 150000-token context \(> --resume-max-context 100000\); retrying in a fresh session/.test(r.err), r.err.slice(-500));
    check("big context: every retry used a new session", new Set(rev.map((t) => t.sessionId)).size === 3, rev.map((t) => t.sessionId).join(","));
    check("big context: retry prompt carries the prescription and the previous output excerpt", /## Gate failure \(retry 1 of 3\)/.test(rev[1].prompt) && /## Previous output \(fresh session\)[\s\S]*line-one-of-the-first-attempt/.test(rev[1].prompt), rev[1].prompt.slice(-500));
  } finally { rmSync(c.base, { recursive: true, force: true }); }

  const d = setup();
  try {
    reviewFixture(d, { claudeResult: claudeResult(150000, 0.01) }, {});
    const r = run(d, ["--resume-max-context", "200000"]);
    const rev = reviewT(d);
    check("--resume-max-context above the context keeps resuming (one session)", r.code === 0 && new Set(rev.map((t) => t.sessionId)).size === 1 && !r.err.includes("fresh session"), `${r.code} ${rev.map((t) => t.sessionId).join(",")}`);
    reviewFixture(d, { claudeResult: claudeResult(50000, 0.01) }, {});
    const d2 = setup0(d);
    const low = run(d2);
    check("default threshold: a 50K context keeps resuming", low.code === 0 && reviewT(d2).length === 3 && new Set(reviewT(d2).map((t) => t.sessionId)).size === 1 && !low.err.includes("fresh session"), `${low.code} ${reviewT(d2).length} ${low.err.slice(-900)}`);
    const bad = run(d, ["--resume-max-context", "0", "--dry-run"]);
    check("invalid --resume-max-context exits 2", bad.code === 2, bad.err.slice(-200));
  } finally { rmSync(d.base, { recursive: true, force: true }); }

  const g = setup();
  try {
    // resume after a cost-cap stop with the same cap must not spend again
    reviewFixture(g, { claudeResult: claudeResult(1000, 0.6) }, {});
    const r1 = run(g, ["--max-cost-usd", "1"]);
    const before = reviewT(g).length;
    const r2 = resume(g, ["--max-cost-usd", "1"]);
    check("resume with an already-exceeded cap exits 4 without invoking the adapter", r1.code === 4 && r2.code === 4 && reviewT(g).length === before && /cost cap exceeded before attempt 1/.test(r2.err), `${r1.code} ${r2.code} ${r2.err.slice(-300)}`);
    check("the early cap exit releases the agent token", skillJson("uwf-state-manager/state.mjs", ["read"], g)?.state?.current_agent === null, JSON.stringify(skillJson("uwf-state-manager/state.mjs", ["read"], g)?.state?.current_agent));
    const n = transcripts(g).length;
    const r3 = resume(g, ["--max-cost-usd", "50"]);
    check("resume with a raised cap continues", r3.code === 0 && transcripts(g).length > n, `${r3.code} ${r3.err.slice(-300)}`);
  } finally { rmSync(g.base, { recursive: true, force: true }); }

  const h = setup();
  try {
    // a recorded session whose last turn was 150K is not resumed by `resume`
    reviewFixture(h, { claudeResult: claudeResult(150000, 0.01) }, { claudeResult: claudeResult(150000, 0.01) });
    const fx = JSON.parse(readFileSync(join(h.fixtures, "review.json"), "utf8"));
    const never = { files: { "tmp/workflow-artifacts/issues-review.md": "# Review\n\nline-one-of-the-first-attempt\n" }, transcript: "x", claudeResult: claudeResult(150000, 0.01) };
    writeFileSync(join(h.fixtures, "review.json"), JSON.stringify({ attempts: [never] }));
    const r1 = run(h);
    const recorded = byStage(trackerRows(h)).review?.session_id;
    const n = reviewT(h).length;
    writeFileSync(join(h.fixtures, "review.json"), JSON.stringify(fx.attempts[2]));
    const r2 = resume(h);
    const added = reviewT(h).slice(n);
    check("setup: review failed with a recorded session", r1.code === 1 && !!recorded, `${r1.code} ${recorded}`);
    check("resume starts the oversized stage in a fresh session", r2.code === 0 && added.length === 1 && added[0].sessionId !== recorded && /the recorded session ended with a 150000-token context/.test(r2.err), `${r2.code} ${added.map((t) => t.sessionId)} ${recorded} ${r2.err.slice(-400)}`);
    check("the fresh start carries the previous-output excerpt", /## Previous output \(fresh session\)[\s\S]*line-one-of-the-first-attempt/.test(added[0]?.prompt ?? ""), (added[0]?.prompt ?? "").slice(-300));
  } finally { rmSync(h.base, { recursive: true, force: true }); }

  const e = setup();
  try {
    // 2. gate passes on the attempt that crosses the cap: stage is recorded passed, then the run stops with 4
    const good = JSON.parse(readFileSync(join(e.fixtures, "review.json"), "utf8"));
    writeFileSync(join(e.fixtures, "review.json"), JSON.stringify({ ...good, claudeResult: claudeResult(1000, 2) }));
    const r = run(e, ["--max-cost-usd", "1"]);
    check("gate-passing attempt over the cap: exit 4, stage recorded passed, message names the status", r.code === 4 && byStage(trackerRows(e)).review?.status === "passed" && /review passed; cost cap exceeded/.test(r.err), `${r.code} ${r.err.slice(-400)}`);
    check("no further stage starts after the cap", !r.err.includes("] technical-writing") && byStage(trackerRows(e)).implementation?.status === "passed" && !trackerRows(e).some((x) => x.stage === "retro" && x.status === "passed"), r.err.slice(-300));
  } finally { rmSync(e.base, { recursive: true, force: true }); }

  const f = setup();
  try {
    // 1. stale transcripts from an earlier run in a reused data dir do not count toward a fresh run
    mkdirSync(join(f.data, "transcripts"), { recursive: true });
    const stale = JSON.stringify({ prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 }, total_cost_usd: 5 }) });
    writeFileSync(join(f.data, "transcripts", "stale.json"), stale);
    const r = run(f, ["--max-cost-usd", "0.5"]);
    check("fresh run ignores stale transcripts in the data dir", r.code === 0, `${r.code} ${r.err.slice(-300)}`);
    // run --from-stage continues the same run: what is already in the data dir counts
    const again = run(f, ["--from-stage", "retro", "--max-cost-usd", "0.5"]);
    check("run --from-stage counts the transcripts already present (exit 4)", again.code === 4 && /run cost \$5\.000 exceeds --max-cost-usd \$0\.5/.test(again.err), `${again.code} ${again.err.slice(-300)}`);
  } finally { rmSync(f.base, { recursive: true, force: true }); }

  const miss = transcriptRow("t.json", { prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200000 }, total_cost_usd: 0.5 }) });
  const hit = transcriptRow("t.json", { prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 1000 }, total_cost_usd: 0.1 }) });
  const first = transcriptRow("t.json", { prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 }, total_cost_usd: 0.05 }) });
  check("a small first write (write > read but under 50K) is not flagged !MISS", first && !first.flags.includes("!MISS"), JSON.stringify(first?.flags));
  check("transcriptRow flags !MISS when cache_write exceeds cache_read and 50K", miss?.flags.includes("!MISS") && !hit?.flags.includes("!MISS"), JSON.stringify([miss?.flags, hit?.flags]));
  const m = scratch();
  try {
    mkdirSync(join(m.data, "transcripts"), { recursive: true });
    writeFileSync(join(m.data, "transcripts", "a.json"), JSON.stringify({ prompt: "Run the review stage for the sw_dev workflow.", stdout: JSON.stringify({ num_turns: 2, usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200000 }, total_cost_usd: 0.5 }) }));
    const cr = spawnSync(process.execPath, [RUNNER, "cost", "--data-dir", m.data], { encoding: "utf8" });
    check("cost report shows !MISS and explains it in the footer", cr.status === 0 && /^review .*!MISS/m.test(cr.stdout) && /!MISS = cache_write above both cache_read and 50K/.test(cr.stdout), cr.stdout + cr.stderr);
  } finally { rmSync(m.base, { recursive: true, force: true }); }
}
// reuse a scratch (fresh data dir, same fixtures/repo) for a second run
function setup0(s) { return { ...s, data: s.data + "-2" }; }

// 12. on_verdict: route a wrong verdict back instead of retrying the reviewer ---------
const RV_MD = "tmp/workflow-artifacts/issues-review.md";
const RV_JSON = "tmp/workflow-artifacts/issues-review.result.json";
const reviewPass = (s) => JSON.parse(readFileSync(join(s.fixtures, "review.json"), "utf8"));
const changesRequested = (extra = {}) => ({
  files: {
    [RV_MD]: "# Review\n\nverdict: changes_requested\n\n- high: the widget is never registered\n",
    [RV_JSON]: JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "high", summary: "widget is never registered" }], ...extra }) + "\n",
  },
  transcript: "review: changes requested",
});
const countInvocations = (s, stage) => transcripts(s).filter((t) => t.prompt.includes(`Run the ${stage} stage`));

{
  console.log("# on_verdict: changes_requested routes to implementation, then passes");
  const s = setup();
  try {
    const good = reviewPass(s);
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify({ attempts: [changesRequested(), { files: good.files, transcript: good.transcript }] }));
    const r = run(s);
    check("exits 0", r.code === 0, `${r.code} ${r.err.slice(-600)}`);
    check("routing line names the verdict, the target and the round trip",
      /\[11\/15\] review: verdict "changes_requested" → routing back to implementation \(round trip 1\/2\)/.test(r.err), r.err.slice(-800));
    const impl = countInvocations(s, "implementation");
    const rev = countInvocations(s, "review");
    check("implementation ran twice, review twice, work-plan once", impl.length === 2 && rev.length === 2 && countInvocations(s, "work-plan").length === 1, `${impl.length}/${rev.length}`);
    check("the review stage was not retried (no Gate failure prompt)", !rev.some((t) => t.prompt.includes("## Gate failure")));
    check("first implementation prompt has no findings; the second has the review file and the note",
      !impl[0].prompt.includes("Review findings to address") && impl[1].prompt.includes("## Review findings to address")
      && impl[1].prompt.includes("issues-review.md") && /review findings to address/.test(impl[1].prompt) && impl[1].prompt.includes("verdict: changes_requested"), impl[1]?.prompt.slice(-900));
    check("the reviewer itself is not given its own output as an extra input", !rev[1].prompt.includes("## Review findings to address"));
    check("table shows the extra attempts", /^implementation\s+2\s+passed/m.test(r.out) && /^review\s+2\s+passed.*1 round trip/m.test(r.out), r.out);
    const state = skillJson("uwf-state-manager/state.mjs", ["read"], s);
    check("phase ends closed after the round trip", state?.state?.phase === "closed", JSON.stringify(state?.state?.phase));
    check("phase was rolled back to planning when routing", (state?.state?.history ?? []).some((h) => h.to_phase === "planning" && /reset from implementation/.test(h.note ?? "")));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# on_verdict: round-trip budget exhausted");
  const s = setup();
  try {
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify(changesRequested()));
    const r = run(s);
    check("exits 1", r.code === 1, `${r.code} ${r.err.slice(-600)}`);
    check("log line says the budget is exhausted", /round-trip budget to implementation is exhausted \(2\/2\)/.test(r.err), r.err.slice(-600));
    check("implementation ran 3 times and review 3 times (1 + 2 round trips)", countInvocations(s, "implementation").length === 3 && countInvocations(s, "review").length === 3);
    check("later stages never ran", !r.err.includes("[12/15]"));
    check("no table on non-zero exit", !r.out.includes("attempts"));
    const tracked = skillJson("uwf-orchestration-engine/stage-tracker.mjs", ["read", "--workflow", "sw_dev"], s);
    check("review marked failed", (tracked?.state ?? []).find((x) => x.stage === "review")?.status === "failed");
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# on_verdict: a finding that needs a user decision stops with exit 3");
  const variants = {
    "questions array in result.json": (fx) => { const c = changesRequested({ questions: ["Should the widget be public API?"] }); return c; },
    "needs-user-decision line in markdown": () => {
      const c = changesRequested();
      c.files[RV_MD] += "\nneeds-user-decision: Should the widget be public API?\n";
      return c;
    },
  };
  for (const [label, make] of Object.entries(variants)) {
    const s = setup();
    try {
      writeFileSync(join(s.fixtures, "review.json"), JSON.stringify(make()));
      const r = run(s);
      check(`${label}: exits 3`, r.code === 3, `${r.code} ${r.err.slice(-500)}`);
      check(`${label}: names the decision and the rerun hint`, r.err.includes("review needs a user decision") && r.err.includes("Should the widget be public API?") && r.err.includes("--from-stage review"), r.err.slice(-500));
      check(`${label}: no routing and no retry`, countInvocations(s, "implementation").length === 1 && countInvocations(s, "review").length === 1);
      const q = skillJson("uwf-question-protocol/questions.mjs", ["list", "--stage", "review", "--status", "pending"], s);
      check(`${label}: the question is logged`, JSON.stringify(q).includes("Should the widget be public API?"), JSON.stringify(q).slice(0, 300));
    } finally { rmSync(s.base, { recursive: true, force: true }); }
  }
}

{
  console.log("# on_verdict: stages.yaml validation");
  const f = setup();
  try {
    const yamlPath = join(f.repo, ".github", "skills", "uwf-sw_dev", "stages.yaml");
    const text = readFileSync(yamlPath, "utf8");
    const line = "      changes_requested: { route_to: implementation, max_round_trips: 2 }";
    check("test setup: stages.yaml declares on_verdict on review", text.includes(line));
    const list = skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], f);
    check("--list-stages exposes onVerdict for review and null elsewhere",
      JSON.stringify(list?.find((x) => x.name === "review")?.onVerdict) === JSON.stringify({ changes_requested: { routeTo: "implementation", maxRoundTrips: 2 } })
      && list?.find((x) => x.name === "intake")?.onVerdict === null, JSON.stringify(list?.find((x) => x.name === "review")?.onVerdict));
    writeFileSync(yamlPath, text.replace(line, "      changes_requested: { route_to: implementation }"));
    check("max_round_trips defaults to 2", skillJson("uwf-sw_dev/run.mjs", ["--list-stages"], f)?.find((x) => x.name === "review")?.onVerdict?.changes_requested?.maxRoundTrips === 2);
    const bad = {
      "unknown route_to": ["{ route_to: nowhere, max_round_trips: 2 }", /route_to \\"nowhere\\" is not a stage/],
      "later route_to": ["{ route_to: acceptance, max_round_trips: 2 }", /must name an earlier stage/],
      "self route_to": ["{ route_to: review, max_round_trips: 2 }", /must name an earlier stage/],
      "max_round_trips 0": ["{ route_to: implementation, max_round_trips: 0 }", /max_round_trips must be a positive integer/],
      "rule not a map": ["implementation", /must be a map with route_to/],
    };
    for (const [label, [rule, re]] of Object.entries(bad)) {
      writeFileSync(yamlPath, text.replace(line, `      changes_requested: ${rule}`));
      const r = spawnSync(process.execPath, [join(SKILLS, "uwf-sw_dev", "run.mjs"), "--list-stages", "--data-dir", f.data], { encoding: "utf8", cwd: f.repo });
      check(`${label} is rejected`, r.status !== 0 && re.test(r.stdout), r.stdout.slice(0, 300));
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
}

{
  console.log("# prescriptions: a wrong verdict is an outcome, a missing one is asked for");
  const s = setup();
  try {
    const art = join(s.repo, "tmp", "workflow-artifacts");
    mkdirSync(art, { recursive: true });
    const gate = () => {
      const r = spawnSync(process.execPath, [join(SKILLS, "uwf-sw_dev", "run.mjs"), "--check-gate", "review", "--data-dir", s.data], { encoding: "utf8", cwd: s.repo });
      try { return JSON.parse(r.stdout); } catch { return { failures: [], prescriptions: [r.stdout + r.stderr] }; }
    };
    const cr = changesRequested();
    writeFileSync(join(art, "issues-review.md"), cr.files[RV_MD]);
    writeFileSync(join(art, "issues-review.result.json"), cr.files[RV_JSON]);
    const wrong = gate();
    const pres = (wrong.prescriptions ?? []).join("\n");
    check("wrong verdict: gate fails and reports the observed verdict", wrong.passed === false && wrong.verdict === "changes_requested", JSON.stringify(wrong).slice(0, 300));
    check("wrong verdict: prescriptions state the observed verdict and call it a review outcome",
      pres.includes('records verdict "changes_requested"') && pres.includes("review outcome") && pres.includes("not something to rewrite"), pres);
    check("wrong verdict: no 'Include the text verdict: approved' prescription", !/Include the text "verdict: approved"/.test(pres) && !/equal to "approved"/.test(pres), pres);
    writeFileSync(join(art, "issues-review.md"), "# Review\n\nNo verdict line here.\n");
    writeFileSync(join(art, "issues-review.result.json"), JSON.stringify({ findings: [] }));
    const missing = gate();
    check("missing verdict: still asks for the text", (missing.prescriptions ?? []).some((p) => /Include the text "verdict: approved" in /.test(p)), JSON.stringify(missing.prescriptions));
    check("missing verdict: carries no routable verdict", missing.verdict === undefined);
    const audit = spawnSync(process.execPath, [RUNNER, "gates", "--workflow", "sw_dev", "--repo-root", s.repo], { encoding: "utf8" });
    check("gates audit keeps the generic prescription and lists on_verdict", /Include the text "verdict: approved"/.test(audit.stdout) && /on_verdict: changes_requested -> implementation x2/.test(audit.stdout), audit.stdout.slice(0, 200));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# on_verdict: a schema-invalid changes_requested result is retried, not routed");
  const s = setup();
  try {
    const bad = changesRequested();
    bad.files[RV_JSON] = JSON.stringify({ verdict: "changes_requested" }) + "\n"; // findings missing
    const good = reviewPass(s);
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify({ attempts: [bad, { files: good.files, transcript: good.transcript }] }));
    const r = run(s);
    check("exits 0", r.code === 0, `${r.code} ${r.err.slice(-600)}`);
    check("no routing happened", !r.err.includes("routing back") && countInvocations(s, "implementation").length === 1, r.err.slice(-600));
    const rev = countInvocations(s, "review");
    check("review was retried with the schema prescription", rev.length === 2 && rev[1].prompt.includes("## Gate failure (retry 1 of 3)") && /\/findings is required/.test(rev[1].prompt), rev[1]?.prompt.slice(-700));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# on_verdict: routing context survives an interrupted run (resume)");
  const s = setup();
  try {
    const good = reviewPass(s);
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify({ attempts: [changesRequested(), changesRequested()] }));
    const impl = JSON.parse(readFileSync(join(s.fixtures, "implementation.json"), "utf8"));
    // 1st implementation ok; every later one fails (adapter error) so the routed re-run exhausts its attempts.
    writeFileSync(join(s.fixtures, "implementation.json"), JSON.stringify({ attempts: [impl, { ...impl, exitCode: 1 }] }));
    const r1 = run(s);
    check("first run exits 1 (routed implementation failed)", r1.code === 1 && r1.err.includes("routing back to implementation (round trip 1/2)"), `${r1.code} ${r1.err.slice(-500)}`);
    const saved = (() => { try { return JSON.parse(readFileSync(join(s.data, "runner-routing.json"), "utf8")); } catch { return null; } })();
    check("routing state is persisted", saved?.trips?.["review|changes_requested"] === 1 && !!saved?.findings?.implementation, JSON.stringify(saved));
    // Repair the fixtures: implementation works, the reviewer keeps asking for changes.
    writeFileSync(join(s.fixtures, "implementation.json"), JSON.stringify(impl));
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify(changesRequested()));
    const dir = join(s.data, "transcripts");
    const before = new Set(readdirSync(dir));
    const r2 = spawnSync(process.execPath, [RUNNER, "resume", "--workflow", "sw_dev", "--repo-root", s.repo, "--data-dir", s.data], {
      encoding: "utf8", env: { ...process.env, UWF_FAKE_FIXTURE_DIR: s.fixtures, UWF_DATA_DIR: "" } });
    const fresh = readdirSync(dir).filter((f) => !before.has(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
    const firstImpl = fresh.find((t) => t.prompt.includes("Run the implementation stage"));
    check("resumed implementation prompt carries the review findings", !!firstImpl && firstImpl.prompt.includes("## Review findings to address") && firstImpl.prompt.includes("issues-review.md"), firstImpl?.prompt.slice(-500));
    check("budget carried over: resume routes as round trip 2/2, never 1/2", r2.stderr.includes("(round trip 2/2)") && !r2.stderr.includes("(round trip 1/2)"), r2.stderr.slice(-700));
    check("then exhausts at 2/2 and exits 1", r2.status === 1 && /budget to implementation is exhausted \(2\/2\)/.test(r2.stderr), `${r2.status} ${r2.stderr.slice(-500)}`);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# on_verdict: changes_requested JSON but markdown without a verdict line is retried, not routed");
  const s = setup();
  try {
    const bad = changesRequested();
    bad.files[RV_MD] = "# Review\n\nFindings below, no verdict line.\n";
    const good = reviewPass(s);
    writeFileSync(join(s.fixtures, "review.json"), JSON.stringify({ attempts: [bad, { files: good.files, transcript: good.transcript }] }));
    const r = run(s);
    check("exits 0", r.code === 0, `${r.code} ${r.err.slice(-600)}`);
    const rev = countInvocations(s, "review");
    check("no routing; implementation ran once", !r.err.includes("routing back") && countInvocations(s, "implementation").length === 1, r.err.slice(-600));
    check("review retried with the include-the-text prescription", rev.length === 2 && rev[1].prompt.includes("## Gate failure (retry 1 of 3)") && rev[1].prompt.includes('Include the text "verdict: approved"'), rev[1]?.prompt.slice(-700));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

{
  console.log("# run.lock: one run per data dir");
  const s = setup();
  try {
    mkdirSync(s.data, { recursive: true });
    const lock = join(s.data, "run.lock");
    writeFileSync(lock, JSON.stringify({ runId: "other-run-1", pid: process.pid, workflow: "sw_dev" }));
    const r = run(s);
    check("live lock: exits 2", r.code === 2, `${r.code} ${r.err.slice(-400)}`);
    check("live lock: names the other run and --data-dir", r.err.includes("other-run-1") && r.err.includes("distinct --data-dir"), r.err.slice(-400));
    check("live lock: lock left untouched", JSON.parse(readFileSync(lock, "utf8")).runId === "other-run-1");
    check("live lock: nothing ran", transcripts(s).length === 0);
    // A dead pid: spawn a short-lived child and reuse its pid. The runner never takes a lock over by itself.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(lock, JSON.stringify({ runId: "crashed-run", pid: dead.pid ?? 2147483646, workflow: "sw_dev" }));
    const r2 = run(s);
    check("crashed-run lock: exits 2 and names --unlock", r2.code === 2 && r2.err.includes("not running") && r2.err.includes("--unlock"), `${r2.code} ${r2.err.slice(-400)}`);
    check("crashed-run lock: left in place", existsSync(lock));
    const r2b = run(s, ["--unlock"]);
    check("crashed-run lock + --unlock: replaced and run completes", r2b.code === 0, `${r2b.code} ${r2b.err.slice(-400)}`);
    check("lock removed on exit", !existsSync(lock));
    // Unreadable metadata (an owner still writing, or garbage) is waited on while young, never removed.
    writeFileSync(lock, "");
    const r3 = run(s, ["--unlock"]);
    check("young unreadable lock: exits 2 even with --unlock", r3.code === 2 && r3.err.includes("another run is starting"), `${r3.code} ${r3.err.slice(-400)}`);
    check("young unreadable lock: left in place", existsSync(lock));
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const r4 = run(s);
    check("old unreadable lock: exits 2 without --unlock", r4.code === 2 && r4.err.includes("--unlock"), `${r4.code} ${r4.err.slice(-400)}`);
    const r4b = run(s, ["--unlock"]);
    check("old unreadable lock + --unlock: replaced and run completes", r4b.code === 0, `${r4b.code} ${r4b.err.slice(-400)}`);
    check("lock removed on exit (2)", !existsSync(lock));
    // Contention over a crashed lock without --unlock: nobody takes it over, nothing is removed or left behind.
    writeFileSync(lock, JSON.stringify({ runId: "crashed-run-2", pid: dead.pid ?? 2147483646, workflow: "sw_dev" }));
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => runAsync(s)));
    check("contended crashed lock: all six refused with exit 2", outcomes.every((o) => o.code === 2 && o.err.includes("--unlock")), outcomes.map((o) => `${o.code}`).join(","));
    check("contended crashed lock: lock untouched", JSON.parse(readFileSync(lock, "utf8")).runId === "crashed-run-2");
    check("contended crashed lock: no temp files left behind", readdirSync(s.data).filter((f) => f.startsWith("run.lock")).length === 1, readdirSync(s.data).join(","));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

// Model selection: --model > stage model > adapter default (claude-code only) ------------------
{
  console.log("# model selection");
  const s = setup();
  try {
    const dflt = run(s, ["--adapter", "claude-code", "--dry-run"]);
    check("claude-code dry-run shows the Sonnet default", dflt.code === 0 && dflt.out.includes("model: claude-sonnet-5-5 (default for claude-code; pass --model to override)"), dflt.out.slice(0, 600));
    check("claude-code dry-run never says (adapter default)", !dflt.out.includes("(adapter default)"));
    const over = run(s, ["--adapter", "claude-code", "--model", "claude-test-x", "--dry-run"]);
    check("--model wins over the default", over.out.includes("model: claude-test-x (--model)") && !over.out.includes("claude-sonnet-5-5"), over.out.slice(0, 600));
    const fake = run(s, ["--dry-run"]);
    check("fake adapter keeps the adapter default", fake.out.includes("model: (adapter default)") && !fake.out.includes("claude-sonnet-5-5"));
    const cap = run(s, ["--dry-run", "--max-cost-usd", "5"]);
    check("dry-run banner states the cap is a stop-after check", /stop-after check/.test(cap.out) && /single attempt can exceed it/.test(cap.out), cap.out.slice(0, 400));
    check("no cap, no cap note", !fake.out.includes("stop-after"));

    // A real claude-code run with a fake `claude` on PATH: the run log names the resolved model.
    const bin = join(s.base, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nprocess.stderr.write("fake claude\\n"); process.exit(1);\n`, { mode: 0o755 });
    const env = { UWF_FAKE_FIXTURE_DIR: "", PATH: `${bin}:${process.env.PATH ?? ""}` };
    const live = run(s, ["--adapter", "claude-code", "--timeout-ms", "20000"], env);
    check("claude-code run logs the Sonnet default once", live.err.includes("model: claude-sonnet-5-5 (default for claude-code; pass --model to override)"), live.err.slice(0, 600));
    rmSync(s.data, { recursive: true, force: true });
    const live2 = run(s, ["--adapter", "claude-code", "--model", "claude-test-x", "--timeout-ms", "20000"], env);
    check("claude-code run with --model logs that model", live2.err.includes("model: claude-test-x (--model)") && !live2.err.includes("claude-sonnet-5-5"), live2.err.slice(0, 600));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
