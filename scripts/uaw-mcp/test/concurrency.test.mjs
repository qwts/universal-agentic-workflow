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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { outputOwnerPaths } from "../ownership.mjs";
import { lookupRunById, readRunMeta } from "../paths.mjs";
import { startHttpServer } from "../server.mjs";
import { createFixtureWorkspace } from "./helpers.mjs";

const PROTOCOL_URL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "protocol.mjs")).href;

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

  // 4. Two concurrent uaw_run calls sharing ONE data_dir with DIFFERENT explicit output_paths serialize cleanly
  {
    const sharedDataDir = join(ws.repoRoot, ".runs", "shared-data-dir-race");
    const raceOut1 = join(ws.repoRoot, "deliverables", "race-out-1");
    const raceOut2 = join(ws.repoRoot, "deliverables", "race-out-2");
    const fx1 = ws.writeFixturesForOutput(raceOut1);
    const fx2 = ws.writeFixturesForOutput(raceOut2);
    const [r1, r2] = await Promise.all([
      callTool("uaw_run", {
        workflow: "mcp_fixture",
        goal: "Race 1 on shared data_dir",
        adapter: "fake",
        data_dir: sharedDataDir,
        output_path: raceOut1,
        repo_root: ws.repoRoot,
        skills_root: ws.skillsRoot,
        fake_fixture_dir: fx1,
      }),
      callTool("uaw_run", {
        workflow: "mcp_fixture",
        goal: "Race 2 on shared data_dir",
        adapter: "fake",
        data_dir: sharedDataDir,
        output_path: raceOut2,
        repo_root: ws.repoRoot,
        skills_root: ws.skillsRoot,
        fake_fixture_dir: fx2,
      }),
    ]);
    const winner = [r1, r2].find((r) => r.exit_code !== 2);
    const loser = [r1, r2].find((r) => r.exit_code === 2);
    assert.ok(winner, `exactly one shared data_dir contender should proceed; got ${JSON.stringify([r1, r2])}`);
    assert.ok(loser, "second shared data_dir contender must be rejected with exit_code 2");
    assert.equal(winner.exit_code, 0);
    assert.equal(readRunMeta(sharedDataDir)?.output_path, winner.output_path);
    assert.equal(readRunMeta(sharedDataDir)?.run_id, winner.run_id);
  }

  // 5. Two separate processes racing with the SAME explicit run_id and DIFFERENT data_dirs serialize atomically
  {
    const sharedRunId = "cross-proc-shared-run-id";
    const dataA = join(ws.repoRoot, ".runs", "proc-race-a");
    const dataB = join(ws.repoRoot, ".runs", "proc-race-b");
    const outA = join(ws.repoRoot, "deliverables", "proc-out-a");
    const outB = join(ws.repoRoot, "deliverables", "proc-out-b");
    const fxA = ws.writeFixturesForOutput(outA);
    const fxB = ws.writeFixturesForOutput(outB);

    const runInChild = ({ dataDir, outputPath, fakeFixtureDir }) =>
      new Promise((resolveChild, rejectChild) => {
        const script = [
          `import { createMcpHandler } from ${JSON.stringify(PROTOCOL_URL)};`,
          `const h = createMcpHandler({ allowedRoots: [${JSON.stringify(ws.root)}], stateDir: ${JSON.stringify(ws.stateDir)} });`,
          `const res = await h.callTool("uaw_run", {`,
          `  workflow: "mcp_fixture",`,
          `  run_id: ${JSON.stringify(sharedRunId)},`,
          `  goal: "Cross-process run_id race",`,
          `  adapter: "fake",`,
          `  data_dir: ${JSON.stringify(dataDir)},`,
          `  output_path: ${JSON.stringify(outputPath)},`,
          `  repo_root: ${JSON.stringify(ws.repoRoot)},`,
          `  skills_root: ${JSON.stringify(ws.skillsRoot)},`,
          `  fake_fixture_dir: ${JSON.stringify(fakeFixtureDir)},`,
          `});`,
          `process.stdout.write(JSON.stringify(res.structuredContent));`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", rejectChild);
        child.on("close", (code) => {
          if (code !== 0) {
            rejectChild(new Error(`Child exited ${code}: ${stderr}\nstdout: ${stdout}`));
            return;
          }
          resolveChild({ dataDir, result: JSON.parse(stdout) });
        });
      });

    const [resA, resB] = await Promise.all([
      runInChild({ dataDir: dataA, outputPath: outA, fakeFixtureDir: fxA }),
      runInChild({ dataDir: dataB, outputPath: outB, fakeFixtureDir: fxB }),
    ]);
    const winner = [resA, resB].find((x) => x.result.exit_code === 0);
    const loser = [resA, resB].find((x) => x.result.exit_code === 2);
    assert.ok(winner, `one process must claim run_id cleanly; got ${JSON.stringify([resA, resB])}`);
    assert.ok(loser, `second process must fail closed with exit_code 2; got ${JSON.stringify([resA, resB])}`);
    assert.match(loser.result.error ?? "", /already registered to data_dir/);
    assert.equal(lookupRunById(ws.stateDir, sharedRunId)?.data_dir, winner.dataDir);
    assert.equal(readRunMeta(loser.dataDir), null, "losing data_dir must not persist run-meta.json");

    // Losing contender must NOT leave an orphaned output-owners record behind for loserOut.
    const loserOut = loser.dataDir === dataA ? outA : outB;
    const loserFx = loser.dataDir === dataA ? fxA : fxB;
    const legitFollowup = await callTool("uaw_run", {
      workflow: "mcp_fixture",
      run_id: "cross-proc-followup-legit",
      goal: "Reclaim loser output_path cleanly",
      adapter: "fake",
      data_dir: join(ws.repoRoot, ".runs", "proc-race-followup"),
      output_path: loserOut,
      repo_root: ws.repoRoot,
      skills_root: ws.skillsRoot,
      fake_fixture_dir: loserFx,
    });
    assert.equal(legitFollowup.exit_code, 0, "rejected run_id race must not orphan output_path ownership");
  }

  console.log("uaw-mcp concurrency & out-of-tree output ownership tests passed");
} finally {
  await srv.close();
  rmSync(ws.root, { recursive: true, force: true });
  rmSync(wsPause.root, { recursive: true, force: true });
}
