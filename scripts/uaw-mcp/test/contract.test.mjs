/**
 * contract.test.mjs — End-to-end uaw-mcp/v1 contract test (ADR-0008):
 *   1. Runs identical 3-stage workflow (exit-3 QUESTIONS pause -> answer -> resume ->
 *      on_verdict review round-trip -> exit 0) through:
 *        (a) direct CLI (`runner.mjs`)
 *        (b) `stdio` MCP client
 *        (c) Streamable HTTP / SSE MCP client
 *   2. Asserts identical terminal rows in `uwf-state.db` and `uwf-stages.db`.
 *   3. Verifies CQRS read-only zero-mutation invariant via SHA-256 digests before/after reads.
 *   4. Verifies `uaw_gates`, `uaw_cost`, `uaw_stage_transition`, and all 11 resource URIs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHttpServer } from "../server.mjs";
import { readStages, readState } from "../store.mjs";
import {
  createFixtureWorkspace,
  createStdioClient,
  QUESTIONS_CLI,
  RUNNER_PATH,
  sha256File,
} from "./helpers.mjs";

const ws = createFixtureWorkspace({ withQuestions: true, withRoundTrip: true });

function normalizeState(s) {
  return {
    phase: s.state.phase,
    status: s.state.status,
    current_agent: s.state.current_agent,
  };
}

function normalizeStages(st) {
  return st.stage_runs.map((r) => ({
    workflow: r.workflow,
    stage: r.stage,
    status: r.status,
    retry_count: r.retry_count,
  }));
}

async function runDirectCli() {
  const dataDir = join(ws.repoRoot, ".runs", "cli-data");
  const outputPath = join(dataDir, "workflow-artifacts");
  const fxDir = ws.writeFixturesForOutput(outputPath);

  const env = { ...process.env, UWF_FAKE_FIXTURE_DIR: fxDir };
  const r1 = spawnSync(
    process.execPath,
    [
      RUNNER_PATH,
      "run",
      "--workflow",
      "mcp_fixture",
      "--goal",
      "Contract parity test",
      "--adapter",
      "fake",
      "--data-dir",
      dataDir,
      "--output-path",
      outputPath,
      "--repo-root",
      ws.repoRoot,
      "--skills-root",
      ws.skillsRoot,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(r1.status, 3, `CLI run should pause with exit 3, got ${r1.status}: ${r1.stderr}`);

  const qList = JSON.parse(
    spawnSync(process.execPath, [QUESTIONS_CLI, "list", "--data-dir", dataDir, "--status", "pending"], {
      encoding: "utf8",
    }).stdout,
  );
  assert.equal(qList.questions.length, 1);
  const ans = spawnSync(
    process.execPath,
    [QUESTIONS_CLI, "answer", "--data-dir", dataDir, "--id", String(qList.questions[0].id), "--answer", "node"],
    { encoding: "utf8" },
  );
  assert.equal(ans.status, 0);

  const r2 = spawnSync(
    process.execPath,
    [
      RUNNER_PATH,
      "resume",
      "--workflow",
      "mcp_fixture",
      "--adapter",
      "fake",
      "--data-dir",
      dataDir,
      "--output-path",
      outputPath,
      "--repo-root",
      ws.repoRoot,
      "--skills-root",
      ws.skillsRoot,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(r2.status, 0, `CLI resume should exit 0, got ${r2.status}: ${r2.stderr}`);

  return {
    state: normalizeState(readState(dataDir)),
    stages: normalizeStages(readStages(dataDir, { workflow: "mcp_fixture" })),
  };
}

async function runStdioMcp() {
  const client = createStdioClient({ allowedRoots: [ws.root], stateDir: ws.stateDir });
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(init.result.serverInfo.contract, "uaw-mcp/v1");

    const toolsList = await client.request("tools/list");
    const toolNames = new Set(toolsList.result.tools.map((t) => t.name));
    for (const expected of [
      "uaw_run",
      "uaw_resume",
      "uaw_gates",
      "uaw_cost",
      "uaw_stage_transition",
      "uaw_question_resolve",
      "uaw_read_state",
      "uaw_read_stages",
      "uaw_read_requirements",
      "uaw_read_adrs",
      "uaw_read_discoveries",
      "uaw_read_issues",
      "uaw_read_reviews",
      "uaw_read_questions",
      "uaw_read_transcript",
    ]) {
      assert.ok(toolNames.has(expected), `missing tool ${expected}`);
    }

    const templates = await client.request("resources/templates/list");
    assert.equal(templates.result.resourceTemplates.length, 11);

    const dataDir = join(ws.repoRoot, ".runs", "stdio-data");
    const expectedOut = join(dataDir, "workflow-artifacts");
    const fxDir = ws.writeFixturesForOutput(expectedOut);

    // 1. uaw_run (omitting output_path -> defaults to <data-dir>/workflow-artifacts) -> exit 3
    const runRes = await client.callTool("uaw_run", {
      workflow: "mcp_fixture",
      goal: "Contract parity test",
      adapter: "fake",
      data_dir: dataDir,
      repo_root: ws.repoRoot,
      skills_root: ws.skillsRoot,
      fake_fixture_dir: fxDir,
    });
    assert.equal(runRes.exit_code, 3, `stdio uaw_run expected exit 3, got ${runRes.exit_code}: ${runRes.stderr}`);
    assert.equal(runRes.status, "questions_pending");
    assert.equal(runRes.output_path, expectedOut);
    assert.ok(runRes.run_id && runRes.run_id.startsWith("uaw-mcp_fixture-"));
    assert.equal(runRes.pending_questions.length, 1);

    // 2. uaw_question_resolve (list -> check -> answer)
    const qCheckFail = await client.callTool("uaw_question_resolve", {
      run_id: runRes.run_id,
      action: "check",
      stage: "plan",
    });
    assert.equal(qCheckFail.exit_code, 1);

    const qAns = await client.callTool("uaw_question_resolve", {
      run_id: runRes.run_id,
      action: "answer",
      id: runRes.pending_questions[0].id,
      answer: "node",
    });
    assert.equal(qAns.ok, true);
    assert.equal(qAns.exit_code, 0);

    // 3. uaw_resume using ONLY run_id (reloads persisted data_dir + output_path) -> exit 0
    const resumeRes = await client.callTool("uaw_resume", {
      run_id: runRes.run_id,
      adapter: "fake",
      fake_fixture_dir: fxDir,
    });
    assert.equal(resumeRes.exit_code, 0, `stdio uaw_resume expected exit 0: ${resumeRes.stderr}`);
    assert.equal(resumeRes.run_id, runRes.run_id);
    assert.equal(resumeRes.output_path, expectedOut);
    assert.equal(resumeRes.phase, "closed");

    // 4. uaw_gates & uaw_cost
    const gatesPresc = await client.callTool("uaw_gates", {
      run_id: runRes.run_id,
      mode: "prescriptions",
    });
    assert.equal(gatesPresc.ok, true);
    assert.equal(gatesPresc.stages.length, 3);

    const gateCheck = await client.callTool("uaw_gates", {
      run_id: runRes.run_id,
      stage: "review",
      mode: "check",
    });
    assert.equal(gateCheck.ok, true);
    assert.equal(gateCheck.gate.passed, true);

    const costRes = await client.callTool("uaw_cost", { run_id: runRes.run_id });
    assert.equal(costRes.ok, true);
    assert.ok(costRes.totals.turns > 0);
    assert.ok(costRes.totals.cost_usd > 0);

    // 5. CQRS read-only zero-mutation invariant: record digests before & after ALL read calls
    const dbFiles = [
      join(dataDir, "uwf-state.db"),
      join(dataDir, "uwf-state.db-wal"),
      join(dataDir, "uwf-stages.db"),
      join(dataDir, "uwf-stages.db-wal"),
      join(dataDir, "uwf-questions.db"),
      join(dataDir, "uwf-questions.db-wal"),
    ];
    const digestsBefore = dbFiles.map(sha256File);

    const encRun = encodeURIComponent(runRes.run_id);
    const stRes = await client.readResource(`uaw://${encRun}/state`);
    const stagesRes = await client.readResource(`uaw://${encRun}/stages`);
    const gateRes = await client.readResource(`uaw://${encRun}/gates/review`);
    const reqsRes = await client.readResource(`uaw://${encRun}/requirements`);
    const adrsRes = await client.readResource(`uaw://${encRun}/adrs`);
    const discRes = await client.readResource(`uaw://${encRun}/discoveries`);
    const issRes = await client.readResource(`uaw://${encRun}/issues`);
    const revRes = await client.readResource(`uaw://${encRun}/reviews`);
    const qRes = await client.readResource(`uaw://${encRun}/questions`);
    const trList = await client.readResource(`uaw://${encRun}/transcripts`);

    assert.equal(stRes.state.phase, "closed");
    assert.equal(stagesRes.stage_runs.length, 3);
    assert.equal(gateRes.status, "passed");
    assert.equal(reqsRes.count, 0);
    assert.equal(adrsRes.count, 0);
    assert.equal(discRes.count, 0);
    assert.equal(issRes.count, 0);
    assert.equal(revRes.count, 0);
    assert.equal(qRes.count, 1);
    assert.ok(trList.count >= 4);

    const firstTr = await client.readResource(`uaw://${encRun}/transcripts/${trList.transcripts[0].id}`);
    assert.equal(firstTr.id, trList.transcripts[0].id);

    // Also verify read tools
    const readToolState = await client.callTool("uaw_read_state", { run_id: runRes.run_id });
    assert.equal(readToolState.state.phase, "closed");

    const digestsAfter = dbFiles.map(sha256File);
    assert.deepEqual(digestsAfter, digestsBefore, "CQRS read queries must not mutate SQLite files or WAL");

    // 6. uaw_stage_transition refuses mutation with code 2 when active run.lock is held
    const fakeLock = join(dataDir, "run.lock");
    writeFileSync(
      fakeLock,
      JSON.stringify({ runId: "other-live-run", pid: process.pid, workflow: "mcp_fixture" }),
      "utf8",
    );
    try {
      const blocked = await client.callTool("uaw_stage_transition", {
        run_id: runRes.run_id,
        target: "state",
        action: "note",
        agent: "operator",
        note: "should fail while locked",
      });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.exit_code, 2);
    } finally {
      rmSync(fakeLock, { force: true });
    }

    // Once lock is removed, uaw_stage_transition succeeds
    const noteOk = await client.callTool("uaw_stage_transition", {
      run_id: runRes.run_id,
      target: "state",
      action: "note",
      agent: "operator",
      note: "post-run verification note",
    });
    assert.equal(noteOk.ok, true);
    assert.equal(noteOk.exit_code, 0);

    return {
      state: normalizeState(readState(dataDir)),
      stages: normalizeStages(readStages(dataDir, { workflow: "mcp_fixture" })),
    };
  } finally {
    await client.close();
  }
}

async function runHttpMcp() {
  const token = "test-secret-token-uaw-177";
  const srv = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    allowedOrigins: ["http://127.0.0.1:*", "chrome-extension://*"],
    allowedRoots: [ws.root],
    stateDir: ws.stateDir,
  });

  const baseUrl = `http://${srv.host}:${srv.port}`;
  let nextId = 1;

  async function rpc(method, params = {}, { accept = "application/json", origin = "chrome-extension://abcdef" } = {}) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: accept,
        Authorization: `Bearer ${token}`,
        Origin: origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    assert.equal(res.status, 200, `HTTP ${method} expected 200, got ${res.status}`);
    if (accept === "text/event-stream") {
      const text = await res.text();
      assert.match(text, /^event: message\ndata: /m);
      const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine.slice("data: ".length));
    }
    return res.json();
  }

  try {
    // Verify SSE response format over POST /mcp
    const sseInit = await rpc("initialize", { protocolVersion: "2025-03-26" }, { accept: "text/event-stream" });
    assert.equal(sseInit.result.serverInfo.contract, "uaw-mcp/v1");

    const dataDir = join(ws.repoRoot, ".runs", "http-data");
    const expectedOut = join(dataDir, "workflow-artifacts");
    const fxDir = ws.writeFixturesForOutput(expectedOut);

    const r1 = await rpc("tools/call", {
      name: "uaw_run",
      arguments: {
        workflow: "mcp_fixture",
        goal: "Contract parity test",
        adapter: "fake",
        data_dir: dataDir,
        repo_root: ws.repoRoot,
        skills_root: ws.skillsRoot,
        fake_fixture_dir: fxDir,
      },
    });
    const runEnv = r1.result.structuredContent;
    assert.equal(runEnv.exit_code, 3);

    const ans = await rpc("tools/call", {
      name: "uaw_question_resolve",
      arguments: {
        run_id: runEnv.run_id,
        action: "answer",
        id: runEnv.pending_questions[0].id,
        answer: "node",
      },
    });
    assert.equal(ans.result.structuredContent.ok, true);

    const r2 = await rpc("tools/call", {
      name: "uaw_resume",
      arguments: {
        run_id: runEnv.run_id,
        adapter: "fake",
        fake_fixture_dir: fxDir,
      },
    });
    assert.equal(r2.result.structuredContent.exit_code, 0);
    assert.equal(r2.result.structuredContent.phase, "closed");

    return {
      state: normalizeState(readState(dataDir)),
      stages: normalizeStages(readStages(dataDir, { workflow: "mcp_fixture" })),
    };
  } finally {
    await srv.close();
  }
}

try {
  const cli = await runDirectCli();
  const stdio = await runStdioMcp();
  const http = await runHttpMcp();

  assert.deepEqual(stdio.state, cli.state, "stdio MCP terminal workflow_state must match direct CLI");
  assert.deepEqual(stdio.stages, cli.stages, "stdio MCP terminal stage_runs must match direct CLI");
  assert.deepEqual(http.state, cli.state, "HTTP/SSE MCP terminal workflow_state must match direct CLI");
  assert.deepEqual(http.stages, cli.stages, "HTTP/SSE MCP terminal stage_runs must match direct CLI");

  console.log("uaw-mcp contract tests passed (CLI === stdio MCP === HTTP/SSE MCP, CQRS zero-mutation verified)");
} finally {
  rmSync(ws.root, { recursive: true, force: true });
}
