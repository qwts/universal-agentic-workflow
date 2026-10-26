#!/usr/bin/env node
/**
 * Post (or update in place) the sticky UWF report comment on a pull request.
 *
 * Usage: node scripts/uwf-on-pr/report.mjs [--print]
 * Flags or env (flag wins): --repo/REPO, --pr/PR_NUMBER, --run-url/RUN_URL, --exit-code/RUNNER_EXIT,
 *   --log/RUNNER_LOG, --data-dir/UWF_DATA_DIR, --workflow/INPUT_WORKFLOW, --max-cost-usd/INPUT_MAX_COST_USD,
 *   --push-result/PUSH_RESULT (JSON written by push-as-bot.mjs), --author/PR_AUTHOR, --cost-file/COST_FILE,
 *   --kept/UWF_KEPT (true when the `uwf:keep` label keeps the data dir in the artifact).
 * GH_TOKEN must be set for the gh calls. `--print` writes the body to stdout and calls nothing.
 *
 * Everything from the log is untrusted text (model output can reach gate messages): it is neutralised
 * (no @-mentions, no markdown breakout), scrubbed with the shared secret patterns and length-capped,
 * and nothing is interpolated into a shell: the body travels to `gh api` on stdin as JSON.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../hooks/secret-patterns.mjs";

export const MARKER = "<!-- uwf-on-pr:report -->";
const COMMENT_AUTHOR = "github-actions[bot]";
const MAX_BODY = 60000;

const flatten = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Untrusted text as one inline code span: no newline, no backtick, no @-mention, capped. */
export function inline(s, max = 400) {
  const t = flatten(redactSecrets(s).text).replace(/`/g, "'");
  return "`" + (t.length > max ? t.slice(0, max - 1) + "…" : t) + "`";
}

/** Untrusted text as a fenced block that cannot be closed from inside. */
export function fence(s, max = 6000) {
  let t = redactSecrets(String(s ?? "").replace(/\r/g, "")).text.replace(/`{3,}/g, "'''");
  if (t.length > max) t = t.slice(0, max) + "\n…";
  return "```\n" + t.replace(/\s+$/, "") + "\n```";
}

/** Parse the runner log: stage rows, the failing gate, its prescription, the runner's final message. */
export function parseLog(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let rows = [];
  // Exit 0: "stage  attempts  result" table on stdout.
  for (let i = 0; i < lines.length; i++) {
    if (/^stage +attempts +result\s*$/.test(lines[i])) {
      const block = [];
      for (let j = i + 1; j < lines.length && lines[j].trim(); j++) {
        const m = lines[j].match(/^(\S+)\s{2,}(\d+)\s{2,}(.*)$/);
        if (m) block.push({ stage: m[1], attempts: Number(m[2]), result: m[3].trim() });
      }
      rows = block;
    }
  }
  // Any other exit: "  <stage>: <result> (attempts N)" lines after the failure message.
  if (!rows.length) {
    let block = [];
    for (const line of lines) {
      const m = line.match(/^ {2}([^\s:]+): (.*) \(attempts (\d+)\)$/);
      if (m) block.push({ stage: m[1], attempts: Number(m[3]), result: m[2].trim() });
      else if (block.length) { rows = block; block = []; }
    }
    if (block.length) rows = block;
  }
  let gate = null;
  let prescription = null;
  let message = null;
  for (const line of lines) {
    let m = line.match(/^\[\d+\/\d+\] (\S+) gate: FAIL — (.*)$/);
    if (m) { gate = { stage: m[1], failures: m[2] }; continue; }
    m = line.match(/^\[\d+\/\d+\] (\S+)\s+attempt \d+\/\d+; to fix: (.*)$/);
    if (m) { prescription = { stage: m[1], text: m[2] }; continue; }
    m = line.match(/^\[runner\] Stage (\S+) gate failed \(on_gate_failure: \w+\)\. Failures: (.*?)\. What would have fixed it: (.*) The runner (?:marked|did)/);
    if (m) { gate = { stage: m[1], failures: m[2] }; prescription = { stage: m[1], text: m[3] }; continue; }
    m = line.match(/^\[runner\] (\[\d+\/\d+\] .*)$/);
    if (m) message = m[1];
  }
  return { rows, gate, prescription, message };
}

const pushLine = (push, exit, author) => {
  if (exit !== "0") return "No commits were pushed: the run did not complete.";
  switch (push?.status) {
    case "pushed":
      return `Pushed commit ${inline(String(push.sha ?? "").slice(0, 7))} (${push.files ?? "?"} file(s)) to ${inline(push.branch)} as the bot.` +
        (author ? ` @${author}, please review the change. The workflow never merges.` : " Please review the change. The workflow never merges.");
    case "no-changes": return "The run left no changes in the checkout, so nothing was pushed.";
    case "moved": return "The PR branch moved while the run was in progress, so the run's commit was not pushed. Push again to re-run.";
    case "no-token": return "Commits were not pushed because no bot token (`UWF_BOT_TOKEN`) is configured for this repository.";
    case "error": return `Pushing the run's commit failed: ${inline(push.reason)}. Nothing was pushed.`;
    default: return "The push step did not report a result, so nothing is known to be pushed.";
  }
};

/** Markdown body of the sticky comment. */
export function buildBody({ log, exitCode, runUrl, workflow = "sw_dev", maxCostUsd, push, author, cost, kept }) {
  const exit = String(exitCode ?? "");
  const { rows, gate, prescription, message } = parseLog(log);
  const verdict = {
    "0": "complete", "1": "blocked", "2": "configuration error", "3": "questions pending", "4": "cost cap hit",
  }[exit] ?? (exit === "" ? "did not finish" : "failed");
  const out = [MARKER, `### UWF ${workflow}: ${verdict}`, "",
    `Run: ${runUrl ? `[workflow run](${runUrl})` : "(link unavailable)"} · runner exit code: ${exit === "" ? "n/a" : exit}`, ""];
  if (rows.length) {
    out.push("| stage | attempts | gate result |", "| --- | --- | --- |");
    for (const r of rows) out.push(`| ${inline(r.stage, 80)} | ${r.attempts} | ${inline(r.result, 120)} |`);
  } else {
    out.push("_No stage table was produced._");
  }
  out.push("");
  if (exit === "1") {
    out.push("**Gate blocked**");
    if (gate) out.push(`- Gate: ${inline(gate.stage + " gate", 120)}`, `- Failures: ${inline(gate.failures, 600)}`);
    if (prescription) out.push(`- To fix: ${inline(prescription.text, 800)}`);
    if (!gate && message) out.push(`- ${inline(message, 600)}`);
    out.push("");
  } else if (exit === "3") {
    out.push("**Questions pending.** The run needs a user decision before it can continue." +
      (message ? ` Runner message: ${inline(message, 500)}.` : "") +
      " Posting the questions to this PR is tracked in #96; until then read them in the run's artifact.", "");
  } else if (exit === "4") {
    out.push(`**Cost cap hit.** The run stopped at the cap of $${flatten(maxCostUsd ?? "?")} (\`max_cost_usd\`).` +
      (message ? ` Runner message: ${inline(message, 500)}.` : "") + " Raise the cap and re-run to continue.", "");
  } else if (exit === "2" || (exit !== "0" && exit !== "")) {
    out.push(`**Runner failed.** ${message ? inline(message, 500) : "See the run log."}`, "");
  } else if (exit === "") {
    out.push("**The runner did not produce an exit code.** An earlier step failed; see the run log.", "");
  }
  out.push(pushLine(push, exit, author), "");
  if (cost && String(cost).trim()) out.push("<details><summary>Cost per stage</summary>", "", fence(cost, 3000), "", "</details>", "");
  out.push(runUrl
    ? `Artifacts: [uwf-pr artifact on the run page](${runUrl}#artifacts) (kept 14 days${kept ? "; the whole data directory is included because of the `uwf:keep` label" : ""}).`
    : "Artifacts: on the workflow run page.");
  let body = out.join("\n");
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + "\n…(truncated)";
  return body;
}

/** gh(args, stdin) -> stdout. Default runs the real CLI (no shell). */
export function realGh(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  return r.stdout;
}

/** Id of the existing sticky comment (carries MARKER, posted by the Actions bot), or null. */
export function findComment(gh, repo, pr, author = COMMENT_AUTHOR) {
  const jq = `.[] | select(.user.login == ${JSON.stringify(author)} and (.body | contains(${JSON.stringify(MARKER)}))) | .id`;
  const out = gh(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", jq]);
  const ids = String(out).split(/\s+/).filter(Boolean);
  return ids.length ? ids[ids.length - 1] : null;
}

/** PATCH the sticky comment if present, else POST a new one. Returns { action, id }. */
export function upsertComment(gh, { repo, pr, body }) {
  const id = findComment(gh, repo, pr);
  const payload = JSON.stringify({ body });
  if (id) { gh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], payload); return { action: "updated", id }; }
  const created = JSON.parse(gh(["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], payload) || "{}");
  return { action: "created", id: created.id ?? null };
}

function arg(argv, name, envName) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : process.env[envName];
}
const readIf = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const g = (n, e) => arg(argv, n, e);
  const repo = g("repo", "REPO");
  const pr = g("pr", "PR_NUMBER");
  if (!repo || !pr || !/^\d+$/.test(pr) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error("report: --repo owner/name and a numeric --pr (or REPO, PR_NUMBER) are required");
    process.exit(2);
  }
  let push = null;
  try { const t = readIf(g("push-result", "PUSH_RESULT")); push = t ? JSON.parse(t) : null; } catch { push = null; }
  const author = g("author", "PR_AUTHOR");
  const body = buildBody({
    log: readIf(g("log", "RUNNER_LOG")), exitCode: g("exit-code", "RUNNER_EXIT"), runUrl: g("run-url", "RUN_URL"),
    workflow: g("workflow", "INPUT_WORKFLOW") || "sw_dev", maxCostUsd: g("max-cost-usd", "INPUT_MAX_COST_USD"),
    push, author: author && /^[A-Za-z0-9-]+(\[bot\])?$/.test(author) ? author.replace(/\[bot\]$/, "") : null,
    cost: readIf(g("cost-file", "COST_FILE")), kept: g("kept", "UWF_KEPT") === "true",
  });
  if (argv.includes("--print")) { process.stdout.write(body + "\n"); process.exit(0); }
  try {
    const r = upsertComment(realGh, { repo, pr, body });
    console.log(`report: comment ${r.action}${r.id ? ` (${r.id})` : ""}`);
  } catch (e) {
    console.error(`report: ${e.message}`);
    process.exit(1);
  }
}
