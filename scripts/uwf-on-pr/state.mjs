#!/usr/bin/env node
/**
 * Paused-run state for uwf-on-pr (#96): the data dir travels between jobs as the artifact
 * `uwf-state-pr-<pr>` (overwritten on every pause/answer, kept 14 days).
 *
 * Usage: node scripts/uwf-on-pr/state.mjs fetch|restore
 *   fetch    download the newest unexpired artifact into $STATE_DIR; found=true only when it holds paused.json
 *   restore  fetch into $UWF_DATA_DIR; resume only when paused.json says resume:true and headSha equals $HEAD_SHA,
 *            then put the saved working-tree changes back into $TARGET_DIR. Anything else leaves the dir empty.
 * Env: REPO, PR_NUMBER, GH_TOKEN, STATE_DIR / UWF_DATA_DIR, HEAD_SHA, TARGET_DIR, GITHUB_OUTPUT, GITHUB_ENV.
 * Outputs: found=... (fetch), mode=resume|fresh (restore; resume also exports UWF_MODE=resume to GITHUB_ENV).
 *
 * paused.json: { headSha, stage, pausedAt, resume? }. done.json marks consumed state.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listChanges } from "./push-as-bot.mjs";

export const stateArtifactName = (pr) => `uwf-state-pr-${pr}`;
const SNAP = "target-snapshot";

/** Newest unexpired artifact of an `actions/artifacts` listing (the API lists newest first), or null. */
export function pickArtifact(listing) {
  const a = (listing?.artifacts ?? []).find((x) => x && !x.expired);
  return a ? { id: Number(a.id), name: a.name } : null;
}

export function readPaused(dir) {
  try { return JSON.parse(readFileSync(join(dir, "paused.json"), "utf8")); } catch { return null; }
}

/** Resume only a state the answer job released (resume:true) for the very head the run paused on. */
export function decideResume(paused, headSha) {
  if (!paused) return { resume: false, reason: "no paused state" };
  if (paused.resume !== true) return { resume: false, reason: "questions are still unanswered" };
  if (!headSha || paused.headSha !== headSha) return { resume: false, reason: "the PR head moved since the pause" };
  return { resume: true, reason: "ok" };
}

export function clearDir(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
}

/** Save the run's working-tree changes (and tmp/workflow-artifacts) so a resume starts from the same tree. */
export function snapshotTarget(targetDir, dataDir) {
  const snap = join(dataDir, SNAP);
  rmSync(snap, { recursive: true, force: true });
  mkdirSync(join(snap, "files"), { recursive: true });
  const changes = listChanges(targetDir);
  for (const c of changes) {
    if (c.deleted) continue;
    const dest = join(snap, "files", c.path);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(targetDir, c.path), dest, { verbatimSymlinks: true });
  }
  writeFileSync(join(snap, "deleted.json"), JSON.stringify(changes.filter((c) => c.deleted).map((c) => c.path)));
  const wa = join(targetDir, "tmp", "workflow-artifacts");
  if (existsSync(wa)) cpSync(wa, join(snap, "workflow-artifacts"), { recursive: true, verbatimSymlinks: true });
  return { files: changes.length };
}

const inside = (root, p) => {
  const base = resolve(root);
  const r = resolve(base, p);
  return r.startsWith(base + sep) ? r : null;
};

export function restoreTarget(dataDir, targetDir) {
  const snap = join(dataDir, SNAP);
  if (!existsSync(snap)) return { files: 0 };
  let n = 0;
  const walk = (dir, rel = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(join(dir, e.name), r); continue; }
      const dest = inside(targetDir, r);
      if (!dest) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(dir, e.name), dest, { verbatimSymlinks: true });
      n++;
    }
  };
  if (existsSync(join(snap, "files"))) walk(join(snap, "files"));
  let deleted = [];
  try { deleted = JSON.parse(readFileSync(join(snap, "deleted.json"), "utf8")); } catch { /* none */ }
  for (const p of deleted) { const d = inside(targetDir, String(p)); if (d) rmSync(d, { force: true, recursive: true }); }
  if (existsSync(join(snap, "workflow-artifacts"))) {
    cpSync(join(snap, "workflow-artifacts"), join(targetDir, "tmp", "workflow-artifacts"), { recursive: true, verbatimSymlinks: true });
  }
  rmSync(snap, { recursive: true, force: true });
  return { files: n };
}

function gh(args, binary = false) {
  const r = spawnSync("gh", args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${String(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  return r.stdout;
}

/** Download the newest state artifact into `dir`. Returns true when it holds paused.json. */
export function fetchState({ repo, pr, dir, ghFn = gh, unzip = (zip, to) => spawnSync("unzip", ["-o", "-q", zip, "-d", to]) }) {
  const name = stateArtifactName(pr);
  const art = pickArtifact(JSON.parse(ghFn(["api", `repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=10`])));
  if (!art) return false;
  mkdirSync(dir, { recursive: true });
  const zip = join(dirname(resolve(dir)), `${name}-${process.pid}.zip`);
  writeFileSync(zip, ghFn(["api", `repos/${repo}/actions/artifacts/${art.id}/zip`], true));
  const r = unzip(zip, dir);
  rmSync(zip, { force: true });
  if (r.status !== 0) throw new Error("unzip of the state artifact failed");
  return readPaused(dir) !== null;
}

const out = (file, line) => { if (file) appendFileSync(file, line + "\n"); };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const { REPO, PR_NUMBER, GITHUB_OUTPUT, GITHUB_ENV } = process.env;
  if (!["fetch", "restore"].includes(cmd) || !REPO || !/^\d+$/.test(PR_NUMBER ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
    console.error("state: usage: state.mjs fetch|restore with REPO and a numeric PR_NUMBER");
    process.exit(2);
  }
  try {
    if (cmd === "fetch") {
      const dir = process.env.STATE_DIR;
      if (!dir) { console.error("state: STATE_DIR is required"); process.exit(2); }
      const found = fetchState({ repo: REPO, pr: PR_NUMBER, dir });
      if (!found) clearDir(dir);
      out(GITHUB_OUTPUT, `found=${found}`);
      console.log(`state: ${found ? "paused state downloaded" : "no paused state for this PR"}`);
    } else {
      const dir = process.env.UWF_DATA_DIR;
      if (!dir) { console.error("state: UWF_DATA_DIR is required"); process.exit(2); }
      let verdict;
      try {
        const found = fetchState({ repo: REPO, pr: PR_NUMBER, dir });
        verdict = found ? decideResume(readPaused(dir), process.env.HEAD_SHA) : { resume: false, reason: "no paused state" };
      } catch (e) {
        console.error(`::warning::could not restore paused state: ${e.message}`);
        verdict = { resume: false, reason: "restore failed" };
      }
      if (verdict.resume) {
        const r = restoreTarget(dir, process.env.TARGET_DIR);
        out(GITHUB_ENV, "UWF_MODE=resume");
        out(GITHUB_OUTPUT, "mode=resume");
        console.log(`state: resuming (${r.files} working-tree file(s) restored)`);
      } else {
        clearDir(dir);
        out(GITHUB_OUTPUT, "mode=fresh");
        console.log(`state: fresh run (${verdict.reason})`);
      }
    }
  } catch (e) {
    console.error(`state: ${e.message}`);
    process.exit(1);
  }
}
