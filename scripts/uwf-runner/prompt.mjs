/**
 * prompt.mjs — materialize ONE stage prompt for the UWF runner.
 *
 * Combines: the stage agent file (.github/agents/<agent>.agent.md), the engine
 * context block (uwf-orchestration-engine/SKILL.md "context block" and
 * "New-style stage context injection"), the resolved inputs (with excerpts)
 * and the required outputs.
 *
 * Model-adaptation profile: the resolved `steering_policy` (instruction_density,
 * include_examples, ...) is passed through in the context block only; this module
 * does not rewrite the agent body per density.
 *
 * CLI: node scripts/uwf-runner/prompt.mjs --workflow <w> --stage <s>
 *        [--output-path p] [--data-dir d] [--model-profile p] [--json]
 * Exit codes: 0 ok, 2 usage error.
 */

import { existsSync, readFileSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(__dirname, "..", "..");
const EXCERPT_LINES = 40;

// js-yaml lives in the engine skill's node_modules (npm ci there).
// Prefer the target repo's install; fall back to this checkout's so the runner
// works against a scratch or target repository that has no skill installs.
function loadYaml(repoRoot) {
  for (const root of [repoRoot, DEFAULT_REPO]) {
    const pkg = join(root, ".github", "skills", "uwf-orchestration-engine", "package.json");
    if (!existsSync(pkg)) continue;
    try { return createRequire(pkg)("js-yaml"); } catch { /* try next root */ }
  }
  throw new PromptError("js-yaml not found: run npm ci in .github/skills/uwf-orchestration-engine");
}

export class PromptError extends Error {}

const readYaml = (yaml, p) => (existsSync(p) ? yaml.load(readFileSync(p, "utf8")) : null);

// ---- policy resolution (mirrors uwf-orchestration-engine/stage-tracker.mjs) ----
const Q_ORDER = ["minimal", "standard", "aggressive"];
const E_ORDER = ["low", "standard", "high"];
const stricter = (order, a, b) =>
  order[Math.max(order.indexOf(a ?? "standard"), order.indexOf(b ?? "standard"))] ?? "standard";
const union = (...arrs) => [...new Set(arrs.flatMap((a) => a ?? []))];

function mergePolicy(def, traitPolicies) {
  const m = {
    priority_order: [...(def.priority_order ?? [])],
    must_address: [...(def.must_address ?? [])],
    question_policy: def.question_policy ?? "standard",
    risk_focus: [...(def.risk_focus ?? [])],
    evidence_threshold: def.evidence_threshold ?? "standard",
  };
  for (const tp of traitPolicies) {
    m.priority_order = union(m.priority_order, tp.priority_order);
    m.must_address = union(m.must_address, tp.must_address);
    m.risk_focus = union(m.risk_focus, tp.risk_focus);
    m.question_policy = stricter(Q_ORDER, m.question_policy, tp.question_policy);
    m.evidence_threshold = stricter(E_ORDER, m.evidence_threshold, tp.evidence_threshold);
  }
  return m;
}

// Engine resources (stage contracts, traits, profiles) come from the target repo
// when it carries them, else from this checkout, so a target repo only needs
// its persona skill and agents.
function skillFile(skills, ...segs) {
  const local = join(skills, ...segs);
  return existsSync(local) ? local : join(DEFAULT_REPO, ".github", "skills", ...segs);
}

function resolveNewStyle(yaml, skills, stageDef, modelProfile) {
  const { stage_type, traits = [], name } = stageDef;
  const contract = readYaml(yaml, skillFile(skills, "uwf-orchestration-engine", "stage-contracts", `${stage_type}.yaml`));
  if (!contract) throw new PromptError(`Stage "${name}": unknown stage_type "${stage_type}"`);
  const policies = traits.map((t) => {
    const def = readYaml(yaml, skillFile(skills, "uwf-traits", "traits", `${t}.yaml`));
    const p = def?.stage_policies?.[stage_type];
    if (!p) throw new PromptError(`Stage "${name}": trait "${t}" has no policy for stage_type "${stage_type}"`);
    return p;
  });
  const profiles = readYaml(yaml, skillFile(skills, "uwf-model-adaptation", "profiles.yaml"));
  const profile = modelProfile ?? profiles?.default_profile ?? "balanced";
  const base = { ...(profiles?.profiles?.[profile]?.steering_policy ?? {}) };
  const override = profiles?.stage_overrides?.[profile]?.[stage_type];
  return {
    agent: contract.default_agent,
    stage_type,
    trait_ids: traits,
    behavior_policy: mergePolicy(contract.default_behavior_policy ?? {}, policies),
    model_profile: profile,
    steering_policy: override ? { ...base, ...override } : base,
  };
}

// ---- agent file ----
export function parseAgentFile(yaml, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  return { frontmatter: yaml.load(m[1]) ?? {}, body: m[2] };
}

/** Copilot tool names -> adapter permission preset. `agent`, `todo`, `web`, ... are ignored. */
export function mapPermissions(tools) {
  const t = new Set((Array.isArray(tools) ? tools : []).map((x) => String(x).toLowerCase()));
  if (t.has("execute")) return "edit+exec";
  if (t.has("edit")) return "edit";
  return "read-only";
}

function personaRole(skills, workflow) {
  const p = join(skills, `uwf-${workflow}`, "SKILL.md");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^\|\s*`role`\s*\|\s*`([^`]+)`/m);
  return m ? m[1] : null;
}

export async function materializePrompt({ workflow, stage, repoRoot, outputPath, dataDir, extraContext, modelProfile } = {}) {
  repoRoot = resolve(repoRoot ?? DEFAULT_REPO);
  dataDir = dataDir ?? process.env.UWF_DATA_DIR ?? "./tmp/uwf";
  outputPath = outputPath ?? join(dataDir, "workflow-artifacts");
  if (!workflow || !stage) throw new PromptError("workflow and stage are required");

  const yaml = loadYaml(repoRoot);
  const skills = join(repoRoot, ".github", "skills");
  const stagesPath = join(skills, `uwf-${workflow}`, "stages.yaml");
  if (!existsSync(stagesPath)) throw new PromptError(`stages.yaml not found for workflow "${workflow}": ${stagesPath}`);
  const stagesDoc = yaml.load(readFileSync(stagesPath, "utf8"));
  const stageDef = (stagesDoc.stages ?? []).find((s) => s.name === stage);
  if (!stageDef) {
    const names = (stagesDoc.stages ?? []).map((s) => s.name).join(", ");
    throw new PromptError(`Unknown stage "${stage}" for workflow "${workflow}". Stages: ${names}`);
  }

  const resolved = stageDef.stage_type !== undefined ? resolveNewStyle(yaml, skills, stageDef, modelProfile) : null;
  const agentName = resolved ? resolved.agent : stageDef.agent;
  const agentFile = join(repoRoot, ".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(agentFile)) throw new PromptError(`Agent file not found: ${agentFile}`);
  const { frontmatter, body } = parseAgentFile(yaml, readFileSync(agentFile, "utf8"));

  const subst = (s) => String(s).replace(/\{\{output_path\}\}/g, outputPath).replace(/\{\{cwd\}\}/g, repoRoot);
  const inputs = (stageDef.inputs ?? []).map(subst);
  const outputs = (stageDef.outputs ?? []).map(subst);

  const abs = (p) => resolve(repoRoot, p);
  const expand = (p) =>
    /[*?[{]/.test(p) ? globSync(p, { cwd: repoRoot }).map(abs).sort() : existsSync(abs(p)) ? [abs(p)] : [];
  const inputsMissing = [];
  const inputBlocks = [];
  for (const p of inputs) {
    const files = expand(p);
    if (files.length === 0) {
      inputsMissing.push(p);
      inputBlocks.push(`### ${p}\n(missing)`);
      continue;
    }
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      const shown = lines.slice(0, EXCERPT_LINES).join("\n");
      const more = lines.length > EXCERPT_LINES ? `\n... (${lines.length - EXCERPT_LINES} more lines)` : "";
      inputBlocks.push(`### ${f === abs(p) ? p : f}\n\`\`\`\n${shown}${more}\n\`\`\``);
    }
  }

  const ctx = {
    workflow,
    role: personaRole(skills, workflow),
    phase: stageDef.advances_phase_to ?? stage,
    outputPath,
    statePath: join(dataDir, "uwf-state.json"),
  };
  if (resolved) {
    Object.assign(ctx, {
      stage_type: resolved.stage_type,
      trait_ids: resolved.trait_ids,
      model_profile: resolved.model_profile,
      behavior_policy: resolved.behavior_policy,
      steering_policy: resolved.steering_policy,
    });
  }
  Object.assign(ctx, extraContext ?? {});

  const prompt = [
    `Run the ${stage} stage for the ${workflow} workflow.`,
    "",
    "Context:",
    JSON.stringify(ctx, null, 2),
    "",
    "## Inputs",
    inputBlocks.length ? inputBlocks.join("\n\n") : "(none)",
    "",
    "## Required outputs",
    outputs.length ? outputs.map((o) => `- ${o}`).join("\n") : "(none)",
    "",
  ].join("\n");

  return {
    agentFile,
    agentName: frontmatter.name ?? agentName,
    systemPrompt: body,
    prompt,
    permissions: mapPermissions(frontmatter.tools),
    model: stageDef.model ?? null,
    inputsMissing,
    outputsRequired: outputs,
  };
}

// ---- CLI ----
function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith("--")) { f[k] = n; i++; } else f[k] = true;
  }
  return f;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  const str = (k) => (typeof f[k] === "string" ? f[k] : undefined);
  if (!str("workflow") || !str("stage")) {
    console.error("usage: prompt.mjs --workflow <w> --stage <s> [--output-path p] [--data-dir d] [--model-profile p] [--json]");
    process.exit(2);
  }
  try {
    const r = await materializePrompt({
      workflow: str("workflow"),
      stage: str("stage"),
      repoRoot: str("repo-root"),
      outputPath: str("output-path"),
      dataDir: str("data-dir"),
      modelProfile: str("model-profile"),
    });
    process.stdout.write(f.json ? JSON.stringify(r, null, 2) + "\n" : r.prompt);
  } catch (e) {
    console.error(e instanceof PromptError ? e.message : e.stack);
    process.exit(e instanceof PromptError ? 2 : 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
