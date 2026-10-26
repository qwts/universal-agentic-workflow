/**
 * prompt.test.mjs — golden snapshots + behaviour checks for prompt.mjs.
 * Plain node. Regenerate snapshots with UPDATE_SNAPSHOTS=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializePrompt, mapPermissions } from "../prompt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const snapDir = join(here, "fixtures", "prompts");
const update = process.env.UPDATE_SNAPSHOTS === "1";
const opts = { repoRoot, outputPath: "/OUT", dataDir: "/DATA" };

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n${e.stack ?? e}`); }
}

for (const stage of ["discovery", "review", "retro"]) {
  await test(`snapshot sw_dev-${stage}`, async () => {
    const r = await materializePrompt({ workflow: "sw_dev", stage, ...opts });
    const file = join(snapDir, `sw_dev-${stage}.txt`);
    if (update || !existsSync(file)) {
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(file, r.prompt);
    }
    assert.equal(r.prompt, readFileSync(file, "utf8"), `snapshot drift for ${stage}; rerun with UPDATE_SNAPSHOTS=1`);
  });
}

await test("missing input is reported with its path", async () => {
  const r = await materializePrompt({ workflow: "sw_dev", stage: "discovery", ...opts });
  assert.deepEqual(r.inputsMissing, ["/OUT/issues-intake.md"]);
  assert.deepEqual(r.outputsRequired, ["/OUT/issues-discovery.md"]);
});

await test("materialized inputs are returned with templates substituted (what the runner hands adapters)", async () => {
  const r = await materializePrompt({ workflow: "sw_dev", stage: "discovery", ...opts });
  assert.ok(Array.isArray(r.inputs) && r.inputs.length > 0, "inputs returned");
  assert.ok(r.inputs.includes("/OUT/issues-intake.md"), `declared input substituted: ${r.inputs}`);
  assert.ok(r.inputs.every((p) => !/\{\{/.test(p)), `no unresolved templates: ${r.inputs}`);
  const e = await materializePrompt({ workflow: "sw_dev", stage: "discovery", ...opts, extraInputs: ["{{output_path}}/review-findings.md"] });
  assert.ok(e.inputs.includes("/OUT/review-findings.md"), `extra inputs substituted too: ${e.inputs}`);
});

await test("existing input is excerpted to 12 lines and not reported missing", async () => {
  const out = mkdtempSync(join(tmpdir(), "uwf-prompt-"));
  writeFileSync(join(out, "issues-intake.md"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
  const r = await materializePrompt({ workflow: "sw_dev", stage: "discovery", repoRoot, outputPath: out, dataDir: "/DATA" });
  assert.deepEqual(r.inputsMissing, []);
  assert.match(r.prompt, /line 12\b/);
  assert.doesNotMatch(r.prompt, /line 13\b/);
  assert.match(r.prompt, /38 more lines/);
});

await test("prompt tells the stage to read only its declared inputs", async () => {
  const r = await materializePrompt({ workflow: "sw_dev", stage: "blueprint", ...opts });
  assert.match(r.prompt, /## Reading rules\nRead the files listed under Inputs .*plus only the repository files your task requires/);
  assert.match(r.prompt, /Do not list or read the whole artifacts directory, and do not dump the whole repository into context/);
  assert.ok(r.prompt.indexOf("## Reading rules") < r.prompt.indexOf("## Inputs"));
});

await test("long input lines are clipped in the excerpt", async () => {
  const out = mkdtempSync(join(tmpdir(), "uwf-prompt-"));
  writeFileSync(join(out, "issues-intake.md"), "x".repeat(5000) + "\n");
  const r = await materializePrompt({ workflow: "sw_dev", stage: "discovery", repoRoot, outputPath: out, dataDir: "/DATA" });
  assert.ok(r.prompt.length < 3000, `prompt is ${r.prompt.length} chars`);
});

await test("result shape and defaults", async () => {
  const r = await materializePrompt({ workflow: "sw_dev", stage: "discovery", ...opts });
  assert.equal(r.model, null);
  assert.match(r.agentFile, /\.github\/agents\/uwf-stage-discovery\.agent\.md$/);
  assert.equal(r.agentName, "uwf-stage-discovery");
  assert.ok(!r.systemPrompt.startsWith("---"));
  assert.match(r.prompt, /"stage_type": "discovery"/);
  assert.match(r.prompt, /"steering_policy"/);
  const d = await materializePrompt({ workflow: "sw_dev", stage: "retro", repoRoot });
  assert.match(d.outputsRequired[0], /tmp\/uwf\/workflow-artifacts\/issues-retro\.md$|workflow-artifacts\/issues-retro\.md$/);
});

await test("agent body templates are replaced with the resolved output path", async () => {
  const r = await materializePrompt({ workflow: "forensic-analyst", stage: "repo-audit", repoRoot, outputPath: "/OUT" });
  assert.ok(!r.systemPrompt.includes("{{"), "no unreplaced {{...}} template in the system prompt");
  assert.match(r.systemPrompt, /\/OUT\/forensic-repo-audit\.md/);
});

await test("permissions mapping", () => {
  assert.equal(mapPermissions(["agent", "todo", "search", "read"]), "read-only");
  assert.equal(mapPermissions(["agent", "read", "edit", "search"]), "edit");
  assert.equal(mapPermissions(["read", "edit", "execute", "web"]), "edit+exec");
});

await test("unknown stage exits 2", () => {
  const p = join(here, "..", "prompt.mjs");
  const r = spawnSync(process.execPath, [p, "--workflow", "sw_dev", "--stage", "nope"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown stage "nope"/);
  assert.equal(spawnSync(process.execPath, [p], { encoding: "utf8" }).status, 2);
});

await test("CLI prints the same prompt as the API", async () => {
  const p = join(here, "..", "prompt.mjs");
  const r = spawnSync(process.execPath, [p, "--workflow", "sw_dev", "--stage", "review", "--output-path", "/OUT", "--data-dir", "/DATA"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, (await materializePrompt({ workflow: "sw_dev", stage: "review", ...opts })).prompt);
});


// Two roots: a bare target (no .github/) gets agent text whose references point into skillsRoot.
await test("bare target: referenced files are absolute skillsRoot paths, none under <repoRoot>/.github", async () => {
  const bare = mkdtempSync(join(tmpdir(), "uwf-bare-"));
  try {
    // Only stages whose agent text references .github/ files (retro and the stage agents do not).
    for (const stage of ["review", "blueprint"]) {
      const r = await materializePrompt({ workflow: "sw_dev", stage, repoRoot: bare, outputPath: "/OUT", dataDir: "/DATA" });
      const refs = r.systemPrompt.match(/\/[^\s`'")]*\.github\/(?:skills|agents)\/[^\s`'")]*/g) ?? [];
      assert.ok(refs.length > 0, `${stage}: agent text has no skillsRoot references to check`);
      for (const ref of refs) assert.ok(ref.startsWith(`${repoRoot}/.github/`), `${stage}: ${ref} is not under skillsRoot`);
      assert.ok(!/(^|[^/\w])\.github\/(skills|agents)\//m.test(r.systemPrompt), `${stage}: relative .github path left in agent text`);
      assert.ok(!r.systemPrompt.includes(`${bare}/.github`) && !r.prompt.includes(`${bare}/.github`));
      assert.ok(r.agentFile.startsWith(`${repoRoot}/.github/agents/`));
      assert.match(r.prompt, /## Skill files\n[^\n]*use the same path under /, `${stage}: no skill-files rule for the bare target`);
    }
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

// Partial target: it carries only its workflow's stages.yaml, so it is its own skills root, but the agent
// files and skill docs still come from this checkout and the references must point there.
await test("partial target: fallback agent references resolve to this checkout, own files stay relative", async () => {
  const t = mkdtempSync(join(tmpdir(), "uwf-partial-"));
  try {
    mkdirSync(join(t, ".github", "skills", "uwf-sw_dev"), { recursive: true });
    copyFileSync(join(repoRoot, ".github", "skills", "uwf-sw_dev", "stages.yaml"), join(t, ".github", "skills", "uwf-sw_dev", "stages.yaml"));
    mkdirSync(join(t, ".github", "skills", "uwf-review"), { recursive: true });
    writeFileSync(join(t, ".github", "skills", "uwf-review", "SKILL.md"), "# local review skill\n");
    const r = await materializePrompt({ workflow: "sw_dev", stage: "review", repoRoot: t, outputPath: "/OUT", dataDir: "/DATA" });
    assert.ok(r.systemPrompt.includes("`.github/skills/uwf-review/SKILL.md`") || r.systemPrompt.includes(".github/skills/uwf-review/SKILL.md"), "the target's own skill file stays relative");
    assert.ok(!r.systemPrompt.includes(`${repoRoot}/.github/skills/uwf-review/SKILL.md`));
    const others = r.systemPrompt.match(/\.github\/(?:skills|agents)\/[^\s`'")]*/g).filter((x) => !x.includes("uwf-review/SKILL.md"));
    assert.ok(others.length > 0, "review agent should reference other skill files");
    for (const ref of others) assert.ok(r.systemPrompt.includes(`${repoRoot}/${ref}`), `${ref} should resolve to this checkout`);
    assert.match(r.prompt, new RegExp(`## Skill files\\n[^\\n]*under ${repoRoot} instead`));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

await test("explicit skillsRoot is honoured and the target's own copy is auto-detected", async () => {
  const t = mkdtempSync(join(tmpdir(), "uwf-own-"));
  try {
    const { resolveSkillsRoot } = await import("../prompt.mjs");
    assert.deepEqual(resolveSkillsRoot({ explicit: t, repoRoot: t, workflow: "sw_dev" }), { root: t, source: "flag" });
    assert.equal(resolveSkillsRoot({ repoRoot: t, workflow: "sw_dev" }).source, "own");
    mkdirSync(join(t, ".github", "skills", "uwf-sw_dev"), { recursive: true });
    writeFileSync(join(t, ".github", "skills", "uwf-sw_dev", "stages.yaml"), "workflow: sw_dev\nstages: []\n");
    assert.deepEqual(resolveSkillsRoot({ repoRoot: t, workflow: "sw_dev" }), { root: t, source: "target" });
  } finally { rmSync(t, { recursive: true, force: true }); }
});

// Node 20 has no fs.globSync: the fallback matcher must agree with the native one.
{
  const { globFiles } = await import("../prompt.mjs");
  const pattern = "docs/adr/ADR-[0-9]*.md";
  const native = globFiles(pattern, repoRoot).map((p) => p.replace(`${repoRoot}/`, "")).sort();
  process.env.UWF_FORCE_GLOB_FALLBACK = "1";
  const fallback = globFiles(pattern, repoRoot).map((p) => p.replace(`${repoRoot}/`, "")).sort();
  delete process.env.UWF_FORCE_GLOB_FALLBACK;
  assert.ok(native.length > 0, "glob pattern matched nothing");
  assert.deepEqual(fallback, native, "glob fallback disagrees with fs.globSync");
  console.log("ok   glob fallback matches native");
}

await test("inputs of a skipped stage are optional: not missing, one-line note in the prompt", async () => {
  const out = mkdtempSync(join(tmpdir(), "uwf-prompt-"));
  const repo = mkdtempSync(join(tmpdir(), "uwf-prompt-repo-"));
  const o = { workflow: "sw_dev", stage: "risk-plan", repoRoot: repo, outputPath: out, dataDir: "/DATA", skillsRoot: repoRoot };
  const adrGlob = `${repo}/docs/adr/ADR-[0-9]*.md`;
  const skipped = await materializePrompt({ ...o, skippedStages: ["adr"] });
  assert.ok(!skipped.inputsMissing.includes(adrGlob), `adr input not missing: ${skipped.inputsMissing}`);
  assert.deepEqual(skipped.inputsSkipped, [{ stage: "adr", path: adrGlob }]);
  const notes = skipped.prompt.split("\n").filter((l) => l.startsWith("inputs from skipped stage adr are unavailable: "));
  assert.equal(notes.length, 1, "exactly one note line");
  assert.ok(notes[0].endsWith(adrGlob));
  assert.ok(!skipped.prompt.includes(`### ${adrGlob}`), "no (missing) block for the skipped input");
  // genuinely missing inputs still reported
  assert.ok(skipped.inputsMissing.some((p) => p.endsWith("issues-intake.md")));
});

await test("adr not skipped but files absent: still reported missing", async () => {
  const out = mkdtempSync(join(tmpdir(), "uwf-prompt-"));
  const repo = mkdtempSync(join(tmpdir(), "uwf-prompt-repo-"));
  const r = await materializePrompt({ workflow: "sw_dev", stage: "risk-plan", repoRoot: repo, outputPath: out, dataDir: "/DATA", skillsRoot: repoRoot, skippedStages: ["security-plan"] });
  assert.ok(r.inputsMissing.includes(`${repo}/docs/adr/ADR-[0-9]*.md`), `${r.inputsMissing}`);
  assert.deepEqual(r.inputsSkipped, []);
  assert.doesNotMatch(r.prompt, /inputs from skipped stage/);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log("\nall prompt tests passed");
