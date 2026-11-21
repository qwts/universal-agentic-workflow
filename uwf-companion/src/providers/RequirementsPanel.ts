import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, renderDynamicTable } from "./webviewUtils";

const PRIORITY_COLORS: Record<string, "red" | "yellow" | "blue" | "grey"> = {
  must: "red",
  should: "yellow",
  could: "blue",
  wont: "grey",
};

const managed = new ManagedWebviewPanel({
  registryId: "requirements",
  viewType: "uwf.requirements",
  title: "UWF: Requirements",
  pageTitle: "UWF Requirements",
  sectionTitle: "Requirements",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getRequirements(target);
    if (!res.exists) return `<p class="empty">No requirements store found for active run.</p>`;
    const rows = res.requirements ?? [];
    const cols = deriveColumns(rows, [
      "id",
      "type",
      "number",
      "title",
      "priority",
      "status",
      "role",
      "stage",
    ]);
    return renderDynamicTable(cols, rows, {
      priority: (v) => badge(String(v ?? ""), PRIORITY_COLORS[String(v).toLowerCase()] ?? "grey"),
    });
  },
});

export class RequirementsPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
