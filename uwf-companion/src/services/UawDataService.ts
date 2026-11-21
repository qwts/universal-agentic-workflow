import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CompanionSettings, ResolvedServerConfig } from "../mcp/McpServerConfig";
import { UawMcpClient } from "../mcp/UawMcpClient";

export type StoreKind =
  | "state"
  | "stages"
  | "requirements"
  | "adrs"
  | "discoveries"
  | "issues"
  | "reviews"
  | "questions";

const LEGACY_SKILL_DIR: Record<StoreKind, string> = {
  state: "uwf-state-manager",
  stages: "uwf-orchestration-engine",
  requirements: "uwf-requirements",
  adrs: "uwf-adr",
  discoveries: "uwf-discovery",
  issues: "uwf-local-tracking",
  reviews: "uwf-review",
  questions: "uwf-question-protocol",
};

export type RunSelection =
  | { kind: "auto" }
  | { kind: "run_id"; runId: string; dataDir?: string; workflow?: string }
  | { kind: "data_dir"; dataDir: string }
  | { kind: "legacy_workspace" };

export type ResolvedRunTarget =
  | { kind: "run_id"; runId: string; dataDir?: string; workflow?: string; label: string }
  | { kind: "data_dir"; dataDir: string; label: string }
  | { kind: "legacy_workspace"; label: string }
  | { kind: "none"; label: string };

export interface WorkflowStateRecord {
  phase: string;
  mode: string | null;
  status: string;
  current_agent: string | null;
  artifact_path: string | null;
  ready_for_implementation: boolean;
  model_profile?: string | null;
  model_name?: string | null;
  history: Array<{
    id: number;
    ts: string;
    from_phase: string | null;
    to_phase: string;
    agent: string | null;
    note: string | null;
  }>;
}

export interface RunMetaRecord {
  run_id?: string;
  workflow?: string;
  output_path?: string;
  repo_root?: string;
  created_at?: string;
}

export interface StatePayload {
  run_id: string | null;
  data_dir: string | null;
  run_meta: RunMetaRecord | null;
  exists: boolean;
  state: WorkflowStateRecord | null;
}

export interface StagesPayload {
  run_id: string | null;
  data_dir: string | null;
  workflow: string | null;
  exists: boolean;
  stage_runs: Array<Record<string, unknown>>;
  stage_history: Array<Record<string, unknown>>;
  routing: {
    trips: Record<string, unknown>;
    findings: Record<string, unknown>;
  };
}

export interface RequirementsPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  requirements: Array<Record<string, unknown>>;
}

export interface AdrsPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  adrs: Array<Record<string, unknown>>;
}

export interface DiscoveriesPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  discoveries: Array<Record<string, unknown>>;
}

export interface IssuesPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  issues: Array<Record<string, unknown>>;
}

export interface ReviewsPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  reviews: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
}

export interface QuestionsPayload {
  run_id: string | null;
  data_dir: string | null;
  exists: boolean;
  count: number;
  questions: Array<Record<string, unknown>>;
}

export interface CostStageRow {
  file: string;
  stage: string;
  turns: number;
  ctx_per_turn: number;
  last_turn: number;
  cache_read: number;
  cache_write: number;
  output: number;
  thinking: number;
  cost_usd: number;
  flags: string[];
}

export interface CostPayload {
  ok: boolean;
  exit_code: number;
  run_id: string | null;
  data_dir: string | null;
  stages: CostStageRow[];
  totals: {
    turns: number;
    ctx_per_turn: number;
    cache_read: number;
    cache_write: number;
    output: number;
    thinking: number;
    cost_usd: number;
  };
  flags: string[];
  report: string | null;
}

export interface GatesStageDefinition {
  name: string;
  agent: string;
  resolved_agent?: string;
  inputs: string[];
  outputs: string[];
  advancesTo?: string | null;
  gated?: boolean;
  conditional?: boolean;
  maxRetries?: number;
  maxTurns?: number;
}

export interface GatesListPayload {
  ok: boolean;
  exit_code: number;
  mode: "list";
  workflow: string;
  stages: GatesStageDefinition[];
  error: string | null;
}

export interface GatePrescriptionCheck {
  type: string;
  label: string | null;
  prescription: string;
}

export interface GatePrescriptionStage {
  stage: string;
  gated: boolean;
  conditional: boolean;
  on_gate_failure: string;
  max_retries: number;
  max_turns: number | null;
  checks: GatePrescriptionCheck[];
}

export interface GatesPrescriptionsPayload {
  ok: boolean;
  exit_code: number;
  mode: "prescriptions";
  workflow: string;
  stages: GatePrescriptionStage[];
  error: string | null;
}

export interface DiscoveredRun {
  kind: "run_id" | "data_dir";
  runId: string | null;
  dataDir: string | null;
  repoRoot: string | null;
  workflow: string | null;
  phase: string | null;
  status: string | null;
}

export interface WorkflowBlueprint {
  workflow: string;
  stages: GatesStageDefinition[];
}

export interface ArtifactInsight {
  workflow: string;
  stage: string;
  path: string;
  exists: boolean | null;
}

export interface WorkflowInsightsSnapshot {
  target: ResolvedRunTarget;
  currentWorkflow: string | null;
  currentPhase: string | null;
  currentStatus: string | null;
  pendingQuestions: number;
  workflows: WorkflowBlueprint[];
  stageCounts: Record<string, number>;
  artifactInsights: ArtifactInsight[];
  stageRuns: Array<Record<string, unknown>>;
  issuesCount: number;
  openIssuesCount: number;
}

export interface ExportSnapshot {
  issues: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>;
  adrs: Array<Record<string, unknown>>;
  discoveries: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  stages: Array<Record<string, unknown>>;
}

function canonicalizeWithAncestorRealpath(targetPath: string): string | null {
  let cur = path.resolve(targetPath);
  const tail: string[] = [];
  while (true) {
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(cur);
    } catch {
      lst = null;
    }
    if (lst) {
      try {
        const realBase = fs.realpathSync(cur);
        return tail.length ? path.join(realBase, ...tail) : realBase;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

function isWithinDir(targetPath: string, rootDir: string): boolean {
  try {
    const realRoot = fs.realpathSync(rootDir);
    const canonicalTarget = canonicalizeWithAncestorRealpath(targetPath);
    if (!canonicalTarget) return false;
    const rel = path.relative(realRoot, canonicalTarget);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function isGlobPattern(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/** Fail closed: only explicit false/0/"0"/"false"/"no" are optional; all other values are required. */
export function isQuestionRequired(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (norm === "0" || norm === "false" || norm === "no") return false;
  }
  return true;
}

function parseRunIdFromStateUri(uri: string): string | null {
  if (!uri.startsWith("uaw://") || !uri.endsWith("/state")) return null;
  const rawRun = uri.slice("uaw://".length, -"/state".length);
  if (!rawRun || rawRun.includes("/")) return null;
  try {
    return decodeURIComponent(rawRun);
  } catch {
    return null;
  }
}

export class UawDataService {
  private selection: RunSelection = { kind: "auto" };

  constructor(
    private readonly client: UawMcpClient,
    private readonly options: {
      workspaceRoot?: string;
      bundledPluginRoot?: string | null;
      settings?: CompanionSettings;
      transport?: ResolvedServerConfig["transport"];
    } = {},
  ) {}

  get transport(): ResolvedServerConfig["transport"] {
    return this.options.transport ?? this.client.transport;
  }

  getSelection(): RunSelection {
    return this.selection;
  }

  setSelection(selection: RunSelection): void {
    this.selection = selection;
  }

  private get settings(): CompanionSettings {
    return this.options.settings ?? {};
  }

  private resolveLocalPath(raw: string): string {
    const base = this.options.workspaceRoot || process.cwd();
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  }

  private runMatchesWorkspace(run: DiscoveredRun): boolean {
    const ws = this.options.workspaceRoot;
    if (!ws) return false;
    if (run.repoRoot) {
      return isWithinDir(run.repoRoot, ws) && isWithinDir(ws, run.repoRoot);
    }
    if (run.dataDir && isWithinDir(run.dataDir, ws)) {
      return true;
    }
    return false;
  }

  async discoverRuns(): Promise<DiscoveredRun[]> {
    const found: DiscoveredRun[] = [];
    const seenRunIds = new Set<string>();
    const seenDataDirs = new Set<string>();

    let resources: Array<{ uri: string }> = [];
    try {
      resources = await this.client.listResources();
    } catch {
      resources = [];
    }

    const runIds = new Set<string>();
    for (const r of resources) {
      const id = parseRunIdFromStateUri(r.uri);
      if (id) runIds.add(id);
    }

    for (const runId of [...runIds].sort()) {
      try {
        const st = await this.client.callTool<StatePayload>("uaw_read_state", { run_id: runId });
        const dataDir = st.data_dir ?? null;
        seenRunIds.add(runId);
        if (dataDir) seenDataDirs.add(path.resolve(dataDir));
        found.push({
          kind: "run_id",
          runId,
          dataDir,
          repoRoot: st.run_meta?.repo_root ?? null,
          workflow: st.run_meta?.workflow ?? null,
          phase: st.state?.phase ?? null,
          status: st.state?.status ?? null,
        });
      } catch {
        found.push({
          kind: "run_id",
          runId,
          dataDir: null,
          repoRoot: null,
          workflow: null,
          phase: null,
          status: null,
        });
      }
    }

    if (this.transport === "stdio" && this.options.workspaceRoot) {
      const runsDir = path.join(this.options.workspaceRoot, ".uaw-runs");
      try {
        if (fs.existsSync(runsDir) && !fs.lstatSync(runsDir).isSymbolicLink()) {
          for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(runsDir, entry.name);
            if (fs.lstatSync(dir).isSymbolicLink()) continue;
            const resolvedDir = path.resolve(dir);
            if (seenDataDirs.has(resolvedDir)) continue;
            const hasMeta = fs.existsSync(path.join(dir, "run-meta.json"));
            const hasDb = fs.existsSync(path.join(dir, "uwf-state.db"));
            if (!hasMeta && !hasDb) continue;
            try {
              const st = await this.client.callTool<StatePayload>("uaw_read_state", {
                data_dir: resolvedDir,
              });
              const rId = st.run_id ?? null;
              if (rId && seenRunIds.has(rId)) continue;
              if (rId) seenRunIds.add(rId);
              seenDataDirs.add(resolvedDir);
              found.push({
                kind: rId ? "run_id" : "data_dir",
                runId: rId,
                dataDir: resolvedDir,
                repoRoot: st.run_meta?.repo_root ?? null,
                workflow: st.run_meta?.workflow ?? null,
                phase: st.state?.phase ?? null,
                status: st.state?.status ?? null,
              });
            } catch {
              /* ignore unreadable .uaw-runs dir */
            }
          }
        }
      } catch {
        /* ignore unreadable .uaw-runs */
      }
    }

    return found;
  }

  hasLegacyWorkspaceSkills(): boolean {
    if (this.transport !== "stdio" || !this.options.workspaceRoot) return false;
    const skillsDir = path.join(this.options.workspaceRoot, ".github", "skills");
    return fs.existsSync(skillsDir);
  }

  async resolveActiveTarget(): Promise<ResolvedRunTarget> {
    const explicitDataDir = this.settings.dataDir?.trim();
    if (explicitDataDir) {
      const resolved =
        this.transport === "stdio" ? this.resolveLocalPath(explicitDataDir) : explicitDataDir;
      return { kind: "data_dir", dataDir: resolved, label: resolved };
    }

    if (this.selection.kind === "run_id") {
      return {
        kind: "run_id",
        runId: this.selection.runId,
        dataDir: this.selection.dataDir,
        workflow: this.selection.workflow,
        label: this.selection.runId,
      };
    }
    if (this.selection.kind === "data_dir") {
      return {
        kind: "data_dir",
        dataDir: this.selection.dataDir,
        label: this.selection.dataDir,
      };
    }
    if (this.selection.kind === "legacy_workspace") {
      return { kind: "legacy_workspace", label: "workspace (.github/skills)" };
    }

    const runs = await this.discoverRuns();
    if (this.transport === "stdio") {
      const workspaceMatches = runs.filter((r) => this.runMatchesWorkspace(r));
      if (workspaceMatches.length === 1) {
        const workspaceMatch = workspaceMatches[0];
        if (workspaceMatch.runId) {
          return {
            kind: "run_id",
            runId: workspaceMatch.runId,
            dataDir: workspaceMatch.dataDir ?? undefined,
            workflow: workspaceMatch.workflow ?? undefined,
            label: workspaceMatch.runId,
          };
        }
        if (workspaceMatch.dataDir) {
          return {
            kind: "data_dir",
            dataDir: workspaceMatch.dataDir,
            label: workspaceMatch.dataDir,
          };
        }
      }
      if (workspaceMatches.length > 1) {
        return {
          kind: "none",
          label: `${workspaceMatches.length} workspace runs active — select one`,
        };
      }

      if (this.hasLegacyWorkspaceSkills()) {
        return { kind: "legacy_workspace", label: "workspace (.github/skills)" };
      }

      return {
        kind: "none",
        label: runs.length ? `${runs.length} run(s) available — select one` : "no matching run",
      };
    }

    return {
      kind: "none",
      label: runs.length ? `${runs.length} remote run(s) available — select one` : "no active run",
    };
  }

  private scopeForStore(
    target: ResolvedRunTarget,
    store: StoreKind,
  ): { run_id?: string; data_dir?: string } | null {
    if (target.kind === "none") return null;
    if (target.kind === "run_id") {
      return {
        run_id: target.runId,
        ...(target.dataDir ? { data_dir: target.dataDir } : {}),
      };
    }
    if (target.kind === "data_dir") return { data_dir: target.dataDir };
    if (!this.options.workspaceRoot) return null;
    const skillDir = path.join(this.options.workspaceRoot, ".github", "skills", LEGACY_SKILL_DIR[store]);
    if (!fs.existsSync(skillDir)) return null;
    return { data_dir: skillDir };
  }

  private scopeDirForWatch(target: ResolvedRunTarget): string | null {
    if (target.kind === "data_dir") return target.dataDir;
    if (target.kind === "run_id") return target.dataDir ?? null;
    return null;
  }

  getActiveWatchDataDir(target: ResolvedRunTarget): string | null {
    return this.scopeDirForWatch(target);
  }

  async getState(target?: ResolvedRunTarget): Promise<StatePayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "state");
    if (!scope) {
      return { run_id: null, data_dir: null, run_meta: null, exists: false, state: null };
    }
    return await this.client.callTool<StatePayload>("uaw_read_state", scope);
  }

  async getStages(workflow?: string, target?: ResolvedRunTarget): Promise<StagesPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "stages");
    if (!scope) {
      return {
        run_id: null,
        data_dir: null,
        workflow: workflow ?? null,
        exists: false,
        stage_runs: [],
        stage_history: [],
        routing: { trips: {}, findings: {} },
      };
    }
    return await this.client.callTool<StagesPayload>("uaw_read_stages", {
      ...scope,
      ...(workflow ? { workflow } : {}),
    });
  }

  async getRequirements(target?: ResolvedRunTarget): Promise<RequirementsPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "requirements");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, requirements: [] };
    }
    return await this.client.callTool<RequirementsPayload>("uaw_read_requirements", scope);
  }

  async getAdrs(target?: ResolvedRunTarget): Promise<AdrsPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "adrs");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, adrs: [] };
    }
    return await this.client.callTool<AdrsPayload>("uaw_read_adrs", scope);
  }

  async getDiscoveries(target?: ResolvedRunTarget): Promise<DiscoveriesPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "discoveries");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, discoveries: [] };
    }
    return await this.client.callTool<DiscoveriesPayload>("uaw_read_discoveries", scope);
  }

  async getIssues(target?: ResolvedRunTarget): Promise<IssuesPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "issues");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, issues: [] };
    }
    return await this.client.callTool<IssuesPayload>("uaw_read_issues", scope);
  }

  async getReviews(target?: ResolvedRunTarget): Promise<ReviewsPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "reviews");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, reviews: [], findings: [] };
    }
    return await this.client.callTool<ReviewsPayload>("uaw_read_reviews", scope);
  }

  async getQuestions(target?: ResolvedRunTarget): Promise<QuestionsPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "questions");
    if (!scope) {
      return { run_id: null, data_dir: null, exists: false, count: 0, questions: [] };
    }
    return await this.client.callTool<QuestionsPayload>("uaw_read_questions", scope);
  }

  async resolveQuestion(params: {
    action: "answer" | "skip";
    id: number;
    answer?: string;
    target?: ResolvedRunTarget;
    expectedQuestion?: string;
  }): Promise<Record<string, unknown>> {
    const resolved = params.target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "questions");
    if (!scope) {
      throw new Error("No active UAW run or workspace question store is available");
    }

    const args: Record<string, unknown> = {
      ...scope,
      action: params.action,
      id: params.id,
      expected_status: "pending",
    };
    if (params.expectedQuestion !== undefined) {
      args.expected_question_sha256 = crypto
        .createHash("sha256")
        .update(params.expectedQuestion, "utf8")
        .digest("hex");
    }
    if (params.action === "skip") {
      args.reject_required = true;
    }
    if (params.answer !== undefined) {
      args.answer = params.answer;
    }

    const res = await this.client.callTool<Record<string, unknown>>("uaw_question_resolve", args);
    if (res && res.ok === false) {
      throw new Error(String(res.error ?? `Question #${params.id} could not be resolved`));
    }
    return res;
  }

  async getCost(workflow?: string, target?: ResolvedRunTarget): Promise<CostPayload | null> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const scope = this.scopeForStore(resolved, "state");
    if (!scope) return null;
    const wf =
      workflow ??
      (resolved.kind === "run_id" ? resolved.workflow : undefined) ??
      (this.settings.workflow?.trim() || undefined);
    const args: Record<string, unknown> = { ...scope };
    if (wf) args.workflow = wf;
    if (this.transport === "stdio" && this.options.workspaceRoot) {
      args.repo_root = this.options.workspaceRoot;
    }
    try {
      return await this.client.callTool<CostPayload>("uaw_cost", args);
    } catch {
      return null;
    }
  }

  async getGatePrescriptions(
    workflow?: string,
    target?: ResolvedRunTarget,
  ): Promise<GatesPrescriptionsPayload> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const wf =
      workflow ??
      (resolved.kind === "run_id" ? resolved.workflow : undefined) ??
      this.settings.workflow?.trim() ??
      "sw_dev";
    const args: Record<string, unknown> = {
      mode: "prescriptions",
      workflow: wf,
    };
    if (resolved.kind === "run_id") args.run_id = resolved.runId;
    else if (resolved.kind === "data_dir") args.data_dir = resolved.dataDir;
    if (this.transport === "stdio" && this.options.workspaceRoot) {
      args.repo_root = this.options.workspaceRoot;
    }
    return await this.client.callTool<GatesPrescriptionsPayload>("uaw_gates", args);
  }

  discoverWorkflowNames(): string[] {
    const names = new Set<string>();
    const scanSkillsRoot = (skillsRoot: string | null | undefined) => {
      if (!skillsRoot) return;
      try {
        if (!fs.existsSync(skillsRoot) || fs.lstatSync(skillsRoot).isSymbolicLink()) return;
        for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("uwf-")) continue;
          const stagesPath = path.join(skillsRoot, entry.name, "stages.yaml");
          if (fs.existsSync(stagesPath)) {
            names.add(entry.name.slice("uwf-".length));
          }
        }
      } catch {
        /* ignore unreadable skill dirs */
      }
    };

    if (this.transport === "stdio") {
      if (this.options.workspaceRoot) {
        scanSkillsRoot(path.join(this.options.workspaceRoot, ".github", "skills"));
      }
      if (this.options.bundledPluginRoot) {
        scanSkillsRoot(path.join(this.options.bundledPluginRoot, "runtime", ".github", "skills"));
      }
    }

    if (names.size === 0) {
      names.add(this.settings.workflow?.trim() || "sw_dev");
    }
    return [...names].sort();
  }

  async listWorkflowBlueprints(): Promise<WorkflowBlueprint[]> {
    const names = this.discoverWorkflowNames();
    const blueprints: WorkflowBlueprint[] = [];
    for (const wf of names) {
      try {
        const args: Record<string, unknown> = { mode: "list", workflow: wf };
        if (this.transport === "stdio" && this.options.workspaceRoot) {
          args.repo_root = this.options.workspaceRoot;
        }
        const res = await this.client.callTool<GatesListPayload>("uaw_gates", args);
        if (res.ok && Array.isArray(res.stages)) {
          blueprints.push({ workflow: res.workflow ?? wf, stages: res.stages });
        }
      } catch {
        /* skip workflows unavailable on this host */
      }
    }
    return blueprints;
  }

  async collectInsights(target?: ResolvedRunTarget): Promise<WorkflowInsightsSnapshot> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const [stateRes, stagesRes, issuesRes, questionsRes, workflows] = await Promise.all([
      this.getState(resolved),
      this.getStages(resolved.kind === "run_id" ? resolved.workflow : undefined, resolved),
      this.getIssues(resolved),
      this.getQuestions(resolved),
      this.listWorkflowBlueprints(),
    ]);

    const stageRuns = stagesRes.stage_runs ?? [];
    const stageCounts: Record<string, number> = {};
    for (const run of stageRuns) {
      const wf = String(run.workflow ?? "unknown");
      const status = String(run.status ?? "unknown");
      const key = `${wf}:${status}`;
      stageCounts[key] = (stageCounts[key] ?? 0) + 1;
    }

    const lastRunWf = stageRuns.length
      ? String(stageRuns[stageRuns.length - 1]?.workflow ?? "") || null
      : null;
    const currentWorkflow =
      stateRes.run_meta?.workflow ??
      stagesRes.workflow ??
      lastRunWf ??
      (resolved.kind === "run_id" ? resolved.workflow ?? null : null);

    const outputRoot =
      stateRes.run_meta?.output_path ??
      stateRes.state?.artifact_path ??
      "./tmp/workflow-artifacts";
    const workspaceRoot = this.options.workspaceRoot;
    const runDataDir = stateRes.data_dir ?? this.scopeDirForWatch(resolved);

    const artifactInsights: ArtifactInsight[] = [];
    for (const wf of workflows) {
      for (const stage of wf.stages) {
        for (const template of stage.outputs ?? []) {
          const substituted = template
            .replaceAll("{{output_path}}", outputRoot)
            .replaceAll("{{cwd}}", workspaceRoot ?? ".");
          const resolvedPath =
            workspaceRoot && !path.isAbsolute(substituted)
              ? path.resolve(workspaceRoot, substituted)
              : path.resolve(substituted);
          const displayPath = workspaceRoot
            ? path.relative(workspaceRoot, resolvedPath)
            : substituted;

          let exists: boolean | null = null;
          if (this.transport === "stdio" && !isGlobPattern(resolvedPath)) {
            const allowedInWorkspace = workspaceRoot ? isWithinDir(resolvedPath, workspaceRoot) : false;
            const allowedInDataDir = runDataDir ? isWithinDir(resolvedPath, runDataDir) : false;
            if (allowedInWorkspace || allowedInDataDir) {
              try {
                exists = fs.existsSync(resolvedPath) && !fs.lstatSync(resolvedPath).isSymbolicLink();
              } catch {
                exists = false;
              }
            }
          }

          artifactInsights.push({
            workflow: wf.workflow,
            stage: stage.name,
            path: displayPath,
            exists,
          });
        }
      }
    }

    const openIssuesCount = (issuesRes.issues ?? []).filter(
      (i) => i.status === "open" || i.status === "active",
    ).length;
    const pendingQuestions = (questionsRes.questions ?? []).filter(
      (q) => q.status === "pending",
    ).length;

    return {
      target: resolved,
      currentWorkflow,
      currentPhase: stateRes.state?.phase ?? null,
      currentStatus: stateRes.state?.status ?? null,
      pendingQuestions,
      workflows,
      stageCounts,
      artifactInsights,
      stageRuns,
      issuesCount: (issuesRes.issues ?? []).length,
      openIssuesCount,
    };
  }

  async collectExportSnapshot(target?: ResolvedRunTarget): Promise<ExportSnapshot> {
    const resolved = target ?? (await this.resolveActiveTarget());
    const [issuesRes, reqRes, adrRes, discRes, revRes, qRes, stgRes] = await Promise.all([
      this.getIssues(resolved),
      this.getRequirements(resolved),
      this.getAdrs(resolved),
      this.getDiscoveries(resolved),
      this.getReviews(resolved),
      this.getQuestions(resolved),
      this.getStages(resolved.kind === "run_id" ? resolved.workflow : undefined, resolved),
    ]);

    return {
      issues: issuesRes.issues ?? [],
      requirements: reqRes.requirements ?? [],
      adrs: adrRes.adrs ?? [],
      discoveries: discRes.discoveries ?? [],
      reviews: revRes.reviews ?? [],
      findings: revRes.findings ?? [],
      questions: qRes.questions ?? [],
      stages: stgRes.stage_runs ?? [],
    };
  }
}
