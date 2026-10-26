/**
 * Workflow expressions may only use the contexts GitHub allows at that key.
 *
 * GitHub validates this only when the file is pushed, and a reusable workflow
 * with a bad expression fails silently as an "Invalid workflow file" run that
 * no PR check reports (uwf-on-pr.yml shipped with `runner.temp` in job-level
 * env that way). This test applies the documented availability table to the
 * job-level keys where mistakes are easy: `env`, `if`, `name`, `concurrency`,
 * `timeout-minutes`, `runs-on`, `outputs`, `container`, `services`.
 *
 *   https://docs.github.com/actions/learn-github-actions/contexts#context-availability
 *
 * Usage:
 *   node scripts/uwf-smoke/test-workflow-contexts.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github/workflows");
const yaml = createRequire(import.meta.url)(join(REPO_ROOT, ".github/skills/uwf-orchestration-engine/node_modules/js-yaml"));

// Contexts allowed per job-level key (workflow-level keys are not checked here).
const ALLOWED = {
  "name": ["github", "needs", "strategy", "matrix", "vars", "inputs"],
  "if": ["github", "needs", "vars", "inputs"],
  "env": ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"],
  "concurrency": ["github", "needs", "strategy", "matrix", "vars", "inputs"],
  "timeout-minutes": ["github", "needs", "strategy", "matrix", "vars", "inputs"],
  "runs-on": ["github", "needs", "strategy", "matrix", "vars", "inputs"],
  "outputs": ["github", "needs", "strategy", "matrix", "job", "runner", "env", "vars", "secrets", "steps", "inputs"],
  "container": ["github", "needs", "strategy", "matrix", "vars", "env", "secrets", "inputs"],
  "services": ["github", "needs", "strategy", "matrix", "vars", "env", "secrets", "inputs"],
};
const CONTEXTS = ["github", "env", "vars", "job", "jobs", "steps", "runner", "secrets", "strategy", "matrix", "needs", "inputs"];

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

/** Context names referenced by `${{ ... }}` expressions anywhere inside `value`. */
function contextsUsed(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const found = new Set();
  for (const m of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const c of m[1].matchAll(/(?<![\w.'"])([a-z]+)\s*(?:\.|\[)/g)) {
      if (CONTEXTS.includes(c[1])) found.add(c[1]);
    }
  }
  return [...found];
}

const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
assert("workflow files found", files.length > 0);

for (const file of files) {
  const doc = yaml.load(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    for (const [key, allowed] of Object.entries(ALLOWED)) {
      if (!(key in job)) continue;
      const bad = contextsUsed(job[key]).filter((c) => !allowed.includes(c));
      assert(`${file} job ${jobId} ${key} uses only allowed contexts`, bad.length === 0, `not allowed here: ${bad.join(", ")}`);
    }
  }
}

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
