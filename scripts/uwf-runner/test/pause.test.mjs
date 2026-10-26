import assert from "node:assert/strict";
import { blockedStage, pausedRecord } from "../../uwf-on-pr/pause.mjs";
import { LABEL_NEEDS_INPUT, LABEL_RUN, QUESTIONS_MARKER, buildQuestionsBody, findQuestionsComment, pendingRequired, upsertQuestionsComment } from "../../uwf-on-pr/questions.mjs";

const Qs = [
  { id: 4, stage: "requirements", question: "Which database should the service use?", proposed: "sqlite", required: true, status: "pending", answer: null },
  { id: 5, stage: "requirements", question: "Preferred log format?", proposed: null, required: false, status: "pending", answer: null },
  { id: 6, stage: "requirements", question: "Support Windows?", proposed: "no", required: true, status: "answered", answer: "no, mac and linux only" },
  { id: 7, stage: "requirements", question: "Old question", proposed: null, required: true, status: "skipped", answer: null },
];

// body: marker first, one checklist line per question, ids, stage, required/optional, proposed answers
const b = buildQuestionsBody({ questions: Qs, stage: "requirements", runUrl: "https://github.com/qwts/toy/actions/runs/42" });
assert.ok(b.startsWith(QUESTIONS_MARKER + "\n"));
assert.equal(QUESTIONS_MARKER, "<!-- uwf-on-pr:questions -->");
assert.match(b, /^- \[ \] \*\*Q4\*\* \(requirements, required\) Which database should the service use\?$/m);
assert.match(b, /^ {2}- Proposed answer: sqlite$/m);
assert.match(b, /^- \[ \] \*\*Q5\*\* \(requirements, optional\) Preferred log format\?$/m);
assert.match(b, /^- \[x\] \*\*Q6\*\* \(requirements, required\) Support Windows\?$/m);
assert.match(b, /Answer: no, mac and linux only/);
assert.match(b, /^- \[x\] \*\*Q7\*\*/m);
assert.match(b, /\/uwf answer <id> <text>/);
assert.match(b, /\/uwf skip <id>/);
assert.match(b, /Optional questions .* do not block/);
assert.match(b, /actions\/runs\/42/);
assert.equal((b.match(/- \[[ x]\] \*\*Q/g) ?? []).length, 4);

// ready state: no reply instructions
const ready = buildQuestionsBody({ questions: Qs.map((q) => ({ ...q, status: "answered" })), stage: "requirements", ready: true });
assert.match(ready, /all required questions answered/);
assert.ok(!/\/uwf answer <id>/.test(ready));

// untrusted text: no mention, no HTML, no forged marker, no key
const evil = buildQuestionsBody({
  questions: [{ id: 1, stage: "s", question: "@everyone <!-- uwf-on-pr:questions --> sk-ant-" + "api03-" + "AAAAAAAAAAAAAAAAAAAAAAAA\nsecond line", proposed: "<b>x</b>", required: true, status: "pending", answer: null }],
});
assert.ok(!evil.includes("sk-ant-api03"));
assert.ok(!evil.includes("@everyone"));
assert.equal(evil.split(QUESTIONS_MARKER).length, 2, "only the real marker");
assert.ok(!evil.includes("<b>"));
assert.match(evil, /^- \[ \] \*\*Q1\*\* \(s, required\) .*second line$/m, "one line per question");

// only required pending questions block
assert.deepEqual(pendingRequired(Qs).map((q) => q.id), [4]);
assert.deepEqual(pendingRequired(Qs.filter((q) => !q.required || q.status !== "pending")), []);
assert.deepEqual(pendingRequired([Qs[1]]), [], "an optional question alone never blocks");

// paused.json
const rec = pausedRecord({ headSha: "abc123", stage: "requirements", now: new Date("2026-10-26T12:00:00Z") });
assert.deepEqual(rec, { headSha: "abc123", stage: "requirements", pausedAt: "2026-10-26T12:00:00.000Z" });
assert.equal(blockedStage(Qs), "requirements");
assert.equal(blockedStage([], "  requirements: passed (attempts 1)\n  implementation: blocked: questions pending (attempts 1)\n"), "implementation");
assert.equal(blockedStage([], ""), null);
assert.equal(LABEL_RUN, "uwf:run");
assert.equal(LABEL_NEEDS_INPUT, "uwf:needs-input");

// sticky: PATCH when the marker comment exists, POST otherwise; body on stdin as JSON
const calls = [];
const mk = (existing) => (args, input) => {
  calls.push({ args, input });
  if (args.includes("--paginate")) return existing ? "11\n22\n" : "";
  if (args.includes("POST")) return JSON.stringify({ id: 99 });
  return "";
};
assert.deepEqual(upsertQuestionsComment(mk(true), { repo: "qwts/toy", pr: 7, body: "B" }), { action: "updated", id: "22" });
assert.deepEqual(calls.at(-1).args.slice(0, 4), ["api", "--method", "PATCH", "repos/qwts/toy/issues/comments/22"]);
assert.equal(JSON.parse(calls.at(-1).input).body, "B");
calls.length = 0;
assert.deepEqual(upsertQuestionsComment(mk(false), { repo: "qwts/toy", pr: 7, body: "B" }), { action: "created", id: 99 });
assert.match(calls[0].args.join(" "), /uwf-on-pr:questions/);
assert.equal(findQuestionsComment(() => "", "a/b", 1), null);

console.log("pause tests passed");
