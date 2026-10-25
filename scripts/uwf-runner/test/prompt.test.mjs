/**
 * prompt.test.mjs — golden snapshots + behaviour checks for prompt.mjs.
 * Plain node. Regenerate snapshots with UPDATE_SNAPSHOTS=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.match(r.prompt, /Do not list or read the whole artifacts directory or the whole repository/);
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

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log("\nall prompt tests passed");

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
