import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, deriveColumns, escHtml, renderDynamicTable } from "./webviewUtils";

const SEVERITY_COLORS: Record<string, "red" | "yellow" | "blue" | "grey"> = {
  critical: "red",
  major: "yellow",
  high: "red",
  medium: "yellow",
  minor: "blue",
  low: "blue",
  info: "grey",
};

const VERDICT_COLORS: Record<string, "green" | "red" | "yellow"> = {
  pass: "green",
  approved: "green",
  fail: "red",
  changes_requested: "red",
  conditional: "yellow",
};

const managed = new ManagedWebviewPanel({
  registryId: "review",
  viewType: "uwf.review",
  title: "UWF: Review Findings",
  pageTitle: "UWF Review",
  sectionTitle: "Review Findings",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const res = await dataService.getReviews(target);
    if (!res.exists) return `<p class="empty">No review store found for active run.</p>`;
    const reviews = res.reviews ?? [];
    if (!reviews.length) return `<p class="empty">No reviews recorded yet.</p>`;

    const allFindings = res.findings ?? [];
    const sections = reviews
      .map((rv) => {
        const verdict = String(rv.verdict ?? "");
        const verdictBadge = badge(
          verdict,
          VERDICT_COLORS[verdict.toLowerCase()] ?? "grey",
        );
        const findings = allFindings.filter((f) => f.review_id === rv.id);
        const cols = deriveColumns(findings, [
          "id",
          "severity",
          "status",
          "file_path",
          "description",
        ]);
        const findingsTable = renderDynamicTable(cols, findings, {
          severity: (v) =>
            badge(String(v ?? ""), SEVERITY_COLORS[String(v).toLowerCase()] ?? "grey"),
        });
        return `<h3>Review #${escHtml(rv.id)} — ${escHtml(rv.role)} &nbsp;${verdictBadge}</h3>
          ${rv.notes ? `<p style="opacity:.8;">${escHtml(rv.notes)}</p>` : ""}
          ${findingsTable}`;
      })
      .join("<hr>");
    return sections;
  },
});

export class ReviewPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
