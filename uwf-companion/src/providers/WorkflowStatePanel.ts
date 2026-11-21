import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, escHtml, renderDynamicTable } from "./webviewUtils";

const STATUS_COLORS: Record<string, "green" | "yellow" | "red" | "grey"> = {
  idle: "grey",
  running: "yellow",
  complete: "green",
  completed: "green",
  closed: "green",
  error: "red",
  paused: "grey",
  questions: "yellow",
};

const PHASE_COLORS: Record<string, "green" | "yellow" | "blue" | "grey"> = {
  idea: "grey",
  intake: "blue",
  discovery: "blue",
  requirements: "blue",
  planning: "blue",
  execution: "yellow",
  implementation: "yellow",
  review: "yellow",
  acceptance: "green",
  snapshot: "green",
  complete: "green",
  done: "green",
  closed: "green",
};

const STATE_CARD_STYLE = `
  <style>
    .state-card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 12px; margin-bottom: 8px; }
    .state-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
    .label { min-width: 140px; opacity: .7; font-size: 12px; }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; opacity: .85; }
    h2 { margin: 16px 0 8px; font-size: 14px; }
    h2:first-child { margin-top: 0; }
  </style>
`;

const managed = new ManagedWebviewPanel({
  registryId: "workflowState",
  viewType: "uwf.workflowState",
  title: "UWF: Workflow State",
  pageTitle: "UWF Workflow State",
  sectionTitle: "Current State",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getState(target);
    if (!res.exists) {
      return `<p class="empty">No workflow state found for active run.</p>`;
    }
    const state = res.state;
    const stateBlock = state
      ? `<div class="state-card">
          ${res.run_id ? `<div class="state-row"><span class="label">Run ID</span><code>${escHtml(res.run_id)}</code></div>` : ""}
          <div class="state-row"><span class="label">Phase</span>${badge(state.phase, PHASE_COLORS[state.phase?.toLowerCase()] ?? "grey")}</div>
          <div class="state-row"><span class="label">Status</span>${badge(state.status, STATUS_COLORS[state.status?.toLowerCase()] ?? "grey")}</div>
          <div class="state-row"><span class="label">Mode</span>${escHtml(state.mode ?? "—")}</div>
          <div class="state-row"><span class="label">Current agent</span>${escHtml(state.current_agent ?? "—")}</div>
          <div class="state-row"><span class="label">Artifact path</span><code>${escHtml(state.artifact_path ?? "—")}</code></div>
          <div class="state-row"><span class="label">Model profile</span>${escHtml(state.model_profile ?? "—")}${state.model_name ? ` (${escHtml(state.model_name)})` : ""}</div>
          <div class="state-row"><span class="label">Ready for impl.</span>${state.ready_for_implementation ? badge("yes", "green") : badge("no", "grey")}</div>
        </div>`
      : `<p class="empty">No workflow state recorded yet.</p>`;

    const history = [...(state?.history ?? [])].slice(-50).reverse();
    const historyCols = deriveColumns(history as Array<Record<string, unknown>>, [
      "id",
      "ts",
      "from_phase",
      "to_phase",
      "agent",
      "note",
    ]);
    const historyTable = renderDynamicTable(historyCols, history, {
      to_phase: (v) => badge(String(v ?? ""), PHASE_COLORS[String(v).toLowerCase()] ?? "grey"),
    });

    return `${STATE_CARD_STYLE}
      ${stateBlock}
      <h2>Phase History <span style="font-weight:400;font-size:12px;opacity:.6;">(last 50)</span></h2>
      ${history.length ? historyTable : '<p class="empty">No history yet.</p>'}`;
  },
});

export class WorkflowStatePanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
