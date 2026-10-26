import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTreeEntries, commitMessage, listChanges, pushAsBot, readEntry } from "../../uwf-on-pr/push-as-bot.mjs";

const dir = mkdtempSync(join(tmpdir(), "uwf-push-"));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
try {
  git("init", "-q");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), "tmp/\n*.log\n");
  writeFileSync(join(dir, "keep.txt"), "one\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  git("add", "."); git("commit", "-q", "-m", "init");

  writeFileSync(join(dir, "keep.txt"), "two\n");           // modified tracked
  git("rm", "-q", "gone.txt");                              // deleted tracked (staged)
  mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src", "new.mjs"), "x\n");
  chmodSync(join(dir, "src", "new.mjs"), 0o755);
  symlinkSync("keep.txt", join(dir, "link"));
  mkdirSync(join(dir, "tmp")); writeFileSync(join(dir, "tmp", "scratch"), "no\n"); // ignored AND excluded
  writeFileSync(join(dir, "debug.log"), "ignored\n");

  const changes = listChanges(dir);
  assert.deepEqual(changes, [
    { path: "gone.txt", deleted: true }, { path: "keep.txt", deleted: false },
    { path: "link", deleted: false }, { path: "src/new.mjs", deleted: false },
  ]);
  assert.equal(readEntry(dir, "src/new.mjs").mode, "100755");
  assert.deepEqual(readEntry(dir, "link"), { mode: "120000", content: Buffer.from("keep.txt") });

  // tmp/ is excluded even when it is not gitignored
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  assert.ok(!listChanges(dir).some((c) => c.path.startsWith("tmp/")));

  const calls = [];
  const fakeApi = (over = {}) => ({
    getPull: async () => ({ head: { ref: "feat/x", sha: "S0" } }),
    getRefSha: async () => "S0",
    getCommitTree: async (sha) => { calls.push(["tree-of", sha]); return "T0"; },
    createBlob: async (b64) => { calls.push(["blob", Buffer.from(b64, "base64").toString()]); return `B${calls.length}`; },
    createTree: async (base, entries) => { calls.push(["tree", base, entries]); return "T1"; },
    createCommit: async (c) => { calls.push(["commit", c]); return { sha: "C1", verified: true }; },
    updateRef: async (b, s) => { calls.push(["ref", b, s]); },
    ...over,
  });
  const read = (p) => readEntry(dir, p);
  const message = commitMessage({ title: "Add X\nline2", runId: 42 });
  assert.match(message, /^uwf\(sw_dev\): Add X line2 \(run 42\)\n\nCo-Authored-By: .+<.+>\n$/);

  const entries = await buildTreeEntries(changes, read, fakeApi());
  assert.deepEqual(entries.map((e) => [e.path, e.mode, e.sha === null]), [
    ["gone.txt", "100644", true], ["keep.txt", "100644", false], ["link", "120000", false], ["src/new.mjs", "100755", false],
  ]);

  calls.length = 0;
  const ok = await pushAsBot({ api: fakeApi(), changes, read, expectedSha: "S0", message });
  assert.deepEqual(ok, { status: "pushed", sha: "C1", files: 4, branch: "feat/x" });
  assert.deepEqual(calls.at(-1), ["ref", "feat/x", "C1"]);
  const commit = calls.find((c) => c[0] === "commit")[1];
  assert.deepEqual([commit.tree, commit.parent], ["T1", "S0"]);
  assert.equal(calls.find((c) => c[0] === "tree")[1], "T0");

  // branch moved: nothing written
  calls.length = 0;
  assert.deepEqual(await pushAsBot({ api: fakeApi({ getPull: async () => ({ head: { ref: "feat/x", sha: "S9" } }) }), changes, read, expectedSha: "S0", message }), { status: "moved", branch: "feat/x" });
  assert.deepEqual(await pushAsBot({ api: fakeApi({ getRefSha: async () => "S9" }), changes, read, expectedSha: "S0", message }), { status: "moved", branch: "feat/x" });
  assert.equal(calls.length, 0);

  // no changes: no API call at all
  assert.deepEqual(await pushAsBot({ api: fakeApi({ getPull: async () => { throw new Error("must not be called"); } }), changes: [], read, expectedSha: "S0", message }), { status: "no-changes" });

  // unverified commit is never referenced
  calls.length = 0;
  const bad = await pushAsBot({ api: fakeApi({ createCommit: async () => ({ sha: "C2", verified: false, reason: "unsigned" }) }), changes, read, expectedSha: "S0", message });
  assert.equal(bad.status, "error");
  assert.ok(!calls.some((c) => c[0] === "ref"));
  console.log("push-as-bot tests passed");
} finally {
  rmSync(dir, { recursive: true });
}
