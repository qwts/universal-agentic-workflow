import * as vscode from "vscode";
import { isQuestionRequired, UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, renderDynamicTable, statusBadge } from "./webviewUtils";

const managed = new ManagedWebviewPanel({
  registryId: "questions",
  viewType: "uwf.questions",
  title: "UWF: Questions",
  pageTitle: "UWF Questions",
  sectionTitle: "Questions Protocol",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getQuestions(target);
    const toolbar = `<div style="margin-bottom:10px;">
      <a class="btn" href="command:uwf.resolveQuestion">Resolve Pending Question</a>
    </div>`;
    if (!res.exists) return `${toolbar}<p class="empty">No questions store found for active run.</p>`;
    const rows = res.questions ?? [];
    const cols = deriveColumns(rows, [
      "id",
      "stage",
      "status",
      "required",
      "question",
      "proposed",
      "answer",
      "answered_at",
    ]);
    const table = renderDynamicTable(cols, rows, {
      status: (v) => statusBadge(String(v ?? "")),
      required: (v) => (isQuestionRequired(v) ? badge("required", "red") : badge("optional", "grey")),
    });
    return `${toolbar}${table}`;
  },
});

export class QuestionsPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
