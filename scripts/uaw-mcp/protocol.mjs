/**
 * protocol.mjs — MCP JSON-RPC 2.0 protocol handler for `uaw-mcp/v1`.
 *
 * Exposes:
 *   - 6 command tools: uaw_run, uaw_resume, uaw_gates, uaw_cost,
 *     uaw_stage_transition, uaw_question_resolve
 *   - 9 read-only CQRS query tools: uaw_read_state, uaw_read_stages,
 *     uaw_read_requirements, uaw_read_adrs, uaw_read_discoveries,
 *     uaw_read_issues, uaw_read_reviews, uaw_read_questions, uaw_read_transcript
 *   - 11 read-only CQRS resource URI templates (`uaw://<run>/...`)
 */

import {
  cmdCost,
  cmdGates,
  cmdQuestionResolve,
  cmdResume,
  cmdRun,
  cmdStageTransition,
  EXIT,
} from "./commands.mjs";
import {
  listRegisteredRuns,
  resolveRunTarget,
  resolveUawStateDir,
  UsageError,
} from "./paths.mjs";
import {
  listTranscriptRecords,
  readAdrs,
  readDiscoveries,
  readGate,
  readIssues,
  readQuestions,
  readRequirements,
  readReviews,
  readStages,
  readState,
  readTranscriptRecord,
} from "./store.mjs";

export const CONTRACT_VERSION = "uaw-mcp/v1";
export const MCP_PROTOCOL_VERSION = "2025-03-26";

const RUN_SCOPE_PROPS = {
  run_id: { type: "string", description: "Durable logical UAW run identifier" },
  data_dir: { type: "string", description: "Isolated per-run UAW data directory path" },
};

export const TOOL_DEFINITIONS = [
  // ---- Command tools ----
  {
    name: "uaw_run",
    description:
      "Execute a UAW workflow via runner.mjs, persisting durable run_id and output_path (<data-dir>/workflow-artifacts by default) with out-of-tree ownership enforcement.",
    inputSchema: {
      type: "object",
      required: ["workflow", "goal"],
      properties: {
        ...RUN_SCOPE_PROPS,
        workflow: { type: "string", description: "Workflow name (e.g., sw_dev)" },
        goal: { type: "string", description: "Goal text or path to goal file" },
        adapter: {
          type: "string",
          enum: ["claude-code", "codex", "fake", "grokbot"],
          description: "Execution harness adapter",
        },
        model: { type: "string" },
        output_path: { type: "string", description: "Artifact directory (defaults to <data-dir>/workflow-artifacts)" },
        from_stage: { type: "string" },
        force: { type: "boolean" },
        unlock: { type: "boolean" },
        non_interactive: { type: "boolean" },
        dry_run: { type: "boolean" },
        timeout_ms: { type: "number" },
        repo_root: { type: "string" },
        skills_root: { type: "string" },
        max_cost_usd: { type: "number" },
        resume_max_context: { type: "number" },
        fake_fixture_dir: { type: "string", description: "Fixture directory for --adapter fake" },
      },
    },
  },
  {
    name: "uaw_resume",
    description:
      "Reload durable run_id and output_path from <data-dir>/run-meta.json and resume from the first non-passed, non-skipped stage.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        workflow: { type: "string" },
        adapter: { type: "string", enum: ["claude-code", "codex", "fake", "grokbot"] },
        model: { type: "string" },
        output_path: { type: "string" },
        unlock: { type: "boolean" },
        non_interactive: { type: "boolean" },
        timeout_ms: { type: "number" },
        repo_root: { type: "string" },
        skills_root: { type: "string" },
        max_cost_usd: { type: "number" },
        resume_max_context: { type: "number" },
        fake_fixture_dir: { type: "string" },
      },
    },
  },
  {
    name: "uaw_gates",
    description:
      "Evaluate deterministic stage gate checks or list stage definitions and gate prescriptions without advancing workflow state.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        workflow: { type: "string" },
        stage: { type: "string" },
        mode: { type: "string", enum: ["prescriptions", "check", "list"] },
        output_path: { type: "string" },
        repo_root: { type: "string" },
        skills_root: { type: "string" },
      },
    },
  },
  {
    name: "uaw_cost",
    description:
      "Compute per-stage and total token usage, cost, and !50K/!100K/!MISS threshold flags from <data-dir>/transcripts/*.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        workflow: { type: "string" },
        output_path: { type: "string" },
        repo_root: { type: "string" },
        skills_root: { type: "string" },
      },
    },
  },
  {
    name: "uaw_stage_transition",
    description:
      "Execute explicit operator or thin-orchestrator transitions on state.mjs or stage-tracker.mjs; refuses mutation with code 2 if an active run.lock is held.",
    inputSchema: {
      type: "object",
      required: ["target", "action"],
      properties: {
        ...RUN_SCOPE_PROPS,
        target: { type: "string", enum: ["state", "stage"] },
        action: { type: "string" },
        workflow: { type: "string" },
        stage: { type: "string" },
        mode: { type: "string" },
        to: { type: "string" },
        agent: { type: "string" },
        note: { type: "string" },
        phases: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        status: { type: "string" },
        profile: { type: "string" },
        model: { type: "string" },
        session_id: { type: "string" },
        force: { type: "boolean" },
        output_path: { type: "string" },
        repo_root: { type: "string" },
        skills_root: { type: "string" },
      },
    },
  },
  {
    name: "uaw_question_resolve",
    description:
      "List, check, answer, or skip pending questions via uwf-question-protocol to unblock exit-3 QUESTIONS pauses before uaw_resume.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        ...RUN_SCOPE_PROPS,
        action: { type: "string", enum: ["list", "check", "answer", "skip"] },
        stage: { type: "string" },
        status: { type: "string", enum: ["pending", "answered", "skipped"] },
        id: { type: "integer" },
        ids: { oneOf: [{ type: "string" }, { type: "array", items: { type: "integer" } }] },
        answer: { type: "string" },
      },
    },
  },

  // ---- Read-only CQRS query tools ----
  {
    name: "uaw_read_state",
    description: "Read-only CQRS query over uwf-state.db (workflow_state and workflow_history) and run-meta.json.",
    inputSchema: { type: "object", properties: { ...RUN_SCOPE_PROPS } },
  },
  {
    name: "uaw_read_stages",
    description: "Read-only CQRS query over uwf-stages.db (stage_runs, stage_history) and runner-routing.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        workflow: { type: "string" },
        stage: { type: "string", description: "Optional stage name to return single-stage gate detail" },
      },
    },
  },
  {
    name: "uaw_read_requirements",
    description: "Read-only CQRS query over uwf-requirements.db.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        role: { type: "string" },
        type: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
      },
    },
  },
  {
    name: "uaw_read_adrs",
    description: "Read-only CQRS query over uwf-adrs.db.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        status: { type: "string" },
        impact: { type: "string" },
      },
    },
  },
  {
    name: "uaw_read_discoveries",
    description: "Read-only CQRS query over uwf-discoveries.db.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        role: { type: "string" },
        category: { type: "string" },
        status: { type: "string" },
        impact: { type: "string" },
        gaps_only: { type: "boolean" },
      },
    },
  },
  {
    name: "uaw_read_issues",
    description: "Read-only CQRS query over uwf-issues.db.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        status: { type: "string" },
        milestone: { type: "string" },
        sprint: { type: "string" },
      },
    },
  },
  {
    name: "uaw_read_reviews",
    description: "Read-only CQRS query over uwf-reviews.db (reviews and findings).",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        role: { type: "string" },
        stage: { type: "string" },
        verdict: { type: "string" },
        severity: { type: "string" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "uaw_read_questions",
    description: "Read-only CQRS query over uwf-questions.db.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        stage: { type: "string" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "uaw_read_transcript",
    description:
      "Read-only CQRS query over <data-dir>/transcripts/*.json with mandatory redactSecrets() scrubbing. Omit transcript_id to list available transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        ...RUN_SCOPE_PROPS,
        transcript_id: { type: "string", description: "Transcript ID (filename without .json)" },
      },
    },
  },
];

export const RESOURCE_TEMPLATES = [
  { uriTemplate: "uaw://{run}/state", name: "Workflow State", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/stages", name: "Stage Runs & Routing", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/gates/{stage}", name: "Stage Gate Detail", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/requirements", name: "Requirements", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/adrs", name: "Architecture Decision Records", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/discoveries", name: "Discoveries", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/issues", name: "Local Tracking Issues", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/reviews", name: "Reviews & Findings", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/questions", name: "Questions", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/transcripts", name: "Transcripts List", mimeType: "application/json" },
  { uriTemplate: "uaw://{run}/transcripts/{id}", name: "Redacted Transcript", mimeType: "application/json" },
];

function toolResponse(payload, { isError = false } = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  };
}

function parseUawUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("uaw://")) {
    throw new UsageError(`Unsupported resource URI "${uri}"; expected uaw://<run>/...`);
  }
  const rest = uri.slice("uaw://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) {
    throw new UsageError(`Malformed resource URI "${uri}"; expected uaw://<run>/<resource>`);
  }
  const runSegment = decodeURIComponent(rest.slice(0, slashIdx));
  const pathPart = rest.slice(slashIdx + 1);
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) {
    throw new UsageError(`Missing resource path in URI "${uri}"`);
  }
  return { runSegment, segments };
}

/**
 * Create a stateless/session-agnostic JSON-RPC 2.0 handler for `uaw-mcp/v1`.
 */
export function createMcpHandler({ allowedRoots = [], stateDir } = {}) {
  const ctx = {
    allowedRoots,
    stateDir: resolveUawStateDir(stateDir),
  };

  async function callTool(name, args = {}) {
    try {
      switch (name) {
        case "uaw_run": {
          const res = await cmdRun(args, ctx);
          return toolResponse(res, { isError: false });
        }
        case "uaw_resume": {
          const res = await cmdResume(args, ctx);
          return toolResponse(res, { isError: false });
        }
        case "uaw_gates": {
          const res = await cmdGates(args, ctx);
          return toolResponse(res, { isError: false });
        }
        case "uaw_cost": {
          const res = await cmdCost(args, ctx);
          return toolResponse(res, { isError: false });
        }
        case "uaw_stage_transition": {
          const res = await cmdStageTransition(args, ctx);
          return toolResponse(res, { isError: !res.ok });
        }
        case "uaw_question_resolve": {
          const res = await cmdQuestionResolve(args, ctx);
          return toolResponse(res, { isError: false });
        }
        case "uaw_read_state": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readState(dataDir));
        }
        case "uaw_read_stages": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          const data = args.stage
            ? readGate(dataDir, args.stage, { workflow: args.workflow })
            : readStages(dataDir, { workflow: args.workflow });
          return toolResponse(data);
        }
        case "uaw_read_requirements": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readRequirements(dataDir, args));
        }
        case "uaw_read_adrs": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readAdrs(dataDir, args));
        }
        case "uaw_read_discoveries": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readDiscoveries(dataDir, args));
        }
        case "uaw_read_issues": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readIssues(dataDir, args));
        }
        case "uaw_read_reviews": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readReviews(dataDir, args));
        }
        case "uaw_read_questions": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          return toolResponse(readQuestions(dataDir, args));
        }
        case "uaw_read_transcript": {
          const { dataDir } = resolveRunTarget({ ...args, ...ctx, requireExisting: true });
          const data = args.transcript_id
            ? readTranscriptRecord(dataDir, args.transcript_id)
            : listTranscriptRecords(dataDir);
          return toolResponse(data);
        }
        default:
          return toolResponse(
            { ok: false, exit_code: EXIT.USAGE, error: `Unknown tool "${name}"` },
            { isError: true },
          );
      }
    } catch (err) {
      const exitCode = err instanceof UsageError ? err.exitCode : EXIT.USAGE;
      return toolResponse(
        {
          ok: false,
          exit_code: exitCode,
          status: "usage_error",
          error: err.message ?? String(err),
        },
        { isError: true },
      );
    }
  }

  function readResource(uri) {
    const { runSegment, segments } = parseUawUri(uri);
    const { dataDir } = resolveRunTarget({
      run_id: runSegment,
      ...ctx,
      requireExisting: true,
    });

    const [kind, subId] = segments;
    let payload;
    switch (kind) {
      case "state":
        payload = readState(dataDir);
        break;
      case "stages":
        payload = readStages(dataDir);
        break;
      case "gates":
        if (!subId) throw new UsageError(`Missing stage in URI "${uri}"`);
        payload = readGate(dataDir, subId);
        break;
      case "requirements":
        payload = readRequirements(dataDir);
        break;
      case "adrs":
        payload = readAdrs(dataDir);
        break;
      case "discoveries":
        payload = readDiscoveries(dataDir);
        break;
      case "issues":
        payload = readIssues(dataDir);
        break;
      case "reviews":
        payload = readReviews(dataDir);
        break;
      case "questions":
        payload = readQuestions(dataDir);
        break;
      case "transcripts":
        payload = subId
          ? readTranscriptRecord(dataDir, subId)
          : listTranscriptRecords(dataDir);
        break;
      default:
        throw new UsageError(`Unknown resource "${kind}" in URI "${uri}"`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  function listResources() {
    const runs = listRegisteredRuns(ctx.stateDir);
    const resources = [];
    for (const r of runs) {
      const enc = encodeURIComponent(r.run_id);
      for (const kind of [
        "state",
        "stages",
        "requirements",
        "adrs",
        "discoveries",
        "issues",
        "reviews",
        "questions",
        "transcripts",
      ]) {
        resources.push({
          uri: `uaw://${enc}/${kind}`,
          name: `${r.run_id}/${kind}`,
          mimeType: "application/json",
        });
      }
    }
    return { resources };
  }

  async function handleJsonRpc(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined;

    try {
      let result;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: "uaw-mcp",
              version: "1.0.0",
              contract: CONTRACT_VERSION,
            },
          };
          break;
        case "notifications/initialized":
          return null;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: TOOL_DEFINITIONS };
          break;
        case "tools/call":
          if (!params?.name || typeof params.name !== "string") {
            return {
              jsonrpc: "2.0",
              id: id ?? null,
              error: { code: -32602, message: "tools/call requires params.name" },
            };
          }
          result = await callTool(params.name, params.arguments ?? {});
          break;
        case "resources/list":
          result = listResources();
          break;
        case "resources/templates/list":
          result = { resourceTemplates: RESOURCE_TEMPLATES };
          break;
        case "resources/read":
          if (!params?.uri || typeof params.uri !== "string") {
            return {
              jsonrpc: "2.0",
              id: id ?? null,
              error: { code: -32602, message: "resources/read requires params.uri" },
            };
          }
          result = readResource(params.uri);
          break;
        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }

      if (isNotification) return null;
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (isNotification) return null;
      const code = err instanceof UsageError ? -32602 : -32603;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message: err.message ?? String(err),
          data: err instanceof UsageError ? { exit_code: err.exitCode } : undefined,
        },
      };
    }
  }

  return { handleJsonRpc, callTool, readResource, listResources };
}
