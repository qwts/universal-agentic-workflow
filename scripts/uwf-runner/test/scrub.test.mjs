import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubPaths } from "../../uwf-on-pr/scrub.mjs";
import { SECRET_PATTERNS } from "../../hooks/secret-patterns.mjs";

// Fake keys are assembled at runtime so no secret-shaped literal sits in the repo.
const anthropic = "sk-ant-" + "api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const github = "ghp_" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8";
const openai = "sk-" + "Qw3Er4Ty5Ui6Op7As8Df9Gh0Jk1Lz2Xc";
const bearer = "Bearer " + "eyJhbGciOiJIUzI1NiJ9.payload-part.sig_part-1234";

const dir = mkdtempSync(join(tmpdir(), "uwf-scrub-"));
try {
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  writeFileSync(join(dir, "transcripts", "a.json"), JSON.stringify({ stdout: `key ${anthropic} and ${github}` }));
  writeFileSync(join(dir, "transcripts", "b.json"), `{"h":"Authorization: ${bearer}","k":"${openai}"}`);
  writeFileSync(join(dir, "runner.log"), `env ANTHROPIC_API_KEY=${anthropic}\nclean line\n`);
  writeFileSync(join(dir, "state.db"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(anthropic)]));

  const stats = scrubPaths([dir, join(dir, "missing")]);
  assert.equal(stats.skipped, 1, "binary file skipped");
  assert.equal(stats.redacted, 5);

  const all = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name)); };
  walk(dir);
  for (const f of all.filter((f) => !f.endsWith("state.db"))) {
    const text = readFileSync(f, "utf8");
    for (const { re } of SECRET_PATTERNS) assert.equal(text.match(new RegExp(re.source, re.flags))?.length ?? 0, 0, `${f} still matches ${re}`);
    for (const secret of [anthropic, github, openai, bearer.slice(7)]) assert.ok(!text.includes(secret), `${f} still has key text`);
  }
  assert.match(readFileSync(join(dir, "runner.log"), "utf8"), /ANTHROPIC_API_KEY=\[redacted:anthropic-key\]\nclean line/);
  assert.match(readFileSync(join(dir, "transcripts", "a.json"), "utf8"), /\[redacted:github-token\]/);
  assert.match(readFileSync(join(dir, "transcripts", "b.json"), "utf8"), /\[redacted:bearer-token\].*\[redacted:openai-key\]/);
  assert.equal(scrubPaths([dir]).redacted, 0, "idempotent");
  console.log("scrub tests passed");
} finally {
  rmSync(dir, { recursive: true });
}
