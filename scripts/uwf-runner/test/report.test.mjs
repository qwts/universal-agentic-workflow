import assert from "node:assert/strict";
import { MARKER, buildBody, findComment, parseLog, upsertComment } from "../../uwf-on-pr/report.mjs";

const RUN = "https://github.com/qwts/toy/actions/runs/42";
const TABLE = [
  "[1/3] requirements → claude-code (attempt 1/2)",
  "[1/3] requirements gate: PASS",
  "stage         attempts  result",
  "requirements  1         passed",
  "implementation  2       passed",
  "",
].join("\n");
const FAIL = [
  "[2/3] implementation → claude-code (attempt 2/2)",
  "[2/3] implementation gate: FAIL — tests missing; lint failed",
  "[2/3] implementation   attempt 2/2; to fix: add tests under tests/ and rerun lint",
  "[runner] [2/3] implementation: gate blocked after 2 attempt(s): tests missing; lint failed",
  "  requirements: passed (attempts 1)",
  "  implementation: failed (attempts 2)",
  "",
].join("\n");
const Q = [
  "[runner] [2/3] implementation: 2 question(s) logged (ids 4,5); answer them, then rerun with --from-stage implementation",
  "  requirements: passed (attempts 1)",
  "  implementation: needs input (attempts 1)",
].join("\n");
const COST = [
  "[runner] [2/3] implementation: failed; cost cap exceeded after attempt 1: run cost $1.200 exceeds --max-cost-usd $1; raise the cap and use \"resume\" to continue",
  "  requirements: passed (attempts 1)",
  "  implementation: failed (attempts 1)",
].join("\n");

// exit 0
let p = parseLog(TABLE);
assert.deepEqual(p.rows, [{ stage: "requirements", attempts: 1, result: "passed" }, { stage: "implementation", attempts: 2, result: "passed" }]);
let b = buildBody({ log: TABLE, exitCode: "0", runUrl: RUN, push: { status: "pushed", sha: "abcdef0123", files: 3, branch: "feat/x" }, author: "octocat" });
assert.ok(b.startsWith(MARKER + "\n"));
assert.match(b, /### UWF sw_dev: complete/);
assert.match(b, /\| `requirements` \| 1 \| `passed` \|/);
assert.match(b, /Pushed commit `abcdef0`.*3 file\(s\).*`feat\/x`.*@octocat, please review/);
assert.match(b, /never merges/);
assert.match(b, /actions\/runs\/42#artifacts/);
assert.match(buildBody({ log: TABLE, exitCode: "0", runUrl: RUN, push: { status: "no-token" } }), /no bot token \(`UWF_BOT_TOKEN`\)/);
assert.match(buildBody({ log: TABLE, exitCode: "0", runUrl: RUN, push: { status: "moved" } }), /branch moved/);
assert.match(buildBody({ log: TABLE, exitCode: "0", runUrl: RUN, push: { status: "no-changes" } }), /no changes/);
assert.match(buildBody({ log: TABLE, exitCode: "0", runUrl: RUN, kept: true }), /uwf:keep/);

// exit 1: gate name and prescription
p = parseLog(FAIL);
assert.equal(p.gate.stage, "implementation");
assert.equal(p.rows.length, 2);
b = buildBody({ log: FAIL, exitCode: "1", runUrl: RUN, push: { status: "pushed", sha: "x" }, author: "octocat" });
assert.match(b, /### UWF sw_dev: blocked/);
assert.match(b, /Gate: `implementation gate`/);
assert.match(b, /Failures: `tests missing; lint failed`/);
assert.match(b, /To fix: `add tests under tests\/ and rerun lint`/);
assert.match(b, /\| `implementation` \| 2 \| `failed` \|/);
assert.match(b, /No commits were pushed/);
assert.ok(!/@octocat/.test(b), "no review request without a push");

// exit 3
b = buildBody({ log: Q, exitCode: "3", runUrl: RUN });
assert.match(b, /Questions pending/);
assert.match(b, /#96/);
assert.match(b, /needs input/);

// exit 4
b = buildBody({ log: COST, exitCode: "4", runUrl: RUN, maxCostUsd: "1", cost: "implementation $1.2" });
assert.match(b, /Cost cap hit.*cap of \$1 /);
assert.match(b, /Cost per stage/);

// exit 2 / empty exit
assert.match(buildBody({ log: "[runner] unknown workflow", exitCode: "2", runUrl: RUN }), /Runner failed/);
assert.match(buildBody({ log: "", exitCode: "", runUrl: RUN }), /did not produce an exit code/);

// untrusted text cannot mention, break out of code, or leak keys
const evil = "[2/3] impl gate: FAIL — @everyone ``` <script> sk-ant-" + "api03-" + "AAAAAAAAAAAAAAAAAAAAAAAA `x`";
b = buildBody({ log: evil + "\n[2/3] impl   attempt 1/1; to fix: @team\nrerun", exitCode: "1", runUrl: RUN });
assert.ok(!b.includes("sk-ant-api03"));
assert.match(b, /\[redacted:anthropic-key\]/);
assert.match(b, /Failures: `@everyone/); // inside a code span, which GitHub does not notify
assert.ok(!/`{3}/.test(b.replace(/```\n/g, "")), "no fence breakout");

// sticky behaviour: PATCH when the marker comment exists, POST otherwise; no shell, body on stdin
const calls = [];
const mk = (existing) => (args, input) => {
  calls.push({ args, input });
  if (args.includes("--paginate")) return existing ? "11\n22\n" : "";
  if (args.includes("POST")) return JSON.stringify({ id: 99 });
  return "";
};
let r = upsertComment(mk(true), { repo: "qwts/toy", pr: 7, body: "B" });
assert.deepEqual(r, { action: "updated", id: "22" });
const patch = calls.at(-1);
assert.deepEqual(patch.args.slice(0, 4), ["api", "--method", "PATCH", "repos/qwts/toy/issues/comments/22"]);
assert.equal(JSON.parse(patch.input).body, "B");
calls.length = 0;
r = upsertComment(mk(false), { repo: "qwts/toy", pr: 7, body: "B" });
assert.deepEqual(r, { action: "created", id: 99 });
assert.deepEqual(calls.at(-1).args.slice(0, 4), ["api", "--method", "POST", "repos/qwts/toy/issues/7/comments"]);
assert.match(calls[0].args.join(" "), /uwf-on-pr:report/);
assert.equal(findComment(() => "", "a/b", 1), null);
console.log("report tests passed");
