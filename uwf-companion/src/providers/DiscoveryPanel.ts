import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, renderDynamicTable } from "./webviewUtils";

const IMPACT_COLORS: Record<string, "red" | "yellow" | "grey"> = {
  high: "red",
  medium: "yellow",
  low: "grey",
};

const managed = new ManagedWebviewPanel({
  registryId: "discoveries",
  viewType: "uwf.discoveries",
  title: "UWF: Discoveries",
  pageTitle: "UWF Discoveries",
  sectionTitle: "Discovery Findings",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getDiscoveries(target);
    if (!res.exists) return `<p class="empty">No discoveries store found for active run.</p>`;
    const rows = res.discoveries ?? [];
    const cols = deriveColumns(rows, [
      "id",
      "role",
      "stage",
      "category",
      "title",
      "impact",
      "status",
    ]);
    return renderDynamicTable(cols, rows, {
      impact: (v) => badge(String(v ?? ""), IMPACT_COLORS[String(v).toLowerCase()] ?? "grey"),
    });
  },
});

export class DiscoveryPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
