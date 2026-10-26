import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCommands, canResume, collectComments, parseCommands, replyBody } from "../../uwf-on-pr/answer.mjs";
import { listQuestions, runQuestions } from "../../uwf-on-pr/questions.mjs";
import { checkArchive, decideResume, pickArtifact, restoreTarget, snapshotTarget } from "../../uwf-on-pr/state.mjs";
import { execFileSync } from "node:child_process";

// parsing: several lines, noise ignored, CRLF tolerated
let p = parseCommands("Thanks!\n/uwf answer 4 use sqlite\r\nsome noise\n/uwf skip 5\n  /uwf answer 6 indented is noise\n/uwf run");
assert.deepEqual(p.commands, [{ action: "answer", id: 4, text: "use sqlite" }, { action: "skip", id: 5, text: undefined }]);
assert.deepEqual(p.rejected, []);

// non-numeric ids, missing text, an answer the CLI would read as a flag: rejected, not applied
p = parseCommands("/uwf answer x1 nope\n/uwf answer 3\n/uwf skip abc\n/uwf answer 9 --db-path /etc/x\n/uwf answer -1 neg\n/uwf answer 1234567890123 big");
assert.deepEqual(p.commands, []);
assert.equal(p.rejected.length, 6);

// text is kept verbatim: quotes, backticks, $(...), semicolons
const nasty = "it's \"quoted\" `tick` $(touch /tmp/pwn); rm -rf / && echo ${HOME} \\n";
p = parseCommands(`/uwf answer 2 ${nasty}`);
assert.equal(p.commands[0].text, nasty.replace(/\s+$/, ""));

// applyCommands: one argv array per command, text a single element; only pending ids are touched
const seen = [];
const res = applyCommands(parseCommands(`/uwf answer 4 ${nasty}\n/uwf skip 5\n/uwf answer 8 not pending\n/uwf skip 4`).commands, [4, 5], (args) => { seen.push(args); return { ok: true }; });
assert.deepEqual(seen, [["answer", "--id", "4", "--answer", nasty.replace(/\s+$/, "")], ["skip", "--id", "5"]]);
assert.deepEqual(res.applied, [{ action: "answer", id: 4 }, { action: "skip", id: 5 }]);
assert.deepEqual(res.ignored.map((i) => i.id), [8, 4]);
assert.equal(applyCommands(parseCommands("/uwf skip 1").commands, [1], () => ({ ok: false, error: "boom" })).ignored[0].id, 1);

// resume is decided by the required pending questions
const q = (id, required, status) => ({ id, stage: "s", question: "?", proposed: null, required, status, answer: null });
assert.equal(canResume([q(1, true, "answered"), q(2, false, "pending")]), true, "a pending optional question does not hold the run");
assert.equal(canResume([q(1, true, "pending")]), false);
assert.equal(canResume([q(1, true, "skipped"), q(2, true, "answered")]), true);
assert.match(replyBody({ applied: [{ action: "answer", id: 1 }], ignored: [], rejected: [], questions: [q(2, true, "pending")], resume: false }), /Still waiting on required: Q2/);
assert.match(replyBody({ applied: [], ignored: [], rejected: ["/uwf answer x y"], questions: [], resume: true, activated: true }), /Could not parse/);
assert.match(replyBody({ applied: [], ignored: [], rejected: [], questions: [], resume: true, activated: false }), /Add the `uwf:run` label/);

// collecting comments: eligible, non-collaborator, already applied, before the pause; the trigger is deduplicated
const cm = (id, at, assoc, body) => ({ id, created_at: at, author_association: assoc, body });
const batch = collectComments({
  comments: [
    cm(10, "2026-10-26T10:05:00Z", "COLLABORATOR", "/uwf answer 1 yes"),
    cm(11, "2026-10-26T10:06:00Z", "NONE", "/uwf answer 2 evil"),
    cm(12, "2026-10-26T10:07:00Z", "OWNER", "/uwf skip 3"),
    cm(13, "2026-10-26T10:01:00Z", "OWNER", "/uwf answer 9 before the pause"),
    cm(14, "2026-10-26T10:08:00Z", "MEMBER", "just chatting"),
    cm(15, "2026-10-26T10:09:00Z", "MEMBER", "/uwf skip 4"),
  ],
  applied: [12],
  pausedAt: "2026-10-26T10:02:00Z",
  triggering: { id: "15", body: "/uwf skip 4", created_at: "2026-10-26T10:09:00Z" },
});
assert.deepEqual(batch.map((c) => c.id), [10, 15], "eligible, in creation order, trigger not duplicated");
const lone = collectComments({ comments: [], applied: [], pausedAt: "x", triggering: { id: "20", body: "/uwf skip 1" } });
assert.deepEqual(lone.map((c) => c.id), [20], "the trigger is processed even when the listing misses it");
assert.deepEqual(collectComments({ comments: [], applied: [20], triggering: { id: "20", body: "/uwf skip 1" } }), [], "an applied trigger is not repeated");

// state: artifact choice, resume decision, working-tree snapshot
assert.deepEqual(pickArtifact({ artifacts: [{ id: 3, name: "n", expired: true }, { id: 2, name: "n", expired: false }] }), { id: 2, name: "n" });
assert.equal(pickArtifact({ artifacts: [] }), null);
assert.equal(decideResume(null, "a").resume, false);
assert.equal(decideResume({ headSha: "a" }, "a").resume, false, "unanswered");
assert.equal(decideResume({ headSha: "a", resume: true }, "b").resume, false, "head moved");
assert.equal(decideResume({ headSha: "a", resume: true }, "a").resume, true);

const tmp = mkdtempSync(join(tmpdir(), "uwf-answer-test-"));
try {
  const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  const t1 = join(tmp, "t1");
  mkdirSync(t1);
  git(t1, "init", "-q");
  writeFileSync(join(t1, "keep.txt"), "one\n");
  writeFileSync(join(t1, "gone.txt"), "bye\n");
  git(t1, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(t1, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(t1, "keep.txt"), "two\n");
  rmSync(join(t1, "gone.txt"));
  mkdirSync(join(t1, "src"));
  writeFileSync(join(t1, "src", "new.js"), "x\n");
  writeFileSync(join(t1, ".hidden"), "dot\n");
  mkdirSync(join(t1, ".github"));
  writeFileSync(join(t1, ".github", "ci.yml"), "a: 1\n");
  // a secret-shaped string in a source file must come back byte for byte (the snapshot is not scrubbed)
  const secretish = "const t = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';\n";
  writeFileSync(join(t1, "src", "secret-fixture.js"), secretish);
  writeFileSync(join(t1, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(t1, "run.sh"), 0o755);
  mkdirSync(join(t1, "tmp", "workflow-artifacts"), { recursive: true });
  writeFileSync(join(t1, "tmp", "workflow-artifacts", "req.md"), "req\n");
  const data = join(tmp, "data");
  mkdirSync(data);
  snapshotTarget(t1, data);
  const t2 = join(tmp, "t2");
  mkdirSync(t2);
  git(t2, "init", "-q");
  writeFileSync(join(t2, "keep.txt"), "one\n");
  writeFileSync(join(t2, "gone.txt"), "bye\n");
  restoreTarget(data, t2);
  assert.equal(readFileSync(join(t2, "keep.txt"), "utf8"), "two\n");
  assert.ok(!existsSync(join(t2, "gone.txt")));
  assert.equal(readFileSync(join(t2, "src", "new.js"), "utf8"), "x\n");
  assert.equal(readFileSync(join(t2, ".hidden"), "utf8"), "dot\n");
  assert.equal(readFileSync(join(t2, ".github", "ci.yml"), "utf8"), "a: 1\n");
  assert.equal(readFileSync(join(t2, "src", "secret-fixture.js"), "utf8"), secretish);
  assert.equal(statSync(join(t2, "run.sh")).mode & 0o777, 0o755, "executable bit preserved");
  assert.equal(statSync(join(t2, "keep.txt")).mode & 0o111, 0, "plain file stays non-executable");
  assert.ok(!existsSync(join(data, "target-snapshot.tar")), "archive consumed");
  // an archive member that leaves the target is refused
  const evilDir = join(tmp, "evil", "inner");
  mkdirSync(evilDir, { recursive: true });
  writeFileSync(join(tmp, "evil", "out.txt"), "x");
  execFileSync("tar", ["-c", "-P", "-f", join(tmp, "evil.tar"), "../out.txt"], { cwd: evilDir });
  assert.throws(() => checkArchive(join(tmp, "evil.tar"), t2), /unsafe path/);
  assert.equal(readFileSync(join(t2, "tmp", "workflow-artifacts", "req.md"), "utf8"), "req\n");

  // end to end with the real question CLI when its dependencies are installed
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/skills/uwf-question-protocol/questions.mjs");
  if (existsSync(join(dirname(CLI), "node_modules", "better-sqlite3"))) {
    const d = join(tmp, "qdata");
    mkdirSync(d);
    assert.ok(runQuestions(CLI, d, ["log", "--stage", "requirements", "--question", "DB?", "--proposed", "sqlite", "--required", "true"]).ok);
    assert.ok(runQuestions(CLI, d, ["log", "--stage", "requirements", "--question", "Format?", "--required", "false"]).ok);
    let qs = listQuestions(CLI, d);
    assert.deepEqual(qs.map((x) => [x.id, x.required, x.status]), [[1, true, "pending"], [2, false, "pending"]]);
    assert.equal(qs[0].proposed, "sqlite");
    assert.equal(canResume(qs), false);
    const r = applyCommands(parseCommands(`/uwf answer 1 ${nasty}`).commands, [1, 2], (args) => runQuestions(CLI, d, args));
    assert.equal(r.applied.length, 1);
    qs = listQuestions(CLI, d);
    assert.equal(qs[0].answer, nasty.replace(/\s+$/, ""), "stored verbatim");
    assert.equal(qs[0].status, "answered");
    assert.equal(canResume(qs), true, "the optional question is still pending but does not block");
    // the runner's own gate: check passes while only an optional question is pending
    const chk = runQuestions(CLI, d, ["check", "--stage", "requirements"]);
    assert.ok(chk.ok, "questions.mjs check ignores optional pending questions");
  } else {
    console.log("answer tests: question-protocol dependencies not installed; skipped the real-CLI part");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("answer tests passed");
