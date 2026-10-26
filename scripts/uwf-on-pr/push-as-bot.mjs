#!/usr/bin/env node
/**
 * Push the run's changes in `target/` to the PR head branch as ONE commit through the Git Data API
 * (blobs, tree, commit, ref update), authenticated as the bot, so GitHub signs it and shows Verified.
 * This is the signed-commit procedure (ENG-0016) applied to a working tree instead of local commits.
 *
 * Run it only after a runner exit 0. Env (nothing is read from argv, nothing is shell-interpolated):
 *   UWF_BOT_TOKEN  bot token; empty -> result "no-token", exit 0
 *   REPO, PR_NUMBER, PR_TITLE, RUN_ID, EXPECTED_SHA (the PR head sha the run checked out), TARGET_DIR,
 *   RESULT_FILE (JSON { status, sha?, files?, branch?, reason? }), WORKFLOW (default sw_dev),
 *   GITHUB_API_URL (default https://api.github.com), GITHUB_OUTPUT (optional: status=...).
 * Statuses: pushed | no-changes | moved | no-token | error. The token is never printed or written.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COAUTHOR = "Co-Authored-By: Claude <noreply@anthropic.com>";
const EXCLUDED = (p) => p === "tmp" || p.startsWith("tmp/") || p === ".git" || p.startsWith(".git/");

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
const nulList = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

/**
 * Paths changed in `dir` relative to HEAD: modified/added/deleted tracked files plus untracked files
 * that .gitignore does not exclude. `tmp/` is never included. Returns [{ path, deleted }].
 */
export function listChanges(dir) {
  const out = new Map();
  const fields = nulList(git(dir, ["diff", "--name-status", "-z", "--no-renames", "HEAD"]));
  for (let i = 0; i + 1 < fields.length; i += 2) out.set(fields[i + 1], { path: fields[i + 1], deleted: fields[i].startsWith("D") });
  for (const p of nulList(git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]))) out.set(p, { path: p, deleted: false });
  return [...out.values()].filter((c) => !EXCLUDED(c.path)).sort((a, b) => a.path.localeCompare(b.path));
}

/** { mode, content } for a working-tree path, or null for a directory (nested repo) that cannot be a blob. */
export function readEntry(dir, path) {
  const full = join(dir, path);
  const st = lstatSync(full);
  if (st.isSymbolicLink()) return { mode: "120000", content: Buffer.from(readlinkSync(full)) };
  if (!st.isFile()) return null;
  return { mode: st.mode & 0o111 ? "100755" : "100644", content: readFileSync(full) };
}

/**
 * Tree entries for the Git Data API. `api.createBlob(base64) -> sha`. A deletion is an entry with
 * sha null; a path that is not a regular file or symlink (e.g. a nested repo) is skipped.
 */
export async function buildTreeEntries(changes, read, api) {
  const entries = [];
  for (const c of changes) {
    if (c.deleted) { entries.push({ path: c.path, mode: "100644", type: "blob", sha: null }); continue; }
    const f = read(c.path);
    if (!f) continue;
    entries.push({ path: c.path, mode: f.mode, type: "blob", sha: await api.createBlob(f.content.toString("base64")) });
  }
  return entries;
}

export function commitMessage({ workflow = "sw_dev", title, runId }) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "changes";
  return `uwf(${workflow}): ${t} (run ${runId})\n\n${COAUTHOR}\n`;
}

/**
 * The whole push. `api` is injected: { getPull(), getRefSha(branch), getCommitTree(sha), createBlob(b64),
 * createTree(baseTree, entries), createCommit({message, tree, parent}) -> {sha, verified, reason},
 * updateRef(branch, sha) }. Returns the result object; never pushes unless the PR head is still
 * `expectedSha`, and the ref update is not forced, so a concurrent push also wins.
 */
export async function pushAsBot({ api, changes, read, expectedSha, message }) {
  if (!changes.length) return { status: "no-changes" };
  const pull = await api.getPull();
  const branch = pull.head.ref;
  if (pull.head.sha !== expectedSha || (await api.getRefSha(branch)) !== expectedSha) return { status: "moved", branch };
  const entries = await buildTreeEntries(changes, read, api);
  if (!entries.length) return { status: "no-changes" };
  const baseTree = await api.getCommitTree(expectedSha);
  const tree = await api.createTree(baseTree, entries);
  const commit = await api.createCommit({ message, tree, parent: expectedSha });
  if (!commit.verified) return { status: "error", branch, reason: `commit came back unverified (${commit.reason ?? "no reason"}); not pushed` };
  await api.updateRef(branch, commit.sha);
  return { status: "pushed", sha: commit.sha, files: entries.length, branch };
}

/** Real API client over fetch. The token is only ever in the Authorization header. */
export function httpApi({ repo, pr, token, base = "https://api.github.com", fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}/repos/${repo}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200).replace(token, "***")}`);
    return res.json();
  };
  return {
    getPull: () => call("GET", `pulls/${pr}`),
    getRefSha: async (branch) => (await call("GET", `git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)).object.sha,
    getCommitTree: async (sha) => (await call("GET", `git/commits/${sha}`)).tree.sha,
    createBlob: async (b64) => (await call("POST", "git/blobs", { content: b64, encoding: "base64" })).sha,
    createTree: async (baseTree, tree) => (await call("POST", "git/trees", { base_tree: baseTree, tree })).sha,
    createCommit: async ({ message, tree, parent }) => {
      const c = await call("POST", "git/commits", { message, tree, parents: [parent] });
      return { sha: c.sha, verified: Boolean(c.verification?.verified), reason: c.verification?.reason };
    },
    updateRef: (branch, sha) => call("PATCH", `git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { sha, force: false }),
  };
}

function finish(result) {
  const { RESULT_FILE, GITHUB_OUTPUT } = process.env;
  if (RESULT_FILE) writeFileSync(RESULT_FILE, JSON.stringify(result));
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `push_status=${result.status}\n`);
  console.log(`push-as-bot: ${result.status}${result.sha ? ` ${result.sha.slice(0, 7)}` : ""}${result.reason ? ` (${result.reason})` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { UWF_BOT_TOKEN = "", REPO, PR_NUMBER, PR_TITLE = "", RUN_ID, EXPECTED_SHA, TARGET_DIR, WORKFLOW = "sw_dev", GITHUB_API_URL } = process.env;
  if (!REPO || !PR_NUMBER || !RUN_ID || !EXPECTED_SHA || !TARGET_DIR) {
    console.error("push-as-bot: REPO, PR_NUMBER, RUN_ID, EXPECTED_SHA and TARGET_DIR are required");
    process.exit(2);
  }
  if (!UWF_BOT_TOKEN) { finish({ status: "no-token" }); process.exit(0); }
  try {
    const result = await pushAsBot({
      api: httpApi({ repo: REPO, pr: PR_NUMBER, token: UWF_BOT_TOKEN, base: GITHUB_API_URL || "https://api.github.com" }),
      changes: listChanges(TARGET_DIR),
      read: (p) => readEntry(TARGET_DIR, p),
      expectedSha: EXPECTED_SHA,
      message: commitMessage({ workflow: WORKFLOW, title: PR_TITLE, runId: RUN_ID }),
    });
    finish(result);
  } catch (e) {
    finish({ status: "error", reason: String(e.message).replace(UWF_BOT_TOKEN, "***").slice(0, 300) });
  }
}
