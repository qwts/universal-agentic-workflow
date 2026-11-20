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
const { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } = fs;
const fsGlobSync = fs.globSync;
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(__dirname, "..", "..");
// The excerpt is only a preview: the stage reads the full file when it needs it, and every inlined
// character is re-sent on every turn of the stage, so keep it small.
const EXCERPT_LINES = 12;
const EXCERPT_LINE_CHARS = 200;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const OPEN_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
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

function matchPath(patSegs, strSegs, pi = 0, si = 0, seen = new Set()) {
  const key = `${pi}:${si}`;
  if (seen.has(key)) return false;
  while (pi < patSegs.length) {
    if (patSegs[pi] === "**") {
      for (let k = si; k <= strSegs.length; k++) {
        if (matchPath(patSegs, strSegs, pi + 1, k, seen)) return true;
      }
      seen.add(key);
      return false;
    }
    if (si >= strSegs.length || !matchSegment(patSegs[pi], strSegs[si])) {
      seen.add(key);
      return false;
    }
    pi++; si++;
  }
  if (si !== strSegs.length) seen.add(key);
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
export const REVIEW_SCRIPT_COMMAND = "node .github/skills/uwf-review/reviews.mjs";

/**
 * `allowedCommands` is the agent frontmatter `allowed-commands` list. A read-only agent that lists
 * the review script gets the `read-only+review` preset: read tools plus that one command, nothing else.
 */
export function mapPermissions(tools, allowedCommands) {
  const t = new Set((Array.isArray(tools) ? tools : []).map((x) => String(x).toLowerCase()));
  if (t.has("execute")) return "edit+exec";
  if (t.has("edit")) return "edit";
  if ((Array.isArray(allowedCommands) ? allowedCommands : []).includes(REVIEW_SCRIPT_COMMAND)) return "read-only+review";
  return "read-only";
}

function personaRole(skills, workflow) {
  const p = join(skills, `uwf-${workflow}`, "SKILL.md");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^\|\s*`role`\s*\|\s*`([^`]+)`/m);
  return m ? m[1] : null;
}

/** One line per skipped stage whose outputs are unavailable as inputs. */
function skippedInputNotes(inputsSkipped) {
  const by = new Map();
  for (const { stage, path } of inputsSkipped) by.set(stage, [...(by.get(stage) ?? []), path]);
  const lines = [...by].map(([stage, paths]) => `inputs from skipped stage ${stage} are unavailable: ${paths.join(", ")}`);
  return lines.length ? [...lines, ""] : [];
}

function expandBraces(pattern, max = 64) {
  const results = [];
  const walkBrace = (str) => {
    if (results.length >= max) {
      throw new PromptError(`Stage input brace glob exceeds ${max} expansions: ${pattern}`);
    }
    let open = -1;
    let depth = 0;
    let inClass = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "[" && !inClass) { inClass = true; continue; }
      if (ch === "]" && inClass) { inClass = false; continue; }
      if (inClass) continue;
      if (ch === "{") {
        if (depth === 0) open = i;
        depth++;
      } else if (ch === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          const prefix = str.slice(0, open);
          const suffix = str.slice(i + 1);
          const inner = str.slice(open + 1, i);
          const parts = [];
          let last = 0;
          let subDepth = 0;
          let subClass = false;
          for (let j = 0; j < inner.length; j++) {
            const c = inner[j];
            if (c === "[" && !subClass) { subClass = true; continue; }
            if (c === "]" && subClass) { subClass = false; continue; }
            if (subClass) continue;
            if (c === "{") subDepth++;
            else if (c === "}" && subDepth > 0) subDepth--;
            else if (c === "," && subDepth === 0) {
              parts.push(inner.slice(last, j));
              last = j + 1;
            }
          }
          parts.push(inner.slice(last));
          for (const part of parts) {
            if (results.length >= max) {
              throw new PromptError(`Stage input brace glob exceeds ${max} expansions: ${pattern}`);
            }
            walkBrace(prefix + part + suffix);
          }
          return;
        }
      }
    }
    if (results.length >= max) {
      throw new PromptError(`Stage input brace glob exceeds ${max} expansions: ${pattern}`);
    }
    results.push(str);
  };
  walkBrace(pattern);
  return results;
}

function canMatchDescendants(patSegs, dirSegs, pi = 0, si = 0, seen = new Set()) {
  const key = `${pi}:${si}`;
  if (seen.has(key)) return false;
  if (patSegs[pi] === "**") {
    const ok =
      canMatchDescendants(patSegs, dirSegs, pi + 1, si, seen) ||
      (si < dirSegs.length ? canMatchDescendants(patSegs, dirSegs, pi, si + 1, seen) : true);
    if (!ok) seen.add(key);
    return ok;
  }
  if (si === dirSegs.length) return pi < patSegs.length;
  if (pi >= patSegs.length || !matchSegment(patSegs[pi], dirSegs[si])) {
    seen.add(key);
    return false;
  }
  const ok = canMatchDescendants(patSegs, dirSegs, pi + 1, si + 1, seen);
  if (!ok) seen.add(key);
  return ok;
}

function buildStageInputContext(repoRoot, outputPath, extraRoots = []) {
  const absRepo = resolve(repoRoot);
  const absOut = outputPath ? resolve(absRepo, outputPath) : null;
  const containerRoots = [
    ...new Set([
      absRepo,
      ...(absOut ? [absOut] : []),
      ...extraRoots.filter(Boolean).map((r) => resolve(absRepo, r)),
    ]),
  ];
  const allowedRealRoots = [];
  for (const c of containerRoots) {
    let st;
    try {
      st = statSync(c);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (!st.isDirectory()) {
      throw new PromptError(`Stage root must be a directory: ${c}`);
    }
    allowedRealRoots.push(realpathSync(c));
  }
  const insideRealRoot = (realP) =>
    allowedRealRoots.some((r) => realP === r || realP.startsWith(r.endsWith(sep) ? r : r + sep));
  const isOutsideRel = (rel) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
  const findContainerOrNull = (absTarget) => {
    let best = null;
    for (const c of containerRoots) {
      const rel = relative(c, absTarget);
      if (absTarget === c || (rel !== "" && !isOutsideRel(rel))) {
        if (!best || c.length > best.length) best = c;
      }
    }
    return best;
  };
  const hasContainer = (absTarget) => findContainerOrNull(absTarget) !== null;
  const findContainer = (absTarget) => {
    const best = findContainerOrNull(absTarget);
    if (!best) {
      throw new PromptError(`Stage input escapes repo_root and output_path: ${absTarget}`);
    }
    return best;
  };
  const assertNoSymlinkAncestors = (container, absTarget) => {
    let curLst;
    try {
      curLst = statSync(container);
    } catch (e) {
      if (e.code === "ENOENT") return { exists: false, leafLst: null };
      throw e;
    }
    if (!curLst.isDirectory()) {
      throw new PromptError(`Stage input root must be a directory: ${container}`);
    }
    const parts = relative(container, absTarget).split(sep).filter(Boolean);
    let cur = container;
    let leafLst = curLst;
    for (let i = 0; i < parts.length; i++) {
      cur = join(cur, parts[i]);
      try {
        leafLst = lstatSync(cur);
      } catch (e) {
        if (e.code === "ENOENT") return { exists: false, leafLst: null };
        throw e;
      }
      if (leafLst.isSymbolicLink()) {
        throw new PromptError(`Stage input must not traverse symlinks: ${cur}`);
      }
      if (i < parts.length - 1 && !leafLst.isDirectory()) {
        return { exists: false, leafLst: null };
      }
    }
    return { exists: true, leafLst };
  };
  const assertRegularContainedInput = (absTarget) => {
    const container = findContainer(absTarget);
    const walkRes = assertNoSymlinkAncestors(container, absTarget);
    if (!walkRes.exists) return false;
    if (!walkRes.leafLst.isFile()) {
      throw new PromptError(`Stage input must be a regular file: ${absTarget}`);
    }
    if (walkRes.leafLst.size > MAX_INPUT_BYTES) {
      throw new PromptError(`Stage input exceeds ${MAX_INPUT_BYTES} byte limit: ${absTarget}`);
    }
    const realTarget = realpathSync(absTarget);
    if (!insideRealRoot(realTarget)) {
      throw new PromptError(`Stage input escapes allowed root: ${absTarget}`);
    }
    let fd;
    try {
      fd = openSync(absTarget, OPEN_NOFOLLOW_FLAGS);
      const fst = fstatSync(fd);
      if (!fst.isFile()) {
        throw new PromptError(`Stage input must be a regular file: ${absTarget}`);
      }
      if (fst.size > MAX_INPUT_BYTES) {
        throw new PromptError(`Stage input exceeds ${MAX_INPUT_BYTES} byte limit: ${absTarget}`);
      }
    } catch (err) {
      if (err instanceof PromptError) throw err;
      throw new PromptError(`Cannot validate stage input ${absTarget}: ${err.message}`);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
    return true;
  };
  const assertSafeGateDir = (dirSpec) => {
    const absDir = resolve(absRepo, dirSpec);
    const container = findContainer(absDir);
    const walkRes = assertNoSymlinkAncestors(container, absDir);
    if (!walkRes.exists) return;
    if (!walkRes.leafLst.isDirectory()) {
      throw new PromptError(`Gate directory must be a regular directory: ${absDir}`);
    }
    if (!insideRealRoot(realpathSync(absDir))) {
      throw new PromptError(`Gate directory escapes allowed root: ${absDir}`);
    }
  };
  const assertSafeGateArgPath = (absTarget, { enforceSizeLimit = false } = {}) => {
    const container = findContainer(absTarget);
    const walkRes = assertNoSymlinkAncestors(container, absTarget);
    if (!walkRes.exists) return;
    if (walkRes.leafLst.isDirectory()) {
      if (!insideRealRoot(realpathSync(absTarget))) {
        throw new PromptError(`Gate directory escapes allowed root: ${absTarget}`);
      }
      return;
    }
    if (!walkRes.leafLst.isFile()) {
      throw new PromptError(`Gate path must be a regular file or directory: ${absTarget}`);
    }
    if (!insideRealRoot(realpathSync(absTarget))) {
      throw new PromptError(`Gate path escapes allowed root: ${absTarget}`);
    }
    if (enforceSizeLimit) {
      assertRegularContainedInput(absTarget);
    }
  };
  const expandOne = (subPat, outSet) => {
    const absP = resolve(absRepo, subPat);
    const container = findContainer(absP);
    const relPat = relative(container, absP);
    const patSegs = relPat.split(sep).filter(Boolean);
    const firstGlob = patSegs.findIndex((s) => /[*?[]/.test(s));
    if (firstGlob === -1) {
      if (assertRegularContainedInput(absP)) outSet.add(absP);
      return;
    }
    const baseDir = firstGlob === 0 ? container : join(container, ...patSegs.slice(0, firstGlob));
    const baseWalk = assertNoSymlinkAncestors(container, baseDir);
    if (!baseWalk.exists) return;
    if (!baseWalk.leafLst.isDirectory()) {
      throw new PromptError(`Stage input directory must be a regular directory: ${baseDir}`);
    }
    if (!insideRealRoot(realpathSync(baseDir))) {
      throw new PromptError(`Stage input directory escapes allowed root: ${baseDir}`);
    }
    const scanDir = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if ((entry.name === ".git" || entry.name === "node_modules") && !patSegs.includes(entry.name)) {
          continue;
        }
        const cand = join(dir, entry.name);
        let candLst;
        try {
          candLst = lstatSync(cand);
        } catch (e) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        const candRelSegs = relative(container, cand).split(sep).filter(Boolean);
        const hitsPattern = matchPath(patSegs, candRelSegs);
        const traversesSubdir = canMatchDescendants(patSegs, candRelSegs);
        if (candLst.isSymbolicLink()) {
          let isDirTarget = false;
          if (traversesSubdir) {
            try { isDirTarget = statSync(cand).isDirectory(); } catch { /* broken/file */ }
          }
          if (hitsPattern || (traversesSubdir && isDirTarget)) {
            throw new PromptError(`Stage input must not be or traverse a symlink: ${cand}`);
          }
          continue;
        }
        if (candLst.isDirectory()) {
          if (traversesSubdir) {
            if (!insideRealRoot(realpathSync(cand))) {
              throw new PromptError(`Stage input directory escapes allowed root: ${cand}`);
            }
            scanDir(cand);
          }
          continue;
        }
        if (hitsPattern && assertRegularContainedInput(cand)) {
          outSet.add(cand);
        }
      }
    };
    scanDir(baseDir);
  };
  const expand = (p) => {
    const matched = new Set();
    for (const subPat of expandBraces(p)) {
      expandOne(subPat, matched);
    }
    return [...matched].sort();
  };
  const readSafeInputUtf8 = (absFile) => {
    assertRegularContainedInput(absFile);
    let fd;
    try {
      fd = openSync(absFile, OPEN_NOFOLLOW_FLAGS);
      const st = fstatSync(fd);
      if (!st.isFile()) {
        throw new PromptError(`Stage input must be a regular file: ${absFile}`);
      }
      if (st.size > MAX_INPUT_BYTES) {
        throw new PromptError(`Stage input exceeds ${MAX_INPUT_BYTES} byte limit: ${absFile}`);
      }
      if (!insideRealRoot(realpathSync(absFile))) {
        throw new PromptError(`Stage input escapes allowed root: ${absFile}`);
      }
      const chunks = [];
      let total = 0;
      const chunkBuf = Buffer.allocUnsafe(65536);
      while (true) {
        const n = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
        if (n === 0) break;
        total += n;
        if (total > MAX_INPUT_BYTES) {
          throw new PromptError(`Stage input exceeds ${MAX_INPUT_BYTES} byte limit: ${absFile}`);
        }
        chunks.push(Buffer.from(chunkBuf.subarray(0, n)));
      }
      return Buffer.concat(chunks, total).toString("utf8");
    } catch (err) {
      if (err instanceof PromptError) throw err;
      throw new PromptError(`Cannot read stage input ${absFile}: ${err.message}`);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  };
  return {
    abs: (p) => resolve(absRepo, p),
    expand,
    readSafeInputUtf8,
    assertRegularContainedInput,
    assertSafeGateDir,
    assertSafeGateArgPath,
    hasContainer,
  };
}

/**
 * Validate declared stage `inputs` (literal and glob) and, when `validateGates` is true,
 * gate/condition file & directory paths against symlinks, non-regular files (e.g., FIFOs),
 * size bounds, and root containment.
 */
export function validateWorkflowStageInputs({ workflow, stage = null, validateGates = Boolean(stage), repoRoot, skillsRoot, outputPath, dataDir } = {}) {
  const absRepo = resolve(repoRoot ?? DEFAULT_REPO);
  const effectiveSkillsRoot = resolveSkillsRoot({ explicit: skillsRoot, repoRoot: absRepo, workflow }).root;
  const stagesPath = join(effectiveSkillsRoot, ".github", "skills", `uwf-${workflow}`, "stages.yaml");
  if (!existsSync(stagesPath)) return;
  const yaml = loadYaml(effectiveSkillsRoot);
  const stagesDoc = yaml.load(readFileSync(stagesPath, "utf8"));
  const chosenDataDir = dataDir ?? process.env.UWF_DATA_DIR;
  const effectiveDataDir = resolve(absRepo, chosenDataDir ?? "./tmp/uwf");
  const rawOut = outputPath ?? (chosenDataDir ? join(chosenDataDir, "workflow-artifacts") : "./tmp/workflow-artifacts");
  const resolvedOut = resolve(absRepo, rawOut);
  const { expand, assertSafeGateDir, assertSafeGateArgPath, hasContainer } = buildStageInputContext(
    absRepo,
    resolvedOut,
    [effectiveSkillsRoot, effectiveDataDir, DEFAULT_REPO],
  );
  const subst = (s) =>
    String(s)
      .replace(/\{\{output_path\}\}/g, () => resolvedOut)
      .replace(/\{\{cwd\}\}/g, () => absRepo)
      .replace(/\{\{skills_root\}\}/g, () => effectiveSkillsRoot);
  const stages = Array.isArray(stagesDoc?.stages) ? stagesDoc.stages : [];
  const targetStages = stage ? stages.filter((st) => st?.name === stage) : stages;
  if (stage && stages.length > 0 && targetStages.length === 0) {
    throw new PromptError(`Unknown stage "${stage}" in workflow "${workflow}"`);
  }
  for (const st of targetStages) {
    for (const raw of st?.inputs ?? []) {
      expand(subst(raw));
    }
    if (!validateGates) continue;
    if (typeof st?.condition?.path === "string") {
      assertSafeGateArgPath(resolve(absRepo, subst(st.condition.path)), { enforceSizeLimit: true });
    }
    for (const check of st?.gate?.checks ?? []) {
      if (typeof check?.path === "string") {
        const readsFile = check?.type === "require_contains" || check?.type === "require_json_field";
        assertSafeGateArgPath(resolve(absRepo, subst(check.path)), { enforceSizeLimit: readsFile });
      }
      if ((check?.type === "require_files_with_prefix" || check?.type === "require_file_matching_pattern") && typeof check?.dir === "string") {
        assertSafeGateDir(subst(check.dir));
      }
      if (check?.type === "run_script" && Array.isArray(check?.args)) {
        for (let i = 0; i < check.args.length; i++) {
          const rawArg = check.args[i];
          if (typeof rawArg !== "string" || /[\n;]/.test(rawArg)) continue;
          if (i > 0 && /^(-e|-p|--eval|--print)$/.test(String(check.args[i - 1]))) continue;
          const candidates = [];
          if (rawArg.startsWith("-")) {
            const eq = rawArg.indexOf("=");
            if (eq > 0) candidates.push(rawArg.slice(eq + 1));
          } else {
            candidates.push(rawArg);
            const eq = rawArg.indexOf("=");
            if (eq > 0) candidates.push(rawArg.slice(eq + 1));
          }
          for (const candidate of candidates) {
            if (!candidate) continue;
            const resolvedArg = resolve(absRepo, subst(candidate));
            let existsOnDisk = false;
            try {
              lstatSync(resolvedArg);
              existsOnDisk = true;
            } catch (e) {
              if (e.code !== "ENOENT" && e.code !== "ENOTDIR" && e.code !== "ENAMETOOLONG") throw e;
            }
            if (hasContainer(resolvedArg) || existsOnDisk || /\{\{(?:output_path|cwd|skills_root)\}\}/.test(candidate)) {
              assertSafeGateArgPath(resolvedArg, { enforceSizeLimit: false });
            }
          }
        }
      }
    }
  }
}

/**
 * Two roots: `skillsRoot` holds workflow definitions, stage contracts, traits, profiles, agent files
 * and SKILL docs (default: this checkout, or UWF_SKILLS_ROOT); `repoRoot` is the target repo the
 * agent works in, where {{cwd}} / {{output_path}} and the artifacts resolve.
 */
export async function materializePrompt({ workflow, stage, repoRoot, skillsRoot, outputPath, dataDir, extraContext, modelProfile, extraInputs, extraNote, skippedStages } = {}) {
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
  // The approved commands must match what the (possibly rewritten) prompt tells the agent to run, so
  // list both the repo-relative form and the form resolved against the skills root.
  const allowedCommands = [...new Set((Array.isArray(frontmatter["allowed-commands"]) ? frontmatter["allowed-commands"] : []).flatMap((c) => {
    const rewritten = String(c).replace(/\.github\/(?:skills|agents)\/[^\s`'")]*/g, (full) => {
      if (existsSync(join(repoRoot, full))) return full;
      return fallbackRoots.map((r) => join(r, full)).find((q) => existsSync(q)) ?? join(fallbackRoots[0] ?? skillsRoot, full);
    });
    return [String(c), rewritten];
  }))];
  const skillFilesNote = rewrote ? [
    "## Skill files",
    `The workflow skills are not all in this repository. When an instruction names a \`.github/skills/...\` or \`.github/agents/...\` path or command that does not exist in the working directory, use the same path under ${fallbackRoots.join(" or, failing that, ")} instead.`,
    "",
  ] : [];

  const subst = (s) => String(s).replace(/\{\{output_path\}\}/g, () => outputPath).replace(/\{\{cwd\}\}/g, () => repoRoot);
  const inputs = [...(stageDef.inputs ?? []), ...(extraInputs ?? [])].map(subst);
  const outputs = (stageDef.outputs ?? []).map(subst);

  const { abs, expand, readSafeInputUtf8 } = buildStageInputContext(repoRoot, outputPath, [skillsRoot, resolve(repoRoot, dataDir)]);
  // Outputs of skipped stages: a missing input that one of them would have produced is expected, not an error.
  const skippedOutputs = new Map();
  for (const sk of skippedStages ?? []) {
    const def = (stagesDoc.stages ?? []).find((s) => s.name === sk);
    for (const o of def?.outputs ?? []) if (!skippedOutputs.has(subst(o))) skippedOutputs.set(subst(o), sk);
  }
  const inputsMissing = [];
  const inputsSkipped = [];
  const inputBlocks = [];
  for (const p of inputs) {
    const files = expand(p);
    if (files.length === 0) {
      if (skippedOutputs.has(p)) {
        inputsSkipped.push({ stage: skippedOutputs.get(p), path: p });
        continue;
      }
      inputsMissing.push(p);
      inputBlocks.push(`### ${p}\n(missing)`);
      continue;
    }
    for (const f of files) {
      const lines = readSafeInputUtf8(f).split(/\r?\n/);
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
    ...skippedInputNotes(inputsSkipped),
    inputBlocks.length ? inputBlocks.join("\n\n") : "(none)",
    "",
    ...(extraNote ? ["## Review findings to address", extraNote, ""] : []),
    "## Required outputs",
    outputs.length ? outputs.map((o) => `- ${o}`).join("\n") : "(none)",
    "",
  ].join("\n");

  return {
    agentFile,
    agentName: frontmatter.name ?? agentName,
    // The agent body names its files with the same {{output_path}} / {{cwd}} templates as stages.yaml.
    systemPrompt: subst(body),
    prompt,
    permissions: mapPermissions(frontmatter.tools, frontmatter["allowed-commands"]),
    allowedCommands,
    model: stageDef.model ?? null,
    inputs,
    inputsMissing,
    inputsSkipped,
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
