#!/usr/bin/env node
/**
 * Pause a uwf-on-pr run that ended with runner exit 3 (required questions pending), #96.
 *
 * Usage: node scripts/uwf-on-pr/pause.mjs
 * Env: REPO, PR_NUMBER, HEAD_SHA (PR head the run checked out), UWF_DATA_DIR, QUESTIONS_CLI (path to questions.mjs),
 *   TARGET_DIR (the checkout whose working-tree changes are saved), RUN_URL, GH_TOKEN, RUNNER_LOG (optional).
 * It (1) writes the sticky checklist comment (marker <!-- uwf-on-pr:questions -->), (2) writes
 * $UWF_DATA_DIR/paused.json { headSha, stage, pausedAt } and a snapshot of the working tree, (3) swaps the labels
 * (+uwf:needs-input, -uwf:run). The workflow uploads the data dir as artifact uwf-state-pr-<pr> afterwards.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LABEL_NEEDS_INPUT, LABEL_RUN, addLabel, buildQuestionsBody, listQuestions, makeGh, pendingRequired, removeLabel, upsertQuestionsComment,
} from "./questions.mjs";
import { snapshotTarget } from "./state.mjs";

/** The stage the run is blocked at: the first pending required question's stage, else a "blocked" row of the log. */
export function blockedStage(questions, log = "") {
  const q = pendingRequired(questions)[0];
  if (q) return q.stage;
  const m = String(log).match(/^ {2}([^\s:]+): blocked: questions pending/m);
  return m ? m[1] : null;
}

/** Content of paused.json. */
export function pausedRecord({ headSha, stage, now = new Date() }) {
  return { headSha: String(headSha ?? ""), stage: stage ?? null, pausedAt: now.toISOString() };
}

function main() {
  const { REPO, PR_NUMBER, HEAD_SHA, UWF_DATA_DIR, QUESTIONS_CLI, TARGET_DIR, RUN_URL, RUNNER_LOG } = process.env;
  if (!REPO || !/^[\w.-]+\/[\w.-]+$/.test(REPO) || !/^\d+$/.test(PR_NUMBER ?? "") || !HEAD_SHA || !UWF_DATA_DIR || !QUESTIONS_CLI) {
    console.error("pause: REPO, PR_NUMBER, HEAD_SHA, UWF_DATA_DIR and QUESTIONS_CLI are required");
    process.exit(2);
  }
  const questions = listQuestions(QUESTIONS_CLI, UWF_DATA_DIR);
  const log = RUNNER_LOG && existsSync(RUNNER_LOG) ? readFileSync(RUNNER_LOG, "utf8") : "";
  const stage = blockedStage(questions, log);
  writeFileSync(join(UWF_DATA_DIR, "paused.json"), JSON.stringify(pausedRecord({ headSha: HEAD_SHA, stage }), null, 2) + "\n");
  if (TARGET_DIR && existsSync(TARGET_DIR)) {
    const s = snapshotTarget(TARGET_DIR, UWF_DATA_DIR);
    console.log(`pause: saved ${s.files} working-tree file(s)`);
  }
  const gh = makeGh();
  const step = (what, fn) => { try { fn(); } catch (e) { console.error(`::warning::pause: ${what}: ${e.message}`); } };
  step("questions comment", () => {
    const r = upsertQuestionsComment(gh, { repo: REPO, pr: PR_NUMBER, body: buildQuestionsBody({ questions, stage, runUrl: RUN_URL }) });
    console.log(`pause: questions comment ${r.action}${r.id ? ` (${r.id})` : ""}`);
  });
  step("add label", () => addLabel(gh, { repo: REPO, pr: PR_NUMBER, label: LABEL_NEEDS_INPUT }));
  step("remove label", () => removeLabel(gh, { repo: REPO, pr: PR_NUMBER, label: LABEL_RUN }));
  // The pause itself (paused.json, snapshot) succeeded; a PR-side failure is only a warning.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
