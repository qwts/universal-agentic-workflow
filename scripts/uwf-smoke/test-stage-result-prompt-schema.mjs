#!/usr/bin/env node
// Cross-checks that stage prompts describing the stage-result JSON agree with
// stage-result.schema.json (severity enum and required finding fields).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const schema = JSON.parse(read(".github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json"));
const item = schema.properties.findings.items;
const severities = item.properties.severity.enum;
const required = item.required;
const errors = [];

const accPath = ".github/agents/uwf-core-acceptance.agent.md";
const prompts = [
  accPath,
  ".github/skills/uwf-review/SKILL.md",
  ".github/skills/uwf-orchestration-engine/SKILL.md",
];
for (const p of prompts) {
  const text = read(p);
  for (const sev of severities) {
    if (!text.includes(sev)) errors.push(`${p}: does not mention schema severity "${sev}"`);
  }
  for (const field of required) {
    if (!new RegExp(`\\b${field}\\b`).test(text)) {
      errors.push(`${p}: does not mention required finding field "${field}"`);
    }
  }
}

// The acceptance prompt must state the enum and required fields explicitly
// and map the DB severities (critical/major/minor) onto the schema enum.
const acc = read(accPath);
for (const sev of severities) {
  if (!acc.includes(`\`${sev}\``)) errors.push(`${accPath}: severity \`${sev}\` not stated`);
}
for (const field of required) {
  if (!new RegExp(`\\b${field}\\b`).test(acc)) errors.push(`${accPath}: required field \`${field}\` not stated`);
}
for (const [db, out] of [["critical", "high"], ["major", "medium"], ["minor", "low"]]) {
  if (!acc.includes(`\`${db}\` to \`${out}\``)) errors.push(`${accPath}: missing mapping ${db} -> ${out}`);
}
for (const m of acc.matchAll(/"severity":\s*"([^"]+)"/g)) {
  if (!severities.includes(m[1])) errors.push(`${accPath}: example severity "${m[1]}" not in schema enum`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("stage-result prompt/schema agreement: ok");
