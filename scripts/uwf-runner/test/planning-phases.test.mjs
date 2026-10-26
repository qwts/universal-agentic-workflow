/**
 * Runner phase tracking for a planning-only workflow (fake adapter, offline).
 * Usage: node scripts/uwf-runner/test/planning-phases.test.mjs
 *
 * project_manager has no execution phase: its stages advance intake -> discovery -> planning ->
 * acceptance -> snapshot -> closed. The runner must apply every one of those advances (the state
 * manager is told the workflow's phase sequence) and log no "not applied" line.
 * Fixtures are generated here; the scratch repo carries a copy of the workflow definition whose
 * issue-state-population gate (which needs the tracked SQLite issues DB) is replaced by a file check.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const RUNNER = join(ROOT, "scripts", "uwf-runner", "runner.mjs");
const SKILLS = join(ROOT, ".github", "skills");
const WF = "project_manager";
const ART = "tmp/workflow-artifacts";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}

const base = mkdtempSync(join(tmpdir(), "uwf-planning-phases-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));
const repo = join(base, "repo");
const data = join(base, "data");
const fixtures = join(base, "fixtures");
mkdirSync(fixtures, { recursive: true });

cpSync(join(ROOT, ".github", "agents"), join(repo, ".github", "agents"), { recursive: true });
const wfDir = join(repo, ".github", "skills", `uwf-${WF}`);
cpSync(join(SKILLS, `uwf-${WF}`), wfDir, { recursive: true });
const yamlPath = join(wfDir, "stages.yaml");
const yamlText = readFileSync(yamlPath, "utf8");
const patched = yamlText.replace(/        - type: run_script\n          cmd: .*\n          label: "SQLite issues table has open records"/,
  `        - type: require_non_empty\n          path: "{{output_path}}/issues-backlog.md"\n          label: "issues-backlog.md"`);
if (patched === yamlText) throw new Error("issue-state-population gate not found in project_manager stages.yaml");
writeFileSync(yamlPath, patched);

const fx = (files) => ({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`${ART}/${k}`, v])), transcript: "done", delayMs: 0 });
const put = (stage, files) => writeFileSync(join(fixtures, `${stage}.json`), JSON.stringify(fx(files)));
const body = "Fixture content for the runner test.\n";
put("intake", { "project-intake.md": `# Intake\n\nGoal\n\nNon-goals\n\nConstraints\n\nSuccess metrics\n\nStakeholders\n\nTarget environment\n\nRisk tolerance\n\nWork-breakdown strategy\n\n${body}` });
put("discovery", { "project-discovery.md": `# Discovery\n\n${body}` });
put("requirements", { "project-requirements.md": `# Requirements\n\n${body}` });
put("risk-plan", { "project-risk-plan.md": `# Risks\n\n${body}` });
put("test-plan", { "project-test-plan.md": `# Test plan\n\n${body}` });
put("blueprint", { "project-blueprint.md": `# Blueprint\n\n${body}`, "project-br.json": "{\"requirements\":[]}\n" });
put("timeline-planning", { "issues-backlog.md": `# Backlog\n\n${body}`, "project-roadmap.md": `# Roadmap\n\n${body}` });
put("review", { "project-review.md": `# Review\n\nverdict: approved\n\n${body}`, "project-review.result.json": "{\"verdict\":\"approved\",\"findings\":[]}\n" });
put("issue-state-population", {});
put("acceptance", { "project-acceptance.md": `# Acceptance\n\nverdict: approved\n\n${body}`, "project-acceptance.result.json": "{\"verdict\":\"approved\",\"findings\":[]}\n" });
put("snapshot", { "project-drs.json": "{\"divergence_log\":[]}\n", "project-br.json": "{\"requirements\":[],\"stratum\":5}\n", "uwf-changelog.md": `# Changelog\n\n${body}` });
put("retro", { "project-retro.md": `# Retro\n\n${body}` });

function skillJson(script, args) {
  const r = spawnSync(process.execPath, [join(SKILLS, script), ...args, "--data-dir", data], { encoding: "utf8", cwd: repo });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

console.log("# planning-only workflow (project_manager) reaches closed");
const r = spawnSync(process.execPath, [RUNNER, "run", "--workflow", WF, "--goal", "Plan a project",
  "--repo-root", repo, "--data-dir", data], {
  encoding: "utf8",
  env: { ...process.env, UWF_FAKE_FIXTURE_DIR: fixtures, UWF_DATA_DIR: "" },
});
check("exits 0", r.status === 0, r.stderr.slice(-800));
const notApplied = r.stderr.split("\n").filter((l) => /phase .*not applied/.test(l));
check("no 'not applied' phase line is logged", notApplied.length === 0, notApplied.join(" | "));
const state = skillJson("uwf-state-manager/state.mjs", ["read"])?.state;
check("final phase is closed", state?.phase === "closed", JSON.stringify(state?.phase));
const visited = (state?.history ?? []).filter((h) => /^stage .* passed$/.test(h.note ?? "")).map((h) => h.to_phase);
check("phases visited in order, execution skipped",
  JSON.stringify(visited) === JSON.stringify(["intake", "discovery", "planning", "acceptance", "snapshot", "closed"]), JSON.stringify(visited));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
