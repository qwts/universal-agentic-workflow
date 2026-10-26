#!/usr/bin/env node
/**
 * Assemble the runner goal file for uwf-on-pr.yml from a pull request.
 *
 * Usage: node scripts/uwf-on-pr/build-goal.mjs <output file>
 * Env:   PR_NUMBER, PR_TITLE, PR_BODY, REPO (owner/repo of the PR), GH_TOKEN (for `gh issue view`)
 *
 * The PR title and body are untrusted text, so they arrive through the environment, never through
 * shell interpolation. Issue references found in the body (`#12`, `owner/repo#12`, and closing
 * keywords such as `Closes #12`) are fetched with `gh issue view --json title,body`; one that
 * cannot be fetched is listed as unavailable and does not fail the run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ISSUES = 10;
const REF = /(?<![\w/&])((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?)#(\d+)\b/g;

/** Unique issue references in `body` as { repo, number }, in order of appearance (closing keywords are plain refs). */
export function parseIssueRefs(body, { repo, selfNumber } = {}) {
  const seen = new Set();
  const refs = [];
  for (const m of String(body ?? "").matchAll(REF)) {
    const ref = { repo: m[1] || repo, number: Number(m[2]) };
    const key = `${ref.repo}#${ref.number}`;
    if (seen.has(key) || (ref.repo === repo && ref.number === Number(selfNumber))) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.slice(0, MAX_ISSUES);
}

function ghIssue({ repo, number }) {
  const r = spawnSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "title,body"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** Markdown goal text. `fetchIssue({repo, number})` returns { title, body } or null. */
export function buildGoal({ number, title, body, repo }, fetchIssue = ghIssue) {
  const out = [`# Goal: ${title}`, "", `Pull request ${repo}#${number}. Implement what this pull request and its linked issues ask for.`, "",
    "## Pull request description", "", String(body ?? "").trim() || "(no description)", ""];
  for (const ref of parseIssueRefs(body, { repo, selfNumber: number })) {
    const issue = fetchIssue(ref);
    out.push(`## Linked issue ${ref.repo}#${ref.number}`, "");
    out.push(issue ? `**${issue.title}**\n\n${String(issue.body ?? "").trim() || "(no description)"}` : "(could not be fetched)", "");
  }
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  const { PR_NUMBER, PR_TITLE = "", PR_BODY = "", REPO } = process.env;
  if (!target || !PR_NUMBER || !REPO) {
    console.error("usage: PR_NUMBER=.. PR_TITLE=.. PR_BODY=.. REPO=owner/repo build-goal.mjs <output file>");
    process.exit(2);
  }
  mkdirSync(dirname(resolve(target)), { recursive: true });
  writeFileSync(target, buildGoal({ number: PR_NUMBER, title: PR_TITLE, body: PR_BODY, repo: REPO }));
}
