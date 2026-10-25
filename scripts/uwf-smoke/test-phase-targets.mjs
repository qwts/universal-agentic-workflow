/**
 * Every stage's advances_phase_to must be a phase the state manager accepts.
 *
 * The phase list is read from VALID_PHASES in state.mjs, which is the list
 * state.mjs enforces at `advance` time. workflow-schema.yaml does not carry an
 * enum, so state.mjs is the single source of truth here.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-phase-targets.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SKILLS_DIR = join(REPO_ROOT, ".github/skills");
const STATE_MJS = join(SKILLS_DIR, "uwf-state-manager/state.mjs");

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

console.log("\nSmoke test: advances_phase_to targets are valid phases\n");

// 1. Read the phase list that state.mjs enforces.
const stateSource = readFileSync(STATE_MJS, "utf8");
const phaseMatch = stateSource.match(/const\s+VALID_PHASES\s*=\s*\[([^\]]*)\]/);
const validPhases = phaseMatch
  ? [...phaseMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];

assert("VALID_PHASES found in state.mjs", validPhases.length > 0, STATE_MJS);
assert("VALID_PHASES includes snapshot", validPhases.includes("snapshot"));

// 2. Collect every stages.yaml under .github/skills/uwf-*/.
const stagesFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("uwf-"))
  .map((d) => join(SKILLS_DIR, d.name, "stages.yaml"))
  .filter((p) => existsSync(p));

assert("at least one stages.yaml found", stagesFiles.length > 0, SKILLS_DIR);

// 3. Check every advances_phase_to value.
let targetCount = 0;
for (const file of stagesFiles) {
  const rel = file.slice(REPO_ROOT.length + 1);
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*advances_phase_to:\s*(.*?)\s*(#.*)?$/);
    if (!m) continue;
    targetCount++;
    const target = m[1].replace(/^["']|["']$/g, "");
    assert(
      `${rel}:${i + 1} advances_phase_to "${target}" is a valid phase`,
      validPhases.includes(target),
      `valid phases: ${validPhases.join(", ")}`,
    );
  }
}

assert("at least one advances_phase_to target checked", targetCount > 0);

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
