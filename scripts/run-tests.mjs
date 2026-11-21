#!/usr/bin/env node
/**
 * run-tests.mjs — Cross-platform Node test runner for UWF suites.
 *
 * Usage:
 *   node scripts/run-tests.mjs [all|smoke|runner|mcp|bench|pack]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SUITES = {
  smoke: { dir: join(ROOT, "scripts", "uwf-smoke"), suffix: ".mjs" },
  runner: { dir: join(ROOT, "scripts", "uwf-runner", "test"), suffix: ".test.mjs" },
  mcp: { dir: join(ROOT, "scripts", "uaw-mcp", "test"), suffix: ".test.mjs" },
  bench: { dir: join(ROOT, "scripts", "uwf-bench", "test"), suffix: ".test.mjs" },
  pack: { dir: join(ROOT, "scripts", "uaw-pack", "test"), suffix: ".test.mjs" },
};

const requested = process.argv[2] ?? "all";
const suiteNames = requested === "all" ? Object.keys(SUITES) : [requested];

for (const name of suiteNames) {
  if (!Object.hasOwn(SUITES, name)) {
    process.stderr.write(`Unknown test suite "${name}". Expected: all | ${Object.keys(SUITES).join(" | ")}\n`);
    process.exit(2);
  }
}

for (const name of suiteNames) {
  const { dir, suffix } = SUITES[name];
  if (!existsSync(dir)) {
    process.stderr.write(`Missing test directory for suite "${name}": ${dir}\n`);
    process.exit(1);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => join(dir, f));

  if (files.length === 0) {
    process.stderr.write(`No *${suffix} files found in ${dir}\n`);
    process.exit(1);
  }

  for (const file of files) {
    process.stdout.write(`\n=== [${name}] ${file.slice(ROOT.length + 1)} ===\n`);
    const result = spawnSync(process.execPath, [file], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.error) {
      process.stderr.write(`Failed to run ${file}: ${result.error.message}\n`);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}
