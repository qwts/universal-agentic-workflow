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
 *   stage-start    --workflow <name> --stage <s>             Mark stage active
 *   stage-complete --workflow <name> --stage <s>             Mark stage passed
 *   stage-fail     --workflow <name> --stage <s> [--note <t>] Increment retry, record failure
 *   stage-skip     --workflow <name> --stage <s>             Mark stage skipped
 *
 * Global options:
 *   --output-path <path>   Default: ./tmp/workflow-artifacts
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
import { execSync } from "node:child_process";
import { resolve, join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = join(__dirname, "uwf-stages.db");
const SCHEMA_PATH = join(__dirname, "stage-schema.yaml");
const STAGE_CONTRACTS_DIR = join(__dirname, "stage-contracts");
const TRAITS_DIR = join(__dirname, "..", "uwf-traits", "traits");
const PROFILES_PATH = join(__dirname, "..", "uwf-model-adaptation", "profiles.yaml");
const AGENTS_DIR = join(__dirname, "..", "..", "agents");

// ---------------------------------------------------------------------------
// Stage resolution helpers
// ---------------------------------------------------------------------------

/** Load a stage contract YAML by stage_type. Returns null if not found. */
function loadStageContract(stageType) {
  const contractPath = join(STAGE_CONTRACTS_DIR, `${stageType}.yaml`);
  if (!existsSync(contractPath)) return null;
  return yaml.load(readFileSync(contractPath, "utf8"));
}

/** Load a trait YAML by trait_id. Returns null if not found. */
function loadTrait(traitId) {
  const traitPath = join(TRAITS_DIR, `${traitId}.yaml`);
  if (!existsSync(traitPath)) return null;
  return yaml.load(readFileSync(traitPath, "utf8"));
}

/** Load the model adaptation profiles.yaml. */
function loadProfiles() {
  if (!existsSync(PROFILES_PATH)) return null;
  return yaml.load(readFileSync(PROFILES_PATH, "utf8"));
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
  const agentFilePath = join(AGENTS_DIR, `${resolvedAgent}.agent.md`);
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
const outputPath = flags["output-path"] ?? "./tmp/workflow-artifacts";

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
  const schema = yaml.load(readFileSync(SCHEMA_PATH, "utf8"));
  db.transaction(() => {
    for (const [tableName, def] of Object.entries(schema.tables)) {
      db.exec(buildCreateTable(tableName, def.columns));
    }
  })();
}

function buildCreateTable(tableName, columns) {
  const defs = columns.map((col) => {
    let d = `"${col.name}" ${col.type}`;
    if (col.primary_key && col.autoincrement) d += " PRIMARY KEY AUTOINCREMENT";
    else if (col.primary_key) d += " PRIMARY KEY";
    if (col.not_null) d += " NOT NULL";
    if (col.default !== undefined) {
      const v = typeof col.default === "string" ? `'${col.default}'` : col.default;
      d += ` DEFAULT ${v}`;
    }
    return d;
  });
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (${defs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Stages YAML loader
// ---------------------------------------------------------------------------

function loadStagesYaml(wf) {
  const yamlPath = resolve(join(".github", "skills", `uwf-${wf}`, "stages.yaml"));
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
    case "init":           cmdInit(db);        break;
    case "read":           cmdRead(db);        break;
    case "stage-start":    cmdStageUpdate(db, "active");    break;
    case "stage-complete": cmdStageUpdate(db, "passed");    break;
    case "stage-fail":     cmdStageFail(db);               break;
    case "stage-skip":     cmdStageUpdate(db, "skipped");  break;
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
  const Q_MJS = ".github/skills/uwf-question-protocol/questions.mjs";
  const modelProfile = flags["model-profile"] ?? null;

  const list = stages.map((stageDef) => {
    const { name, agent, stage_type, traits, max_retries, on_gate_failure, gated, conditional, run_as_subagent, inputs, outputs, advances_phase_to } = stageDef;

    // Validation: agent and stage_type must not coexist
    if (agent !== undefined && stage_type !== undefined) {
      fail(`Stage "${name}": a stage entry must use exactly one of "agent" or "stage_type", not both.`);
    }

    const base = {
      name,
      maxRetries: max_retries ?? 2,
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
  process.exit(0);
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
  const STATE_MJS  = ".github/skills/uwf-state-manager/state.mjs";
  const Q_MJS      = ".github/skills/uwf-question-protocol/questions.mjs";

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
    `UPDATE stage_runs SET status = 'failed', retry_count = retry_count + 1, completed_at = ?, notes = ? WHERE workflow = ? AND stage = ?`
  ).run(new Date().toISOString(), note, workflow, stageName);

  appendHistory(db, workflow, stageName, row.status, "failed", note);
  const updated   = db.prepare(`SELECT * FROM stage_runs WHERE workflow = ? AND stage = ?`).get(workflow, stageName);
  const STATE_MJS = ".github/skills/uwf-state-manager/state.mjs";
  succeed({
    procedure:    "stage-fail",
    workflow,
    stage:        stageName,
    retry_count:  updated.retry_count,
    state_actions: [`node ${STATE_MJS} release-agent`],
    state:        readState(db),
  });
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

function evaluateGate(stageDef, stageName) {
  // Ungated stages always pass
  if (stageDef.gated === false) {
    return { stage: stageName, passed: true, failures: [], note: "ungated — always passes" };
  }

  // Conditional stage: check if condition is met; if not, auto-pass
  if (stageDef.conditional === true && stageDef.condition) {
    if (!evaluateCondition(stageDef.condition)) {
      return { stage: stageName, passed: true, failures: [], note: "conditional — not required" };
    }
  }

  // Evaluate gate checks
  const failures = [];
  for (const check of (stageDef.gate?.checks ?? [])) {
    const failure = evaluateCheck(check);
    if (failure) failures.push(failure);
  }

  return failures.length
    ? { stage: stageName, passed: false, failures }
    : { stage: stageName, passed: true,  failures: [] };
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
      // Runs a shell command; gate passes if exit code is 0.
      // check.cmd   — the command string to execute
      // check.label — human-readable description for failure messages
      const cmd = resolveTemplates(check.cmd);
      if (!cmd) return `${check.label ?? "run_script"} is missing cmd`;
      try {
        execSync(cmd, { stdio: "pipe" });
        return null;
      } catch (err) {
        const detail = err.stdout?.toString().trim() || err.stderr?.toString().trim() || "";
        return `${check.label ?? cmd} failed (exit ${err.status})${detail ? ": " + detail : ""}`;
      }
    }
    default:
      return `Unknown check type: "${check.type}"`;
  }
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
