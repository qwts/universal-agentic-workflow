/**
 * Regression coverage for complete list-stages JSON on captured stdout.
 *
 * Usage:
 *   node scripts/uwf-smoke/test-stage-output-integrity.mjs
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const TRACKER = join(
  REPO_ROOT,
  ".github/skills/uwf-orchestration-engine/stage-tracker.mjs",
);

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

console.log("\nSmoke test: complete stage-list output\n");

let output = "";
let stages = null;
try {
  output = execFileSync(
    process.execPath,
    [
      TRACKER,
      "list-stages",
      "--workflow",
      "project_manager",
      "--model-profile",
      "balanced",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  stages = JSON.parse(output);
} catch (error) {
  console.error(error.stderr?.toString() ?? error.message);
}

assert(
  "captured output exceeds the historical 8 KiB truncation boundary",
  Buffer.byteLength(output) > 8 * 1024,
  `${Buffer.byteLength(output)} bytes`,
);
assert("captured output is complete JSON", Array.isArray(stages));
assert("first stage is intake", stages?.[0]?.name === "intake");
assert("last stage is retro", stages?.at(-1)?.name === "retro");

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
