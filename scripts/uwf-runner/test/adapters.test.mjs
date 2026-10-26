/**
 * UWF adapter contract test — runs the same assertions against each adapter.
 *
 * Usage: node scripts/uwf-runner/test/adapters.test.mjs
 * The claude-code and codex adapters are SKIPPED unless their CLI is on PATH and UWF_TEST_LIVE is set
 * (live run uses model haiku and a tiny prompt).
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { loadAdapter } from "../adapters/index.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}

function cliAvailable(bin) {
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function contract(adapterName, { prompt, model, fixtureFor, timeoutCase }) {
  console.log(`# adapter: ${adapterName}`);
  const adapter = await loadAdapter(adapterName);
  const root = mkdtempSync(join(tmpdir(), `uwf-adapter-${adapterName}-`));
  const cwd = join(root, "work");
  const dataDir = join(root, "data");
  mkdirSync(cwd);
  try {
    const base = { prompt, cwd, dataDir, model, permissions: "read-only", timeoutMs: 180000 };
    const extraFor = (n) => (fixtureFor ? { fixture: fixtureFor(root, n) } : undefined);

    const r1 = await adapter.invokeStage({ ...base }, extraFor(1));
    console.log(`  info usage=${JSON.stringify(r1.usage)} cost=${r1.costUsd ?? "n/a"}`);
    check("ok is true", r1.ok === true, r1.error ?? "");
    for (const k of ["ok", "sessionId", "transcriptPath", "stdout", "exitCode", "usage"]) {
      check(`result has "${k}"`, k in r1);
    }
    check("stdout is non-empty string", typeof r1.stdout === "string" && r1.stdout.length > 0);
    check("exitCode is 0", r1.exitCode === 0);
    check("transcript written under dataDir/transcripts",
      !!r1.transcriptPath && r1.transcriptPath.startsWith(join(dataDir, "transcripts")) && existsSync(r1.transcriptPath));
    if (r1.transcriptPath && existsSync(r1.transcriptPath)) {
      try { JSON.parse(readFileSync(r1.transcriptPath, "utf8")); check("transcript is valid JSON", true); }
      catch { check("transcript is valid JSON", false); }
    }
    check("usage null or numeric", r1.usage === null ||
      (typeof r1.usage.inputTokens === "number" && typeof r1.usage.outputTokens === "number"));
    check("sessionId is a string", typeof r1.sessionId === "string" && r1.sessionId.length > 0);

    const r2 = await adapter.invokeStage({ ...base, sessionId: r1.sessionId }, extraFor(1));
    console.log(`  info usage=${JSON.stringify(r2.usage)} cost=${r2.costUsd ?? "n/a"}`);
    check("second call ok", r2.ok === true, r2.error ?? "");
    check("sessionId round-trips", r2.sessionId === r1.sessionId, `${r1.sessionId} vs ${r2.sessionId}`);

    const r3 = await adapter.invokeStage({ ...base, timeoutMs: timeoutCase.timeoutMs }, extraFor("slow"));
    check("timeout returns ok:false (no throw)", r3.ok === false && typeof r3.error === "string", JSON.stringify(r3.error));
    check("timeout result keeps shape", "usage" in r3 && "exitCode" in r3 && "stdout" in r3);
    return r1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- fake adapter (always runs) ---
{
  const r = await contract("fake", {
    prompt: "Reply with the word OK.",
    timeoutCase: { timeoutMs: 50 },
    fixtureFor: (root, n) => {
      const p = join(root, `fixture-${n}.json`);
      writeFileSync(p, JSON.stringify(n === "slow"
        ? { transcript: "slow", delayMs: 2000 }
        : { files: { "out/result.md": "# done\n" }, transcript: "OK", sessionId: "fake-sess-1" }));
      return p;
    },
  });
  check("fake: sessionId from fixture", r.sessionId === "fake-sess-1");
  check("fake: usage is null", r.usage === null);
}

// --- claude-code argv (offline: a fake `claude` on PATH records the argv it was spawned with) ---
{
  const root = mkdtempSync(join(tmpdir(), "uwf-argv-"));
  const bin = join(root, "bin");
  const argvFile = join(root, "argv.json");
  mkdirSync(bin);
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ result: "OK", session_id: "argv-sess", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(fakeClaude, 0o755);
  try {
    const adapter = await loadAdapter("claude-code");
    const cwd = join(root, "work");
    mkdirSync(cwd);
    const r = await adapter.invokeStage({
      prompt: "argv check", cwd, dataDir: join(root, "data"), permissions: "read-only", timeoutMs: 20000,
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    });
    check("claude-code argv run ok", r.ok === true, r.error ?? "");
    const argv = existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, "utf8")) : [];
    const i = argv.indexOf("--setting-sources");
    check("claude-code argv contains --setting-sources project", i >= 0 && argv[i + 1] === "project", JSON.stringify(argv));
    check("claude-code argv passes --setting-sources right after --permission-mode dontAsk",
      i > 0 && argv[i - 1] === "dontAsk" && argv[i - 2] === "--permission-mode", JSON.stringify(argv));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- claude-code adapter (opt-in live) ---
if (!process.env.UWF_TEST_LIVE || !cliAvailable("claude")) {
  console.log("# adapter: claude-code\nSKIP (needs `claude` on PATH and UWF_TEST_LIVE=1)");
} else {
  await contract("claude-code", {
    prompt: "Reply with the single word OK. Do not use any tools.",
    model: process.env.UWF_TEST_MODEL ?? "haiku",
    timeoutCase: { timeoutMs: 1 },
  });
}

// --- codex adapter (opt-in live) ---
if (!process.env.UWF_TEST_LIVE || !cliAvailable("codex")) {
  console.log("# adapter: codex\nSKIP (needs `codex` on PATH and UWF_TEST_LIVE=1)");
} else {
  await contract("codex", {
    prompt: "Reply with the single word OK. Do not run any commands.",
    model: process.env.UWF_TEST_CODEX_MODEL, // unset -> the CLI's configured default
    timeoutCase: { timeoutMs: 1 },
  });
}

// --- grokbot adapter (offline: an in-process responder plays the external agent) ---
{
  console.log("# adapter: grokbot");
  const g = await loadAdapter("grokbot");
  const root = mkdtempSync(join(tmpdir(), "uwf-adapter-grokbot-"));
  const cwd = join(root, "work"); const dataDir = join(root, "data"); mkdirSync(cwd);
  const env = { UWF_GROKBOT_POLL_MS: "20" };
  const respond = (body, delayMs = 100) => setTimeout(() => {
    const p = JSON.parse(readFileSync(join(dataDir, "grokbot", "pending.json"), "utf8"));
    writeFileSync(join(cwd, "out.md"), "done");
    writeFileSync(p.responsePath, JSON.stringify(body));
  }, delayMs);
  respond({ ok: true, summary: "OK" });
  const r1 = await g.invokeStage({ prompt: "Run the intake stage", cwd, dataDir, env, outputs: ["out.md"] });
  check("ok is true", r1.ok === true, r1.error ?? "");
  for (const k of ["ok", "sessionId", "transcriptPath", "stdout", "exitCode", "usage"]) check(`result has "${k}"`, k in r1);
  check("stdout is the agent summary", r1.stdout === "OK");
  check("transcript written", r1.transcriptPath && existsSync(r1.transcriptPath));
  check("request file lists outputs", JSON.parse(readFileSync(join(dataDir, "grokbot", "requests", "0001-intake.json"), "utf8")).outputs[0] === "out.md");
  respond({ ok: false, error: "nope" });
  const r2 = await g.invokeStage({ prompt: "Run the intake stage", cwd, dataDir, env, sessionId: r1.sessionId });
  check("sessionId in -> same out", r2.sessionId === r1.sessionId);
  check("agent failure -> ok:false with error", r2.ok === false && /nope/.test(r2.error));
  const r3 = await g.invokeStage({ prompt: "x", cwd, dataDir, env, timeoutMs: 50 });
  check("timeout -> ok:false", r3.ok === false && /timeout/.test(r3.error));
  // A response that lands after the deadline but before the next (slow) poll is not accepted: with a 400 ms poll
  // and a 60 ms timeout the loop sleeps only the remaining 60 ms, then fails on the deadline although the
  // response (written at 30 ms) is on disk. The responder fires before invokeStage returns, so nothing outlives the test.
  respond({ ok: true, summary: "late" }, 30);
  const t0 = Date.now();
  const r4 = await g.invokeStage({ prompt: "x", cwd, dataDir, env: { UWF_GROKBOT_POLL_MS: "400" }, timeoutMs: 60 });
  check("response after the deadline -> ok:false", r4.ok === false && /timeout/.test(r4.error));
  check("sleep is capped at the remaining timeout", Date.now() - t0 < 300, `${Date.now() - t0}ms`);
  check("the late response was on disk when the loop woke", existsSync(join(dataDir, "grokbot", "responses", "0004-stage.json")));
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll adapter checks passed");
