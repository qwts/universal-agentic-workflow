#!/usr/bin/env node
/**
 * uaw — Universal Agentic Workflow CLI entrypoint.
 *
 * Subcommands:
 *   uaw run|resume|gates|cost [options]   Run, resume, inspect gates, or report cost
 *   uaw mcp [options]                     Start the uaw-mcp/v1 MCP server (stdio | http)
 *   uaw hook pre-tool-use                 Run the PreToolUse security guardrail hook (stdin JSON)
 *   uaw --version | -v                    Print version
 *   uaw --help | -h                       Print usage
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE = [22, 13, 0];

function checkNodeVersion(versionStr = process.versions?.node ?? "0.0.0") {
  const [maj = 0, min = 0, patch = 0] = String(versionStr)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const [reqMaj, reqMin, reqPatch] = MIN_NODE;
  if (maj !== reqMaj) return maj > reqMaj;
  if (min !== reqMin) return min > reqMin;
  return patch >= reqPatch;
}

if (!checkNodeVersion()) {
  process.stderr.write(
    `[uaw] Node.js >= ${MIN_NODE.join(".")} is required (built-in node:sqlite); found v${process.versions?.node ?? "unknown"}\n`,
  );
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNNER_SUBCOMMANDS = new Set(["run", "resume", "gates", "cost"]);

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usageText() {
  return [
    "uaw — Universal Agentic Workflow CLI",
    "",
    "Usage:",
    "  uaw run --workflow <w> --goal <file|text> [options]",
    "  uaw resume --workflow <w> [options]",
    "  uaw gates --workflow <w> [options]",
    "  uaw cost --data-dir <dir> [--workflow <w>] [options]",
    "  uaw mcp [--transport stdio|http] [options]",
    "  uaw hook pre-tool-use",
    "  uaw --version | --help",
    "",
  ].join("\n");
}

async function run(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === "--version" || subcommand === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(usageText());
    return 0;
  }
  if (!subcommand) {
    process.stderr.write(usageText());
    return 2;
  }
  if (RUNNER_SUBCOMMANDS.has(subcommand)) {
    const { main: runnerMain } = await import("../scripts/uwf-runner/runner.mjs");
    return await runnerMain(argv);
  }
  if (subcommand === "mcp") {
    const { main: mcpMain } = await import("../scripts/uaw-mcp/server.mjs");
    await mcpMain(rest);
    return undefined;
  }
  if (subcommand === "hook") {
    const [hookName] = rest;
    if (hookName !== "pre-tool-use") {
      process.stderr.write(`Unknown hook "${hookName ?? ""}". Expected: pre-tool-use\n`);
      return 2;
    }
    const { runPreToolUseHook } = await import("../scripts/hooks/preToolUse.mjs");
    runPreToolUseHook();
    return 0;
  }

  process.stderr.write(`Unknown command "${subcommand}".\n\n${usageText()}`);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  },
  (err) => {
    const msg = err?.constructor?.name === "UsageError" ? err.message : `fatal: ${err?.stack ?? err}`;
    process.stderr.write(`[uaw] ${msg}\n`);
    process.exitCode = 2;
  },
);
