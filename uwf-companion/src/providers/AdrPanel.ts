import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, renderDynamicTable } from "./webviewUtils";

const STATUS_COLORS: Record<string, "green" | "yellow" | "red" | "grey"> = {
  accepted: "green",
  proposed: "yellow",
  rejected: "red",
  superseded: "grey",
  deprecated: "grey",
};

const managed = new ManagedWebviewPanel({
  registryId: "adrs",
  viewType: "uwf.adrs",
  title: "UWF: ADRs",
  pageTitle: "UWF ADRs",
  sectionTitle: "Architecture Decision Records",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getAdrs(target);
    if (!res.exists) return `<p class="empty">No ADR store found for active run.</p>`;
    const rows = res.adrs ?? [];
    const cols = deriveColumns(rows, [
      "number",
      "slug",
      "title",
      "status",
      "impact",
      "stage",
      "file_path",
    ]);
    return renderDynamicTable(cols, rows, {
      status: (v) => badge(String(v ?? ""), STATUS_COLORS[String(v).toLowerCase()] ?? "grey"),
    });
  },
});

export class AdrPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
