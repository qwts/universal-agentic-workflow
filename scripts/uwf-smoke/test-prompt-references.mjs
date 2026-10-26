/**
 * Smoke test: stage prompts (agents and skill docs) reference only what exists and what the
 * runner provides.
 *
 * The runner materializes each stage's required outputs and context into the prompt, so a prompt
 * must not hardcode the default artifact directory, ship an unreplaced `{placeholder}`, or point at
 * a skill, agent, or script that does not exist.
 *
 * For every `.github/agents/*.md` and `.github/skills/*\/SKILL.md` it fails on:
 *   (a) a single-brace `{identifier}` placeholder outside a code fence (`{{...}}` runner templates are fine)
 *   (b) a literal `tmp/workflow-artifacts` path
 *   (c) a `uwf-<name>` skill or agent reference with no matching skill directory or agent file
 *   (d) a `.github/...` or `scripts/...` path that does not exist
 *
 * Usage: node scripts/uwf-smoke/test-prompt-references.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agentsDir = join(root, ".github", "agents");
const skillsDir = join(root, ".github", "skills");

// Files that may name the literal default artifact directory because documenting that default is
// their job. Each entry needs a reason.
const LITERAL_PATH_ALLOWED = new Map([
  // The engine contract documents the `--output-path` flag default and the CLI examples.
  [".github/skills/uwf-orchestration-engine/SKILL.md", "documents the CLI default and example invocations"],
]);

// Single-brace names that are not unreplaced placeholders.
const PLACEHOLDER_ALLOWED = new Map([
  // Persona context the runner prints in the prompt (workflow, role, output path) and the artifact
  // naming convention from the persona table (`{output_path}/{prefix}-intake.md`).
  ...["role", "prefix", "workflow", "stage", "output_path", "outputPath", "cwd"].map((n) => [n, "persona context / artifact naming convention"]),
  // Blanks in an output format the agent fills in (`GAP-{id}: ...`, `ACCESS_FAILED: {reason}`).
  ...["id", "seq", "stratum-label", "name", "filename", "verb", "object", "rationale", "reason", "repo-a", "repo-b"].map((n) => [n, "output-format slot the agent fills in"]),
]);

// `uwf-*` tokens that are not skill or agent names.
const NON_REFERENCE_TOKENS = new Map([
  ["uwf-state", "the uwf-state.json file name, not a skill"],
  ["uwf-requirements-db", "the uwf-requirements.db file name, not a skill"],
  // Build-record artifact names (Canonical Build Spec, Build Record, Decision Record Snapshot, changelog, traceability).
  ...["uwf-br", "uwf-drs", "uwf-changelog", "uwf-tm"].map((n) => [n, "build-record artifact name, not a skill"]),
  // The orchestration-engine contract lists this as an example of an invented subagent name to avoid.
  ["uwf-project_manager-initiate", "deliberate counter-example of a fabricated agent name"],
]);

// Paths that are legitimately absent from this checkout.
const PATH_ALLOWED = new Map([
  [".github/adr", "an ADR location in the repository being audited, not this one"],
]);

const files = [];
for (const f of readdirSync(agentsDir).filter((n) => n.endsWith(".md")).sort()) files.push(join(agentsDir, f));
for (const d of readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const p = join(skillsDir, d.name, "SKILL.md");
  if (existsSync(p)) files.push(p);
}

const skillNames = new Set(readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
const agentNames = new Set(readdirSync(agentsDir).filter((n) => n.endsWith(".agent.md")).map((n) => n.replace(/\.agent\.md$/, "")));

/** Blank out fenced code blocks (keeping line numbers) so examples are not mistaken for prompt text. */
function stripFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return "";
    }
    return fence ? "" : line;
  });
}

const findings = [];
for (const file of files) {
  const rel = relative(root, file).split("\\").join("/");
  const lines = stripFences(readFileSync(file, "utf8"));
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    const noTemplates = line.replace(/\{\{[^}]*\}\}/g, "");

    for (const m of noTemplates.matchAll(/\{([A-Za-z_][\w.-]*)\}/g)) {
      if (!PLACEHOLDER_ALLOWED.has(m[1])) findings.push(`${at}: unreplaced placeholder ${m[0]}`);
    }

    if (/tmp\/workflow-artifacts/.test(line) && !LITERAL_PATH_ALLOWED.has(rel)) {
      findings.push(`${at}: literal tmp/workflow-artifacts path; refer to the required output paths in the prompt`);
    }

    for (const m of line.matchAll(/\buwf-[a-z0-9_]+(?:-[a-z0-9_]+)*/g)) {
      const name = m[0];
      const next = line[m.index + name.length];
      if (next === "." && /^\.[a-z]/.test(line.slice(m.index + name.length))) continue; // a file name such as uwf-state.json
      if (NON_REFERENCE_TOKENS.has(name)) continue;
      // Paths such as `.github/skills/uwf-x/...` are checked by (d); skip the part inside a path.
      if (m.index > 0 && line[m.index - 1] === "/") continue;
      if (!skillNames.has(name) && !agentNames.has(name)) findings.push(`${at}: ${name} is not an existing skill or agent`);
    }

    for (const m of line.matchAll(/(?<![\w./-])((?:\.github|scripts)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/g)) {
      const p = m[1];
      if (/[*<>]/.test(p) || PATH_ALLOWED.has(p)) continue;
      if (/\.db$/.test(p)) continue; // SQLite stores created at run time and gitignored
      if (/^-?\{/.test(line.slice(m.index + p.length))) continue; // a `uwf-{workflow}` style pattern
      if (!existsSync(join(root, p))) findings.push(`${at}: path ${p} does not exist`);
    }
  });
}

if (findings.length) {
  console.error(`test-prompt-references: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`test-prompt-references: ${files.length} prompt files OK`);
