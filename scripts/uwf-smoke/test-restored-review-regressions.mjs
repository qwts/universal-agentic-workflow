/**
 * Regression coverage for defects found while reviewing the M0 skill restore.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-restored-review-regressions.mjs
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const TRACKER = join(
  REPO_ROOT,
  ".github/skills/uwf-orchestration-engine/stage-tracker.mjs",
);
const ADRS = join(REPO_ROOT, ".github/skills/uwf-adr/adrs.mjs");
const REQUIREMENTS = join(
  REPO_ROOT,
  ".github/skills/uwf-requirements/requirements.mjs",
);

let passed = 0;
let failed = 0;

function run(script, args) {
  try {
    const output = execFileSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { ok: true, exitCode: 0, output };
  } catch (error) {
    return {
      ok: false,
      exitCode: error.status ?? 1,
      output: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function parse(result) {
  try {
    return JSON.parse(result.output);
  } catch {
    return null;
  }
}

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function reset(script) {
  run(script, ["reset"]);
}

const tempRoot = mkdtempSync(join(tmpdir(), "uwf-restored-regressions-"));

console.log("\nSmoke test: restored skill review regressions\n");

try {
  console.log("1. Forensic run_script gates resolve custom output paths");
  const forensicOutput = join(tempRoot, "forensic output");
  mkdirSync(forensicOutput, { recursive: true });
  writeFileSync(
    join(forensicOutput, "forensic-gap-report.md"),
    "# Gap Entries\n\nNo unresolved gaps.\n",
  );
  writeFileSync(
    join(forensicOutput, "forensic-br.json"),
    JSON.stringify({ gap_report_reviewed: true }),
  );
  const gate = run(TRACKER, [
    "check-gate",
    "--workflow",
    "forensic-analyst",
    "--stage",
    "gap-report",
    "--output-path",
    forensicOutput,
  ]);
  assert("custom-path forensic gate exits 0", gate.ok, gate.output + gate.stderr);
  assert("custom-path forensic gate passes", parse(gate)?.passed === true);

  console.log("2. ADR numbering includes records already present on disk");
  const adrOutput = join(tempRoot, "adrs");
  mkdirSync(adrOutput, { recursive: true });
  writeFileSync(join(adrOutput, "ADR-0006-existing.md"), "# Existing ADR\n");
  reset(ADRS);
  const createdAdr = run(ADRS, [
    "create",
    "--title",
    "Review numbering",
    "--decision",
    "Keep ADR identifiers collision-free.",
    "--output-path",
    adrOutput,
  ]);
  const adr = parse(createdAdr)?.adr;
  assert("ADR create exits 0", createdAdr.ok, createdAdr.output + createdAdr.stderr);
  assert("next ADR number is 0007", adr?.number === "0007", adr?.number);
  assert(
    "ADR-0007 file is created",
    existsSync(join(adrOutput, "ADR-0007-review-numbering.md")),
    basename(adr?.file_path ?? ""),
  );

  console.log("3. Requirement type changes receive the matching identifier");
  reset(REQUIREMENTS);
  const added = run(REQUIREMENTS, [
    "add",
    "--role",
    "developer",
    "--title",
    "Original functional requirement",
  ]);
  const requirementId = parse(added)?.requirement_id;
  const updated = run(REQUIREMENTS, [
    "update",
    "--id",
    String(requirementId),
    "--type",
    "risk",
  ]);
  const updatedRequirement = parse(updated)?.requirement;
  assert("type update exits 0", updated.ok, updated.output + updated.stderr);
  assert("risk type receives RK prefix", updatedRequirement?.number === "RK-001");

  const secondFunctional = run(REQUIREMENTS, [
    "add",
    "--role",
    "developer",
    "--title",
    "Replacement functional requirement",
  ]);
  assert(
    "next functional requirement remains collision-free",
    parse(secondFunctional)?.number === "FR-001",
  );
} finally {
  reset(ADRS);
  reset(REQUIREMENTS);
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
