// TEMPORARY: superseded by #85
/**
 * Minimal stage prompt materializer (placeholder for #85).
 *
 * materializePrompt({ workflow, stage, repoRoot, outputPath, dataDir, extraContext })
 *   -> { agentFile, agentName, systemPrompt, prompt, permissions, model, inputsMissing, outputsRequired }
 *
 * `stage` is a stage name (resolved via `run.mjs --list-stages`) or an already-resolved stage object.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const resolveTemplates = (s, outputPath, cwd) =>
  s.replaceAll("{{output_path}}", outputPath).replaceAll("{{cwd}}", cwd);

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

function exists(path) {
  if (!/[*[]/.test(path)) return existsSync(path);
  const dir = dirname(path);
  const re = globToRegExp(path.slice(dir.length + 1).replace(/\[0-9\]/g, "\\d"));
  return existsSync(dir) && readdirSync(dir).some((f) => re.test(f));
}

function resolveStage(workflow, stage, repoRoot, dataDir) {
  if (stage && typeof stage === "object") return stage;
  const run = join(OWN_ROOT, ".github", "skills", `uwf-${workflow}`, "run.mjs");
  const args = [run, "--list-stages"];
  if (dataDir) args.push("--data-dir", dataDir);
  const list = JSON.parse(execFileSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" }));
  const found = list.find((s) => s.name === stage);
  if (!found) throw new Error(`Unknown stage "${stage}" in workflow "${workflow}"`);
  return found;
}

function frontmatter(file) {
  const m = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: readFileSync(file, "utf8").trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

export async function materializePrompt({ workflow, stage, repoRoot, outputPath, dataDir, extraContext }) {
  const root = resolve(repoRoot ?? OWN_ROOT);
  const out = outputPath ?? "./tmp/workflow-artifacts";
  const st = resolveStage(workflow, stage, root, dataDir);
  const agentName = st.resolved_agent ?? st.agent ?? st.name;
  const file = [root, OWN_ROOT]
    .map((r) => join(r, ".github", "agents", `${agentName}.agent.md`))
    .find(existsSync);
  const { meta, body } = file ? frontmatter(file) : { meta: {}, body: "" };

  const tools = meta.tools ?? "";
  const permissions = /execute|terminal|run/.test(tools) ? "edit+exec" : /edit/.test(tools) ? "edit" : "read-only";

  const inputs = (st.inputs ?? []).map((p) => resolveTemplates(p, out, root));
  const outputsRequired = (st.outputs ?? []).map((p) => resolveTemplates(p, out, root));
  const inputsMissing = inputs.filter((p) => !exists(resolve(root, p)));

  const prompt = [
    `Run the ${st.name} stage.`,
    "",
    "Context:",
    JSON.stringify({ workflow, stage: st.name, outputPath: out, ...extraContext }, null, 2),
    "",
    `inputs: ${JSON.stringify(inputs)}`,
    `outputs: ${JSON.stringify(outputsRequired)}`,
  ].join("\n");

  return {
    agentFile: file ?? null,
    agentName,
    systemPrompt: body,
    prompt,
    permissions,
    model: meta.model ?? null,
    inputsMissing,
    outputsRequired,
  };
}
