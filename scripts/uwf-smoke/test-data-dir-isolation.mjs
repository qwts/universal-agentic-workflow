/**
 * Smoke tests for UWF_DATA_DIR / --data-dir isolation.
 *
 * Tests: two runs with different UWF_DATA_DIR create distinct databases
 * (state.mjs, stage-tracker.mjs, issues.mjs); --data-dir beats the env var;
 * with neither set, the CLIs fall back to their __dirname default.
 *
 * The default-path check runs the CLIs from a copy of .github so the real
 * databases in this checkout are never touched.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-data-dir-isolation.mjs
 *
 * Exit codes:
 *   0  all tests passed
 *   1  one or more tests failed
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SKILLS = join(REPO_ROOT, ".github/skills");

const CLIS = {
  state: { script: join(SKILLS, "uwf-state-manager/state.mjs"), args: ["init", "--workflow", "sw_dev"], db: "uwf-state.db", dir: "uwf-state-manager" },
  stages: { script: join(SKILLS, "uwf-orchestration-engine/stage-tracker.mjs"), args: ["init", "--workflow", "sw_dev"], db: "uwf-stages.db", dir: "uwf-orchestration-engine" },
  issues: { script: join(SKILLS, "uwf-local-tracking/issues.mjs"), args: ["list"], db: "uwf-issues.db", dir: "uwf-local-tracking" },
};

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    failed++;
  }
}

/** Run a CLI with an explicit env (no inherited UWF_DATA_DIR unless passed). */
function runCli(scriptPath, args, env) {
  try {
    const out = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function envWithout(...keys) {
  const env = { ...process.env };
  for (const k of keys) delete env[k];
  return env;
}

const tempRoot = mkdtempSync(join(tmpdir(), "uwf-data-dir-test-"));

try {
  const dirA = mkdtempSync(join(tempRoot, "a-"));
  const dirB = mkdtempSync(join(tempRoot, "b-"));

  console.log("\nIsolation via UWF_DATA_DIR");
  for (const [name, cli] of Object.entries(CLIS)) {
    const a = runCli(cli.script, cli.args, { ...envWithout("UWF_DATA_DIR"), UWF_DATA_DIR: dirA });
    const b = runCli(cli.script, cli.args, { ...envWithout("UWF_DATA_DIR"), UWF_DATA_DIR: dirB });
    assert(`${name}: run with UWF_DATA_DIR=A succeeds`, a.ok, a.stderr);
    assert(`${name}: run with UWF_DATA_DIR=B succeeds`, b.ok, b.stderr);

    const fileA = join(dirA, cli.db);
    const fileB = join(dirB, cli.db);
    assert(`${name}: A contains ${cli.db}`, existsSync(fileA), fileA);
    assert(`${name}: B contains ${cli.db}`, existsSync(fileB), fileB);
    assert(
      `${name}: A and B are distinct files`,
      existsSync(fileA) && existsSync(fileB) && realpathSync(fileA) !== realpathSync(fileB),
    );
  }

  console.log("\nPrecedence: --data-dir beats UWF_DATA_DIR");
  const dirC = mkdtempSync(join(tempRoot, "c-"));
  const flagged = runCli(CLIS.state.script, [...CLIS.state.args, "--data-dir", dirC], {
    ...envWithout("UWF_DATA_DIR"),
    UWF_DATA_DIR: dirA,
  });
  assert("state: --data-dir run succeeds", flagged.ok, flagged.stderr);
  assert("state: --data-dir wins over env (file in C)", existsSync(join(dirC, CLIS.state.db)));

  console.log("\nDefault: neither env nor flag set");
  // Copy .github so the default __dirname location is exercised without
  // resetting the databases in this checkout.
  const copyRoot = join(tempRoot, "copy");
  cpSync(join(REPO_ROOT, ".github"), join(copyRoot, ".github"), { recursive: true });
  const copySkills = join(copyRoot, ".github/skills");
  for (const [name, cli] of Object.entries(CLIS)) {
    const copyScript = join(copySkills, cli.dir, cli.script.split("/").pop());
    const res = runCli(copyScript, cli.args, envWithout("UWF_DATA_DIR"));
    assert(`${name}: default run succeeds`, res.ok, res.stderr);
    assert(
      `${name}: default DB lands next to the script`,
      existsSync(join(copySkills, cli.dir, cli.db)),
      join(copySkills, cli.dir, cli.db),
    );
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
