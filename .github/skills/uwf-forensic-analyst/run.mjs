/**
 * UWF persona — gate enforcement shim (generic, workflow-agnostic).
 *
 * The workflow name is read from stages.yaml in this directory.
 * All logic is handled by the central stage-tracker in uwf-orchestration-engine.
 *
 * Usage (called by the orchestrator agent via terminal):
 *   node .github/skills/uwf-forensic-analyst/run.mjs --list-stages
 *   node .github/skills/uwf-forensic-analyst/run.mjs --check-gate <stageName> [--output-path <path>]
 *
 * Exit codes:  0 = gate passed   1 = gate failed   2 = usage error
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tracker   = join(__dirname, "..", "uwf-orchestration-engine", "stage-tracker.mjs");

// Read workflow name from the co-located stages.yaml (first-pass line scan — no yaml dep needed here)
const stagesYaml = readFileSync(join(__dirname, "stages.yaml"), "utf8");
const workflowMatch = stagesYaml.match(/^workflow:\s*(\S+)/m);
if (!workflowMatch) { process.stderr.write("stages.yaml must contain a 'workflow:' field.\n"); process.exit(2); }
const workflow = workflowMatch[1];

const rawArgs  = process.argv.slice(2);
const baseArgs = ["--workflow", workflow, ...forwardGlobalFlags(rawArgs)];

let trackerArgs;
if (rawArgs.includes("--list-stages")) {
  trackerArgs = ["list-stages", ...baseArgs];
} else {
  const gateIdx = rawArgs.indexOf("--check-gate");
  if (gateIdx !== -1) {
    const stageName = rawArgs[gateIdx + 1];
    if (!stageName) { process.stderr.write("Usage: --check-gate <stageName>\n"); process.exit(2); }
    trackerArgs = ["check-gate", ...baseArgs, "--stage", stageName];
  } else {
    process.stderr.write("Usage: --list-stages | --check-gate <stageName> [--output-path <p>]\n");
    process.exit(2);
  }
}

spawn(process.execPath, [tracker, ...trackerArgs], { stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 0));

function forwardGlobalFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--output-path") && i + 1 < args.length) {
      out.push(args[i], args[++i]);
    }
  }
  return out;
}
