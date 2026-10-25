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
 *        [--repo-root r] [--skills-root s] [--output-path p] [--data-dir d] [--model-profile p] [--json]
 * Exit codes: 0 ok, 2 usage error.
 */

import * as fs from "node:fs";
// Named-importing globSync is a SyntaxError on Node 20 (no such export), so
// go through the namespace and feature-detect at call time.
const { existsSync, readFileSync, readdirSync, statSync } = fs;
const fsGlobSync = fs.globSync;
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(__dirname, "..", "..");
// The excerpt is only a preview: the stage reads the full file when it needs it, and every inlined
// character is re-sent on every turn of the stage, so keep it small.
const EXCERPT_LINES = 12;
const EXCERPT_LINE_CHARS = 200;
const clip = (l) => (l.length > EXCERPT_LINE_CHARS ? l.slice(0, EXCERPT_LINE_CHARS) + "..." : l);

// js-yaml lives in the engine skill's node_modules (npm ci there).
// Prefer the skills root's install; fall back to this checkout's so the runner
// works against a skills tree or target repository that has no skill installs.
function loadYaml(skillsRoot) {
  for (const root of [skillsRoot, DEFAULT_REPO]) {
    const pkg = join(root, ".github", "skills", "uwf-orchestration-engine", "package.json");
    if (!existsSync(pkg)) continue;
    try { return createRequire(pkg)("js-yaml"); } catch { /* try next root */ }
  }
  throw new PromptError("js-yaml not found: run npm ci in .github/skills/uwf-orchestration-engine");
}

export class PromptError extends Error {}

/**
 * Where workflow definitions, stage contracts, schemas, agent files and SKILL docs come from.
 * Rule: explicit (--skills-root / `explicit`) > UWF_SKILLS_ROOT > the target repo's own copy when
 * <repoRoot>/.github/skills/uwf-<workflow>/stages.yaml exists > this checkout. Returns { root, source }.
 */
export function resolveSkillsRoot({ explicit, repoRoot, workflow } = {}) {
  if (explicit) return { root: resolve(explicit), source: "flag" };
  if (process.env.UWF_SKILLS_ROOT) return { root: resolve(process.env.UWF_SKILLS_ROOT), source: "env" };
  if (repoRoot && workflow && resolve(repoRoot) !== DEFAULT_REPO &&
      existsSync(join(resolve(repoRoot), ".github", "skills", `uwf-${workflow}`, "stages.yaml"))) {
    return { root: resolve(repoRoot), source: "target" };
  }
  return { root: DEFAULT_REPO, source: "own" };
}

// Node 20 has no fs.globSync (added in 22). The stage inputs only use simple
// patterns such as docs/adr/ADR-[0-9]*.md, so a small matcher covers the
// supported runtime; fs.globSync is used when available.
// Direct glob matcher (no RegExp construction from stage input): supports
// *, ?, [...] within a path segment and ** across segments.
function matchClass(cls, ch) {
  let neg = false, i = 0;
  if (cls[0] === "!" || cls[0] === "^") { neg = true; i = 1; }
  let hit = false;
  for (; i < cls.length; i++) {
    if (cls[i + 1] === "-" && i + 2 < cls.length) {
      if (ch >= cls[i] && ch <= cls[i + 2]) hit = true;
      i += 2;
    } else if (cls[i] === ch) hit = true;
  }
  return neg ? !hit : hit;
}

function matchSegment(pat, str, pi = 0, si = 0) {
  while (pi < pat.length) {
    const c = pat[pi];
    if (c === "*") {
      for (let k = si; k <= str.length; k++) if (matchSegment(pat, str, pi + 1, k)) return true;
      return false;
    }
    if (si >= str.length) return false;
    if (c === "[") {
      const close = pat.indexOf("]", pi + 2);
      if (close === -1) { if (str[si] !== "[") return false; pi++; si++; continue; }
      if (!matchClass(pat.slice(pi + 1, close), str[si])) return false;
      pi = close + 1; si++; continue;
    }
    if (c !== "?" && c !== str[si]) return false;
    pi++; si++;
  }
  return si === str.length;
}

function matchPath(patSegs, strSegs, pi = 0, si = 0) {
  while (pi < patSegs.length) {
    if (patSegs[pi] === "**") {
      for (let k = si; k <= strSegs.length; k++) if (matchPath(patSegs, strSegs, pi + 1, k)) return true;
      return false;
    }
    if (si >= strSegs.length || !matchSegment(patSegs[pi], strSegs[si])) return false;
    pi++; si++;
  }
  return si === strSegs.length;
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export function globFiles(pattern, cwd) {
  if (typeof fsGlobSync === "function" && !process.env.UWF_FORCE_GLOB_FALLBACK) return fsGlobSync(pattern, { cwd });
  const abs = resolve(cwd, pattern);
  const segs = abs.split("/");
  const firstGlob = segs.findIndex((s) => /[*?[{]/.test(s));
  if (firstGlob === -1) return existsSync(abs) ? [abs] : [];
  const base = segs.slice(0, firstGlob).join("/") || "/";
  const deep = segs.slice(firstGlob).some((s) => s.includes("**")) || segs.length - firstGlob > 1;
  const candidates = deep ? walk(base) : (() => { try { return readdirSync(base).map((n) => join(base, n)); } catch { return []; } })();
  return candidates.filter((f) => matchPath(segs, f.split("/")) && (() => { try { return statSync(f).isFile(); } catch { return false; } })());
}

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

// Engine resources (stage contracts, traits, profiles) come from the skills root
// when it carries them, else from this checkout.
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

/**
 * Two roots: `skillsRoot` holds workflow definitions, stage contracts, traits, profiles, agent files
 * and SKILL docs (default: this checkout, or UWF_SKILLS_ROOT); `repoRoot` is the target repo the
 * agent works in, where {{cwd}} / {{output_path}} and the artifacts resolve.
 */
export async function materializePrompt({ workflow, stage, repoRoot, skillsRoot, outputPath, dataDir, extraContext, modelProfile } = {}) {
  repoRoot = resolve(repoRoot ?? DEFAULT_REPO);
  skillsRoot = resolveSkillsRoot({ explicit: skillsRoot, repoRoot, workflow }).root;
  // Match stage-tracker.mjs: artifacts live under <data-dir>/workflow-artifacts
  // only when a data dir was chosen; otherwise the shared ./tmp/workflow-artifacts.
  const chosenDataDir = dataDir ?? process.env.UWF_DATA_DIR;
  dataDir = chosenDataDir ?? "./tmp/uwf";
  outputPath = outputPath ?? (chosenDataDir ? join(chosenDataDir, "workflow-artifacts") : "./tmp/workflow-artifacts");
  if (!workflow || !stage) throw new PromptError("workflow and stage are required");

  const yaml = loadYaml(skillsRoot);
  const skills = join(skillsRoot, ".github", "skills");
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
  let agentFile = join(skillsRoot, ".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(agentFile)) agentFile = join(DEFAULT_REPO, ".github", "agents", `${agentName}.agent.md`);
  if (!existsSync(agentFile)) throw new PromptError(`Agent file not found: ${join(skillsRoot, ".github", "agents", `${agentName}.agent.md`)}`);
  const parsed = parseAgentFile(yaml, readFileSync(agentFile, "utf8"));
  const { frontmatter } = parsed;
  // The agent text names its reference files as `.github/skills/...` / `.github/agents/...`, relative to
  // the agent's cwd (repoRoot). A reference the target carries stays relative; any other points at the
  // first root that has it (skillsRoot, then this checkout), so a bare or partial target reads the right files.
  const fallbackRoots = [...new Set([skillsRoot, DEFAULT_REPO])].filter((r) => r !== repoRoot);
  let rewrote = false;
  const body = parsed.body.replace(/\.github\/(?:skills|agents)\/[^\s`'")]*/g, (full) => {
    const m = full.replace(/[.,;:]+$/, "");
    if (existsSync(join(repoRoot, m))) return full;
    const at = fallbackRoots.map((r) => join(r, m)).find((q) => existsSync(q)) ?? join(fallbackRoots[0] ?? skillsRoot, m);
    rewrote = true;
    return at + full.slice(m.length);
  });
  // Skill docs the agent is told to read carry their own relative `.github/skills/...` commands, which
  // the prompt cannot rewrite; give the stage the rule instead.
  const skillFilesNote = rewrote ? [
    "## Skill files",
    `The workflow skills are not all in this repository. When an instruction names a \`.github/skills/...\` or \`.github/agents/...\` path or command that does not exist in the working directory, use the same path under ${fallbackRoots.join(" or, failing that, ")} instead.`,
    "",
  ] : [];

  const subst = (s) => String(s).replace(/\{\{output_path\}\}/g, outputPath).replace(/\{\{cwd\}\}/g, repoRoot);
  const inputs = (stageDef.inputs ?? []).map(subst);
  const outputs = (stageDef.outputs ?? []).map(subst);

  const abs = (p) => resolve(repoRoot, p);
  const expand = (p) =>
    /[*?[{]/.test(p) ? globFiles(p, repoRoot).map(abs).sort() : existsSync(abs(p)) ? [abs(p)] : [];
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
      const shown = lines.slice(0, EXCERPT_LINES).map(clip).join("\n");
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
    inputs,
    outputs,
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
    "## Reading rules",
    "Read the files listed under Inputs (the excerpts below are previews; open the file for the rest) plus only the repository files your task requires you to inspect or change. " +
      "Do not list or read the whole artifacts directory, and do not dump the whole repository into context. " +
      "Write the required outputs directly once you have what you need.",
    "",
    ...skillFilesNote,
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
    console.error("usage: prompt.mjs --workflow <w> --stage <s> [--repo-root r] [--skills-root s] [--output-path p] [--data-dir d] [--model-profile p] [--json]");
    process.exit(2);
  }
  try {
    const r = await materializePrompt({
      workflow: str("workflow"),
      stage: str("stage"),
      repoRoot: str("repo-root"),
      skillsRoot: str("skills-root"),
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
