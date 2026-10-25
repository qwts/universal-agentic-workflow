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
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "uwf-runner-test-"));
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
  cpSync(FIXTURES, s.fixtures, { recursive: true });
  cpSync(join(ROOT, ".github", "agents"), join(s.repo, ".github", "agents"), { recursive: true });
  // stage-tracker resolves stages.yaml relative to cwd, so the scratch repo needs the persona dir.
  cpSync(join(SKILLS, "uwf-sw_dev"), join(s.repo, ".github", "skills", "uwf-sw_dev"), { recursive: true });
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
