import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, escHtml, renderDynamicTable } from "./webviewUtils";

const managed = new ManagedWebviewPanel({
  registryId: "gates",
  viewType: "uwf.gates",
  title: "UWF: Gate Audit",
  pageTitle: "UWF Gate Audit",
  sectionTitle: "Declarative Gate Prescriptions",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getGatePrescriptions(undefined, target);
    if (!res.ok || !res.stages.length) {
      return `<p class="empty">${escHtml(res.error ?? "No stage gate prescriptions returned.")}</p>`;
    }

    const rows = res.stages.map((s) => ({
      stage: s.stage,
      gated: s.gated ? "yes" : "no",
      conditional: s.conditional ? "yes" : "no",
      on_gate_failure: s.on_gate_failure,
      max_retries: s.max_retries,
      checks: s.checks.map((c) => `${c.type}${c.label ? `(${c.label})` : ""}`).join(", ") || "(none)",
      prescriptions: s.checks.map((c) => c.prescription).filter(Boolean).join(" | ") || "-",
    }));

    return `<p style="margin-bottom:10px;">Workflow: <b>${escHtml(res.workflow)}</b> (${escHtml(res.stages.length)} stages)</p>` +
      renderDynamicTable(
        ["stage", "gated", "conditional", "on_gate_failure", "max_retries", "checks", "prescriptions"],
        rows,
        {
          gated: (v) => (v === "yes" ? badge("gated", "blue") : badge("ungated", "grey")),
        },
      );
  },
});

export class GatesPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
