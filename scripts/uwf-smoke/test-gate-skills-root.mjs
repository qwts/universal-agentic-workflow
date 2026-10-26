/**
 * Gate run_script commands resolve .github/skills and .github/agents paths against the skills root
 * while still running with cwd = the target repo (#150).
 *
 * Usage:
 *   node scripts/uwf-smoke/test-gate-skills-root.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const TRACKER = join(REPO_ROOT, ".github/skills/uwf-orchestration-engine/stage-tracker.mjs");

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

const tmp = mkdtempSync(join(tmpdir(), "uwf-gate-root-"));
// A root with a space, parentheses and a `$` proves shell-form commands get it as one literal word.
const skillsRoot = join(tmp, "skills root ($1)");
const target = join(tmp, "target");
const targetWithCopy = join(tmp, "target-with-copy");
const dataDir = join(tmp, "data");
const demoDir = (root) => join(root, ".github/skills/uwf-demo");
for (const d of [demoDir(skillsRoot), demoDir(targetWithCopy), target, dataDir]) mkdirSync(d, { recursive: true });

// The probe exits 0 only when it runs with cwd = the directory given as argv[2].
writeFileSync(join(demoDir(skillsRoot), "probe.mjs"), `import { realpathSync } from "node:fs";
if (realpathSync(process.cwd()) !== realpathSync(process.argv[2])) { console.error("cwd mismatch " + process.cwd()); process.exit(3); }
console.log("root probe ok");
`);
writeFileSync(join(demoDir(targetWithCopy), "probe.mjs"), "console.error('target copy ran'); process.exit(7);\n");

const STAGES = `workflow: demo
stages:
  - name: viaargs
    gate:
      checks:
        - type: run_script
          cmd: node
          args: [".github/skills/uwf-demo/probe.mjs", "{{cwd}}"]
          label: probe via args
  - name: viashell
    gate:
      checks:
        - type: run_script
          cmd: "node .github/skills/uwf-demo/probe.mjs . | cat"
          label: probe via shell
  - name: viatemplate
    gate:
      checks:
        - type: run_script
          cmd: node
          args: ["{{skills_root}}/.github/skills/uwf-demo/probe.mjs", "{{cwd}}"]
          label: probe via template
  - name: viaengine
    gate:
      checks:
        - type: run_script
          cmd: node
          args: [".github/skills/uwf-orchestration-engine/verify.mjs", "--dry-run"]
          label: engine script absent from a partial skills root
`;
writeFileSync(join(demoDir(skillsRoot), "stages.yaml"), STAGES);

function gate(cwd, stage, root) {
  const args = [TRACKER, "check-gate", "--workflow", "demo", "--stage", stage, "--data-dir", dataDir];
  const env = { ...process.env };
  delete env.UWF_SKILLS_ROOT;
  if (root) args.push("--skills-root", root);
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { status: r.status, out, detail: JSON.stringify(out) ?? r.stderr };
}

console.log("\nSmoke test: gate commands resolve against the skills root\n");

for (const stage of ["viaargs", "viashell", "viatemplate", "viaengine"]) {
  const r = gate(target, stage, skillsRoot);
  assert(`${stage}: passes with a skills root and a target without skills`, r.status === 0 && r.out?.passed === true, r.detail);
}

// Without a root the stages.yaml has to come from the target itself, and the command fails as it did before.
mkdirSync(demoDir(target), { recursive: true });
writeFileSync(join(demoDir(target), "stages.yaml"), readFileSync(join(demoDir(skillsRoot), "stages.yaml"), "utf8"));
const noRoot = gate(target, "viaargs", null);
assert("viaargs: fails without a skills root (module not found)", noRoot.status === 1 && noRoot.out?.passed === false && /Cannot find module|MODULE_NOT_FOUND/.test(noRoot.detail), noRoot.detail);

// A target repo's own copy wins over the skills root.
const own = gate(targetWithCopy, "viaargs", skillsRoot);
assert("target's own copy wins over the skills root", own.status === 1 && own.detail.includes("target copy ran"), own.detail);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
