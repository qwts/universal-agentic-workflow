import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";

export class WorkflowTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    description?: string,
    command?: vscode.Command,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.command = command;
  }
}

export class WorkflowTreeProvider
  implements vscode.TreeDataProvider<WorkflowTreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData =
    new vscode.EventEmitter<WorkflowTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly getState: () => { dataService?: UawDataService; error?: string },
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: WorkflowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkflowTreeItem): Promise<WorkflowTreeItem[]> {
    if (element) return [];

    const { dataService, error } = this.getState();
    if (!dataService) {
      return [
        new WorkflowTreeItem(
          "UAW MCP Runtime Inactive",
          vscode.TreeItemCollapsibleState.None,
          error ?? "Not initialized",
        ),
      ];
    }

    const items: WorkflowTreeItem[] = [];
    try {
      const target = await dataService.resolveActiveTarget();
      items.push(
        new WorkflowTreeItem(
          "Active Run",
          vscode.TreeItemCollapsibleState.None,
          target.label,
          { command: "uwf.selectRun", title: "Select Active Run", arguments: [] },
        ),
      );

      const [stateRes, stagesRes, issuesRes, questionsRes, blueprints] = await Promise.all([
        dataService.getState(target).catch(() => null),
        dataService
          .getStages(target.kind === "run_id" ? target.workflow : undefined, target)
          .catch(() => null),
        dataService.getIssues(target).catch(() => null),
        dataService.getQuestions(target).catch(() => null),
        dataService.listWorkflowBlueprints().catch(() => []),
      ]);

      const stateDesc =
        stateRes?.exists && stateRes.state
          ? `${stateRes.state.phase} · ${stateRes.state.status}`
          : "not initialized";
      items.push(
        new WorkflowTreeItem(
          "Workflow State",
          vscode.TreeItemCollapsibleState.None,
          stateDesc,
          { command: "uwf.openWorkflowState", title: "Open Workflow State", arguments: [] },
        ),
      );

      items.push(
        new WorkflowTreeItem(
          `Archetypes (${blueprints.length})`,
          vscode.TreeItemCollapsibleState.None,
          blueprints.slice(0, 2).map((w) => w.workflow).join(", ") || "none",
          { command: "uwf.openDashboard", title: "Open Workflow Dashboard", arguments: [] },
        ),
      );

      const plannedArtifacts = blueprints.reduce(
        (acc, wf) => acc + wf.stages.reduce((inner, s) => inner + (s.outputs?.length ?? 0), 0),
        0,
      );
      items.push(
        new WorkflowTreeItem(
          `Artifacts (${plannedArtifacts})`,
          vscode.TreeItemCollapsibleState.None,
          "via uaw_gates",
          { command: "uwf.openDashboard", title: "Open Workflow Dashboard", arguments: [] },
        ),
      );

      if (stagesRes?.exists) {
        const stages = stagesRes.stage_runs ?? [];
        const activeCount = stages.filter((s) => s.status === "active").length;
        items.push(
          new WorkflowTreeItem(
            `Stages (${stages.length})`,
            vscode.TreeItemCollapsibleState.None,
            `${activeCount} active`,
            { command: "uwf.openStages", title: "Open Stages", arguments: [] },
          ),
        );
      }

      if (issuesRes?.exists) {
        const all = issuesRes.issues ?? [];
        const counts = { open: 0, active: 0, closed: 0 };
        for (const i of all) {
          const st = String(i.status ?? "");
          if (st === "open" || st === "active" || st === "closed") counts[st]++;
        }
        const parts = [
          counts.active ? `${counts.active} active` : "",
          counts.open ? `${counts.open} open` : "",
          counts.closed ? `${counts.closed} closed` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        items.push(
          new WorkflowTreeItem(
            `Issues (${all.length})`,
            vscode.TreeItemCollapsibleState.None,
            parts || "empty",
            { command: "uwf.openIssues", title: "Open Issues", arguments: [] },
          ),
        );
      }

      if (questionsRes?.exists) {
        const allQ = questionsRes.questions ?? [];
        const pendingQ = allQ.filter((q) => q.status === "pending").length;
        items.push(
          new WorkflowTreeItem(
            `Questions (${allQ.length})`,
            vscode.TreeItemCollapsibleState.None,
            pendingQ ? `${pendingQ} pending` : "all resolved",
            { command: "uwf.openQuestions", title: "Open Questions", arguments: [] },
          ),
        );
      }

      items.push(
        new WorkflowTreeItem(
          "Workflow Dashboard",
          vscode.TreeItemCollapsibleState.None,
          "MCP runtime insights",
          { command: "uwf.openDashboard", title: "Open Workflow Dashboard", arguments: [] },
        ),
        new WorkflowTreeItem("Requirements", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.openRequirements",
          title: "Open Requirements",
          arguments: [],
        }),
        new WorkflowTreeItem("ADRs", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.openAdrs",
          title: "Open ADRs",
          arguments: [],
        }),
        new WorkflowTreeItem("Discoveries", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.openDiscoveries",
          title: "Open Discoveries",
          arguments: [],
        }),
        new WorkflowTreeItem("Review Findings", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.openReview",
          title: "Open Review",
          arguments: [],
        }),
        new WorkflowTreeItem("Cost & Tokens", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.openCost",
          title: "Open Cost & Token Report",
          arguments: [],
        }),
        new WorkflowTreeItem("Gate Audit", vscode.TreeItemCollapsibleState.None, undefined, {
          command: "uwf.checkGates",
          title: "Audit Stage Gates",
          arguments: [],
        }),
      );
    } catch (err) {
      items.push(
        new WorkflowTreeItem(
          "MCP Unavailable",
          vscode.TreeItemCollapsibleState.None,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }

    return items;
  }
}
