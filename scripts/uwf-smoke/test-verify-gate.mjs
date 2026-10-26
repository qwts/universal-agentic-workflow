/**
 * The sw_dev implementation gate runs the target repo's build and tests (#158).
 *
 * Usage:
 *   node scripts/uwf-smoke/test-verify-gate.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFY = join(REPO_ROOT, ".github/skills/uwf-orchestration-engine/verify.mjs");
const TRACKER = join(REPO_ROOT, ".github/skills/uwf-orchestration-engine/stage-tracker.mjs");

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

const tmp = mkdtempSync(join(tmpdir(), "uwf-verify-"));
const dataDir = join(tmp, "data");
mkdirSync(dataDir);
let n = 0;
function repo(files = {}) {
  const dir = join(tmp, `repo${n++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
function verify(cwd, args = [], env = {}) {
  const e = { ...process.env, ...env };
  if (!("UWF_VERIFY_CMDS" in env)) delete e.UWF_VERIFY_CMDS;
  const r = spawnSync(process.execPath, [VERIFY, ...args], { cwd, encoding: "utf8", env: e });
  return { status: r.status, out: r.stdout + r.stderr };
}
const pkg = (test) => JSON.stringify({ name: "t", version: "1.0.0", scripts: { test } });

console.log("\nSmoke test: implementation verify gate\n");

let r = verify(repo({ "package.json": pkg("node -e \"process.exit(0)\"") }));
assert("package.json with passing test: passes", r.status === 0 && /npm test --if-present/.test(r.out), r.out);

const failing = repo({ "package.json": pkg("node -e \"console.log('boom-marker');process.exit(1)\"") });
r = verify(failing);
assert("package.json with failing test: fails naming the command and output", r.status === 1 && r.out.includes("npm test --if-present") && r.out.includes("boom-marker"), r.out);

r = verify(repo({ "package.json": pkg("echo \"Error: no test specified\" && exit 1") }), ["--dry-run"]);
assert("npm placeholder test script is skipped", r.status === 0 && !/npm test/.test(r.out), r.out);

r = verify(repo({ ".uwf.json": JSON.stringify({ verify: ["node -e \"process.exit(0)\""] }) }));
assert(".uwf.json verify command passes", r.status === 0 && r.out.includes(".uwf.json"), r.out);

r = verify(repo({ ".uwf.json": JSON.stringify({ verify: ["node -e \"process.exit(4)\""] }) }));
assert(".uwf.json failing command fails with exit code", r.status === 1 && r.out.includes("exited 4"), r.out);

r = verify(repo({ ".uwf.json": JSON.stringify({ verify: [] }), "package.json": pkg("exit 1") }));
assert("explicit empty verify list overrides auto-detect", r.status === 0 && /no verify commands/.test(r.out), r.out);

r = verify(repo());
assert("empty repo passes with 'no verify commands'", r.status === 0 && /no verify commands detected/.test(r.out), r.out);

r = verify(failing, [], { UWF_VERIFY_CMDS: "node -e \"process.exit(0)\"\nnode -e \"process.exit(0)\"" });
assert("UWF_VERIFY_CMDS overrides package.json", r.status === 0 && r.out.includes("UWF_VERIFY_CMDS"), r.out);

r = verify(repo(), [], { UWF_VERIFY_CMDS: "node -e \"process.exit(0)\"\nnode -e \"process.exit(2)\"\nnode -e \"process.exit(5)\"" });
assert("stops at first failing command", r.status === 1 && r.out.includes("exited 2") && !r.out.includes("exited 5"), r.out);

const nodeWithTests = repo({ "package.json": pkg("node -e \"process.exit(0)\"") });
mkdirSync(join(nodeWithTests, "tests"));
r = verify(nodeWithTests, ["--dry-run"]);
assert("Node repo with empty tests/ does not get pytest", r.status === 0 && !/pytest/.test(r.out), r.out);
r = verify(nodeWithTests);
assert("Node repo with empty tests/ passes", r.status === 0, r.out);

const py = repo({ "setup.py": "" });
mkdirSync(join(py, "tests"));
r = verify(py, ["--dry-run"]);
assert("Python repo with tests/ and setup.py gets pytest", /-m pytest -q/.test(r.out), r.out);

r = verify(failing, ["--dry-run"]);
assert("--dry-run prints commands without running", r.status === 0 && r.out.includes("npm test") && !r.out.includes("boom-marker"), r.out);

function gate(cwd) {
  const env = { ...process.env };
  delete env.UWF_SKILLS_ROOT;
  delete env.UWF_VERIFY_CMDS;
  const args = [TRACKER, "check-gate", "--workflow", "sw_dev", "--stage", "implementation", "--data-dir", dataDir, "--skills-root", REPO_ROOT];
  const res = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  let out = null;
  try { out = JSON.parse(res.stdout); } catch { /* keep null */ }
  return { status: res.status, out, detail: res.stdout + res.stderr };
}
const g = gate(failing);
assert("check-gate runs verify.mjs via skills root and reports the failure",
  g.status === 1 && g.out?.passed === false && /build and tests pass/.test(g.detail) && /npm test/.test(g.detail), g.detail);
const gOk = gate(repo({ ".uwf.json": JSON.stringify({ verify: [] }) }));
assert("check-gate: verify check itself passes on a repo with nothing to verify",
  !/build and tests pass/.test(gOk.detail), gOk.detail);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
