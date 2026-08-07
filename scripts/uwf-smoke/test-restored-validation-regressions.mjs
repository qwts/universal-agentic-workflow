/**
 * Regression coverage for lifecycle validation and discovery gap ordering.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-restored-validation-regressions.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const DISCOVERIES = join(
  REPO_ROOT,
  ".github/skills/uwf-discovery/discoveries.mjs",
);
const ISSUES = join(
  REPO_ROOT,
  ".github/skills/uwf-local-tracking/issues.mjs",
);
const ADRS = join(REPO_ROOT, ".github/skills/uwf-adr/adrs.mjs");

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

function runWithDb(script, dbPath, args) {
  return run(script, [...args, "--db-path", dbPath]);
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

const tempRoot = mkdtempSync(join(tmpdir(), "uwf-validation-regressions-"));
const discoveriesDb = join(tempRoot, "discoveries.db");
const issuesDb = join(tempRoot, "issues.db");
const adrsDb = join(tempRoot, "adrs.db");

console.log("\nSmoke test: restored lifecycle validation and ordering\n");

try {
  console.log("1. Discovery gaps use explicit impact severity ordering");
  for (const [impact, title] of [
    ["low", "Low impact"],
    ["high", "First high impact"],
    ["medium", "Medium impact"],
    ["high", "Second high impact"],
  ]) {
    const logged = runWithDb(DISCOVERIES, discoveriesDb, [
      "log",
      "--role",
      "developer",
      "--category",
      "gap",
      "--impact",
      impact,
      "--title",
      title,
    ]);
    assert(`log ${title}`, logged.ok, logged.output + logged.stderr);
  }
  const gaps = runWithDb(DISCOVERIES, discoveriesDb, ["gaps"]);
  assert("gaps exits 0", gaps.ok, gaps.output + gaps.stderr);
  assert(
    "gaps order is high, high, medium, low",
    JSON.stringify(parse(gaps)?.discoveries?.map((row) => row.impact)) ===
      JSON.stringify(["high", "high", "medium", "low"]),
  );
  assert(
    "equal-impact gaps preserve insertion order",
    parse(gaps)?.discoveries?.[0]?.title === "First high impact" &&
      parse(gaps)?.discoveries?.[1]?.title === "Second high impact",
  );

  console.log("2. Local tracking rejects unsupported statuses");
  const invalidCreate = runWithDb(ISSUES, issuesDb, [
    "create",
    "--id",
    "invalid-status",
    "--title",
    "Invalid status",
    "--status",
    "opened",
  ]);
  assert("invalid create exits with usage code 2", invalidCreate.exitCode === 2);
  assert("invalid create reports allowed statuses", parse(invalidCreate)?.error?.includes("open, active, closed, skipped"));
  const afterInvalidCreate = runWithDb(ISSUES, issuesDb, ["list"]);
  assert("invalid issue was not inserted", parse(afterInvalidCreate)?.count === 0);

  const validIssue = runWithDb(ISSUES, issuesDb, [
    "create",
    "--id",
    "valid-status",
    "--title",
    "Valid status",
  ]);
  assert("default open issue is accepted", parse(validIssue)?.issue?.status === "open");
  const invalidUpdate = runWithDb(ISSUES, issuesDb, [
    "update",
    "--id",
    "valid-status",
    "--status",
    "opened",
  ]);
  assert("invalid update exits with usage code 2", invalidUpdate.exitCode === 2);
  const emptyStatusUpdate = runWithDb(ISSUES, issuesDb, [
    "update",
    "--id",
    "valid-status",
    "--status",
    "",
  ]);
  assert("empty issue status is rejected", emptyStatusUpdate.exitCode === 2);
  const openIssues = runWithDb(ISSUES, issuesDb, ["list", "--status", "open"]);
  assert("invalid updates leave the issue open", parse(openIssues)?.count === 1);

  console.log("3. ADR updates validate lifecycle status and impact");
  const adrOutput = join(tempRoot, "adr-output");
  const createdAdr = runWithDb(ADRS, adrsDb, [
    "create",
    "--title",
    "Validated lifecycle",
    "--decision",
    "Keep ADR state inside the documented lifecycle.",
    "--output-path",
    adrOutput,
  ]);
  const adrId = parse(createdAdr)?.adr?.id;
  assert("ADR create exits 0", createdAdr.ok, createdAdr.output + createdAdr.stderr);

  const invalidStatus = runWithDb(ADRS, adrsDb, [
    "update",
    "--id",
    String(adrId),
    "--status",
    "acceptd",
  ]);
  assert("invalid ADR status is rejected", invalidStatus.exitCode === 1);
  assert("ADR status error names allowed values", parse(invalidStatus)?.error?.includes("proposed, accepted, deprecated, superseded"));
  const emptyStatus = runWithDb(ADRS, adrsDb, [
    "update",
    "--id",
    String(adrId),
    "--status",
    "",
  ]);
  assert("empty ADR status is rejected", emptyStatus.exitCode === 1);

  const invalidImpact = runWithDb(ADRS, adrsDb, [
    "update",
    "--id",
    String(adrId),
    "--impact",
    "critical",
  ]);
  assert("invalid ADR impact is rejected", invalidImpact.exitCode === 1);
  assert("ADR impact error names allowed values", parse(invalidImpact)?.error?.includes("low, medium, high"));
  const emptyImpact = runWithDb(ADRS, adrsDb, [
    "update",
    "--id",
    String(adrId),
    "--impact",
    "",
  ]);
  assert("empty ADR impact is rejected", emptyImpact.exitCode === 1);

  const validUpdate = runWithDb(ADRS, adrsDb, [
    "update",
    "--id",
    String(adrId),
    "--status",
    "accepted",
    "--impact",
    "high",
  ]);
  assert("valid ADR update exits 0", validUpdate.ok, validUpdate.output + validUpdate.stderr);
  assert(
    "valid ADR lifecycle fields persist",
    parse(validUpdate)?.adr?.status === "accepted" &&
      parse(validUpdate)?.adr?.impact === "high",
  );
} finally {
  runWithDb(DISCOVERIES, discoveriesDb, ["reset"]);
  runWithDb(ISSUES, issuesDb, ["reset"]);
  runWithDb(ADRS, adrsDb, ["reset"]);
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
