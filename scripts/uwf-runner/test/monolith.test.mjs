/**
 * monolith.test.mjs — automated tests for the monolith control-condition adapter (issue #102).
 *
 * Verifies:
 *   1. Prompt assembly (Round 1 / Round 2 rules embedded, all stages in order, inputs/outputs,
 *      gate conditions, prohibition of CLI state offloading, permission merging, token estimate).
 *   2. Single-session execution via a deterministic fake/mock underlying harness (invoked once).
 *   3. Post-hoc gate evaluation across gated, conditional (skipped vs triggered), ungated,
 *      and failing stages, computing first_try_pass_rate identically to the CLI runner.
 *   4. Transcript and metrics JSON output (`monolith-metrics.json` + `<dataDir>/transcripts/`).
 *   5. Standard Adapter contract (`invokeStage`, backend resolution, recursion guard, error handling).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapter, ADAPTERS } from "../adapters/index.mjs";
import {
  ROUND1_ROUND2_RULES,
  assembleMonolithPrompt,
  evaluateMonolithGates,
  mergePermissions,
  resolveBackendName,
  runMonolith,
} from "../adapters/monolith.mjs";
import { attemptUsage, transcriptRow } from "../cost.mjs";
import { markStage, readMarkEvents } from "../mark-stage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

let failures = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}\n${e.stack ?? e}`);
  }
}

console.log("# monolith control adapter tests");

await test("monolith is registered in ADAPTERS and loadable via loadAdapter", async () => {
  assert.ok(ADAPTERS.includes("monolith"), `ADAPTERS missing monolith: ${ADAPTERS}`);
  const mod = await loadAdapter("monolith");
  assert.equal(mod.name, "monolith");
  assert.equal(typeof mod.invokeStage, "function");
  assert.equal(typeof mod.runMonolith, "function");
  assert.equal(typeof mod.assembleMonolithPrompt, "function");
  assert.equal(typeof mod.evaluateMonolithGates, "function");
});

await test("mergePermissions selects highest required preset across stages", () => {
  assert.equal(mergePermissions(["read-only"]), "read-only");
  assert.equal(mergePermissions(["read-only", "read-only+review"]), "read-only+review");
  assert.equal(mergePermissions(["read-only", "edit", "read-only+review"]), "edit");
  assert.equal(mergePermissions(["edit", "edit+exec", "read-only"]), "edit+exec");
});

await test("resolveBackendName defaults cleanly and rejects self-recursion", () => {
  const prevBackend = process.env.UWF_MONOLITH_BACKEND;
  const prevFixture = process.env.UWF_FAKE_FIXTURE;
  const prevDir = process.env.UWF_FAKE_FIXTURE_DIR;
  delete process.env.UWF_MONOLITH_BACKEND;
  delete process.env.UWF_FAKE_FIXTURE;
  delete process.env.UWF_FAKE_FIXTURE_DIR;
  try {
    assert.equal(resolveBackendName({}), "claude-code");
    assert.equal(resolveBackendName({ env: { UWF_FAKE_FIXTURE: "/tmp/x.json" } }), "fake");
    assert.equal(resolveBackendName({ backend: "codex" }), "codex");
    assert.throws(() => resolveBackendName({ backend: "monolith" }), /cannot use "monolith"/);
    assert.throws(() => resolveBackendName({ backend: "bogus" }), /Unknown monolith backend/);
  } finally {
    if (prevBackend !== undefined) process.env.UWF_MONOLITH_BACKEND = prevBackend;
    if (prevFixture !== undefined) process.env.UWF_FAKE_FIXTURE = prevFixture;
    if (prevDir !== undefined) process.env.UWF_FAKE_FIXTURE_DIR = prevDir;
  }
});

await test("assembleMonolithPrompt bundles all stages, Round 1/Round 2 rules, and gate criteria", async () => {
  const stages = [
    { name: "intake", gated: true, conditional: false, maxRetries: 2, maxTurns: 15, onGateFailure: "retry", advancesTo: "intake" },
    { name: "adr", gated: true, conditional: true, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: null },
    { name: "implementation", gated: true, conditional: false, maxRetries: 1, maxTurns: 30, onGateFailure: "retry", advancesTo: "execution" },
    { name: "review", gated: true, conditional: false, maxRetries: 3, maxTurns: 20, onGateFailure: "retry", onVerdict: { changes_requested: { routeTo: "implementation", maxRoundTrips: 2 } }, advancesTo: null },
    { name: "retro", gated: false, conditional: false, maxRetries: 1, maxTurns: 10, onGateFailure: "skip", advancesTo: "closed" },
  ];

  const fakeMaterialize = async ({ stage, outputPath }) => ({
    agentName: `agent-${stage}`,
    systemPrompt: `Instructions for ${stage}: write outputs to ${outputPath}.`,
    prompt: `Run the ${stage} stage for the sw_dev workflow.\n\nContext:\n${JSON.stringify({
      workflow: "sw_dev",
      stage_type: stage === "intake" ? "intake" : null,
      trait_ids: stage === "intake" ? ["sw_dev"] : [],
      behavior_policy: { must_address: ["Objective"] },
      steering_policy: { instruction_density: "standard" },
    }, null, 2)}\n\n## Inputs\n- (none)\n\n## Required outputs\n- ${outputPath}/${stage}-out.md\n`,
    permissions: stage === "implementation" ? "edit+exec" : stage === "review" ? "read-only+review" : "edit",
    allowedCommands: stage === "review" ? ["node .github/skills/uwf-review/reviews.mjs"] : [],
    inputs: stage === "intake" ? [] : [`${outputPath}/${stage}-in.md`],
    outputsRequired: [`${outputPath}/${stage}-out.md`],
  });

  const gateChecksByStage = {
    intake: [{ type: "require_non_empty", prescription: "Write a non-empty file at /out/intake-out.md." }],
    review: [{ type: "require_json_field", prescription: "Write /out/review.result.json with /verdict equal to \"approved\"." }],
  };
  const conditionsByStage = {
    adr: { type: "file_contains", path: "/out/issues-requirements.md", text: "ADR:" },
  };

  const assembled = await assembleMonolithPrompt({
    workflow: "sw_dev",
    stages,
    repoRoot: "/repo",
    skillsRoot: "/skills",
    outputPath: "/out",
    dataDir: "/data",
    goal: "Implement feature X with unit tests",
    gateChecksByStage,
    conditionsByStage,
    materializeFn: fakeMaterialize,
  });

  assert.equal(assembled.stageCount, 5);
  assert.deepEqual(assembled.stageNames, ["intake", "adr", "implementation", "review", "retro"]);
  assert.equal(assembled.permissions, "edit+exec");
  assert.equal(assembled.totalMaxTurns, 85);
  assert.deepEqual(assembled.allowedCommands, ["node .github/skills/uwf-review/reviews.mjs"]);
  assert.deepEqual(assembled.embeddedRules, ROUND1_ROUND2_RULES.map((r) => r.id));
  assert.ok(assembled.approxPromptTokens > 0);

  // Verify Round 1 / Round 2 rules are explicitly documented in systemPrompt
  for (const rule of ROUND1_ROUND2_RULES) {
    assert.ok(assembled.systemPrompt.includes(rule.id), `systemPrompt missing rule id ${rule.id}`);
  }
  assert.match(assembled.systemPrompt, /Do NOT invoke stage-tracker\.mjs, state\.mjs, run\.mjs, or questions\.mjs/);

  // Verify materialized Context (trait_ids, behavior_policy, steering_policy) and conditional predicate are embedded
  assert.ok(assembled.prompt.includes('"trait_ids"'), "assembled prompt must embed materialized Context JSON");
  assert.ok(assembled.prompt.includes('"behavior_policy"'), "assembled prompt must embed behavior_policy");
  assert.ok(assembled.prompt.includes('"steering_policy"'), "assembled prompt must embed steering_policy");
  assert.ok(assembled.prompt.includes("file_contains"), "assembled prompt must include conditional trigger type");
  assert.ok(assembled.prompt.includes("ADR:"), "assembled prompt must include conditional trigger text");
  assert.equal((assembled.prompt.match(/^Run the \S+ stage for the/gm) ?? []).length, 1, "only top-level monolith stage line may start with Run the ...");

  // Verify prompt starts with cost.mjs-compatible stage line and contains all stages in order
  assert.match(assembled.prompt, /^Run the monolith stage for the sw_dev workflow\./);
  assert.ok(assembled.prompt.includes("Implement feature X with unit tests"));
  assert.ok(assembled.prompt.includes("Write a non-empty file at /out/intake-out.md."));
  assert.ok(assembled.prompt.includes("changes_requested -> implementation (max_round_trips: 2)"));

  const idxIntake = assembled.prompt.indexOf("## Stage 1/5: intake");
  const idxAdr = assembled.prompt.indexOf("## Stage 2/5: adr");
  const idxImpl = assembled.prompt.indexOf("## Stage 3/5: implementation");
  const idxReview = assembled.prompt.indexOf("## Stage 4/5: review");
  const idxRetro = assembled.prompt.indexOf("## Stage 5/5: retro");
  assert.ok(idxIntake > 0 && idxIntake < idxAdr && idxAdr < idxImpl && idxImpl < idxReview && idxReview < idxRetro, "stages must appear in authoritative order");
});

await test("runMonolith executes single session via fake backend, evaluates all gates post-hoc, and writes metrics + transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "uwf-monolith-pass-"));
  const repoRoot = join(root, "repo");
  const dataDir = join(root, "data");
  const outputPath = join(root, "artifacts");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(outputPath, { recursive: true });

  try {
    const stages = [
      { name: "intake", gated: true, conditional: false, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: "intake" },
      { name: "adr", gated: true, conditional: true, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: null },
      { name: "work-plan", gated: true, conditional: false, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: "planning" },
      { name: "retro", gated: false, conditional: false, maxRetries: 1, maxTurns: 10, onGateFailure: "skip", advancesTo: "closed" },
    ];

    let invokeCount = 0;
    let receivedOpts = null;
    const mockBackend = {
      name: "mock-harness",
      async invokeStage(opts) {
        invokeCount++;
        receivedOpts = opts;
        writeFileSync(join(outputPath, "issues-intake.md"), "# Intake\nObjective: test\n");
        markStage("intake", { dataDir, outputPath, repoRoot });
        writeFileSync(join(outputPath, "issues-plan.md"), "# Plan\nSteps...\n");
        markStage("work-plan", { dataDir, outputPath, repoRoot });
        writeFileSync(join(outputPath, "issues-retro.md"), "# Retro\nDone.\n");
        markStage("retro", { dataDir, outputPath, repoRoot });
        const fakeAdapter = await loadAdapter("fake");
        const fixturePath = join(root, "monolith-fixture.json");
        writeFileSync(fixturePath, JSON.stringify({
          transcript: "Completed all stages in one session.",
          sessionId: "mono-sess-001",
          claudeResult: {
            num_turns: 12,
            total_cost_usd: 0.42,
            usage: { input_tokens: 1500, output_tokens: 600, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 },
          },
        }));
        return fakeAdapter.invokeStage({ ...opts, env: { ...opts.env, UWF_FAKE_FIXTURE: fixturePath } });
      },
    };

    const trackerCalls = [];
    const stateCalls = [];
    const mockCli = (script, args) => {
      if (script === "TRACKER") {
        trackerCalls.push(args);
        if (args[0] === "gate-prescriptions") {
          return {
            ok: true,
            data: {
              workflow: "sw_dev",
              stages: [
                { stage: "intake", checks: [{ type: "require_non_empty", prescription: "Write issues-intake.md." }] },
                { stage: "work-plan", checks: [{ type: "require_non_empty", prescription: "Write issues-plan.md." }] },
              ],
            },
          };
        }
        return { ok: true, data: { ok: true } };
      }
      if (script === "STATE") {
        stateCalls.push(args);
        if (args[0] === "read") return { ok: true, data: { state: { phase: "idea" } } };
        return { ok: true, data: { ok: true } };
      }
      if (script === "RUN_SCRIPT" && args[0] === "--check-gate") {
        const st = args[1];
        const outIdx = args.indexOf("--output-path");
        const checkOut = outIdx !== -1 ? args[outIdx + 1] : outputPath;
        if (st === "intake") {
          const ok = existsSync(join(checkOut, "issues-intake.md"));
          return ok ? { ok: true, data: { stage: st, passed: true, failures: [], prescriptions: [] } }
            : { ok: false, data: { stage: st, passed: false, failures: ["Missing: issues-intake.md"], prescriptions: ["Write issues-intake.md."] } };
        }
        if (st === "adr") {
          return { ok: true, data: { stage: st, passed: true, failures: [], prescriptions: [], note: "conditional — not required" } };
        }
        if (st === "work-plan") {
          const ok = existsSync(join(checkOut, "issues-plan.md"));
          return ok ? { ok: true, data: { stage: st, passed: true, failures: [], prescriptions: [] } }
            : { ok: false, data: { stage: st, passed: false, failures: ["Missing: issues-plan.md"], prescriptions: ["Write issues-plan.md."] } };
        }
        if (st === "retro") {
          return { ok: true, data: { stage: st, passed: true, failures: [], prescriptions: [], note: "ungated — always passes" } };
        }
      }
      return { ok: true, data: {} };
    };

    const fakeMaterialize = async ({ stage }) => ({
      agentName: `agent-${stage}`,
      systemPrompt: `Do ${stage}.`,
      permissions: "edit",
      allowedCommands: [],
      inputs: [],
      outputsRequired: [`${outputPath}/issues-${stage}.md`],
    });

    const result = await runMonolith({
      workflow: "sw_dev",
      stages,
      runScript: "RUN_SCRIPT",
      trackerScript: "TRACKER",
      stateScript: "STATE",
      repoRoot,
      skillsRoot: repoRoot,
      outputPath,
      dataDir,
      goal: "Build feature X",
      flags: { model: "claude-opus-5-5" },
      cli: mockCli,
      log: () => {},
      backendAdapter: mockBackend,
      materializeFn: fakeMaterialize,
    });

    // Single-session invariant: backend invoked strictly ONCE
    assert.equal(invokeCount, 1, "monolith must invoke backend exactly once");
    assert.equal(receivedOpts.stage, "monolith");
    assert.equal(receivedOpts.model, "claude-opus-5-5");

    // Exit code & gate summary
    assert.equal(result.exitCode, 0);
    assert.equal(result.metrics.summary.totalStages, 4);
    assert.equal(result.metrics.summary.gatedEvaluated, 2); // intake + work-plan (adr skipped, retro ungated)
    assert.equal(result.metrics.summary.gatedPassed, 2);
    assert.equal(result.metrics.summary.skippedStages, 1);
    assert.equal(result.metrics.summary.ungatedStages, 1);
    assert.equal(result.metrics.summary.firstTryPassRate, 1);

    // Stage tracker recorded stage-complete / stage-skip post-hoc & state lock released
    assert.ok(trackerCalls.some((a) => a[0] === "stage-complete" && a.includes("intake")));
    assert.ok(trackerCalls.some((a) => a[0] === "stage-skip" && a.includes("adr")));
    assert.ok(trackerCalls.some((a) => a[0] === "stage-complete" && a.includes("work-plan")));
    assert.ok(trackerCalls.some((a) => a[0] === "stage-complete" && a.includes("retro")));
    assert.ok(stateCalls.some((a) => a[0] === "release-agent"), "runMonolith must release agent lock");

    // Metrics JSON persisted and readable
    assert.ok(existsSync(result.metricsPath));
    const savedMetrics = JSON.parse(readFileSync(result.metricsPath, "utf8"));
    assert.equal(savedMetrics.adapter, "monolith");
    assert.equal(savedMetrics.backend, "mock-harness");
    assert.equal(savedMetrics.costUsd, 0.42);
    assert.equal(savedMetrics.summary.firstTryPassRate, 1);

    // Transcript exists and is parseable by cost.mjs
    assert.ok(result.sessionResult.transcriptPath && existsSync(result.sessionResult.transcriptPath));
    const parsedCost = transcriptRow("t.json", JSON.parse(readFileSync(result.sessionResult.transcriptPath, "utf8")));
    assert.equal(parsedCost.stage, "monolith");
    assert.equal(parsedCost.turns, 12);
    assert.equal(parsedCost.cost, 0.42);
    assert.equal(attemptUsage(result.sessionResult.transcriptPath).cost, 0.42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("assembleMonolithPrompt embeds real materializePrompt context (trait_ids, policies) and sw_dev conditional predicates", async () => {
  const root = mkdtempSync(join(tmpdir(), "uwf-monolith-real-prompt-"));
  const dataDir = join(root, "data");
  const outputPath = join(root, "artifacts");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outputPath, { recursive: true });
  try {
    const stages = [
      { name: "intake", gated: true, conditional: false, maxRetries: 2, maxTurns: 20, onGateFailure: "retry", advancesTo: "intake" },
      { name: "adr", gated: true, conditional: true, maxRetries: 2, maxTurns: 20, onGateFailure: "retry", advancesTo: null },
      { name: "security-plan", gated: true, conditional: true, maxRetries: 2, maxTurns: 20, onGateFailure: "retry", advancesTo: null },
    ];
    const assembled = await assembleMonolithPrompt({
      workflow: "sw_dev",
      stages,
      repoRoot: REPO_ROOT,
      skillsRoot: REPO_ROOT,
      outputPath,
      dataDir,
      goal: "Verify real stage context injection",
    });
    assert.ok(assembled.prompt.includes('"trait_ids"'), "sw_dev intake must embed trait_ids");
    assert.ok(assembled.prompt.includes('"sw_dev"'), "sw_dev intake must include sw_dev trait");
    assert.ok(assembled.prompt.includes('"behavior_policy"'), "must embed behavior_policy");
    assert.ok(assembled.prompt.includes('"steering_policy"'), "must embed steering_policy");
    assert.ok(assembled.prompt.includes('"ADR:"'), "adr stage must expose ADR: condition marker");
    assert.ok(assembled.prompt.includes("security-sensitive: true"), "security-plan stage must expose security marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("runMonolith scores firstTryPass from first mark-stage snapshot and flags unmarked stages as never_marked", async () => {
  const root = mkdtempSync(join(tmpdir(), "uwf-monolith-snap-"));
  const repoRoot = join(root, "repo");
  const dataDir = join(root, "data");
  const outputPath = join(root, "artifacts");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(outputPath, { recursive: true });

  try {
    const stages = [
      { name: "intake", gated: true, conditional: false, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: "intake" },
      { name: "discovery", gated: true, conditional: false, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: "discovery" },
      { name: "work-plan", gated: true, conditional: false, maxRetries: 2, maxTurns: 10, onGateFailure: "retry", advancesTo: "planning" },
    ];

    const mockBackend = {
      name: "mock-repair",
      async invokeStage(opts) {
        // 1. intake: mark with EMPTY file first (fails snapshot 1), then repair and mark again (passes snapshot 2 & end)
        writeFileSync(join(outputPath, "issues-intake.md"), "");
        markStage("intake", { dataDir, outputPath, repoRoot });
        writeFileSync(join(outputPath, "issues-intake.md"), "# Intake\nObjective: fixed\n");
        markStage("intake", { dataDir, outputPath, repoRoot });

        // 2. discovery: valid at first mark -> firstTryPass: true
        writeFileSync(join(outputPath, "issues-discovery.md"), "# Discovery\nValid\n");
        markStage("discovery", { dataDir, outputPath, repoRoot });

        // 3. work-plan: written at end of session WITHOUT markStage -> never_marked -> firstTryPass: false!
        writeFileSync(join(outputPath, "issues-plan.md"), "# Plan\nNever marked\n");

        return { ok: true, sessionId: "mono-snap-1", transcriptPath: null, stdout: "Done", exitCode: 0, usage: null };
      },
    };

    const mockCli = (script, args, extra = []) => {
      if (script === "TRACKER") return { ok: true, data: { workflow: "sw_dev", stages: [] } };
      if (script === "STATE") {
        if (args[0] === "read") return { ok: true, data: { state: { phase: "idea" } } };
        return { ok: true, data: { ok: true } };
      }
      if (script === "RUN_SCRIPT" && args[0] === "--check-gate") {
        const st = args[1];
        const outIdx = extra.indexOf("--output-path");
        const checkOut = outIdx !== -1 ? extra[outIdx + 1] : outputPath;
        const fileMap = { intake: "issues-intake.md", discovery: "issues-discovery.md", "work-plan": "issues-plan.md" };
        const p = join(checkOut, fileMap[st]);
        const ok = existsSync(p) && readFileSync(p, "utf8").trim().length > 0;
        return ok
          ? { ok: true, data: { stage: st, passed: true, failures: [], prescriptions: [] } }
          : { ok: false, data: { stage: st, passed: false, failures: [`Empty/Missing: ${fileMap[st]}`], prescriptions: ["Write non-empty output"] } };
      }
      return { ok: true, data: {} };
    };

    const fakeMaterialize = async ({ stage }) => ({
      agentName: `agent-${stage}`,
      systemPrompt: `Do ${stage}.`,
      permissions: "edit",
      allowedCommands: [],
      inputs: [],
      outputsRequired: [`${outputPath}/${stage}.md`],
    });

    const result = await runMonolith({
      workflow: "sw_dev",
      stages,
      runScript: "RUN_SCRIPT",
      trackerScript: "TRACKER",
      stateScript: "STATE",
      repoRoot,
      skillsRoot: repoRoot,
      outputPath,
      dataDir,
      goal: "Test snapshot scoring",
      cli: mockCli,
      log: () => {},
      backendAdapter: mockBackend,
      materializeFn: fakeMaterialize,
    });

    assert.equal(result.exitCode, 0, "final end-of-session gates all pass");
    assert.equal(result.metrics.summary.gatedEvaluated, 3);
    assert.equal(result.metrics.summary.gatedPassed, 3);
    assert.equal(result.metrics.summary.firstTryPassed, 1);
    assert.equal(result.metrics.summary.neverMarkedStages, 1);
    assert.ok(Math.abs(result.metrics.summary.firstTryPassRate - 1 / 3) < 1e-9, `expected 1/3 firstTryPassRate, got ${result.metrics.summary.firstTryPassRate}`);

    const byStage = Object.fromEntries(result.metrics.stages.map((s) => [s.stage, s]));
    assert.equal(byStage.intake.passed, true);
    assert.equal(byStage.intake.firstTryPass, false, "late repair must NOT inflate firstTryPass");
    assert.equal(byStage.intake.neverMarked, false);
    assert.equal(byStage.intake.retriesToPass, 1);
    assert.equal(byStage.discovery.firstTryPass, true);
    assert.equal(byStage["work-plan"].passed, true);
    assert.equal(byStage["work-plan"].neverMarked, true);
    assert.equal(byStage["work-plan"].firstTryPass, false, "never_marked stage must count as first-try failure");
    assert.equal(readMarkEvents(dataDir).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("evaluateMonolithGates scores partial gate failures accurately without short-circuiting", async () => {
  const stages = [
    { name: "intake", gated: true, conditional: false, advancesTo: "intake" },
    { name: "discovery", gated: true, conditional: false, advancesTo: "discovery" },
    { name: "review", gated: true, conditional: false, advancesTo: null },
    { name: "retro", gated: false, conditional: false, advancesTo: "closed" },
  ];

  const mockCli = (script, args) => {
    if (script === "RUN_SCRIPT" && args[0] === "--check-gate") {
      if (args[1] === "intake") return { ok: true, data: { stage: "intake", passed: true, failures: [], prescriptions: [] } };
      if (args[1] === "discovery") {
        return {
          ok: false,
          data: {
            stage: "discovery",
            passed: false,
            failures: ["Missing: issues-discovery.md"],
            prescriptions: ["Write a non-empty file at /out/issues-discovery.md."],
          },
        };
      }
      if (args[1] === "review") {
        return {
          ok: false,
          data: {
            stage: "review",
            passed: false,
            failures: ["pointer /verdict: observed \"changes_requested\", expected equals \"approved\""],
            prescriptions: ["Do not rewrite verdict."],
            verdict: "changes_requested",
          },
        };
      }
      if (args[1] === "retro") return { ok: true, data: { stage: "retro", passed: true, failures: [], prescriptions: [], note: "ungated — always passes" } };
    }
    return { ok: true, data: { ok: true } };
  };

  const ev = await evaluateMonolithGates({
    workflow: "sw_dev",
    stages,
    runScript: "RUN_SCRIPT",
    trackerScript: "TRACKER",
    stateScript: null,
    outputPath: "/out",
    dataDir: "/data",
    sessionOk: true,
    cli: mockCli,
  });

  assert.equal(ev.allPassed, false);
  assert.equal(ev.summary.gatedEvaluated, 3);
  assert.equal(ev.summary.gatedPassed, 1);
  assert.ok(Math.abs(ev.summary.firstTryPassRate - 1 / 3) < 1e-9);
  assert.equal(ev.stages[0].firstTryPass, true);
  assert.equal(ev.stages[1].firstTryPass, false);
  assert.deepEqual(ev.stages[1].failures, ["Missing: issues-discovery.md"]);
  assert.equal(ev.stages[2].verdict, "changes_requested");
  assert.equal(ev.stages[3].passed, true);
});

await test("monolith invokeStage satisfies standard Adapter contract with fake backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "uwf-monolith-contract-"));
  const cwd = join(root, "work");
  const dataDir = join(root, "data");
  mkdirSync(cwd, { recursive: true });
  const fixturePath = join(root, "fx.json");
  writeFileSync(fixturePath, JSON.stringify({
    files: { "out/result.md": "# monolith done\n" },
    transcript: "OK",
    sessionId: "mono-contract-1",
  }));

  try {
    const adapter = await loadAdapter("monolith");
    const r = await adapter.invokeStage(
      { prompt: "Run all stages", cwd, dataDir, backend: "fake", permissions: "edit" },
      { fixture: fixturePath },
    );
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.sessionId, "mono-contract-1");
    assert.equal(r.stdout, "OK");
    assert.ok(r.transcriptPath && existsSync(r.transcriptPath));
    assert.ok(existsSync(join(cwd, "out", "result.md")));

    // Invalid backend returns ok:false without throwing
    const bad = await adapter.invokeStage({ prompt: "x", cwd, dataDir, backend: "monolith" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /cannot use "monolith"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("markStage handles nested dataDir inside repoRoot and invokeStage honors UWF_MONOLITH_MARK_STAGE=none", async () => {
  const root = mkdtempSync(join(tmpdir(), "uwf-mark-nested-"));
  const nestedData = join(root, "nested", "uwf-data");
  const outDir = join(nestedData, "workflow-artifacts");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(root, "src.js"), "console.log('hi');\n");
  writeFileSync(join(outDir, "issues-intake.md"), "# Intake\nOk\n");

  try {
    const ev = markStage("intake", {
      dataDir: nestedData,
      outputPath: outDir,
      repoRoot: root,
      cwdPaths: ["docs/adr"],
      snapshotWorkspace: true,
    });
    assert.equal(ev.seq, 1);
    assert.ok(existsSync(join(ev.repoSnapshotDir, "src.js")), "workspace source copied despite nested dataDir");
    assert.ok(!existsSync(join(ev.repoSnapshotDir, "nested", "uwf-data")), "nested dataDir excluded from snapshot");

    // Verify invokeStage respects UWF_MONOLITH_MARK_STAGE=none
    const adapter = await loadAdapter("monolith");
    let capturedSystem = "";
    const fakeBackend = {
      name: "cap",
      async invokeStage(o) { capturedSystem = o.systemPrompt; return { ok: true, sessionId: "s", transcriptPath: null, stdout: "", exitCode: 0, usage: null }; },
    };
    await adapter.invokeStage(
      { prompt: "p", cwd: root, dataDir: nestedData, env: { UWF_MONOLITH_MARK_STAGE: "none" } },
      { backendAdapter: fakeBackend },
    );
    assert.ok(!capturedSystem.includes("Mark-stage command:"), "none disables mark-stage instruction");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failures) {
  console.log(`\n${failures} monolith test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll monolith tests passed");
