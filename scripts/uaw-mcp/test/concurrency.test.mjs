/**
 * concurrency.test.mjs — Concurrency, isolation, and out-of-tree output_path ownership tests:
 *   1. Two parallel `uaw_run` calls against the SAME `data_dir`: second fails immediately
 *      with exit code 2 without clobbering `run.lock`; first completes cleanly.
 *   2. Two parallel `uaw_run` calls against DISTINCT `data_dir` paths with `output_path`
 *      omitted: each writes exclusively to `<data-dir>/workflow-artifacts`, preserves its
 *      durable `run_id` across `uaw_resume`, and completes `closed` with zero cross-talk.
 *   3. Sequential/paused explicit `output_path` collision: Run A pauses (exit 3) and releases
 *      its execution lock; Run B (distinct `run_id` and `data_dir`) targeting the SAME explicit
 *      `output_path` is rejected with exit code 2 via the out-of-tree ownership record
 *      `<uaw-state-dir>/output-owners/<sha256(realpath(output_path))>.json`, with ZERO dotfiles
 *      created inside `output_path`. Run A then resumes cleanly on the same `output_path`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { outputOwnerPaths } from "../ownership.mjs";
import { readRunMeta } from "../paths.mjs";
import { startHttpServer } from "../server.mjs";
import { createFixtureWorkspace } from "./helpers.mjs";

const ws = createFixtureWorkspace({ withQuestions: false, withRoundTrip: false, delayMs: 250 });
const wsPause = createFixtureWorkspace({ withQuestions: true, withRoundTrip: false, delayMs: 0 });

const srv = await startHttpServer({
  host: "127.0.0.1",
  port: 0,
  authToken: "concurrency-token",
  allowedRoots: [ws.root, wsPause.root],
  stateDir: ws.stateDir,
});
const baseUrl = `http://${srv.host}:${srv.port}/mcp`;
let rpcId = 1;

async function callTool(name, args) {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer concurrency-token",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.result.structuredContent;
}

try {
  // 1. Two parallel uaw_run calls against the SAME data_dir
  {
    const sharedDataDir = join(ws.repoRoot, ".runs", "same-data-dir");
    const fxDir = ws.writeFixturesForOutput(join(sharedDataDir, "workflow-artifacts"));

    const p1 = callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Parallel collision A",
      adapter: "fake",
      data_dir: sharedDataDir,
      repo_root: ws.repoRoot,
      skills_root: ws.skillsRoot,
      fake_fixture_dir: fxDir,
    });

    // Small delay so p1 reliably acquires locks first
    await new Promise((r) => setTimeout(r, 80));

    const p2 = callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Parallel collision B",
      adapter: "fake",
      data_dir: sharedDataDir,
      repo_root: ws.repoRoot,
      skills_root: ws.skillsRoot,
      fake_fixture_dir: fxDir,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    const codes = [r1.exit_code, r2.exit_code].sort((a, b) => a - b);
    assert.deepEqual(codes, [0, 2], `Expected one exit 0 and one exit 2 on same data_dir, got ${JSON.stringify(codes)}`);
  }

  // 2. Two parallel uaw_run calls against DISTINCT data_dir paths with output_path omitted
  {
    const dataA = join(wsPause.repoRoot, ".runs", "parallel-a");
    const dataB = join(wsPause.repoRoot, ".runs", "parallel-b");
    const outA = join(dataA, "workflow-artifacts");
    const outB = join(dataB, "workflow-artifacts");
    const fxA = wsPause.writeFixturesForOutput(outA);
    const fxB = wsPause.writeFixturesForOutput(outB);

    const [runA, runB] = await Promise.all([
      callTool("uaw_run", {
        workflow: "mcp_fixture",
        goal: "Parallel A",
        adapter: "fake",
        data_dir: dataA,
        repo_root: wsPause.repoRoot,
        skills_root: wsPause.skillsRoot,
        fake_fixture_dir: fxA,
      }),
      callTool("uaw_run", {
        workflow: "mcp_fixture",
        goal: "Parallel B",
        adapter: "fake",
        data_dir: dataB,
        repo_root: wsPause.repoRoot,
        skills_root: wsPause.skillsRoot,
        fake_fixture_dir: fxB,
      }),
    ]);

    assert.equal(runA.exit_code, 3);
    assert.equal(runB.exit_code, 3);
    assert.notEqual(runA.run_id, runB.run_id);
    assert.equal(runA.output_path, outA);
    assert.equal(runB.output_path, outB);
    assert.equal(readRunMeta(dataA).run_id, runA.run_id);
    assert.equal(readRunMeta(dataB).run_id, runB.run_id);

    // Answer both & resume in parallel; verify durable run_id preserved & both close cleanly
    await Promise.all([
      callTool("uaw_question_resolve", {
        run_id: runA.run_id,
        action: "answer",
        id: runA.pending_questions[0].id,
        answer: "node-a",
      }),
      callTool("uaw_question_resolve", {
        run_id: runB.run_id,
        action: "answer",
        id: runB.pending_questions[0].id,
        answer: "node-b",
      }),
    ]);

    const [resA, resB] = await Promise.all([
      callTool("uaw_resume", { run_id: runA.run_id, adapter: "fake", fake_fixture_dir: fxA }),
      callTool("uaw_resume", { run_id: runB.run_id, adapter: "fake", fake_fixture_dir: fxB }),
    ]);

    assert.equal(resA.exit_code, 0);
    assert.equal(resB.exit_code, 0);
    assert.equal(resA.run_id, runA.run_id);
    assert.equal(resB.run_id, runB.run_id);
    assert.equal(resA.phase, "closed");
    assert.equal(resB.phase, "closed");
    assert.ok(existsSync(join(outA, "impl.txt")));
    assert.ok(existsSync(join(outB, "impl.txt")));
  }

  // 3. Sequential/paused explicit output_path collision via out-of-tree ownership registry
  {
    const sharedExplicitOut = join(wsPause.repoRoot, "deliverables", "shared-out");
    mkdirSync(sharedExplicitOut, { recursive: true });
    const fxShared = wsPause.writeFixturesForOutput(sharedExplicitOut);

    const dataRun1 = join(wsPause.repoRoot, ".runs", "paused-owner-1");
    const dataRun2 = join(wsPause.repoRoot, ".runs", "paused-owner-2");

    // Run 1 starts with explicit output_path and pauses at exit 3 (releasing .lock, keeping .json)
    const run1 = await callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Owner 1",
      adapter: "fake",
      data_dir: dataRun1,
      output_path: sharedExplicitOut,
      repo_root: wsPause.repoRoot,
      skills_root: wsPause.skillsRoot,
      fake_fixture_dir: fxShared,
    });
    assert.equal(run1.exit_code, 3);

    // Out-of-tree ownership record exists; execution lock was released; ZERO dotfiles inside output_path!
    const { recordPath, lockPath } = outputOwnerPaths(sharedExplicitOut, ws.stateDir);
    assert.ok(existsSync(recordPath), `Expected out-of-tree ownership record at ${recordPath}`);
    assert.ok(!existsSync(lockPath), "Execution lock must be released after pause");
    const dotfilesInsideOutput = readdirSync(sharedExplicitOut).filter((f) => f.startsWith("."));
    assert.deepEqual(dotfilesInsideOutput, [], "NEVER write lock or ownership dotfiles inside output_path");

    // Run 2 (different run_id and data_dir) targets the SAME explicit output_path -> MUST reject with exit 2
    const run2 = await callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Owner 2 intruder",
      adapter: "fake",
      data_dir: dataRun2,
      output_path: sharedExplicitOut,
      repo_root: wsPause.repoRoot,
      skills_root: wsPause.skillsRoot,
      fake_fixture_dir: fxShared,
    });
    assert.equal(run2.ok, false);
    assert.equal(run2.exit_code, 2, "Different run_id targeting paused output_path must be rejected with exit 2");
    assert.match(run2.error, /already owned by run/);

    // Verify still zero dotfiles inside output_path
    assert.deepEqual(
      readdirSync(sharedExplicitOut).filter((f) => f.startsWith(".")),
      [],
    );

    // Original owner (Run 1) can answer question and resume cleanly
    await callTool("uaw_question_resolve", {
      run_id: run1.run_id,
      action: "answer",
      id: run1.pending_questions[0].id,
      answer: "node",
    });
    const run1Done = await callTool("uaw_resume", {
      run_id: run1.run_id,
      adapter: "fake",
      fake_fixture_dir: fxShared,
    });
    assert.equal(run1Done.exit_code, 0);
    assert.equal(run1Done.phase, "closed");
  }

  console.log("uaw-mcp concurrency & out-of-tree output ownership tests passed");
} finally {
  await srv.close();
  rmSync(ws.root, { recursive: true, force: true });
  rmSync(wsPause.root, { recursive: true, force: true });
}
