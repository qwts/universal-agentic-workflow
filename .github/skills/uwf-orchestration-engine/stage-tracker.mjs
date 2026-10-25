/**
 * UWF Stage Tracker — centralized SQLite-backed stage management CLI.
 *
 * Stage definitions are declared in YAML files co-located with each persona skill:
 *   .github/skills/uwf-{workflow}/stages.yaml
 *
 * Database:  .github/skills/uwf-orchestration-engine/uwf-stages.db
 * Schema:    .github/skills/uwf-orchestration-engine/stage-schema.yaml
 *
 * Usage:
 *   node .github/skills/uwf-orchestration-engine/stage-tracker.mjs <command> [options]
 *
 * Commands:
 *   list-stages    --workflow <name>                          List stages from YAML as JSON
 *   check-gate     --workflow <name> --stage <s>             Evaluate gate; exit 0=pass 1=fail
 *   init           --workflow <name>                          Reset stage tracking for workflow
 *   read           --workflow <name>                          Read current execution state
 *   stage-start    --workflow <name> --stage <s> [--session-id <id>]  Mark stage active
 *   stage-complete --workflow <name> --stage <s> [--session-id <id>]  Mark stage passed
 *   stage-fail     --workflow <name> --stage <s> [--note <t>] [--session-id <id>]  Increment retry, record failure
 *   stage-skip     --workflow <name> --stage <s> [--session-id <id>]  Mark stage skipped
 *   stage-session  --workflow <name> --stage <s> --session-id <id>    Record the adapter session id only
 *   reset-from     --workflow <name> --stage <s> [--note <t>] Set stage and all later ones to pending
 *
 * Global options:
 *   --output-path <path>   Default: ./tmp/workflow-artifacts
 *   --db-path <path>       Override the SQLite path
 *
 * Exit codes:
 *   0  success (gate passed for check-gate)
 *   1  operational error (gate failed for check-gate)
 *   2  usage error
 *
 * All output is JSON to stdout.
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { resolve, join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveDataDir, resolveDbPath } from "../uwf-state-manager/data-dir.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two roots: SKILLS_ROOT is where workflow definitions, stage contracts, traits,
// profiles, schemas and agent files live (--skills-root / UWF_SKILLS_ROOT, a repo-like
// dir containing .github/); process.cwd() is the target repo that {{cwd}} and the
// gate file checks resolve against. Unset = this checkout's own tree (legacy behaviour,
// where the definitions are expected under cwd/.github/skills for stages.yaml).
function readSkillsRoot() {
  const a = process.argv;
  const i = a.indexOf("--skills-root");
  const v = i !== -1 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : process.env.UWF_SKILLS_ROOT;
  return v ? resolve(v) : null;
}
const SKILLS_ROOT = readSkillsRoot();
const OWN_SKILLS_DIR = join(__dirname, "..");
const SKILLS_DIR = SKILLS_ROOT ? join(SKILLS_ROOT, ".github", "skills") : OWN_SKILLS_DIR;
const AGENTS_DIR = SKILLS_ROOT ? join(SKILLS_ROOT, ".github", "agents") : join(__dirname, "..", "..", "agents");
/** Engine resource under SKILLS_DIR; falls back to this checkout's copy so a partial tree still works. */
function skillResource(...segs) {
  const p = join(SKILLS_DIR, ...segs);
  return existsSync(p) ? p : join(OWN_SKILLS_DIR, ...segs);
}
/**
 * Path of a skill CLI as printed in commands for agents. With a skills root the path is absolute and
 * resolved per file: the root's copy when it exists, else this checkout's (a partial tree that ships
 * only its stages.yaml still gets runnable commands). Without a root it stays relative to cwd.
 */
const skillCliPath = (rel) => (SKILLS_ROOT ? skillResource(...rel.split("/")) : `.github/skills/${rel}`);

// ---------------------------------------------------------------------------
// Stage resolution helpers
// ---------------------------------------------------------------------------

/** Load a stage contract YAML by stage_type. Returns null if not found. */
function loadStageContract(stageType) {
  const contractPath = skillResource("uwf-orchestration-engine", "stage-contracts", `${stageType}.yaml`);
  if (!existsSync(contractPath)) return null;
  return yaml.load(readFileSync(contractPath, "utf8"));
}

/** Load a trait YAML by trait_id. Returns null if not found. */
function loadTrait(traitId) {
  const traitPath = skillResource("uwf-traits", "traits", `${traitId}.yaml`);
  if (!existsSync(traitPath)) return null;
  return yaml.load(readFileSync(traitPath, "utf8"));
}

/** Load the model adaptation profiles.yaml. */
function loadProfiles() {
  const profilesPath = skillResource("uwf-model-adaptation", "profiles.yaml");
  if (!existsSync(profilesPath)) return null;
  return yaml.load(readFileSync(profilesPath, "utf8"));
}

/** retry_mode: resume = a retry continues the previous attempt's adapter session; fresh = new session. */
const RETRY_MODES = ["resume", "fresh"];

/** max_turns: per-stage cap on agent turns (adapter `--max-turns`). Default 20; implementation 30. */
const DEFAULT_MAX_TURNS = 20;
const STAGE_MAX_TURNS = { implementation: 30, review: 20 };
function resolveMaxTurns(stageDef) {
  const v = stageDef.max_turns;
  if (v === undefined || v === null) return STAGE_MAX_TURNS[stageDef.name] ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(v) || v <= 0) {
    fail(`Stage "${stageDef.name}": max_turns must be a positive integer, got ${JSON.stringify(v)}.`);
  }
  return v;
}

const QUESTION_POLICY_ORDER = ["minimal", "standard", "aggressive"];
const EVIDENCE_THRESHOLD_ORDER = ["low", "standard", "high"];

/** Return the stricter of two question_policy values. */
function stricterQuestionPolicy(a, b) {
  const ai = QUESTION_POLICY_ORDER.indexOf(a ?? "standard");
  const bi = QUESTION_POLICY_ORDER.indexOf(b ?? "standard");
  return QUESTION_POLICY_ORDER[Math.max(ai, bi)] ?? "standard";
}

/** Return the stricter of two evidence_threshold values. */
function stricterEvidenceThreshold(a, b) {
  const ai = EVIDENCE_THRESHOLD_ORDER.indexOf(a ?? "standard");
  const bi = EVIDENCE_THRESHOLD_ORDER.indexOf(b ?? "standard");
  return EVIDENCE_THRESHOLD_ORDER[Math.max(ai, bi)] ?? "standard";
}

/** Ordered union: merge arrays keeping first-appearance order. */
function orderedUnion(...arrays) {
  const seen = new Set();
  const result = [];
  for (const arr of arrays) {
    for (const item of (arr ?? [])) {
      if (!seen.has(item)) { seen.add(item); result.push(item); }
    }
  }
  return result;
}

/**
 * Merge the default_behavior_policy from the stage contract with all trait
 * stage_policies in order. Returns the merged behavior_policy.
 */
function mergeBehaviorPolicy(defaultPolicy, traitPolicies) {
  let merged = {
    priority_order: [...(defaultPolicy.priority_order ?? [])],
    must_address:   [...(defaultPolicy.must_address   ?? [])],
    question_policy: defaultPolicy.question_policy ?? "standard",
    risk_focus:     [...(defaultPolicy.risk_focus    ?? [])],
    evidence_threshold: defaultPolicy.evidence_threshold ?? "standard",
  };

  for (const tp of traitPolicies) {
    merged.priority_order    = orderedUnion(merged.priority_order, tp.priority_order);
    merged.must_address      = orderedUnion(merged.must_address, tp.must_address);
    merged.risk_focus        = orderedUnion(merged.risk_focus, tp.risk_focus);
    merged.question_policy   = stricterQuestionPolicy(merged.question_policy, tp.question_policy);
    merged.evidence_threshold = stricterEvidenceThreshold(merged.evidence_threshold, tp.evidence_threshold);
  }

  return merged;
}

/**
 * Resolve a new-style stage (stage_type + traits).
 * Returns enriched stage object or throws a descriptive error.
 */
function resolveNewStyleStage(stageDef, modelProfile) {
  const { stage_type, traits, name } = stageDef;

  // Load stage contract
  const contract = loadStageContract(stage_type);
  if (!contract) {
    fail(`Stage "${name}": unknown stage_type "${stage_type}". No contract found at stage-contracts/${stage_type}.yaml.`);
  }

  // Validate traits
  if (!traits || traits.length === 0) {
    fail(`Stage "${name}": stage_type requires non-empty traits list.`);
  }

  // Deduplicate check
  const seen = new Set();
  for (const t of traits) {
    if (seen.has(t)) fail(`Stage "${name}": duplicate trait "${t}" in traits list.`);
    seen.add(t);
  }

  // Validate each trait exists and is supported
  const traitPolicies = [];
  for (const traitId of traits) {
    const traitDef = loadTrait(traitId);
    if (!traitDef) fail(`Stage "${name}": unknown trait "${traitId}". No file found at uwf-traits/traits/${traitId}.yaml.`);
    if (!contract.supported_traits.includes(traitId)) {
      fail(`Stage "${name}": trait "${traitId}" is not supported by stage_type "${stage_type}". Supported: ${contract.supported_traits.join(", ")}.`);
    }
    const stagePolicy = traitDef.stage_policies?.[stage_type];
    if (!stagePolicy) fail(`Stage "${name}": trait "${traitId}" has no policy for stage_type "${stage_type}".`);
    traitPolicies.push(stagePolicy);
  }

  // Merge behavior policies
  const behaviorPolicy = mergeBehaviorPolicy(contract.default_behavior_policy, traitPolicies);

  // Resolve model profile steering
  const profileData = loadProfiles();
  const resolvedProfile = modelProfile ?? profileData?.default_profile ?? "balanced";
  const profileDef = profileData?.profiles?.[resolvedProfile];
  const steeringPolicyBase = { ...(profileDef?.steering_policy ?? {}) };

  // Apply stage-specific overrides
  const stageOverride = profileData?.stage_overrides?.[resolvedProfile]?.[stage_type];
  const steeringPolicy = stageOverride ? { ...steeringPolicyBase, ...stageOverride } : steeringPolicyBase;

  const resolvedAgent = contract.default_agent;

  // Validate that the resolved agent file exists
  const agentFilePath = existsSync(join(AGENTS_DIR, `${resolvedAgent}.agent.md`))
    ? join(AGENTS_DIR, `${resolvedAgent}.agent.md`)
    : join(__dirname, "..", "..", "agents", `${resolvedAgent}.agent.md`);
  if (!existsSync(agentFilePath)) {
    fail(`Stage "${name}": resolved agent "${resolvedAgent}" not found at ${agentFilePath}. Ensure the agent file exists.`);
  }

  return {
    resolved_agent: resolvedAgent,
    stage_type,
    trait_ids: traits,
    behavior_policy: behaviorPolicy,
    model_profile: resolvedProfile,
    steering_policy: steeringPolicy,
  };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const [command, ...rest] = args;
const flags = parseFlags(rest);

const workflow   = flags["workflow"];
const dataDirFlag = resolveDataDir(flags, undefined);
const outputPath = flags["output-path"] ?? (dataDirFlag ? join(dataDirFlag, "workflow-artifacts") : "./tmp/workflow-artifacts");
const DB_PATH = resolveDbPath(flags, "uwf-stages.db", __dirname);

if (!command) usageError("No command provided.");

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  initTables(db);
  return db;
}

function initTables(db) {
  const schema = yaml.load(readFileSync(skillResource("uwf-orchestration-engine", "stage-schema.yaml"), "utf8"));
  db.transaction(() => {
    for (const [tableName, def] of Object.entries(schema.tables)) {
      db.exec(buildCreateTable(tableName, def.columns));
      // Migrate DBs created before a column existed: add it when missing (never drops or rewrites).
      const have = new Set(db.prepare(`PRAGMA table_info("${tableName}")`).all().map((c) => c.name));
      for (const col of def.columns) {
        if (have.has(col.name) || col.primary_key) continue;
        if (col.not_null && col.default === undefined) continue; // SQLite cannot add this without a default
        db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${columnDef(col)}`);
      }
    }
  })();
}

function columnDef(col) {
  let d = `"${col.name}" ${col.type}`;
  if (col.primary_key && col.autoincrement) d += " PRIMARY KEY AUTOINCREMENT";
  else if (col.primary_key) d += " PRIMARY KEY";
  if (col.not_null) d += " NOT NULL";
  if (col.default !== undefined) {
    const v = typeof col.default === "string" ? `'${col.default}'` : col.default;
    d += ` DEFAULT ${v}`;
  }
  return d;
}

function buildCreateTable(tableName, columns) {
  const defs = columns.map(columnDef);
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (${defs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Stages YAML loader
// ---------------------------------------------------------------------------

function loadStagesYaml(wf) {
  const yamlPath = SKILLS_ROOT
    ? join(SKILLS_DIR, `uwf-${wf}`, "stages.yaml")
    : resolve(join(".github", "skills", `uwf-${wf}`, "stages.yaml"));
  if (!existsSync(yamlPath)) usageError(`stages.yaml not found for workflow "${wf}": ${yamlPath}`);
  return yaml.load(readFileSync(yamlPath, "utf8"));
}

function resolveTemplates(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/\{\{output_path\}\}/g, outputPath)
    .replace(/\{\{cwd\}\}/g,         process.cwd());
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
  if (command === "reset") {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    succeed({ procedure: "reset", deleted: DB_PATH });
  }
  const db = openDb();
  switch (command) {
    case "list-stages":    cmdListStages(db); break;
    case "check-gate":     cmdCheckGate(db);  break;
    case "gate-prescriptions": cmdGatePrescriptions(); break;
    case "init":           cmdInit(db);        break;
    case "read":           cmdRead(db);        break;
    case "stage-start":    cmdStageUpdate(db, "active");    break;
    case "stage-complete": cmdStageUpdate(db, "passed");    break;
    case "stage-fail":     cmdStageFail(db);               break;
    case "stage-session":  cmdStageSession(db);            break;
    case "stage-skip":     cmdStageUpdate(db, "skipped");  break;
    case "reset-from":     cmdResetFrom(db);               break;
    case "reset":          cmdReset(db);                    break;
    default: usageError(`Unknown command: "${command}"`);
  }
} catch (err) {
  fail(err.message);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdListStages(db) {
  requireFlag("workflow", "list-stages");
  const { stages } = loadStagesYaml(workflow);
  const Q_MJS = skillCliPath("uwf-question-protocol/questions.mjs");
  const modelProfile = flags["model-profile"] ?? null;

  const list = stages.map((stageDef) => {
    const { name, agent, stage_type, traits, max_retries, on_gate_failure, gated, conditional, run_as_subagent, inputs, outputs, advances_phase_to } = stageDef;

    // Validation: agent and stage_type must not coexist
    if (agent !== undefined && stage_type !== undefined) {
      fail(`Stage "${name}": a stage entry must use exactly one of "agent" or "stage_type", not both.`);
    }

    const retry_mode = stageDef.retry_mode ?? "resume";
    if (!RETRY_MODES.includes(retry_mode)) {
      fail(`Stage "${name}": retry_mode must be one of ${RETRY_MODES.join(" | ")}, got ${JSON.stringify(retry_mode)}.`);
    }

    const base = {
      name,
      maxRetries: max_retries ?? 2,
      retryMode: retry_mode,
      maxTurns: resolveMaxTurns(stageDef),
      onGateFailure: on_gate_failure ?? "retry",
      gated: gated !== false,
      conditional: conditional === true,
      runAsSubagent: run_as_subagent !== false,
      inputs: inputs ?? [],
      outputs: outputs ?? [],
      advancesTo: advances_phase_to ?? null,
      questionsCheckCmd: `node ${Q_MJS} check --stage ${name}`,
    };

    if (stage_type !== undefined) {
      // New-style stage: resolve via stage contract + traits
      const resolved = resolveNewStyleStage(stageDef, modelProfile);
      return {
        ...base,
        agent: resolved.resolved_agent,
        stage_type: resolved.stage_type,
        trait_ids: resolved.trait_ids,
        resolved_agent: resolved.resolved_agent,
        behavior_policy: resolved.behavior_policy,
        model_profile: resolved.model_profile,
        steering_policy: resolved.steering_policy,
      };
    } else {
      // Legacy stage: keep existing behavior
      return {
        ...base,
        agent,
        stage_type: null,
        trait_ids: [],
        resolved_agent: agent,
        behavior_policy: null,
        model_profile: modelProfile,
        steering_policy: null,
      };
    }
  });

  process.stdout.write(JSON.stringify(list, null, 2) + "\n");
  process.exitCode = 0;
}

/** Audit: every stage's gate checks with the prescription each would produce if it failed. */
function cmdGatePrescriptions() {
  requireFlag("workflow", "gate-prescriptions");
  const { stages } = loadStagesYaml(workflow);
  const out = stages.map((s) => ({
    stage: s.name,
    gated: s.gated !== false,
    conditional: s.conditional === true,
    on_gate_failure: s.on_gate_failure ?? "retry",
    max_retries: s.max_retries ?? 2,
    retry_mode: s.retry_mode ?? "resume",
    max_turns: resolveMaxTurns(s),
    checks: (s.gate?.checks ?? []).map((c) => ({ type: c.type, label: c.label ?? null, prescription: prescribeCheck(c, null) })),
  }));
  process.stdout.write(JSON.stringify({ workflow, stages: out }, null, 2) + "\n");
  process.exitCode = 0;
}

function cmdCheckGate(db) {
  requireFlag("workflow", "check-gate");
  requireFlag("stage",    "check-gate");

  const stageName = flags["stage"];
  const { stages } = loadStagesYaml(workflow);
  const stageDef = stages.find((s) => s.name === stageName);
  if (!stageDef) usageError(`Unknown stage "${stageName}" in workflow "${workflow}".`);

  const result = evaluateGate(stageDef, stageName);

  // Persist gate result to DB
  const row = db.prepare(
    `SELECT id FROM stage_runs WHERE workflow = ? AND stage = ?`
  ).get(workflow, stageName);
  if (row) {
    db.prepare(
      `UPDATE stage_runs SET gate_result = ? WHERE workflow = ? AND stage = ?`
    ).run(JSON.stringify(result), workflow, stageName);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.passed ? 0 : 1);
}

function cmdInit(db) {
  requireFlag("workflow", "init");
  const { stages } = loadStagesYaml(workflow);

  db.transaction(() => {
    // Remove existing tracking rows for this workflow
    db.prepare(`DELETE FROM stage_runs WHERE workflow = ?`).run(workflow);
    // Seed a row per stage
    const insert = db.prepare(
      `INSERT INTO stage_runs (workflow, stage, status, retry_count, run_as_subagent) VALUES (?, ?, 'pending', 0, ?)`
    );
    for (const s of stages) insert.run(workflow, s.name, s.run_as_subagent !== false ? 1 : 0);
    // Log history
    appendHistory(db, workflow, "*", null, "pending", "Workflow initialized");
  })();

  succeed({ procedure: "init", workflow, stages: stages.map((s) => s.name), state: readState(db) });
}

function cmdRead(db) {
  requireFlag("workflow", "read");
  succeed({ procedure: "read", workflow, state: readState(db) });
}

function cmdStageUpdate(db, toStatus) {
  requireFlag("workflow", command);
  requireFlag("stage",    command);
  const stageName = flags["stage"];
  const note = flags["note"] ?? null;

  ensureRow(db, stageName);
  const row = db.prepare(`SELECT * FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, stageName);
  const now = new Date().toISOString();

  const updates = { status: toStatus };
  if (flags["session-id"]) updates.session_id = flags["session-id"];
  if (toStatus === "active")  updates.started_at   = now;
  if (toStatus === "passed" || toStatus === "skipped") updates.completed_at = now;
  if (note) updates.notes = note;

  const keys = Object.keys(updates);
  db.prepare(`UPDATE stage_runs SET ${keys.map((k) => `"${k}" = ?`).join(", ")} WHERE workflow = ? AND stage = ?`)
    .run(...keys.map((k) => updates[k]), workflow, stageName);

  appendHistory(db, workflow, stageName, row.status, toStatus, note);

  // Build next-action hints for the orchestrator
  const { stages } = loadStagesYaml(workflow);
  const stageDef   = stages.find((s) => s.name === stageName);
  const agentId    = stageDef?.agent ?? "uwf-core-orchestrator";
  const STATE_MJS  = skillCliPath("uwf-state-manager/state.mjs");
  const Q_MJS      = skillCliPath("uwf-question-protocol/questions.mjs");

  let pre_flight_check = null;
  let state_actions    = [];

  if (toStatus === "active") {
    pre_flight_check = `node ${Q_MJS} check --stage ${stageName}`;
    state_actions    = [
      `node ${STATE_MJS} set-agent --agent ${agentId} --force`,
    ];
  }

  if (toStatus === "passed" || toStatus === "skipped") {
    state_actions = [
      `node ${STATE_MJS} release-agent`,
      ...(stageDef?.advances_phase_to
        ? [`node ${STATE_MJS} advance --to ${stageDef.advances_phase_to} --agent ${agentId} --force`]
        : []),
    ];
  }

  succeed({
    procedure: command,
    workflow,
    stage:   stageName,
    status:  toStatus,
    ...(pre_flight_check && { pre_flight_check }),
    ...(state_actions.length && { state_actions }),
    state: readState(db),
  });
}

function cmdStageFail(db) {
  requireFlag("workflow", "stage-fail");
  requireFlag("stage",    "stage-fail");
  const stageName = flags["stage"];
  const note = flags["note"] ?? null;

  ensureRow(db, stageName);
  const row = db.prepare(`SELECT * FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, stageName);

  db.prepare(
    `UPDATE stage_runs SET status = 'failed', retry_count = retry_count + 1, completed_at = ?, notes = ?, session_id = COALESCE(?, session_id) WHERE workflow = ? AND stage = ?`
  ).run(new Date().toISOString(), note, flags["session-id"] ?? null, workflow, stageName);

  appendHistory(db, workflow, stageName, row.status, "failed", note);
  const updated   = db.prepare(`SELECT * FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, stageName);
  const STATE_MJS = skillCliPath("uwf-state-manager/state.mjs");
  succeed({
    procedure:    "stage-fail",
    workflow,
    stage:        stageName,
    retry_count:  updated.retry_count,
    state_actions: [`node ${STATE_MJS} release-agent`],
    state:        readState(db),
  });
}

/** Record the adapter session id without changing status (so a crash between attempts keeps it). */
function cmdStageSession(db) {
  requireFlag("workflow", "stage-session");
  requireFlag("stage",    "stage-session");
  requireFlag("session-id", "stage-session");
  ensureRow(db, flags["stage"]);
  db.prepare(`UPDATE stage_runs SET session_id = ? WHERE workflow = ? AND stage = ?`).run(flags["session-id"], workflow, flags["stage"]);
  succeed({ procedure: "stage-session", workflow, stage: flags["stage"], session_id: flags["session-id"], state: readState(db) });
}

/** Set --stage and every later stage (YAML order) back to pending; one history row per stage. */
function cmdResetFrom(db) {
  requireFlag("workflow", "reset-from");
  requireFlag("stage",    "reset-from");
  const { stages } = loadStagesYaml(workflow);
  const idx = stages.findIndex((s) => s.name === flags["stage"]);
  if (idx < 0) usageError(`Unknown stage "${flags["stage"]}" in workflow "${workflow}".`);
  const note = flags["note"] ?? `reset-from ${flags["stage"]}`;

  const reset = stages.slice(idx).map((s) => s.name);
  db.transaction(() => {
    for (const name of reset) {
      ensureRow(db, name);
      const row = db.prepare(`SELECT status FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, name);
      db.prepare(
        `UPDATE stage_runs SET status = 'pending', retry_count = 0, started_at = NULL, completed_at = NULL, gate_result = NULL, notes = NULL, session_id = NULL WHERE workflow = ? AND stage = ?`
      ).run(workflow, name);
      appendHistory(db, workflow, name, row.status, "pending", note);
    }
  })();

  succeed({ procedure: "reset-from", workflow, stage: flags["stage"], reset, state: readState(db) });
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

function evaluateGate(stageDef, stageName) {
  // Ungated stages always pass
  if (stageDef.gated === false) {
    return { stage: stageName, passed: true, failures: [], prescriptions: [], note: "ungated — always passes" };
  }

  // Conditional stage: check if condition is met; if not, auto-pass
  if (stageDef.conditional === true && stageDef.condition) {
    if (!evaluateCondition(stageDef.condition)) {
      return { stage: stageName, passed: true, failures: [], prescriptions: [], note: "conditional — not required" };
    }
  }

  // Evaluate gate checks
  const failures = [];
  const prescriptions = [];
  for (const check of (stageDef.gate?.checks ?? [])) {
    const failure = evaluateCheck(check);
    if (failure) { failures.push(failure); prescriptions.push(prescribeCheck(check, failure)); }
  }

  const policy = { on_gate_failure: stageDef.on_gate_failure ?? "retry", max_retries: stageDef.max_retries ?? 2 };
  return failures.length
    ? { stage: stageName, passed: false, failures, prescriptions, ...policy }
    : { stage: stageName, passed: true,  failures: [], prescriptions: [], ...policy };
}

/**
 * One imperative sentence saying exactly what to produce for a failed check. Parallel to
 * `failures`; it doubles as the runner's retry prompt. `failure` is the evaluateCheck string
 * (null for the audit listing, which has no observed failure).
 */
function prescribeCheck(check, failure) {
  const q = (v) => JSON.stringify(v);
  switch (check.type) {
    case "require_non_empty":
      return `Write a non-empty file at ${resolveTemplates(check.path)}.`;
    case "require_contains":
      return `Include the text ${q(check.text)} in ${resolveTemplates(check.path)}.`;
    case "require_files_with_prefix":
      return `Create at least one file named ${check.prefix}* under ${resolveTemplates(check.dir)}.`;
    case "require_file_matching_pattern":
      return `Create a file under ${resolveTemplates(check.dir)} whose name matches ${check.pattern}.`;
    case "run_script": {
      const cmd = [resolveTemplates(check.cmd), ...(Array.isArray(check.args) ? check.args.map((a) => resolveTemplates(String(a))) : [])].join(" ");
      const m = failure && failure.match(/ failed \(exit [^)]*\)(?:: ([\s\S]*))?$/);
      const tail = m?.[1] ? m[1].split(/\r?\n/).slice(-5).join(" | ").slice(-400) : "no output";
      return `Make ${q(cmd)} exit 0${failure ? `; it currently fails with: ${tail}` : ""}.`;
    }
    case "require_json_field": {
      const p = resolveTemplates(check.path);
      const ptr = check.pointer ? check.pointer : "(root)";
      const schema = check.schema ? ` (schema: ${check.schema})` : "";
      let want;
      if ("exists" in check) want = `${ptr} ${check.exists === true ? "present" : "absent"}`;
      else if ("in" in check) want = `${ptr} equal to one of ${q(check.in)}`;
      else if ("equals" in check) want = `${ptr} equal to ${q(check.equals)}`;
      else want = `${ptr} set as the gate requires`;
      const detail = failure?.match(/does not match stage-result schema: ([\s\S]*)$/)?.[1];
      return `Write ${p} as JSON with ${want}${schema}.${detail ? ` Fix: ${detail}.` : ""}`;
    }
    default:
      return `Fix the gate configuration: unknown check type ${q(check.type)}.`;
  }
}

function evaluateCondition(condition) {
  const path = resolveTemplates(condition.path);
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");

  switch (condition.type) {
    case "file_contains":
      return content.includes(condition.text);
    case "file_contains_any":
      return (condition.texts ?? []).some((t) => content.includes(t));
    default:
      return false;
  }
}

function evaluateCheck(check) {
  switch (check.type) {
    case "require_non_empty": {
      const p = resolveTemplates(check.path);
      if (!existsSync(p)) return `Missing: ${check.label ?? p}`;
      if (statSync(p).size === 0) return `Empty: ${check.label ?? p}`;
      return null;
    }
    case "require_contains": {
      const p = resolveTemplates(check.path);
      if (!existsSync(p)) return null; // let require_non_empty catch it
      if (!readFileSync(p, "utf8").includes(check.text)) {
        return `${check.label ?? p} does not contain: "${check.text}"`;
      }
      return null;
    }
    case "require_files_with_prefix": {
      const dir = resolveTemplates(check.dir);
      if (!existsSync(dir)) return `Directory missing: ${dir}`;
      const matches = readdirSync(dir).filter((f) => f.startsWith(check.prefix));
      if (matches.length === 0) return `No ${check.label ?? check.prefix + "*"} files found in ${dir}`;
      return null;
    }
    case "require_file_matching_pattern": {
      const dir = resolveTemplates(check.dir);
      if (!existsSync(dir)) return `Directory missing: ${dir}`;
      const pattern = new RegExp(check.pattern);
      const found = walkDir(dir).some((f) => pattern.test(f));
      if (!found) return `No ${check.label ?? check.pattern} matches found under ${dir}`;
      return null;
    }
    case "run_script": {
      // With args, execute directly so templated values are passed as data.
      // Without args, a static shell command remains available for pipelines.
      const rawCmd = check.cmd;
      if (!Array.isArray(check.args) && rawCmd?.includes("{{")) {
        return `${check.label ?? "run_script"} cannot template a shell command; use args`;
      }
      const cmd = resolveTemplates(rawCmd);
      if (!cmd) return `${check.label ?? "run_script"} is missing cmd`;
      // Gate subprocesses read the same run's stores: forward the chosen data dir.
      const env = { ...process.env, ...(dataDirFlag ? { UWF_DATA_DIR: dataDirFlag } : {}) };
      try {
        if (Array.isArray(check.args)) {
          const scriptArgs = check.args.map((arg) => resolveTemplates(String(arg)));
          execFileSync(cmd, scriptArgs, { stdio: "pipe", env });
        } else {
          execSync(cmd, { stdio: "pipe", env });
        }
        return null;
      } catch (err) {
        const detail = err.stdout?.toString().trim() || err.stderr?.toString().trim() || "";
        return `${check.label ?? cmd} failed (exit ${err.status})${detail ? ": " + detail : ""}`;
      }
    }
    case "require_json_field":
      return evaluateJsonFieldCheck(check);
    default:
      return `Unknown check type: "${check.type}"`;
  }
}

/** Light structural validation against schemas/stage-result.schema.json (no ajv dependency). */
function validateStageResult(doc) {
  const schemaPath = skillResource("uwf-orchestration-engine", "schemas", "stage-result.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const errs = [];
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObj(doc)) return ["/ must be an object"];
  const props = schema.properties;
  for (const k of schema.required) if (!(k in doc)) errs.push(`/${k} is required`);
  if ("verdict" in doc && !props.verdict.enum.includes(doc.verdict)) {
    errs.push(`/verdict must be one of ${props.verdict.enum.join("|")}`);
  }
  if ("findings" in doc) {
    if (!Array.isArray(doc.findings)) errs.push("/findings must be an array");
    else doc.findings.forEach((f, i) => {
      if (!isObj(f)) { errs.push(`/findings/${i} must be an object`); return; }
      const ip = props.findings.items.properties;
      if (!ip.severity.enum.includes(f.severity)) errs.push(`/findings/${i}/severity must be one of ${ip.severity.enum.join("|")}`);
      if (typeof f.summary !== "string") errs.push(`/findings/${i}/summary must be a string`);
      if ("location" in f && typeof f.location !== "string") errs.push(`/findings/${i}/location must be a string`);
    });
  }
  if ("notes" in doc && typeof doc.notes !== "string") errs.push("/notes must be a string");
  return errs;
}

/** Resolve an RFC 6901 JSON pointer. Returns { found, value }. */
function resolvePointer(doc, pointer) {
  if (pointer === "") return { found: true, value: doc };
  if (!pointer.startsWith("/")) return { found: false };
  let cur = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

function evaluateJsonFieldCheck(check) {
  const p = resolveTemplates(check.path);
  const pointer = check.pointer ?? "";
  const where = `${check.label ?? p} (${p}) pointer ${pointer || "(root)"}`;
  const modes = ["equals", "in", "exists"].filter((m) => m in check);
  if (modes.length !== 1) return `${where}: misconfigured, needs exactly one of equals/in/exists`;
  if (!existsSync(p)) return `${where}: file missing`;
  let doc;
  try { doc = JSON.parse(readFileSync(p, "utf8")); }
  catch { return `${where}: invalid JSON`; }
  if (check.schema === "stage-result") {
    const errs = validateStageResult(doc);
    if (errs.length) return `${where}: does not match stage-result schema: ${errs.join("; ")}`;
  } else if (check.schema !== undefined) {
    return `${where}: unknown schema "${check.schema}"`;
  }
  const { found, value } = resolvePointer(doc, pointer);
  const observed = found ? JSON.stringify(value) : "<absent>";
  if ("exists" in check) {
    return found === (check.exists === true) ? null : `${where}: observed ${observed}, expected exists: ${check.exists}`;
  }
  if ("equals" in check) {
    return found && JSON.stringify(value) === JSON.stringify(check.equals) ? null
      : `${where}: observed ${observed}, expected equals ${JSON.stringify(check.equals)}`;
  }
  const allowed = Array.isArray(check.in) ? check.in : [];
  return found && allowed.some((a) => JSON.stringify(a) === JSON.stringify(value)) ? null
    : `${where}: observed ${observed}, expected one of ${JSON.stringify(allowed)}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function readState(db) {
  return db.prepare(`SELECT * FROM stage_runs WHERE workflow = ? ORDER BY id ASC`).all(workflow);
}

function ensureRow(db, stageName) {
  const exists = db.prepare(`SELECT id FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, stageName);
  if (!exists) {
    const { stages } = loadStagesYaml(workflow);
    const stageDef = stages.find((s) => s.name === stageName);
    const runAsSubagent = stageDef ? (stageDef.run_as_subagent !== false ? 1 : 0) : 1;
    db.prepare(`INSERT INTO stage_runs (workflow, stage, status, retry_count, run_as_subagent) VALUES (?, ?, 'pending', 0, ?)`)
      .run(workflow, stageName, runAsSubagent);
  }
}

function appendHistory(db, wf, stage, fromStatus, toStatus, notes) {
  db.prepare(
    `INSERT INTO stage_history (workflow, stage, from_status, to_status, ts, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wf, stage, fromStatus ?? null, toStatus, new Date().toISOString(), notes ?? null);
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Called by persona run.mjs shims to forward --list-stages / --check-gate. */
export function runShim(wf) {
  // Inject --workflow <wf> if not already present
  if (!process.argv.includes("--workflow")) {
    process.argv.push("--workflow", wf);
  }
  // Re-parse is unnecessary — module already evaluated. Instead, proxy by
  // re-executing the CLI via the already-parsed `flags` object trick:
  // We can't re-run the module, so shims must pass --workflow explicitly.
  // This export is kept for documentation; shims use the direct CLI pattern.
}

function succeed(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
  process.exit(0);
}

function fail(message, extras = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extras }, null, 2) + "\n");
  process.exit(1);
}

function usageError(message) {
  process.stderr.write(`Usage error: ${message}\n`);
  process.exit(2);
}

function requireFlag(name, cmd) {
  if (!flags[name]) usageError(`Command "${cmd}" requires --${name}.`);
}

function parseFlags(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result[key] = argv[++i];
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}
