/**
 * Regression coverage for the design-planning gate's heading checks (#155).
 * The gate must accept both "## Overview" and "## 1. Overview", reject a missing
 * heading, and name the same headings, in the same order, as the stage prompt.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-design-planning-headings.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRACKER = join(REPO_ROOT, ".github/skills/uwf-orchestration-engine/stage-tracker.mjs");
const PROMPT = join(REPO_ROOT, ".github/agents/uwf-solutions_architect-design-planner.agent.md");

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

// Headings the prompt's SDD schema block dictates, in order.
const promptText = readFileSync(PROMPT, "utf8");
const schemaBlock = promptText.match(/# System Design Document\n([\s\S]*?)```/)[1];
const promptHeadings = [...schemaBlock.matchAll(/^## \d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]);

const tmp = mkdtempSync(join(tmpdir(), "uwf-design-headings-"));
const dataDir = join(tmp, "data");
const out = join(tmp, "artifacts");
mkdirSync(out, { recursive: true });

function gate() {
  try {
    const stdout = execFileSync(process.execPath, [
      TRACKER, "check-gate", "--workflow", "solutions_architect", "--stage", "design-planning",
      "--output-path", out, "--data-dir", dataDir,
    ], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout.toString());
  }
}
function writeSdd(lines) {
  writeFileSync(join(out, "design-sdd.md"), `# System Design Document\n\n${lines.map((l) => `${l}\n\nBody.\n`).join("\n")}`);
}

try {
  console.log("\nSmoke test: design-planning gate headings\n");
  assert("prompt lists eight numbered SDD sections", promptHeadings.length === 8, promptHeadings.join("|"));

  const yaml = readFileSync(join(REPO_ROOT, ".github/skills/uwf-solutions_architect/stages.yaml"), "utf8");
  const stage = yaml.slice(yaml.indexOf("- name: design-planning"), yaml.indexOf("- name: review"));
  const gateHeadings = [...stage.matchAll(/heading:\s*"## (.+?)"/g)].map((m) => m[1]);
  assert("gate names the same headings, in the same order, as the prompt",
    JSON.stringify(gateHeadings) === JSON.stringify(promptHeadings), `${gateHeadings.join("|")} vs ${promptHeadings.join("|")}`);

  writeSdd(promptHeadings.map((h, i) => `## ${i + 1}. ${h}`));
  let r = gate();
  assert("numbered headings (prompt form) pass", r.passed === true, JSON.stringify(r));

  writeSdd(promptHeadings.map((h) => `## ${h}`));
  r = gate();
  assert("bare headings pass", r.passed === true, JSON.stringify(r));

  writeSdd(promptHeadings.map((h, i) => (i === 0 ? `## ${i + 1}) ${h}` : `## ${i + 1}. ${h}`)));
  r = gate();
  assert("mixed numbering styles pass", r.passed === true, JSON.stringify(r));

  writeSdd(promptHeadings.filter((h) => h !== "Traceability").map((h, i) => `## ${i + 1}. ${h}`));
  r = gate();
  assert("missing Traceability heading fails", r.passed === false);
  assert("failure names the missing heading", JSON.stringify(r).includes("Traceability"));

  writeSdd(promptHeadings.map((h, i) => (h === "Components" ? `### ${i + 1}. ${h}` : `## ${i + 1}. ${h}`)));
  r = gate();
  assert("wrong heading level fails", r.passed === false);

  writeSdd(promptHeadings.map((h, i) => (h === "Components" ? `## ${i + 1}. ${h} and more` : `## ${i + 1}. ${h}`)));
  r = gate();
  assert("heading with extra trailing words fails", r.passed === false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
