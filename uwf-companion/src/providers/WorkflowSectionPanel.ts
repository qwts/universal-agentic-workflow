import * as vscode from "vscode";
import { ResolvedRunTarget, UawDataService } from "../services/UawDataService";
import { ALLOWED_WEBVIEW_COMMANDS, PanelRegistry } from "./PanelRegistry";
import { deriveColumns, escHtml, pageShell, renderDynamicTable } from "./webviewUtils";

const SECTION_TITLES: Record<string, string> = {
  "workflow-state": "Workflow State",
  stages: "Stages",
  artifacts: "Artifacts",
  issues: "Issues",
  requirements: "Requirements",
  discoveries: "Discoveries",
  adrs: "ADRs",
  review: "Review Findings",
  questions: "Questions",
};

export class WorkflowSectionPanel {
  static show(dataService: UawDataService, sectionId: string): void {
    const title = SECTION_TITLES[sectionId] ?? sectionId;
    const panel = vscode.window.createWebviewPanel(
      `uwf.section.${sectionId}`,
      `UWF: ${title} (Interactive)`,
      vscode.ViewColumn.Active,
      {
        enableScripts: false,
        enableCommandUris: ALLOWED_WEBVIEW_COMMANDS,
        retainContextWhenHidden: true,
      },
    );

    let renderSeq = 0;
    let disposed = false;

    const refresh = async (ds: UawDataService, sharedTarget?: ResolvedRunTarget) => {
      const seq = ++renderSeq;
      let body: string;
      try {
        const target = sharedTarget ?? (await ds.resolveActiveTarget());
        if (sectionId === "artifacts") {
          const insights = await ds.collectInsights(target);
          const items = insights.artifactInsights
            .map((a) => {
              const icon = a.exists === null ? "🔷" : a.exists ? "✅" : "⬜";
              return `<li>${icon} <b>${escHtml(a.workflow)}</b> / ${escHtml(a.stage)}: <code>${escHtml(a.path)}</code></li>`;
            })
            .join("");
          body = `<h2>Planned Artifacts</h2>${items ? `<ul>${items}</ul>` : '<p class="empty">No records available.</p>'}`;
        } else if (sectionId === "workflow-state") {
          const st = await ds.getState(target);
          body = `<h2>Workflow State</h2><pre>${escHtml(JSON.stringify(st, null, 2))}</pre>`;
        } else {
          let rows: Array<Record<string, unknown>> = [];
          if (sectionId === "stages") rows = (await ds.getStages(undefined, target)).stage_runs;
          else if (sectionId === "issues") rows = (await ds.getIssues(target)).issues;
          else if (sectionId === "requirements") rows = (await ds.getRequirements(target)).requirements;
          else if (sectionId === "discoveries") rows = (await ds.getDiscoveries(target)).discoveries;
          else if (sectionId === "adrs") rows = (await ds.getAdrs(target)).adrs;
          else if (sectionId === "review") rows = (await ds.getReviews(target)).findings;
          else if (sectionId === "questions") rows = (await ds.getQuestions(target)).questions;

          const cols = deriveColumns(rows);
          body = rows.length
            ? `<h2>${escHtml(title)}</h2>${renderDynamicTable(cols, rows)}`
            : `<h2>${escHtml(title)}</h2><p class="empty">No records available.</p>`;
        }
      } catch (err) {
        body = `<p class="empty">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</p>`;
      }

      if (disposed || seq !== renderSeq) return;
      panel.webview.html = pageShell(`UWF ${title}`, body);
    };

    const registryKey = `section.${sectionId}.${Date.now()}`;
    PanelRegistry.register(registryKey, (ds, sharedTarget) => refresh(ds, sharedTarget));
    panel.onDidDispose(() => {
      disposed = true;
      PanelRegistry.unregister(registryKey);
    });

    void refresh(dataService);
  }
}
