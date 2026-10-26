/**
 * Shared helpers for the pause/answer round trip of uwf-on-pr (#96): reading the question protocol
 * database, the sticky "questions" PR comment, labels and the reaction. No shell is ever involved:
 * the question CLI and `gh` are spawned with argv arrays, and bodies travel to `gh api` on stdin as JSON.
 *
 * Everything that comes from the model (questions, proposed answers) or from a PR comment (answers)
 * is untrusted text: it is redacted with the shared secret patterns, flattened to one line, and
 * defanged so it cannot @-mention, inject HTML or forge the comment marker.
 */
import { spawnSync } from "node:child_process";
import { redactSecrets } from "../hooks/secret-patterns.mjs";

export const QUESTIONS_MARKER = "<!-- uwf-on-pr:questions -->";
export const LABEL_RUN = "uwf:run";
export const LABEL_NEEDS_INPUT = "uwf:needs-input";
const COMMENT_AUTHOR = "github-actions[bot]";
const MAX_BODY = 60000;

/** Untrusted text as a single defanged line. */
export function plain(s, max = 600) {
  let t = redactSecrets(String(s ?? "")).text.replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1) + "…";
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/@/g, "@​");
}

/** Run questions.mjs <command> --data-dir <d> ... (no shell). Returns { ok, data, error }. */
export function runQuestions(cliPath, dataDir, args, spawn = spawnSync) {
  const [command, ...rest] = args;
  const r = spawn(process.execPath, [cliPath, command, "--data-dir", dataDir, ...rest], {
    encoding: "utf8", env: { ...process.env, UWF_DATA_DIR: dataDir }, maxBuffer: 64 * 1024 * 1024,
  });
  let data = null;
  try { data = JSON.parse(r.stdout); } catch { /* non-JSON output */ }
  const ok = r.status === 0 && data?.ok !== false;
  return { ok, data, error: ok ? null : (data?.error ?? String(r.stderr || r.error?.message || `exit ${r.status}`).trim()) };
}

/** All questions in the data dir, oldest first: { id, stage, question, proposed, required, status, answer }. */
export function listQuestions(cliPath, dataDir, run = runQuestions) {
  const r = run(cliPath, dataDir, ["list"]);
  if (!r.ok) throw new Error(`questions list failed: ${r.error}`);
  return (r.data?.questions ?? []).map((q) => ({
    id: Number(q.id), stage: String(q.stage ?? ""), question: String(q.question ?? ""), proposed: q.proposed ?? null,
    required: q.required === 1 || q.required === true || q.required === "1", status: String(q.status ?? "pending"), answer: q.answer ?? null,
  }));
}

export const pendingRequired = (qs) => qs.filter((q) => q.status === "pending" && q.required);

const code = (s) => "`" + plain(s, 80).replace(/`/g, "'") + "`";

/**
 * Markdown of the sticky questions comment. Pending questions are `[ ]`; answered or skipped ones are `[x]`.
 * `ready` (no required question pending) switches the text from "reply" to "resuming".
 */
export function buildQuestionsBody({ questions, stage, runUrl, ready = false }) {
  const at = stage ? ` at stage ${code(stage)}` : "";
  const out = [QUESTIONS_MARKER, ready ? "### UWF: all required questions answered" : "### UWF needs your input", ""];
  if (ready) out.push(`Every required question is answered. The run resumes from the answers${at}.`, "");
  else out.push(`The run is paused${at} until the required questions below are answered.${runUrl ? ` Run: [workflow run](${runUrl}).` : ""}`, "");
  if (!questions.length) out.push("_No questions are recorded._", "");
  for (const q of questions) {
    const done = q.status !== "pending";
    out.push(`- [${done ? "x" : " "}] **Q${q.id}** (${plain(q.stage, 80)}, ${q.required ? "required" : "optional"}) ${plain(q.question)}`);
    if (q.status === "answered" && q.answer) out.push(`  - Answer: ${plain(q.answer)}`);
    else if (q.status === "skipped") out.push("  - Skipped");
    else if (q.proposed) out.push(`  - Proposed answer: ${plain(q.proposed)}`);
  }
  out.push("");
  if (!ready) {
    out.push("Reply to this PR with one or more lines, one command per line:", "",
      "```", "/uwf answer <id> <text>", "/uwf skip <id>", "```", "",
      "Optional questions are listed as recorded; they do not block the run. Only comments from the repository's owner, members and collaborators are honoured.");
  }
  let body = redactSecrets(out.join("\n")).text;
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + "\n…(truncated)";
  return body;
}

/** gh with an optional token override. gh(args, stdin) -> stdout. */
export function makeGh(token) {
  return (args, input) => {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    const r = spawnSync("gh", args, { input, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
    return r.stdout;
  };
}

/** Id of the sticky questions comment (marker, posted by the Actions bot), or null. */
export function findQuestionsComment(gh, repo, pr) {
  const jq = `.[] | select(.user.login == ${JSON.stringify(COMMENT_AUTHOR)} and (.body | contains(${JSON.stringify(QUESTIONS_MARKER)}))) | .id`;
  const ids = String(gh(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", jq])).split(/\s+/).filter(Boolean);
  return ids.length ? ids[ids.length - 1] : null;
}

export function upsertQuestionsComment(gh, { repo, pr, body }) {
  const id = findQuestionsComment(gh, repo, pr);
  const payload = JSON.stringify({ body });
  if (id) { gh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], payload); return { action: "updated", id }; }
  const created = JSON.parse(gh(["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], payload) || "{}");
  return { action: "created", id: created.id ?? null };
}

export function postComment(gh, { repo, pr, body }) {
  gh(["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], JSON.stringify({ body }));
}

export function addLabel(gh, { repo, pr, label }) {
  gh(["api", "--method", "POST", `repos/${repo}/issues/${pr}/labels`, "--input", "-"], JSON.stringify({ labels: [label] }));
}

/** Remove a label; a label that is not on the PR (404) is not an error. */
export function removeLabel(gh, { repo, pr, label }) {
  try { gh(["api", "--method", "DELETE", `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(label)}`]); }
  catch (e) { if (!/404|Not Found/i.test(e.message)) throw e; }
}

export function react(gh, { repo, commentId, content = "+1" }) {
  gh(["api", "--method", "POST", `repos/${repo}/issues/comments/${commentId}/reactions`, "--input", "-"], JSON.stringify({ content }));
}
