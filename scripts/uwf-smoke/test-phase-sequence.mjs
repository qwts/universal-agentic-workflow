/**
 * Phase advances follow the workflow's own phase sequence (state.mjs advance --phases).
 *
 * A planning-only workflow (project_manager, solutions_architect) never visits "execution",
 * so planning -> acceptance -> snapshot -> closed must be legal for it, while a workflow that
 * does have an execution phase (sw_dev) still has to pass through it. Backwards moves stay
 * illegal, and without --phases the canonical chain applies.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-phase-sequence.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = join(REPO_ROOT, ".github/skills/uwf-state-manager/state.mjs");

let passed = 0;
let failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

const dir = mkdtempSync(join(tmpdir(), "uwf-phase-seq-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function state(args) {
  const r = spawnSync(process.execPath, [STATE, ...args, "--data-dir", dir], { encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* usage errors go to stderr */ }
  return { code: r.status, json, err: r.stderr };
}
const advance = (to, phases, extra = []) =>
  state(["advance", "--to", to, "--agent", "smoke", ...(phases ? ["--phases", phases] : []), ...extra]);
const phase = () => state(["read"]).json?.state?.phase;

console.log("\nSmoke test: phase advances follow the workflow's phase sequence\n");

const PLANNING_ONLY = "intake,discovery,planning,acceptance,snapshot,closed";
const SW_DEV = "intake,discovery,planning,execution,acceptance,snapshot,closed";

// 1. Planning-only workflow: no execution phase.
state(["init"]);
for (const to of ["intake", "discovery", "planning", "acceptance", "snapshot", "closed"]) {
  const r = advance(to, PLANNING_ONLY);
  assert(`planning-only: advance to ${to}`, r.json?.ok === true && phase() === to, JSON.stringify(r.json?.error ?? r.err));
}
const back = advance("planning", PLANNING_ONLY);
assert("planning-only: closed -> planning is rejected", back.json?.ok === false && phase() === "closed", JSON.stringify(back.json));

// 2. Workflow with an execution phase: still has to pass through it.
state(["init"]);
for (const to of ["intake", "discovery", "planning"]) advance(to, SW_DEV);
const skip = advance("acceptance", SW_DEV);
assert("sw_dev: planning -> acceptance is rejected", skip.json?.ok === false && phase() === "planning", JSON.stringify(skip.json));
assert("sw_dev: the error names execution as expected", /Expected: "execution"/.test(skip.json?.error ?? ""), skip.json?.error);
assert("sw_dev: planning -> execution is accepted", advance("execution", SW_DEV).json?.ok === true && phase() === "execution");
advance("acceptance", SW_DEV); advance("snapshot", SW_DEV); advance("closed", SW_DEV);
const back2 = advance("planning", SW_DEV);
assert("sw_dev: closed -> planning is rejected", back2.json?.ok === false && phase() === "closed", JSON.stringify(back2.json));

// 3. Jumping ahead inside the sequence stays illegal; --force still overrides.
state(["init"]);
advance("intake", PLANNING_ONLY);
const jump = advance("planning", PLANNING_ONLY);
assert("planning-only: intake -> planning (skipping discovery) is rejected", jump.json?.ok === false && phase() === "intake", JSON.stringify(jump.json));
assert("--force overrides the sequence", advance("planning", PLANNING_ONLY, ["--force"]).json?.ok === true && phase() === "planning");

// 4. Without --phases the canonical chain applies (state CLI used standalone).
state(["init"]);
for (const to of ["intake", "discovery", "planning"]) advance(to);
const canon = advance("acceptance");
assert("no --phases: planning -> acceptance is rejected (canonical chain)", canon.json?.ok === false && /Expected: "execution"/.test(canon.json?.error ?? ""), JSON.stringify(canon.json));
assert("no --phases: planning -> execution is accepted", advance("execution").json?.ok === true);

// 5. Bad --phases values are usage errors and write nothing.
const badPhase = advance("acceptance", "planning,bogus");
assert("--phases with an unknown phase exits 2", badPhase.code === 2 && phase() === "execution", badPhase.err);
const badOrder = advance("acceptance", "acceptance,planning");
assert("--phases out of lifecycle order exits 2", badOrder.code === 2 && phase() === "execution", badOrder.err);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
