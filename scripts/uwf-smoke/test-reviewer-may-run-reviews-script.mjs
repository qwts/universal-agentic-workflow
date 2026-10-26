// Every agent whose stage requires reviews.mjs output must be allowed to run it, while staying
// read-only on the repository: no edit/execute tools, and no unqualified "cannot run commands" rule.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CMD = "node .github/skills/uwf-review/reviews.mjs";
const failures = [];
const fail = (m) => failures.push(m);

const agentsDir = join(root, ".github", "agents");
const reviewers = readdirSync(agentsDir).filter((f) => /-reviewer\.agent\.md$/.test(f));
if (reviewers.length < 3) fail(`expected at least 3 reviewer agents, found ${reviewers.length}`);

for (const f of reviewers) {
  const text = readFileSync(join(agentsDir, f), "utf8");
  const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? "";
  const tools = (fm.match(/^tools:\s*\[([^\]]*)\]/m) ?? [])[1] ?? "";
  const allowed = (fm.match(/^allowed-commands:\s*\[([^\]]*)\]/m) ?? [])[1] ?? "";
  if (!allowed.includes(CMD)) fail(`${f}: frontmatter allowed-commands must list "${CMD}"`);
  if (/"(edit|execute)"/.test(tools)) fail(`${f}: reviewer must not declare edit/execute tools`);
  const body = text.slice(text.indexOf("---", 3) + 3);
  if (!body.includes("reviews.mjs")) fail(`${f}: prompt must name reviews.mjs as an allowed command`);
  if (!/MAY[^.]*run[^.]*reviews\.mjs|MAY[^.]*run[^.]*bookkeeping script/.test(body)) fail(`${f}: prompt must say the reviewer MAY run reviews.mjs`);
  if (/(cannot|can't|must not|never)\s+run\s+(any\s+)?commands?\b(?![^.]*(except|exception|other than))/i.test(body)) {
    fail(`${f}: unqualified "cannot run commands" rule`);
  }
}

// Skill docs: the read-only rule must carry the reviews.mjs exception.
for (const rel of [".github/skills/uwf-review/SKILL.md", ".github/skills/uwf-reviewer/SKILL.md"]) {
  const text = readFileSync(join(root, rel), "utf8");
  if (!text.includes(`MAY run`) || !text.includes(CMD)) fail(`${rel}: read-only rule must state the reviews.mjs exception`);
  if (/no `edit` or `execute`/.test(text) || /Never use `edit` or `execute`/.test(text)) fail(`${rel}: unqualified no-execute rule`);
}

// Runner: the frontmatter must resolve to a preset that permits the command but not edit/exec.
const { mapPermissions } = await import(join(root, "scripts", "uwf-runner", "prompt.mjs"));
if (mapPermissions(["agent", "read"], [CMD]) !== "read-only+review") fail("mapPermissions must give read-only+review for the reviewer frontmatter");
const adapter = readFileSync(join(root, "scripts", "uwf-runner", "adapters", "claude-code.mjs"), "utf8");
if (!adapter.includes(`Bash(${CMD}:*)`)) fail("claude-code adapter must allow only Bash(" + CMD + ":*) for read-only+review");

if (failures.length) {
  console.error(failures.map((m) => `FAIL ${m}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${reviewers.length} reviewer agents may run reviews.mjs and stay read-only`);
