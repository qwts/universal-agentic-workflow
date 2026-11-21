import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, renderDynamicTable } from "./webviewUtils";

const STATUS_COLORS: Record<string, "green" | "yellow" | "red" | "grey"> = {
  passed: "green",
  completed: "green",
  active: "yellow",
  failed: "red",
  pending: "grey",
  skipped: "grey",
};

const managed = new ManagedWebviewPanel({
  registryId: "stages",
  viewType: "uwf.stages",
  title: "UWF: Stages",
  pageTitle: "UWF Stages",
  sectionTitle: "Workflow Stages",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getStages(undefined, target);
    if (!res.exists) return `<p class="empty">No stages store found for active run.</p>`;
    const rows = res.stage_runs ?? [];
    const cols = deriveColumns(rows, [
      "id",
      "workflow",
      "stage",
      "status",
      "retry_count",
      "started_at",
      "completed_at",
      "gate_result",
      "notes",
    ]);
    return renderDynamicTable(cols, rows, {
      status: (v) => badge(String(v ?? ""), STATUS_COLORS[String(v)] ?? "grey"),
    });
  },
});

export class StagesPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
