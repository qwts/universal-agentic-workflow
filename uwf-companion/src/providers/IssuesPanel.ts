import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { deriveColumns, renderDynamicTable, statusBadge } from "./webviewUtils";

const managed = new ManagedWebviewPanel({
  registryId: "issues",
  viewType: "uwf.issues",
  title: "UWF: Issues",
  pageTitle: "UWF Issues",
  sectionTitle: "Issues Backlog",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getIssues(target);
    if (!res.exists) return `<p class="empty">No issues store found for active run.</p>`;
    const rows = res.issues ?? [];
    const cols = deriveColumns(rows, [
      "id",
      "title",
      "status",
      "phase",
      "milestone",
      "sprint",
      "depends_on",
      "assigned_agent",
    ]);
    return renderDynamicTable(cols, rows, {
      status: (v) => statusBadge(String(v ?? "")),
    });
  },
});

export class IssuesPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
