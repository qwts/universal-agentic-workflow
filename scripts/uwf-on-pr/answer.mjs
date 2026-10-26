#!/usr/bin/env node
/**
 * Apply `/uwf answer <id> <text>` and `/uwf skip <id>` lines from a PR comment to a paused run's question
 * database, then decide whether the run can resume (#96).
 *
 * Usage: node scripts/uwf-on-pr/answer.mjs apply|activate|none
 * Env: REPO, PR_NUMBER, COMMENT_ID, COMMENT_BODY (untrusted), UWF_DATA_DIR (the downloaded state),
 *   QUESTIONS_CLI, RUN_URL, GH_TOKEN, LABEL_TOKEN (optional bot token), GITHUB_OUTPUT.
 *   apply     parse and apply the commands, rewrite the sticky checklist, write paused.json (resume:true when no
 *             required question is pending); outputs applied=<n> and resume=true|false. The workflow then
 *             re-uploads the data dir.
 *   activate  after the upload: swap the labels (-uwf:needs-input, +uwf:run) and react to the comment.
 *   none      reply that no paused run exists.
 *
 * The comment body is data. Only lines that match the strict command grammar are used, and each command
 * reaches the question CLI as an argv element, never through a shell. Only pending questions can be changed.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LABEL_NEEDS_INPUT, LABEL_RUN, addLabel, buildQuestionsBody, listQuestions, makeGh, pendingRequired, plain, postComment, react,
  removeLabel, runQuestions, upsertQuestionsComment,
} from "./questions.mjs";

const COMMAND = /^\/uwf (answer|skip) (\d{1,9})(?: (.+))?$/;
const COMMAND_LIKE = /^\/uwf (?:answer|skip)\b/;

/** Parse a comment body: { commands: [{ action, id, text }], rejected: [line] }. */
export function parseCommands(body) {
  const commands = [];
  const rejected = [];
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!COMMAND_LIKE.test(line)) continue;
    const m = line.match(COMMAND);
    if (!m) { rejected.push(line); continue; }
    const [, action, id, text] = m;
    // The question CLI reads a value starting with "--" as the next flag, so such an answer cannot be passed.
    if (action === "answer" && (!text || text.startsWith("--"))) { rejected.push(line); continue; }
    commands.push({ action, id: Number(id), text: action === "answer" ? text : undefined });
  }
  return { commands, rejected };
}

/**
 * Apply commands to the pending questions. `run(args)` runs the question CLI (argv array, no shell).
 * Returns { applied: [{action,id}], ignored: [{id,reason}] }.
 */
export function applyCommands(commands, pendingIds, run) {
  const applied = [];
  const ignored = [];
  const pending = new Set(pendingIds);
  for (const c of commands) {
    if (!pending.has(c.id)) { ignored.push({ id: c.id, reason: "not a pending question" }); continue; }
    const args = c.action === "answer" ? ["answer", "--id", String(c.id), "--answer", c.text] : ["skip", "--id", String(c.id)];
    const r = run(args);
    if (!r.ok) { ignored.push({ id: c.id, reason: `the question CLI failed: ${r.error}` }); continue; }
    pending.delete(c.id);
    applied.push({ action: c.action, id: c.id });
  }
  return { applied, ignored };
}

/** Resume is allowed exactly when no required question is still pending. */
export const canResume = (questions) => pendingRequired(questions).length === 0;

/** Reply text summarising what happened. */
export function replyBody({ applied, ignored, rejected, questions, resume, activated }) {
  const out = [];
  if (applied.length) out.push(`Recorded: ${applied.map((a) => `${a.action} Q${a.id}`).join(", ")}.`);
  for (const i of ignored) out.push(`Ignored Q${i.id}: ${plain(i.reason, 200)}.`);
  for (const r of rejected) out.push(`Could not parse \`${plain(r, 120).replace(/`/g, "'")}\`. Use \`/uwf answer <id> <text>\` or \`/uwf skip <id>\`.`);
  if (resume) {
    out.push(activated ? "All required questions are answered. The run resumes." :
      `All required questions are answered. Add the \`${LABEL_RUN}\` label to resume the run (no bot token is configured to add it automatically).`);
  } else {
    const left = pendingRequired(questions);
    out.push(`Still waiting on required: ${left.map((q) => `Q${q.id}`).join(", ")}.`);
  }
  return out.join("\n\n");
}

const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

function need() {
  const { REPO, PR_NUMBER, UWF_DATA_DIR, QUESTIONS_CLI } = process.env;
  if (!REPO || !/^[\w.-]+\/[\w.-]+$/.test(REPO) || !/^\d+$/.test(PR_NUMBER ?? "")) {
    console.error("answer: REPO and a numeric PR_NUMBER are required");
    process.exit(2);
  }
  return { repo: REPO, pr: PR_NUMBER, dir: UWF_DATA_DIR, cli: QUESTIONS_CLI };
}

function readPausedFile(dir) {
  try { return JSON.parse(readFileSync(join(dir, "paused.json"), "utf8")); } catch { return {}; }
}

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The comments one answer job must process, in creation order: every trusted `/uwf ` comment created at or after the
 * pause that is not yet in `applied`, plus the triggering comment (already vetted by the job's `if`). A cancelled
 * pending job loses only its trigger; the next job still finds that comment here.
 */
export function collectComments({ comments, triggering, applied = [], pausedAt }) {
  const done = new Set(applied.map(Number));
  const byId = new Map();
  for (const c of comments ?? []) {
    if (!c || c.id == null || done.has(Number(c.id))) continue;
    if (!TRUSTED.has(c.author_association) || !String(c.body ?? "").startsWith("/uwf ")) continue;
    if (pausedAt && String(c.created_at ?? "") < pausedAt) continue;
    byId.set(Number(c.id), { id: Number(c.id), created_at: String(c.created_at ?? ""), body: String(c.body) });
  }
  if (triggering && triggering.id != null && !done.has(Number(triggering.id)) && !byId.has(Number(triggering.id))) {
    byId.set(Number(triggering.id), { id: Number(triggering.id), created_at: String(triggering.created_at ?? "9999"), body: String(triggering.body ?? "") });
  }
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
}

/** The PR's issue comments since the pause (a listing failure is not fatal: the trigger still gets processed). */
export function listPrComments(gh, repo, pr, since) {
  const q = since ? `?since=${encodeURIComponent(since)}&per_page=100` : "?per_page=100";
  const jq = ".[] | {id, created_at, body, author_association}";
  const out = gh(["api", `repos/${repo}/issues/${pr}/comments${q}`, "--paginate", "--jq", jq]);
  return String(out).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function apply() {
  const { repo, pr, dir, cli } = need();
  if (!dir || !cli) { console.error("answer: UWF_DATA_DIR and QUESTIONS_CLI are required"); process.exit(2); }
  const gh = makeGh();
  const paused = readPausedFile(dir);
  const log = (what, fn) => { try { return fn(); } catch (e) { console.error(`::warning::answer: ${what}: ${e.message}`); return undefined; } };
  const listing = log("comment listing", () => listPrComments(gh, repo, pr, paused.pausedAt)) ?? [];
  const batch = collectComments({
    comments: listing, applied: paused.appliedComments, pausedAt: paused.pausedAt,
    triggering: { id: process.env.COMMENT_ID, body: process.env.COMMENT_BODY, created_at: process.env.COMMENT_CREATED_AT },
  });
  const commands = [];
  const rejected = [];
  for (const c of batch) { const p = parseCommands(c.body); commands.push(...p.commands); rejected.push(...p.rejected); }
  const before = listQuestions(cli, dir);
  const { applied, ignored } = applyCommands(commands, before.filter((q) => q.status === "pending").map((q) => q.id), (args) => runQuestions(cli, dir, args));
  const questions = listQuestions(cli, dir);
  const resume = canResume(questions);
  const changed = batch.length > 0;
  if (changed || paused.resume !== resume) {
    writeFileSync(join(dir, "paused.json"), JSON.stringify({ ...paused, resume, appliedComments: [...(paused.appliedComments ?? []), ...batch.map((c) => c.id)] }, null, 2) + "\n");
  }
  setOutput("changed", String(changed));
  setOutput("resume", String(resume));
  if (!applied.length && !rejected.length && !ignored.length) { setOutput("applied", 0); return; }
  log("questions comment", () => upsertQuestionsComment(gh, { repo, pr, body: buildQuestionsBody({ questions, stage: paused.stage, runUrl: process.env.RUN_URL, ready: resume }) }));
  // With a bot token the label (and so the resume) follows in `activate`; the reply is posted there.
  if (!resume || !process.env.LABEL_TOKEN) {
    log("reply", () => postComment(gh, { repo, pr, body: replyBody({ applied, ignored, rejected, questions, resume, activated: false }) }));
  }
  setOutput("applied", applied.length);
  console.log(`answer: ${batch.length} comment(s), applied ${applied.length}, ignored ${ignored.length}, rejected ${rejected.length}, resume=${resume}`);
}

function activate() {
  const { repo, pr } = need();
  const gh = makeGh();
  const labelGh = process.env.LABEL_TOKEN ? makeGh(process.env.LABEL_TOKEN) : null;
  const log = (what, fn) => { try { fn(); } catch (e) { console.error(`::warning::answer: ${what}: ${e.message}`); } };
  log("remove needs-input label", () => removeLabel(gh, { repo, pr, label: LABEL_NEEDS_INPUT }));
  if (labelGh) {
    // A label added with the job token raises no workflow event; the bot token's does, and starts the resume run.
    log("add run label", () => addLabel(labelGh, { repo, pr, label: LABEL_RUN }));
    log("reply", () => postComment(gh, { repo, pr, body: "All required questions are answered. The run resumes." }));
  }
  if (process.env.COMMENT_ID && /^\d+$/.test(process.env.COMMENT_ID)) log("reaction", () => react(gh, { repo, commentId: process.env.COMMENT_ID }));
}

function none() {
  const { repo, pr } = need();
  postComment(makeGh(), { repo, pr, body: "No paused UWF run on this PR." });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  try {
    if (mode === "apply") apply();
    else if (mode === "activate") activate();
    else if (mode === "none") none();
    else { console.error("answer: usage: answer.mjs apply|activate|none"); process.exit(2); }
  } catch (e) {
    console.error(`answer: ${e.message}`);
    process.exit(1);
  }
}
