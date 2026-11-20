/**
 * UAW Monolith Control Adapter — single long-prompt control condition without CLI state offloading (issue #102).
 *
 * Represents the Round 1 / Round 2 single-session orchestrator behavior documented in
 * `docs/guide/copilot-orchestrator.md` and specified in `docs/research/cli-offload-design.md` (§3.1):
 *   - One session receives the full stage sequence, every stage's materialized context (`trait_ids`,
 *     policies, inputs/outputs), agent instructions, conditional predicates, and gate criteria in a
 *     single long prompt.
 *   - The model self-tracks workflow state, phase transitions, retries, and review fix-loops in
 *     context without calling `stage-tracker.mjs`, `state.mjs`, `run.mjs`, or `questions.mjs`.
 *   - As the model completes each stage, it runs `mark-stage.mjs <stageName>`, capturing an
 *     immutable point-in-time snapshot of gate-visible paths.
 *   - After the single session finishes, `evaluateMonolithGates()` scores `firstTryPass` against each
 *     stage's FIRST stage-completion snapshot (flagging unmarked stages as `never_marked` first-try
 *     failures per `cli-offload-design.md` §3.1) and evaluates end-of-session gates via
 *     `run.mjs --check-gate <stage>`.
 *
 * Underlying execution backend (configurable via `--backend`, `opts.backend`, or `UWF_MONOLITH_BACKEND`):
 *   - Defaults to `claude-code` (or `fake` when `UWF_FAKE_FIXTURE` / `UWF_FAKE_FIXTURE_DIR` is set).
 *   - Supports any non-monolith harness adapter (`claude-code`, `codex`, `fake`, `grokbot`) or an
 *     injected `backendAdapter` object for deterministic testing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, buildSystemPrompt, loadAdapter, resolveDataDir, writeTranscript } from "./index.mjs";
import { materializePrompt } from "../prompt.mjs";
import { attemptUsage } from "../cost.mjs";
import { markStage, parseCwdPaths, readMarkEvents } from "../mark-stage.mjs";

export const name = "monolith";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_REPO_ROOT = resolve(HERE, "..", "..", "..");
export const MARK_STAGE_SCRIPT = resolve(HERE, "..", "mark-stage.mjs");

const CHARS_PER_TOKEN = 4;
const DEFAULT_STAGE_MAX_TURNS = 20;
const AGENT_ID = "uwf-runner-monolith";

/**
 * Explicit Round 1 / Round 2 orchestrator rules embedded in the monolith control prompt.
 * Derived from `docs/guide/copilot-orchestrator.md` and `docs/research/cli-offload-design.md` (§3.1).
 */
export const ROUND1_ROUND2_RULES = Object.freeze([
  Object.freeze({
    id: "authoritative-stage-order",
    title: "Authoritative Stage Sequence",
    source: "docs/guide/copilot-orchestrator.md (§Startup Procedure, §Violations to Avoid)",
    rule: "Execute every stage in the exact order listed in the Authoritative Stage Sequence below. Never skip, reorder, merge, or substitute stages from memory.",
  }),
  Object.freeze({
    id: "self-tracked-state-no-cli",
    title: "Self-Tracked Workflow State (No CLI State Offloading)",
    source: "docs/research/cli-offload-design.md (§3.1); control counterpart to docs/guide/copilot-orchestrator.md (§Recorded stage transitions)",
    rule: "Track the active stage, current workflow phase, produced artifacts, retry counts, and review round-trip counts in your own context. Do NOT invoke stage-tracker.mjs, state.mjs, run.mjs, or questions.mjs to offload state or gate decisions.",
  }),
  Object.freeze({
    id: "self-judged-gates-and-retries",
    title: "Self-Judged Stage Gates and Gate Failure Retry Protocol",
    source: "docs/guide/copilot-orchestrator.md (§Gate Failure Protocol); docs/research/cli-offload-design.md (§3.1)",
    rule: "Before advancing from stage N to stage N+1, verify every listed gate check for stage N yourself. If any check fails, revise the stage outputs and re-check up to max_retries (default 2), honoring each stage's on_gate_failure policy (retry, abort, or skip).",
  }),
  Object.freeze({
    id: "explicit-conditional-evaluation",
    title: "Explicit Conditional Stage Evaluation",
    source: "docs/guide/copilot-orchestrator.md (§Chat-Runtime Principles #4)",
    rule: "Never skip conditional stages (such as adr or security-plan) from memory. Explicitly inspect the declared trigger condition against the prerequisite artifact: if triggered, execute the stage and write its outputs; if absent, record that the stage is not required and continue.",
  }),
  Object.freeze({
    id: "review-fix-loop-routing",
    title: "Review Fix-Loop (on_verdict) Self-Routing",
    source: "docs/guide/copilot-orchestrator.md (§Review Fix-Loop Protocol)",
    rule: "When a review or acceptance stage finds blocking defects (verdict: changes_requested in both markdown and .result.json), do not rewrite the verdict to pass the gate. Route back to the declared route_to stage (for example, implementation), fix the findings, and re-run forward through review up to max_round_trips (default 2, max 3 total review cycles).",
  }),
  Object.freeze({
    id: "single-session-continuity-no-simulation",
    title: "Single-Session Continuity and Anti-Simulation Guardrails",
    source: "docs/guide/copilot-orchestrator.md (§Chat-Runtime Principles #6, §Violations to Avoid)",
    rule: "Complete the entire workflow in this single continuous session without yielding between stages, without narrating or simulating stage work instead of writing real files, without emitting internal hand-off footers (Current Stage/Phase: / Recommended Next Stage/Phase:), and without producing a final completion summary before every required stage output exists on disk.",
  }),
]);

export const MARK_STAGE_RULE = Object.freeze({
  id: "stage-completion-marking",
  title: "Stage-Completion Event Marking",
  source: "docs/research/cli-offload-design.md (§3.1)",
  rule: "Immediately after you consider a stage complete (and again if you later revise that stage on a retry or review fix-loop), run the configured mark-stage command with the exact stage name.",
});

export const PERMISSION_RANK = Object.freeze(["read-only", "read-only+review", "edit", "edit+exec"]);

/** Merge per-stage permission presets into the minimal preset covering all stages in one session. */
export function mergePermissions(perms) {
  let maxIdx = 0;
  for (const p of perms ?? []) {
    const idx = PERMISSION_RANK.indexOf(p);
    if (idx > maxIdx) maxIdx = idx;
  }
  return PERMISSION_RANK[maxIdx];
}

/** Resolve the underlying harness adapter name used to execute the single monolith session. */
export function resolveBackendName(opts = {}) {
  const explicit = opts.backend ?? opts.env?.UWF_MONOLITH_BACKEND ?? process.env.UWF_MONOLITH_BACKEND;
  if (explicit) {
    if (explicit === name) {
      throw new Error(`monolith adapter cannot use "${name}" as its own backend`);
    }
    if (!ADAPTERS.includes(explicit)) {
      throw new Error(`Unknown monolith backend "${explicit}". Available: ${ADAPTERS.filter((a) => a !== name).join(", ")}`);
    }
    return explicit;
  }
  const hasFake = Boolean(
    opts.env?.UWF_FAKE_FIXTURE ||
    opts.env?.UWF_FAKE_FIXTURE_DIR ||
    process.env.UWF_FAKE_FIXTURE ||
    process.env.UWF_FAKE_FIXTURE_DIR,
  );
  return hasFake ? "fake" : "claude-code";
}

function shellQuoteArg(s) {
  const str = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

export function resolveMarkStageCmd({ flags = {}, env } = {}) {
  const explicit = flags["mark-stage-cmd"] ?? env?.UWF_MONOLITH_MARK_STAGE ?? process.env.UWF_MONOLITH_MARK_STAGE;
  if (explicit !== undefined) {
    if (explicit === false || explicit === null) return null;
    const trimmed = String(explicit).trim();
    if (!trimmed || /^(none|off|false)$/i.test(trimmed)) return null;
    return trimmed;
  }
  return `node ${shellQuoteArg(MARK_STAGE_SCRIPT)}`;
}

/** Format the Round 1 / Round 2 orchestrator rules block embedded in the control system prompt. */
export function formatControlRules({ markStageCmd } = {}) {
  const activeRules = markStageCmd ? [...ROUND1_ROUND2_RULES, MARK_STAGE_RULE] : [...ROUND1_ROUND2_RULES];
  const lines = [
    "# UAW Monolith Control Orchestrator (Round 1 / Round 2 Baseline)",
    "",
    "You are running a Universal Agentic Workflow (UAW) in single-session monolith control mode.",
    "All stage instructions, ordering, inputs, outputs, and gate criteria are provided in this single prompt.",
    "Enforce the following Round 1 / Round 2 orchestrator rules strictly:",
    "",
  ];
  activeRules.forEach((r, idx) => {
    lines.push(`${idx + 1}. **${r.title}** [\`${r.id}\`] (${r.source}): ${r.rule}`);
  });
  if (markStageCmd) {
    lines.push("", `Mark-stage command: \`${markStageCmd} <stageName>\``);
  }
  return { text: lines.join("\n"), embeddedRules: activeRules.map((r) => r.id) };
}

function formatOnVerdict(onVerdict) {
  if (!onVerdict || typeof onVerdict !== "object") return "none";
  return Object.entries(onVerdict)
    .map(([verdict, rule]) => `${verdict} -> ${rule.routeTo} (max_round_trips: ${rule.maxRoundTrips})`)
    .join("; ");
}

function formatGateChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return ["- (none — ungated)"];
  return checks.map((c) => {
    if (c.prescription) return `- [${c.type}] ${c.prescription}`;
    const { type, label, ...rest } = c;
    return `- [${type}]${label ? ` (${label})` : ""} ${JSON.stringify(rest)}`;
  });
}

function resolveConditionTemplates(cond, { outputPath, repoRoot }) {
  if (!cond || typeof cond !== "object") return null;
  const subst = (v) =>
    typeof v === "string"
      ? v.replace(/\{\{output_path\}\}/g, outputPath ?? "./tmp/workflow-artifacts").replace(/\{\{cwd\}\}/g, repoRoot ?? ".")
      : v;
  return {
    ...cond,
    ...(typeof cond.path === "string" ? { path: subst(cond.path) } : {}),
    ...(typeof cond.file === "string" ? { file: subst(cond.file) } : {}),
  };
}

function formatCondition(cond) {
  if (!cond || typeof cond !== "object") return "unspecified (inspect prerequisite artifacts)";
  const target = cond.path ?? cond.file ?? "(unspecified path)";
  if (cond.type === "file_contains") {
    return `\`file_contains\` — run when \`${target}\` contains ${JSON.stringify(cond.text)} (${JSON.stringify(cond)})`;
  }
  if (cond.type === "file_contains_any") {
    return `\`file_contains_any\` — run when \`${target}\` contains any of ${JSON.stringify(cond.texts ?? [])} (${JSON.stringify(cond)})`;
  }
  return JSON.stringify(cond);
}

function loadYamlStageMeta(workflow, skillsRoot, repoRoot) {
  const candidates = [
    skillsRoot ? join(skillsRoot, ".github", "skills", `uwf-${workflow}`, "stages.yaml") : null,
    repoRoot ? join(repoRoot, ".github", "skills", `uwf-${workflow}`, "stages.yaml") : null,
    join(OWN_REPO_ROOT, ".github", "skills", `uwf-${workflow}`, "stages.yaml"),
  ].filter(Boolean);
  const yamlPath = candidates.find((p) => existsSync(p));
  if (!yamlPath) return { conditions: {}, runScriptStages: new Set(), rawPaths: [] };
  try {
    const req = createRequire(join(OWN_REPO_ROOT, ".github", "skills", "uwf-orchestration-engine", "stage-tracker.mjs"));
    const doc = req("js-yaml").load(readFileSync(yamlPath, "utf8"));
    const conditions = {};
    const runScriptStages = new Set();
    const rawPaths = [];
    for (const s of doc?.stages ?? []) {
      if (s.condition) conditions[s.name] = s.condition;
      for (const p of [...(s.inputs ?? []), ...(s.outputs ?? [])]) rawPaths.push(p);
      for (const c of s.gate?.checks ?? []) {
        if (c.type === "run_script") runScriptStages.add(s.name);
        if (c.path) rawPaths.push(c.path);
        if (c.dir) rawPaths.push(c.dir);
      }
    }
    return { conditions, runScriptStages, rawPaths };
  } catch {
    return { conditions: {}, runScriptStages: new Set(), rawPaths: [] };
  }
}

function extractCwdPathsFromMeta(rawPaths = []) {
  const dirs = new Set(["docs/adr"]);
  for (const raw of rawPaths) {
    if (typeof raw !== "string") continue;
    const m = raw.match(/\{\{cwd\}\}\/(.+)$/);
    if (!m) continue;
    const parts = m[1].split("/").filter(Boolean);
    const clean = [];
    for (const seg of parts) {
      if (/[*?[{]/.test(seg)) break;
      clean.push(seg);
    }
    if (!clean.length) continue;
    // If the trailing segment looks like a filename with an extension and there is a parent dir, snapshot its dir.
    if (clean.length > 1 && /\.[A-Za-z0-9]+$/.test(clean[clean.length - 1])) {
      clean.pop();
    }
    if (clean.length) dirs.add(clean.join("/"));
  }
  return [...dirs];
}

function stripStagePromptLead(promptText) {
  if (typeof promptText !== "string") return "";
  return promptText.replace(/^Run the [^\r\n]+ stage for the [^\r\n]+ workflow\.\r?\n+/, "").trim();
}

/**
 * Assemble one long prompt containing all stage instructions, materialized context, conditional
 * trigger predicates, ordering, inputs/outputs, gate criteria, and Round 1 / Round 2 orchestrator rules.
 */
export async function assembleMonolithPrompt({
  workflow,
  stages,
  repoRoot,
  skillsRoot,
  outputPath,
  dataDir,
  goal,
  modelProfile,
  gateChecksByStage = {},
  conditionsByStage = {},
  markStageCmd,
  materializeFn = materializePrompt,
}) {
  if (!workflow) throw new Error("assembleMonolithPrompt: workflow is required");
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("assembleMonolithPrompt: non-empty stages array is required");
  }

  const { text: controlHeader, embeddedRules } = formatControlRules({ markStageCmd });
  const yamlMeta = loadYamlStageMeta(workflow, skillsRoot, repoRoot);
  const stagePerms = [];
  const allAllowedCommands = [];
  const allInputs = [];
  const allOutputs = [];
  let totalMaxTurns = 0;

  if (markStageCmd) {
    allAllowedCommands.push(markStageCmd);
  }

  const sequenceLines = [];
  const stageSections = [];

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const mp = await materializeFn({
      workflow,
      stage: st.name,
      repoRoot,
      skillsRoot,
      outputPath,
      dataDir,
      modelProfile,
      extraContext: { goal },
    });

    stagePerms.push(mp.permissions ?? "edit");
    for (const cmd of mp.allowedCommands ?? []) allAllowedCommands.push(cmd);
    for (const inp of mp.inputs ?? []) allInputs.push(inp);
    for (const out of mp.outputsRequired ?? []) allOutputs.push(out);
    totalMaxTurns += Number.isInteger(st.maxTurns) && st.maxTurns > 0 ? st.maxTurns : DEFAULT_STAGE_MAX_TURNS;

    const rawCond = conditionsByStage[st.name] ?? st.condition ?? yamlMeta.conditions[st.name] ?? null;
    const resolvedCond = resolveConditionTemplates(rawCond, { outputPath, repoRoot });

    const flagsSummary = [
      st.gated === false ? "ungated" : "gated",
      st.conditional ? (resolvedCond ? `conditional (${resolvedCond.type})` : "conditional") : null,
      st.advancesTo ? `advances_phase_to: ${st.advancesTo}` : null,
      `max_retries: ${st.maxRetries ?? 2}`,
      `on_gate_failure: ${st.onGateFailure ?? "retry"}`,
      st.onVerdict ? `on_verdict: ${formatOnVerdict(st.onVerdict)}` : null,
    ].filter(Boolean).join(", ");

    sequenceLines.push(`${i + 1}. \`${st.name}\` (agent: \`${mp.agentName}\`; ${flagsSummary})`);

    const checks = gateChecksByStage[st.name] ?? st.gateChecks ?? st.checks ?? [];
    const embeddedStagePrompt = stripStagePromptLead(mp.prompt);
    const hasEmbeddedIo = Boolean(embeddedStagePrompt && /^##\s+Inputs\b/m.test(embeddedStagePrompt));

    const section = [
      `## Stage ${i + 1}/${stages.length}: ${st.name}`,
      `- Agent: \`${mp.agentName}\``,
      `- Gated: ${st.gated === false ? "false" : "true"}`,
      `- Conditional: ${st.conditional ? "true" : "false"}`,
      ...(st.conditional ? [`- Trigger condition: ${formatCondition(resolvedCond)}`] : []),
      `- Phase transition: ${st.advancesTo ?? "none"}`,
      `- On gate failure: ${st.onGateFailure ?? "retry"} (max_retries: ${st.maxRetries ?? 2})`,
      `- Review routing (on_verdict): ${formatOnVerdict(st.onVerdict)}`,
      "",
      ...(embeddedStagePrompt
        ? ["### Stage Context & Materialized Prompt", embeddedStagePrompt, ""]
        : []),
      ...(!hasEmbeddedIo
        ? [
            "### Inputs",
            ...(mp.inputs?.length ? mp.inputs.map((p) => `- ${p}`) : ["- (none)"]),
            "",
            "### Required Outputs",
            ...(mp.outputsRequired?.length ? mp.outputsRequired.map((p) => `- ${p}`) : ["- (none)"]),
            "",
          ]
        : []),
      "### Gate Conditions (self-verify before advancing)",
      ...formatGateChecks(checks),
      "",
      "### Stage Instructions",
      (mp.systemPrompt ?? "").trim() || "(no additional agent instructions)",
      "",
    ];
    stageSections.push(section.join("\n"));
  }

  const systemPrompt = controlHeader;
  const prompt = [
    `Run the monolith stage for the ${workflow} workflow.`,
    "",
    "# Goal",
    goal ?? "",
    "",
    `# Authoritative Stage Sequence (${stages.length} stages)`,
    ...sequenceLines,
    "",
    "# Stage Instructions and Gate Criteria",
    "",
    ...stageSections,
    "# Completion Protocol",
    "Execute every stage above in order, write every required output file to disk, self-verify every gate condition, " +
      "and do not call stage-tracker.mjs, state.mjs, run.mjs, or questions.mjs. " +
      (markStageCmd
        ? `Run \`${markStageCmd} <stageName>\` immediately upon completing each stage (and again after any retry revision). `
        : "") +
      "Only emit your final completion summary after all stages are finished.",
    "",
  ].join("\n");

  return {
    workflow,
    systemPrompt,
    prompt,
    permissions: mergePermissions(stagePerms),
    allowedCommands: [...new Set(allAllowedCommands)],
    inputs: [...new Set(allInputs)],
    outputs: [...new Set(allOutputs)],
    totalMaxTurns,
    stageCount: stages.length,
    stageNames: stages.map((s) => s.name),
    embeddedRules,
    promptChars: prompt.length,
    systemPromptChars: systemPrompt.length,
    approxPromptTokens: Math.round((prompt.length + systemPrompt.length) / CHARS_PER_TOKEN),
  };
}

function parseGateFailures(g) {
  const failures = Array.isArray(g.data?.failures) && g.data.failures.length
    ? g.data.failures
    : g.ok
      ? []
      : [g.error ?? "gate failed"];
  const prescriptions = Array.isArray(g.data?.prescriptions) && g.data.prescriptions.length
    ? g.data.prescriptions
    : failures;
  const verdict = typeof g.data?.verdict === "string" ? g.data.verdict : null;
  return { failures, prescriptions, verdict };
}

/**
 * Evaluate every stage's gate post-hoc using the standard UAW gate script (`run.mjs --check-gate <stage>`),
 * scoring `firstTryPass` strictly from the first stage-completion snapshot (when `markEvents` / `requireStageMarks`
 * is active, matching `docs/research/cli-offload-design.md` §3.1) and recording terminal state in stage-tracker /
 * state-manager.
 */
export async function evaluateMonolithGates({
  workflow,
  stages,
  runScript,
  trackerScript,
  stateScript,
  outputPath,
  dataDir,
  sessionOk,
  sessionError = null,
  sessionId = null,
  phaseFlags = [],
  cli,
  runGateAt = null,
  skillsRoot = null,
  repoRoot = null,
  markEvents = [],
  requireStageMarks = false,
  log = () => {},
}) {
  const withOut = ["--output-path", outputPath, "--data-dir", dataDir];
  const sessionArgs = sessionId ? ["--session-id", sessionId] : [];
  const rows = [];
  const stageResults = [];

  const checkGateAt = (stageName, snapshot = null) => {
    if (!snapshot) {
      return cli(runScript, ["--check-gate", stageName], withOut);
    }
    const snapDataDir = snapshot.dataSnapshotDir ?? dataDir;
    const extra = [
      "--output-path",
      snapshot.artifactsDir ?? outputPath,
      "--data-dir",
      snapDataDir,
      ...(skillsRoot ? ["--skills-root", skillsRoot] : []),
    ];
    if (typeof runGateAt === "function") {
      return runGateAt(runScript, ["--check-gate", stageName, ...extra], {
        cwd: snapshot.repoSnapshotDir ?? repoRoot,
        dataDir: snapDataDir,
      });
    }
    return cli(runScript, ["--check-gate", stageName], extra);
  };

  const advancePhase = (target, stageName) => {
    if (!stateScript) return null;
    const cur = cli(stateScript, ["read"], withOut);
    if (cur.ok && cur.data?.state?.phase === target) return null;
    const a = cli(
      stateScript,
      ["advance", "--to", target, "--agent", AGENT_ID, "--note", `monolith stage ${stageName} passed`, ...phaseFlags],
      withOut,
    );
    if (a.ok) return `phase→${target}`;
    log(`[monolith] phase "${target}" not applied after ${stageName}: ${a.error}`);
    return `phase ${target} not applied`;
  };

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const tag = `[${i + 1}/${stages.length}] ${st.name}`;
    const isGated = st.gated !== false;
    const isConditional = st.conditional === true;
    const evList = (markEvents ?? []).filter((e) => e.stage === st.name);

    // Evaluate snapshots first so the final end-of-session check below leaves uwf-stages.db with final state.
    const attemptResults = [];
    if (isGated) {
      for (let idx = 0; idx < evList.length; idx++) {
        const ev = evList[idx];
        const sg = checkGateAt(st.name, ev);
        const parsed = parseGateFailures(sg);
        const snapNotRequired = isConditional && sg.ok && /not required/i.test(sg.data?.note ?? "");
        attemptResults.push({
          attempt: idx + 1,
          seq: ev.seq ?? idx + 1,
          timestamp: ev.timestamp ?? null,
          passed: snapNotRequired ? false : Boolean(sg.ok),
          failures: snapNotRequired ? ["conditional — not required at mark snapshot"] : parsed.failures,
          verdict: parsed.verdict,
        });
      }
    }

    const g = checkGateAt(st.name, null);

    if (isConditional && g.ok && /not required/i.test(g.data?.note ?? "")) {
      if (trackerScript) {
        cli(trackerScript, ["stage-skip", "--workflow", workflow, "--stage", st.name, "--note", "condition not met", ...sessionArgs], withOut);
      }
      log(`${tag} gate: SKIP (${g.data?.note ?? "conditional — not required"})`);
      rows.push({ stage: st.name, attempts: 0, result: "skipped (not required)" });
      stageResults.push({
        stage: st.name,
        gated: isGated,
        conditional: true,
        skipped: true,
        passed: false,
        firstTryPass: false,
        neverMarked: false,
        markEventsCount: evList.length,
        attemptResults: [],
        retriesToPass: 0,
        neverPassed: false,
        failures: [],
        prescriptions: [],
        verdict: null,
        note: g.data?.note ?? "conditional — not required",
      });
      continue;
    }

    if (!isGated) {
      if (sessionOk) {
        if (trackerScript) {
          cli(trackerScript, ["stage-complete", "--workflow", workflow, "--stage", st.name, ...sessionArgs], withOut);
        }
        const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name) : null;
        log(`${tag} gate: PASS (ungated)`);
        rows.push({ stage: st.name, attempts: Math.max(1, evList.length), result: adv ? `passed (${adv})` : "passed" });
        stageResults.push({
          stage: st.name,
          gated: false,
          conditional: isConditional,
          skipped: false,
          passed: true,
          firstTryPass: true,
          neverMarked: false,
          markEventsCount: evList.length,
          attemptResults: [],
          retriesToPass: 0,
          neverPassed: false,
          failures: [],
          prescriptions: [],
          verdict: null,
          note: g.data?.note ?? "ungated — always passes",
        });
      } else {
        const reason = sessionError ?? "monolith session failed";
        if (trackerScript) {
          cli(trackerScript, ["stage-fail", "--workflow", workflow, "--stage", st.name, "--note", reason, ...sessionArgs], withOut);
        }
        log(`${tag} gate: FAIL (${reason})`);
        rows.push({ stage: st.name, attempts: Math.max(1, evList.length), result: "failed" });
        stageResults.push({
          stage: st.name,
          gated: false,
          conditional: isConditional,
          skipped: false,
          passed: false,
          firstTryPass: false,
          neverMarked: false,
          markEventsCount: evList.length,
          attemptResults: [],
          retriesToPass: (st.maxRetries ?? 2) + 1,
          neverPassed: true,
          failures: [reason],
          prescriptions: [],
          verdict: null,
          note: null,
        });
      }
      continue;
    }

    const neverMarked = evList.length === 0 && Boolean(requireStageMarks);
    const firstTryPass = evList.length > 0
      ? Boolean(attemptResults[0].passed)
      : requireStageMarks
        ? false
        : Boolean(g.ok);
    const firstPassIdx = attemptResults.findIndex((a) => a.passed);
    const attempts = evList.length > 0 ? evList.length : 1;
    const retriesToPass = evList.length > 0
      ? (firstPassIdx >= 0 ? firstPassIdx : (g.ok ? evList.length : (st.maxRetries ?? 2) + 1))
      : requireStageMarks
        ? (g.ok ? 1 : (st.maxRetries ?? 2) + 1)
        : (g.ok ? 0 : (st.maxRetries ?? 2) + 1);
    const neverPassed = !g.ok && firstPassIdx < 0;

    if (g.ok) {
      if (trackerScript) {
        cli(trackerScript, ["stage-complete", "--workflow", workflow, "--stage", st.name, ...sessionArgs], withOut);
      }
      const adv = st.advancesTo ? advancePhase(st.advancesTo, st.name) : null;
      const suffix = neverMarked ? " (never_marked)" : !firstTryPass ? " (repaired after first mark)" : "";
      log(`${tag} gate: PASS${suffix}`);
      rows.push({
        stage: st.name,
        attempts,
        result: adv
          ? `passed (${adv})`
          : neverMarked
            ? "passed (never_marked)"
            : !firstTryPass
              ? "passed (retry)"
              : "passed",
      });
      stageResults.push({
        stage: st.name,
        gated: true,
        conditional: isConditional,
        skipped: false,
        passed: true,
        firstTryPass,
        neverMarked,
        markEventsCount: evList.length,
        attemptResults,
        retriesToPass,
        neverPassed: false,
        failures: [],
        prescriptions: [],
        verdict: null,
        note: g.data?.note ?? null,
      });
    } else {
      const { failures, prescriptions, verdict } = parseGateFailures(g);
      if (trackerScript) {
        cli(trackerScript, ["stage-fail", "--workflow", workflow, "--stage", st.name, "--note", failures.join("; "), ...sessionArgs], withOut);
      }
      log(`${tag} gate: FAIL${neverMarked ? " (never_marked)" : ""} — ${failures.join("; ")}`);
      rows.push({ stage: st.name, attempts, result: neverMarked ? "failed (never_marked)" : "failed" });
      stageResults.push({
        stage: st.name,
        gated: true,
        conditional: isConditional,
        skipped: false,
        passed: false,
        firstTryPass,
        neverMarked,
        markEventsCount: evList.length,
        attemptResults,
        retriesToPass,
        neverPassed,
        failures,
        prescriptions,
        verdict,
        note: null,
      });
    }
  }

  const gatedEvaluated = stageResults.filter((r) => r.gated && !r.skipped).length;
  const gatedPassed = stageResults.filter((r) => r.gated && !r.skipped && r.passed).length;
  const firstTryPassed = stageResults.filter((r) => r.gated && !r.skipped && r.firstTryPass).length;
  const neverMarkedStages = stageResults.filter((r) => r.gated && !r.skipped && r.neverMarked).length;
  const skippedStages = stageResults.filter((r) => r.skipped).length;
  const ungatedStages = stageResults.filter((r) => !r.gated && !r.skipped).length;
  const firstTryPassRate = gatedEvaluated > 0 ? firstTryPassed / gatedEvaluated : null;
  const allPassed = Boolean(sessionOk) && stageResults.every((r) => r.passed || r.skipped);

  return {
    rows,
    stages: stageResults,
    summary: {
      totalStages: stageResults.length,
      gatedEvaluated,
      gatedPassed,
      firstTryPassed,
      neverMarkedStages,
      skippedStages,
      ungatedStages,
      firstTryPassRate,
    },
    allPassed,
  };
}

function replayFakeStepsIfPresent({ fixturePath, repoRoot, dataDir, outputPath, cwdPaths, runScriptStages }) {
  if (!fixturePath || !existsSync(fixturePath)) return;
  let fx;
  try {
    fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(fx?.steps) || fx.steps.length === 0) return;

  const absRepo = resolve(repoRoot);
  for (const step of fx.steps) {
    for (const [rel, content] of Object.entries(step.files ?? {})) {
      const target = resolve(absRepo, rel);
      const back = relative(absRepo, target);
      if (isAbsolute(rel) || back.startsWith("..")) {
        throw new Error(`monolith fake fixture step escapes repoRoot: ${rel}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (step.stage && step.mark !== false) {
      markStage(step.stage, {
        dataDir,
        outputPath,
        repoRoot: absRepo,
        cwdPaths,
        snapshotWorkspace: runScriptStages.has(step.stage),
      });
    }
  }
}

/**
 * Execute a full monolith control run: assemble one long prompt across all stages,
 * run a single session through the underlying backend harness, evaluate all stage gates
 * post-hoc against stage-completion snapshots + final tree, and persist metrics to
 * `<dataDir>/monolith-metrics.json`.
 */
export async function runMonolith(ctx) {
  const {
    workflow,
    stages,
    runScript,
    trackerScript,
    stateScript,
    repoRoot,
    skillsRoot,
    outputPath,
    dataDir,
    goal,
    flags = {},
    fixtureDir,
    timeoutMs,
    maxCostUsd,
    phaseFlags = [],
    cli,
    runGateAt = null,
    log = (s) => process.stderr.write(s + "\n"),
    backendAdapter,
    materializeFn,
    EXIT = { OK: 0, GATE: 1, USAGE: 2, QUESTIONS: 3, COST: 4 },
  } = ctx;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const resolvedDataDir = resolveDataDir(dataDir);
  const withOut = ["--output-path", outputPath, "--data-dir", dataDir];

  // Clear stale stage-completion events/snapshots when starting a monolith session in this dataDir.
  rmSync(join(resolvedDataDir, "monolith-events.json"), { force: true });
  rmSync(join(resolvedDataDir, "monolith-snapshots"), { recursive: true, force: true });

  const yamlMeta = loadYamlStageMeta(workflow, skillsRoot, repoRoot);

  // Fetch gate prescriptions & conditional predicates from stage-tracker (best-effort).
  let gateChecksByStage = {};
  let conditionsByStage = { ...yamlMeta.conditions };
  if (trackerScript && cli) {
    const gp = cli(trackerScript, ["gate-prescriptions", "--workflow", workflow], withOut);
    if (gp.ok && Array.isArray(gp.data?.stages)) {
      gateChecksByStage = Object.fromEntries(gp.data.stages.map((s) => [s.stage, s.checks ?? []]));
      for (const s of gp.data.stages) {
        if (s.condition) conditionsByStage[s.stage] = s.condition;
      }
    }
  }

  const runScriptStages = new Set(yamlMeta.runScriptStages);
  for (const [stName, checks] of Object.entries(gateChecksByStage)) {
    if (checks.some((c) => c.type === "run_script")) runScriptStages.add(stName);
  }
  const cwdPaths = parseCwdPaths(
    ctx.env?.UWF_MONOLITH_CWD_PATHS ??
      process.env.UWF_MONOLITH_CWD_PATHS ??
      extractCwdPathsFromMeta(yamlMeta.rawPaths),
  );

  const markStageCmd = resolveMarkStageCmd({ flags, env: ctx.env });
  const assembled = await assembleMonolithPrompt({
    workflow,
    stages,
    repoRoot,
    skillsRoot,
    outputPath,
    dataDir,
    goal,
    modelProfile: flags["model-profile"],
    gateChecksByStage,
    conditionsByStage,
    markStageCmd,
    materializeFn,
  });

  const backendName = backendAdapter?.name ?? resolveBackendName({ backend: flags.backend, env: ctx.env });
  const backend = backendAdapter ?? (await loadAdapter(backendName));
  const model = flags.model ?? (backendName === "claude-code" ? "claude-sonnet-5-5" : undefined);

  const env = {
    UWF_DATA_DIR: dataDir,
    UWF_MONOLITH_DATA_DIR: resolvedDataDir,
    UWF_MONOLITH_OUTPUT_PATH: outputPath,
    UWF_MONOLITH_REPO_ROOT: repoRoot,
    UWF_MONOLITH_CWD_PATHS: JSON.stringify(cwdPaths),
    UWF_MONOLITH_RUN_SCRIPT_STAGES: [...runScriptStages].join(","),
    ...(ctx.env ?? {}),
  };
  if (backendName === "fake" && !env.UWF_FAKE_FIXTURE && fixtureDir) {
    env.UWF_FAKE_FIXTURE = join(fixtureDir, "monolith.json");
  }

  log(`[monolith] single session -> ${backendName} (${stages.length} stages, ~${assembled.approxPromptTokens} prompt tokens, permissions=${assembled.permissions}, maxTurns=${assembled.totalMaxTurns})`);

  if (stateScript && cli) {
    cli(stateScript, ["set-agent", "--agent", AGENT_ID, "--force"], withOut);
  }

  let sessionResult;
  let evaluated;
  let transcriptPath;
  try {
    if (backendName === "fake" && !backendAdapter && env.UWF_FAKE_FIXTURE) {
      replayFakeStepsIfPresent({
        fixturePath: env.UWF_FAKE_FIXTURE,
        repoRoot,
        dataDir: resolvedDataDir,
        outputPath,
        cwdPaths,
        runScriptStages,
      });
    }

    sessionResult = await backend.invokeStage({
      systemPrompt: assembled.systemPrompt,
      prompt: assembled.prompt,
      stage: "monolith",
      cwd: repoRoot,
      inputs: assembled.inputs,
      outputs: assembled.outputs,
      model,
      timeoutMs,
      env,
      permissions: assembled.permissions,
      allowedCommands: assembled.allowedCommands,
      skillsRoot,
      dataDir: resolvedDataDir,
      writableRoots: [
        resolvedDataDir,
        isAbsolute(outputPath) ? resolve(outputPath) : resolve(repoRoot, outputPath),
      ],
      maxTurns: assembled.totalMaxTurns,
    });

    // Ensure a transcript file always exists under <dataDir>/transcripts even if backend failed before writing one.
    transcriptPath = sessionResult.transcriptPath;
    if (!transcriptPath) {
      transcriptPath = writeTranscript(dataDir, {
        adapter: name,
        backend: backendName,
        workflow,
        prompt: assembled.prompt,
        sessionId: sessionResult.sessionId ?? null,
        exitCode: sessionResult.exitCode ?? (sessionResult.ok ? 0 : 1),
        stdout: sessionResult.stdout ?? "",
        error: sessionResult.error ?? null,
      });
    }

    const markEvents = readMarkEvents(resolvedDataDir);
    evaluated = await evaluateMonolithGates({
      workflow,
      stages,
      runScript,
      trackerScript,
      stateScript,
      outputPath,
      dataDir,
      sessionOk: sessionResult.ok,
      sessionError: sessionResult.error ?? null,
      sessionId: sessionResult.sessionId ?? null,
      phaseFlags,
      cli,
      runGateAt,
      skillsRoot,
      repoRoot,
      markEvents,
      requireStageMarks: Boolean(markStageCmd),
      log,
    });
  } finally {
    if (stateScript && cli) {
      cli(stateScript, ["release-agent"], withOut);
    }
  }

  const endedAt = new Date().toISOString();
  const wallSeconds = (Date.now() - t0) / 1000;
  const used = attemptUsage(transcriptPath);
  const costUsd = typeof sessionResult.costUsd === "number" ? sessionResult.costUsd : (used.cost || null);

  const metrics = {
    adapter: name,
    backend: backendName,
    workflow,
    model: model ?? null,
    sessionId: sessionResult.sessionId ?? null,
    transcriptPath,
    startedAt,
    endedAt,
    wallSeconds,
    sessionOk: sessionResult.ok,
    sessionError: sessionResult.error ?? null,
    markStageCmd: markStageCmd ?? null,
    markEventsCount: readMarkEvents(resolvedDataDir).length,
    promptChars: assembled.promptChars,
    systemPromptChars: assembled.systemPromptChars,
    approxPromptTokens: assembled.approxPromptTokens,
    embeddedRules: assembled.embeddedRules,
    usage: sessionResult.usage ?? null,
    costUsd,
    summary: evaluated.summary,
    stages: evaluated.stages,
  };

  mkdirSync(resolvedDataDir, { recursive: true });
  const metricsPath = join(resolvedDataDir, "monolith-metrics.json");
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + "\n");

  const overCost = maxCostUsd !== undefined && (costUsd ?? 0) > maxCostUsd;
  const exitCode = overCost ? EXIT.COST : evaluated.allPassed ? EXIT.OK : EXIT.GATE;

  return {
    exitCode,
    rows: evaluated.rows,
    metrics,
    metricsPath,
    sessionResult: { ...sessionResult, transcriptPath },
    promptMeta: assembled,
  };
}

/**
 * Standard Adapter contract entry point (`adapters/types.d.ts`).
 * Wraps the system prompt with the Round 1 / Round 2 monolith control rules and delegates
 * the single invocation to the configured underlying harness backend. Never throws.
 *
 * @param {import("./index.mjs").InvokeStageOptions & { backend?: string }} opts
 * @param {{ fixture?: string, backendAdapter?: { name: string, invokeStage: Function } }} [extra]
 * @returns {Promise<import("./index.mjs").InvokeStageResult>}
 */
export async function invokeStage(opts, extra = {}) {
  const fail = (error) => ({
    ok: false,
    sessionId: opts?.sessionId ?? null,
    transcriptPath: null,
    stdout: "",
    exitCode: null,
    usage: null,
    error,
  });

  let backend;
  try {
    backend = extra.backendAdapter ?? (await loadAdapter(resolveBackendName(opts)));
  } catch (e) {
    return fail(`monolith adapter: ${e.message}`);
  }

  let baseSystem;
  try {
    baseSystem = buildSystemPrompt(opts.agentFile, opts.systemPrompt);
  } catch (e) {
    return fail(`monolith adapter: cannot read agentFile: ${e.message}`);
  }

  const { text: controlHeader } = formatControlRules({
    markStageCmd: resolveMarkStageCmd({ env: opts.env }),
  });
  const systemPrompt = baseSystem.includes("UAW Monolith Control Orchestrator")
    ? baseSystem
    : [controlHeader, baseSystem].filter(Boolean).join("\n\n");

  try {
    const res = await backend.invokeStage(
      { ...opts, agentFile: undefined, systemPrompt },
      extra.fixture ? { fixture: extra.fixture } : undefined,
    );
    return res;
  } catch (e) {
    return fail(`monolith adapter: backend error: ${e.message}`);
  }
}
