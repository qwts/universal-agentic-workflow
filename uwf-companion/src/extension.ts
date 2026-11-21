import * as vscode from "vscode";
import {
  CompanionSettings,
  resolveBundledPluginRoot,
  resolveServerConfig,
  secretKeyForRemoteUrl,
  validateRemoteUrl,
} from "./mcp/McpServerConfig";
import { UawMcpClient } from "./mcp/UawMcpClient";
import { UawMcpDefinitionProvider } from "./mcp/UawMcpDefinitionProvider";
import { AdrPanel } from "./providers/AdrPanel";
import { CostPanel } from "./providers/CostPanel";
import { DashboardPanel } from "./providers/DashboardPanel";
import { DiscoveryPanel } from "./providers/DiscoveryPanel";
import { GatesPanel } from "./providers/GatesPanel";
import { IssuesPanel } from "./providers/IssuesPanel";
import { PanelRegistry } from "./providers/PanelRegistry";
import { QuestionsPanel } from "./providers/QuestionsPanel";
import { RequirementsPanel } from "./providers/RequirementsPanel";
import { ReviewPanel } from "./providers/ReviewPanel";
import { StagesPanel } from "./providers/StagesPanel";
import { WorkflowSectionPanel } from "./providers/WorkflowSectionPanel";
import { WorkflowStatePanel } from "./providers/WorkflowStatePanel";
import { WorkflowTreeProvider } from "./providers/WorkflowTreeProvider";
import { ReportBuilder } from "./reporter/ReportBuilder";
import { isQuestionRequired, RunSelection, UawDataService } from "./services/UawDataService";
import { RuntimeWatcher } from "./watchers/RuntimeWatcher";

let activeClient: UawMcpClient | undefined;
let activeShutdown: (() => Promise<void>) | undefined;

function readSettings(): CompanionSettings {
  const conf = vscode.workspace.getConfiguration("uwf");
  return {
    workflow: conf.get<string>("workflow") ?? "sw_dev",
    dataDir: conf.get<string>("dataDir") ?? "",
    stateDir: conf.get<string>("stateDir") ?? "",
    mcpServerPath: conf.get<string>("mcpServerPath") ?? "",
    mcpServerUrl: conf.get<string>("mcpServerUrl") ?? "",
    nodePath: conf.get<string>("nodePath") ?? "",
    allowedRoots: conf.get<string[]>("allowedRoots") ?? [],
    refreshIntervalMs: conf.get<number>("refreshIntervalMs") ?? 0,
    workflowStagesPath: conf.get<string>("workflowStagesPath") ?? ".github/skills/uwf-sw_dev/stages.yaml",
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const getWorkspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const version = String((context.extension.packageJSON as { version?: string })?.version ?? "0.1.0");
  const bundledPluginRoot = resolveBundledPluginRoot(context.extensionPath);

  let dataService: UawDataService | undefined;
  let runtimeError: string | undefined;
  let currentSelection: RunSelection = { kind: "auto" };
  let disposed = false;
  let reloadSeq = 0;
  let reloadQueue: Promise<void> = Promise.resolve();

  // Register Copilot / VS Code MCP Server Definition Provider unconditionally (provider gates on isTrusted)
  const mcpProvider = new UawMcpDefinitionProvider(
    context,
    getWorkspaceRoot,
    readSettings,
    version,
  );
  const mcpProviderReg = vscode.lm.registerMcpServerDefinitionProvider("uwf.uaw-mcp", mcpProvider);

  const watcher = new RuntimeWatcher(getWorkspaceRoot());
  const treeProvider = new WorkflowTreeProvider(() => ({ dataService, error: runtimeError }));
  const treeReg = vscode.window.registerTreeDataProvider("uwf.workflowTree", treeProvider);
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshSeq = 0;

  const updateStatusBar = async () => {
    const seq = ++refreshSeq;
    const service = dataService;
    if (!service) {
      statusItem.text = !vscode.workspace.isTrusted
        ? "UWF: untrusted workspace"
        : "UWF: MCP unavailable";
      statusItem.tooltip =
        runtimeError ?? "UAW MCP runtime is inactive. Check workspace trust or settings.";
      statusItem.command = "uwf.openDashboard";
      statusItem.show();
      return;
    }

    try {
      const target = await service.resolveActiveTarget();
      watcher.setActiveDataDir(service.getActiveWatchDataDir(target));
      const insights = await service.collectInsights(target);
      if (seq !== refreshSeq) return;
      const qSuffix =
        insights.pendingQuestions > 0 ? ` · ${insights.pendingQuestions} questions` : "";
      statusItem.text = `UWF: ${insights.currentWorkflow ?? "—"} › ${insights.currentPhase ?? "unknown"} (${insights.currentStatus ?? "idle"}${qSuffix})`;
      statusItem.tooltip = `Target: ${insights.target.label} (click for UWF Dashboard)`;
    } catch (err) {
      if (seq !== refreshSeq) return;
      statusItem.text = "UWF: MCP unavailable";
      statusItem.tooltip = err instanceof Error ? err.message : String(err);
    }
    statusItem.command = "uwf.openDashboard";
    statusItem.show();
  };

  const refreshGlobalState = () => {
    treeProvider.refresh();
    if (dataService) {
      void PanelRegistry.refreshAll(dataService);
    }
    if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
    statusRefreshTimer = setTimeout(() => {
      void updateStatusBar();
    }, 300);
  };

  const runReload = async (seq: number) => {
    if (disposed || seq !== reloadSeq) return;

    const prev = activeClient;
    activeClient = undefined;
    dataService = undefined;
    runtimeError = undefined;
    watcher.setActiveDataDir(null);
    watcher.setPollInterval(0);

    if (prev) {
      await prev.dispose();
    }
    if (disposed || seq !== reloadSeq) return;

    if (!vscode.workspace.isTrusted) {
      runtimeError = "Workspace is untrusted. Trust this workspace to run the UAW MCP runtime.";
      refreshGlobalState();
      return;
    }

    let createdClient: UawMcpClient | undefined;
    let settings: ReturnType<typeof readSettings> | undefined;
    try {
      settings = readSettings();
      let authToken: string | undefined;
      if (settings.mcpServerUrl?.trim()) {
        const secretKey = secretKeyForRemoteUrl(settings.mcpServerUrl);
        authToken = (await context.secrets.get(secretKey))?.trim() || undefined;
      }
      if (disposed || seq !== reloadSeq) return;

      const workspaceRoot = getWorkspaceRoot();
      const config = resolveServerConfig({
        extensionPath: context.extensionPath,
        workspaceRoot,
        settings,
        authToken,
        allowMonorepoFallback: context.extensionMode === vscode.ExtensionMode.Development,
      });
      createdClient = new UawMcpClient(config, { clientVersion: version });
      if (disposed || seq !== reloadSeq) {
        await createdClient.dispose();
        return;
      }
      activeClient = createdClient;
      const service = new UawDataService(createdClient, {
        workspaceRoot,
        bundledPluginRoot,
        settings,
        transport: config.transport,
      });
      service.setSelection(currentSelection);
      dataService = service;
      watcher.setPollInterval(settings.refreshIntervalMs ?? 0);
    } catch (err) {
      if (createdClient && activeClient !== createdClient) {
        await createdClient.dispose();
      }
      if (disposed || seq !== reloadSeq) return;
      runtimeError = err instanceof Error ? err.message : String(err);
      const isIdleEmptyWindow =
        !getWorkspaceRoot() &&
        !settings?.mcpServerUrl?.trim() &&
        !(settings?.allowedRoots?.length) &&
        !settings?.dataDir?.trim();
      if (!isIdleEmptyWindow) {
        void vscode.window.showErrorMessage(`UWF Companion initialization failed: ${runtimeError}`);
      }
    }

    if (!disposed && seq === reloadSeq) {
      refreshGlobalState();
    }
  };

  const reloadRuntime = (): Promise<void> => {
    const seq = ++reloadSeq;
    reloadQueue = reloadQueue.then(
      () => runReload(seq),
      () => runReload(seq),
    );
    return reloadQueue;
  };

  const requireService = (): UawDataService | undefined => {
    if (!dataService) {
      void vscode.window.showWarningMessage(
        runtimeError ?? "UAW MCP runtime is inactive. Check Workspace Trust and settings.",
      );
      return undefined;
    }
    return dataService;
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      disposed = true;
      reloadSeq += 1;
      if (statusRefreshTimer) {
        clearTimeout(statusRefreshTimer);
        statusRefreshTimer = undefined;
      }
      await reloadQueue.catch(() => undefined);
      const client = activeClient;
      activeClient = undefined;
      if (client) {
        await client.dispose().catch(() => undefined);
      }
      if (activeShutdown === shutdown) {
        activeShutdown = undefined;
      }
    })();
    return shutdownPromise;
  };
  activeShutdown = shutdown;

  watcher.onRefresh(refreshGlobalState);

  context.subscriptions.push(
    mcpProvider,
    mcpProviderReg,
    watcher,
    treeProvider,
    treeReg,
    statusItem,
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      mcpProvider.notifyChanged();
      void reloadRuntime();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("uwf")) return;
      mcpProvider.notifyChanged();
      void reloadRuntime();
    }),
    vscode.commands.registerCommand("uwf.openDashboard", () => {
      const svc = requireService();
      if (svc) DashboardPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openRequirements", () => {
      const svc = requireService();
      if (svc) RequirementsPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openReview", () => {
      const svc = requireService();
      if (svc) ReviewPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openAdrs", () => {
      const svc = requireService();
      if (svc) AdrPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openDiscoveries", () => {
      const svc = requireService();
      if (svc) DiscoveryPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openWorkflowState", () => {
      const svc = requireService();
      if (svc) WorkflowStatePanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openDashboardSection", (sectionId?: string) => {
      const svc = requireService();
      if (svc && sectionId) WorkflowSectionPanel.show(svc, sectionId);
    }),
    vscode.commands.registerCommand("uwf.openStages", () => {
      const svc = requireService();
      if (svc) StagesPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openIssues", () => {
      const svc = requireService();
      if (svc) IssuesPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openQuestions", () => {
      const svc = requireService();
      if (svc) QuestionsPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.openCost", () => {
      const svc = requireService();
      if (svc) CostPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.checkGates", () => {
      const svc = requireService();
      if (svc) GatesPanel.show(context, svc);
    }),
    vscode.commands.registerCommand("uwf.resolveQuestion", async () => {
      const svc = requireService();
      if (!svc) return;
      try {
        const target = await svc.resolveActiveTarget();
        if (target.kind === "none") {
          void vscode.window.showWarningMessage(
            "No active UAW run or workspace question store is available.",
          );
          return;
        }
        const qRes = await svc.getQuestions(target);
        const pending = (qRes.questions ?? []).filter((q) => q.status === "pending");
        if (!pending.length) {
          void vscode.window.showInformationMessage("No pending UWF questions to resolve.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          pending.map((q) => ({
            label: `#${String(q.id)} [${String(q.stage ?? "general")}]${isQuestionRequired(q.required) ? " [required]" : ""}`,
            description: String(q.question ?? ""),
            question: q,
          })),
          { placeHolder: "Select a pending UWF question to resolve" },
        );
        if (!picked) return;

        const id = Number(picked.question.id);
        const expectedQuestion = String(picked.question.question ?? "");
        const required = isQuestionRequired(picked.question.required);

        let action: "Answer" | "Skip" = "Answer";
        if (!required) {
          const pickedAction = await vscode.window.showQuickPick(["Answer", "Skip"], {
            placeHolder: `${expectedQuestion} (optional question)`,
          });
          if (!pickedAction) return;
          action = pickedAction === "Skip" ? "Skip" : "Answer";
        }

        if (action === "Answer") {
          const answer = await vscode.window.showInputBox({
            prompt: required ? `[Required] ${expectedQuestion}` : expectedQuestion,
            value: String(picked.question.proposed ?? ""),
            ignoreFocusOut: true,
          });
          if (answer === undefined || !answer.trim()) return;
          await svc.resolveQuestion({
            action: "answer",
            id,
            answer: answer.trim(),
            target,
            expectedQuestion,
          });
          void vscode.window.showInformationMessage(`Resolved question #${id}.`);
        } else {
          await svc.resolveQuestion({
            action: "skip",
            id,
            target,
            expectedQuestion,
          });
          void vscode.window.showInformationMessage(`Skipped question #${id}.`);
        }
        refreshGlobalState();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to resolve question: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand("uwf.selectRun", async () => {
      const svc = requireService();
      if (!svc) return;
      try {
        const runs = await svc.discoverRuns();
        const items: Array<{ label: string; description?: string; selection?: RunSelection; browse?: boolean }> = [
          {
            label: "Auto-detect active run",
            description: "Match current workspace or fallback to latest registered run",
            selection: { kind: "auto" },
          },
          ...runs.map((r) => ({
            label: r.runId ?? r.dataDir ?? "unnamed run",
            description: [r.workflow, r.phase, r.status].filter(Boolean).join(" · "),
            selection: r.runId
              ? ({
                  kind: "run_id",
                  runId: r.runId,
                  dataDir: r.dataDir ?? undefined,
                  workflow: r.workflow ?? undefined,
                } satisfies RunSelection)
              : ({ kind: "data_dir", dataDir: r.dataDir! } satisfies RunSelection),
          })),
        ];

        if (svc.hasLegacyWorkspaceSkills()) {
          items.push({
            label: "Workspace legacy (.github/skills)",
            description: "Inspect legacy workspace skill DBs over uaw-mcp/v1",
            selection: { kind: "legacy_workspace" },
          });
        }
        items.push({
          label: "Browse for UAW data directory...",
          browse: true,
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select the UAW run or data directory to inspect",
        });
        if (!picked) return;

        if (picked.browse) {
          const uri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: "Select UAW data directory",
          });
          if (!uri?.[0]) return;
          currentSelection = { kind: "data_dir", dataDir: uri[0].fsPath };
        } else if (picked.selection) {
          currentSelection = picked.selection;
        }
        svc.setSelection(currentSelection);
        refreshGlobalState();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to select UAW run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand("uwf.setRemoteToken", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage("Trust this workspace before managing remote MCP tokens.");
        return;
      }
      const rawUrl = readSettings().mcpServerUrl?.trim();
      if (!rawUrl) {
        void vscode.window.showWarningMessage(
          "Configure uwf.mcpServerUrl before setting a remote MCP bearer token.",
        );
        return;
      }
      let origin: string;
      let secretKey: string;
      try {
        const validated = validateRemoteUrl(rawUrl);
        origin = new URL(validated).origin;
        secretKey = secretKeyForRemoteUrl(rawUrl);
      } catch (err) {
        void vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      const token = await vscode.window.showInputBox({
        password: true,
        prompt: `Enter bearer token for ${origin} (submit blank to clear)`,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token.trim()) {
        await context.secrets.store(secretKey, token.trim());
        void vscode.window.showInformationMessage(`Saved UAW MCP bearer token for ${origin}.`);
      } else {
        await context.secrets.delete(secretKey);
        void vscode.window.showInformationMessage(`Cleared UAW MCP bearer token for ${origin}.`);
      }
      mcpProvider.notifyChanged();
      await reloadRuntime();
    }),
    vscode.commands.registerCommand("uwf.exportReport", async () => {
      const svc = requireService();
      if (!svc) return;
      const ws = getWorkspaceRoot();
      if (!ws) {
        void vscode.window.showWarningMessage("Open a workspace folder before exporting a UWF report.");
        return;
      }
      const format = await vscode.window.showQuickPick(["JSON", "CSV"], {
        placeHolder: "Select export format",
      });
      if (!format) return;
      try {
        await ReportBuilder.export(ws, svc, format.toLowerCase() as "json" | "csv");
        void vscode.window.showInformationMessage(`UWF report exported as ${format}.`);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to export UWF report: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand("uwf.refreshAll", () => {
      refreshGlobalState();
      void vscode.window.showInformationMessage("UWF: Refreshed.");
    }),
    {
      dispose: () => {
        void shutdown();
      },
    },
  );

  await reloadRuntime();
}

export function deactivate(): Promise<void> | undefined {
  return activeShutdown?.();
}
