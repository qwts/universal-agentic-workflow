/**
 * UWF harness adapter contract (types only). See ../README.md.
 */

export type Permissions = "read-only" | "edit" | "edit+exec" | "read-only+review";

export interface InvokeStageOptions {
  /** .github/agents/<name>.agent.md; its body (frontmatter stripped) is prepended to systemPrompt. */
  agentFile?: string;
  systemPrompt?: string;
  prompt: string;
  /** Working directory the harness runs in. */
  cwd: string;
  inputs?: string[];
  outputs?: string[];
  model?: string;
  /** Resume this session when the adapter supports it. */
  sessionId?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  permissions?: Permissions;
  allowedCommands?: string[];
  skillsRoot?: string;
  /** Transcripts go to <dataDir>/transcripts/. Default: UWF_DATA_DIR ?? ./tmp/uwf */
  dataDir?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface InvokeStageResult {
  ok: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  stdout: string;
  exitCode: number | null;
  usage: Usage | null;
  costUsd?: number;
  error?: string;
}

export interface Adapter {
  name: string;
  /** Never throws; failures are returned as ok:false with error. */
  invokeStage(opts: InvokeStageOptions, extra?: { fixture?: string }): Promise<InvokeStageResult>;
}

export function loadAdapter(name: "claude-code" | "codex" | "fake" | string): Promise<Adapter>;
