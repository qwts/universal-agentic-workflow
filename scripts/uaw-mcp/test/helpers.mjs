/**
 * helpers.mjs — Shared fixtures and MCP client helpers for uaw-mcp/v1 tests.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const SERVER_PATH = join(REPO_ROOT, "scripts", "uaw-mcp", "server.mjs");
export const RUNNER_PATH = join(REPO_ROOT, "scripts", "uwf-runner", "runner.mjs");
export const QUESTIONS_CLI = join(
  REPO_ROOT,
  ".github",
  "skills",
  "uwf-question-protocol",
  "questions.mjs",
);

/**
 * Create a self-contained synthetic 3-stage workflow (`mcp_fixture`) under a temp
 * skills root + matching fake-adapter fixtures:
 *   - Stage 1 (`plan`): asks 1 required question on attempt 1 (exit 3), passes on attempt 2.
 *   - Stage 2 (`implement`): writes `impl.txt` (updated on re-run).
 *   - Stage 3 (`review`): returns `verdict: "changes_requested"` on attempt 1 (triggering
 *     `on_verdict` round-trip back to `implement`), then `verdict: "approved"` on attempt 2.
 */
export function createFixtureWorkspace({
  withQuestions = true,
  withRoundTrip = true,
  delayMs = 0,
  prefix = "uaw-mcp-test-",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const skillsRoot = join(root, "skills-root");
  const repoRoot = join(root, "repo-root");
  const fixtureDir = join(root, "fixtures");
  const stateDir = join(root, "uaw-state");

  const wfDir = join(skillsRoot, ".github", "skills", "uwf-mcp_fixture");
  const agentsDir = join(skillsRoot, ".github", "agents");
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    join(agentsDir, "mcp-fixture-agent.agent.md"),
    [
      "---",
      "name: mcp-fixture-agent",
      "tools: [read, edit]",
      "---",
      "Complete the requested stage outputs under {{output_path}}.",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(wfDir, "SKILL.md"),
    "| field | value |\n| --- | --- |\n| `role` | `sw_dev` |\n",
    "utf8",
  );

  const stageTrackerAbs = join(
    REPO_ROOT,
    ".github",
    "skills",
    "uwf-orchestration-engine",
    "stage-tracker.mjs",
  );
  writeFileSync(
    join(wfDir, "run.mjs"),
    [
      'import { spawnSync } from "node:child_process";',
      `const tracker = ${JSON.stringify(stageTrackerAbs)};`,
      "const raw = process.argv.slice(2);",
      "const out = [];",
      "for (let i = 0; i < raw.length; i++) {",
      '  if (raw[i] === "--list-stages") { out.push("list-stages"); continue; }',
      '  if (raw[i] === "--check-gate") { out.push("check-gate", "--stage", raw[++i]); continue; }',
      "  out.push(raw[i]);",
      "}",
      'if (!out.includes("--workflow")) out.push("--workflow", "mcp_fixture");',
      'const r = spawnSync(process.execPath, [tracker, ...out], { stdio: "inherit", env: process.env });',
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(wfDir, "stages.yaml"),
    [
      "workflow: mcp_fixture",
      "stages:",
      "  - name: plan",
      "    agent: mcp-fixture-agent",
      "    advances_phase_to: planning",
      "    outputs:",
      "      - '{{output_path}}/plan.md'",
      "    gate:",
      "      checks:",
      "        - type: require_non_empty",
      "          path: '{{output_path}}/plan.md'",
      "  - name: implement",
      "    agent: mcp-fixture-agent",
      "    advances_phase_to: execution",
      "    inputs:",
      "      - '{{output_path}}/plan.md'",
      "    outputs:",
      "      - '{{output_path}}/impl.txt'",
      "    gate:",
      "      checks:",
      "        - type: require_non_empty",
      "          path: '{{output_path}}/impl.txt'",
      "  - name: review",
      "    agent: mcp-fixture-agent",
      "    advances_phase_to: closed",
      "    inputs:",
      "      - '{{output_path}}/impl.txt'",
      "    outputs:",
      "      - '{{output_path}}/review.result.json'",
      "    on_verdict:",
      "      changes_requested:",
      "        route_to: implement",
      "        max_round_trips: 2",
      "    gate:",
      "      checks:",
      "        - type: require_json_field",
      "          path: '{{output_path}}/review.result.json'",
      "          schema: stage-result",
      "          pointer: /verdict",
      "          equals: approved",
      "",
    ].join("\n"),
    "utf8",
  );

  function writeFixturesForOutput(outputPath) {
    const relOut = relative(repoRoot, outputPath).split("\\").join("/");
    const planRel = `${relOut}/plan.md`;
    const implRel = `${relOut}/impl.txt`;
    const reviewRel = `${relOut}/review.result.json`;

    const claudeUsage = {
      num_turns: 2,
      total_cost_usd: 0.012,
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 500,
        output_tokens: 250,
        iterations: [
          { input_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 250 },
          { input_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 250 },
        ],
      },
    };

    const planFixture = withQuestions
      ? {
          attempts: [
            {
              delayMs,
              transcript: "QUESTIONS_NEEDED\n[Architecture]\nQ: Target runtime?\nProposed: node\nRequired: true\n",
              claudeResult: claudeUsage,
            },
            {
              delayMs,
              files: { [planRel]: "# Plan\nTarget runtime: node\n" },
              transcript: "Plan written.",
              claudeResult: claudeUsage,
            },
          ],
        }
      : {
          delayMs,
          files: { [planRel]: "# Plan\nDirect plan\n" },
          transcript: "Plan written.",
          claudeResult: claudeUsage,
        };

    const implFixture = {
      attempts: [
        {
          delayMs,
          files: { [implRel]: "v1 implementation\n" },
          transcript: "Implemented v1.",
          claudeResult: claudeUsage,
        },
        {
          delayMs,
          files: { [implRel]: "v2 implementation addressing review findings\n" },
          transcript: "Implemented v2.",
          claudeResult: claudeUsage,
        },
      ],
    };

    const reviewFixture = withRoundTrip
      ? {
          attempts: [
            {
              delayMs,
              files: {
                [reviewRel]: JSON.stringify(
                  {
                    verdict: "changes_requested",
                    findings: [{ severity: "medium", summary: "Update impl to v2" }],
                  },
                  null,
                  2,
                ),
              },
              transcript: "Review requested changes.",
              claudeResult: claudeUsage,
            },
            {
              delayMs,
              files: {
                [reviewRel]: JSON.stringify(
                  {
                    verdict: "approved",
                    findings: [],
                  },
                  null,
                  2,
                ),
              },
              transcript: "Review approved.",
              claudeResult: claudeUsage,
            },
          ],
        }
      : {
          delayMs,
          files: {
            [reviewRel]: JSON.stringify({ verdict: "approved", findings: [] }, null, 2),
          },
          transcript: "Review approved.",
          claudeResult: claudeUsage,
        };

    const dir = mkdtempSync(join(fixtureDir, "fx-"));
    writeFileSync(join(dir, "plan.json"), JSON.stringify(planFixture, null, 2), "utf8");
    writeFileSync(join(dir, "implement.json"), JSON.stringify(implFixture, null, 2), "utf8");
    writeFileSync(join(dir, "review.json"), JSON.stringify(reviewFixture, null, 2), "utf8");
    return dir;
  }

  return { root, skillsRoot, repoRoot, stateDir, writeFixturesForOutput };
}

/**
 * Spawn a stdio MCP client connected to `scripts/uaw-mcp/server.mjs --transport stdio`.
 */
export function createStdioClient({ allowedRoots = [], stateDir } = {}) {
  const args = [SERVER_PATH, "--transport", "stdio"];
  if (allowedRoots.length) args.push("--allowed-roots", allowedRoots.join(","));
  if (stateDir) args.push("--state-dir", stateDir);

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(stateDir ? { UAW_STATE_DIR: stateDir } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let nextId = 1;
  const stderrChunks = [];
  child.stderr.on("data", (c) => stderrChunks.push(c));

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function callTool(name, toolArgs = {}) {
    const resp = await request("tools/call", { name, arguments: toolArgs });
    if (resp.error) throw new Error(`MCP error ${resp.error.code}: ${resp.error.message}`);
    return resp.result.structuredContent ?? JSON.parse(resp.result.content[0].text);
  }

  async function readResource(uri) {
    const resp = await request("resources/read", { uri });
    if (resp.error) throw new Error(`MCP error ${resp.error.code}: ${resp.error.message}`);
    return JSON.parse(resp.result.contents[0].text);
  }

  async function close() {
    rl.close();
    child.stdin.end();
    await new Promise((r) => child.once("close", r));
  }

  return {
    request,
    callTool,
    readResource,
    close,
    getStderr: () => Buffer.concat(stderrChunks).toString("utf8"),
  };
}

export function sha256File(filePath) {
  if (!existsSync(filePath)) return null;
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
