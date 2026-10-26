/**
 * Every review stage with a verdict gate must route changes_requested back to an
 * earlier stage of the same workflow via on_verdict (see #135, #154).
 *
 * Needs js-yaml from .github/skills/uwf-orchestration-engine (npm ci).
 *
 * Usage:
 *   node scripts/uwf-smoke/test-review-on-verdict.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SKILLS_DIR = join(REPO_ROOT, ".github/skills");
const require = createRequire(join(SKILLS_DIR, "uwf-orchestration-engine/package.json"));
const yaml = require("js-yaml");

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

console.log("\nSmoke test: review stages route changes_requested to an earlier stage\n");

const files = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("uwf-"))
  .map((d) => join(SKILLS_DIR, d.name, "stages.yaml"))
  .filter((p) => existsSync(p));

const hasVerdictGate = (stage) =>
  (stage.gate?.checks ?? []).some(
    (c) =>
      (c.type === "require_json_field" && c.pointer === "/verdict") ||
      (c.type === "require_contains" && /verdict:/.test(c.text ?? "")),
  );

let reviews = 0;
for (const file of files) {
  const rel = file.slice(REPO_ROOT.length + 1);
  const doc = yaml.load(readFileSync(file, "utf8"));
  const stages = doc.stages ?? [];
  const names = stages.map((s) => s.name);
  stages.forEach((stage, i) => {
    if (stage.name !== "review" || !hasVerdictGate(stage)) return;
    reviews++;
    const rule = stage.on_verdict?.changes_requested;
    assert(`${rel}: review has on_verdict.changes_requested`, !!rule);
    if (!rule) return;
    const target = names.indexOf(rule.route_to);
    assert(`${rel}: route_to "${rule.route_to}" is an earlier stage`, target >= 0 && target < i);
    assert(
      `${rel}: max_round_trips is a positive integer`,
      rule.max_round_trips === undefined ||
        (Number.isInteger(rule.max_round_trips) && rule.max_round_trips > 0),
    );
  });
}

assert("at least one review stage checked", reviews > 0);
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
