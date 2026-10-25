/**
 * Runner loop tests (fake adapter, offline).
 * Usage: node scripts/uwf-runner/test/runner.test.mjs
 *
 * Fixtures: test/fixtures/sw_dev/<stage>.json. `adr` and `security-plan` have no fixture on
 * purpose: they are conditional and the happy path asserts they are skipped, not invoked.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RUNNER = join(ROOT, "scripts", "uwf-runner", "runner.mjs");
const SKILLS = join(ROOT, ".github", "skills");
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

function skillJson(script, args, s) {
  const r = spawnSync(process.execPath, [join(SKILLS, script), ...args, "--data-dir", s.data], { encoding: "utf8", cwd: s.repo });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function setup() {
  const s = scratch();
  try {
    cpSync(FIXTURES, s.fixtures, { recursive: true });
    cpSync(join(ROOT, ".github", "agents"), join(s.repo, ".github", "agents"), { recursive: true });
    // stage-tracker resolves stages.yaml relative to cwd, so the scratch repo needs the persona dir.
    cpSync(join(SKILLS, "uwf-sw_dev"), join(s.repo, ".github", "skills", "uwf-sw_dev"), { recursive: true });
  } catch (e) {
    rmSync(s.base, { recursive: true, force: true });
    throw e;
  }
  return s;
}

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

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
