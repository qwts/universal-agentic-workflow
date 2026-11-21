import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, escHtml } from "./webviewUtils";

const EXTRA_STYLE = `
<style>
.section { border:1px solid var(--vscode-panel-border,#444); border-radius:8px; padding:10px; margin-bottom:12px; }
.section-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.section-header h3 { margin:0; font-size:13px; }
.small { font-size:12px; opacity:.75; }
ul { margin:4px 0 0 16px; }
</style>
<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:10px;">
  <a class="btn" href="command:uwf.selectRun">Switch Run</a>
  <a class="btn" href="command:uwf.openWorkflowState">Workflow State</a>
  <a class="btn" href="command:uwf.openStages">Stages</a>
  <a class="btn" href="command:uwf.openIssues">Issues</a>
  <a class="btn" href="command:uwf.openQuestions">Questions</a>
  <a class="btn" href="command:uwf.openCost">Cost</a>
  <a class="btn" href="command:uwf.checkGates">Gates</a>
</div>`;

const managed = new ManagedWebviewPanel({
  registryId: "dashboard",
  viewType: "uwf.dashboard",
  title: "UWF: Workflow Dashboard",
  pageTitle: "UWF Dashboard",
  sectionTitle: "",
  renderBody: async (dataService, target) => {
    const insights = await dataService.collectInsights(target);

    const stageCountRows = Object.entries(insights.stageCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, count]) => `<li><code>${escHtml(k)}</code>: ${escHtml(count)}</li>`)
      .join("");

    const plannedArtifacts = insights.artifactInsights
      .slice(0, 40)
      .map((artifact) => {
        const icon = artifact.exists === null ? "🔷" : artifact.exists ? "✅" : "⬜";
        return `<li>${icon} <b>${escHtml(artifact.workflow)}</b> / ${escHtml(artifact.stage)} <span class="small">${escHtml(artifact.path)}</span></li>`;
      })
      .join("");

    const workflowCards = insights.workflows
      .map((wf) => {
        const stageSample = wf.stages
          .slice(0, 8)
          .map((s) => `<li>${escHtml(s.name)} <span class="small">${escHtml(s.resolved_agent ?? s.agent)}</span></li>`)
          .join("");
        return `<div class="section">
          <div class="section-header">
            <h3>${escHtml(wf.workflow)} <span class="small">(${escHtml(wf.stages.length)} stages)</span></h3>
            <a href="command:uwf.checkGates">Audit gates</a>
          </div>
          <ul>${stageSample || "<li>No stages declared.</li>"}</ul>
        </div>`;
      })
      .join("");

    const questionBadge =
      insights.pendingQuestions > 0
        ? ` &nbsp;${badge(`${insights.pendingQuestions} pending questions`, "yellow")}`
        : "";

    return `${EXTRA_STYLE}
      <div class="section">
        <div class="section-header"><h3>Live Workflow State</h3><a href="command:uwf.openWorkflowState">Open webview</a></div>
        <div>Active target: <code>${escHtml(insights.target.label)}</code></div>
        <div>Current workflow: <b>${escHtml(insights.currentWorkflow ?? "—")}</b></div>
        <div>Phase / status: <b>${escHtml(insights.currentPhase ?? "—")}</b> / <b>${escHtml(insights.currentStatus ?? "—")}</b>${questionBadge}</div>
        <div>Issues: <b>${escHtml(insights.openIssuesCount)}</b> open / active (${escHtml(insights.issuesCount)} total)</div>
      </div>
      <div class="section">
        <div class="section-header"><h3>Executed Stages</h3><a href="command:uwf.openStages">Open webview</a></div>
        <ul>${stageCountRows || "<li>No stage runs yet.</li>"}</ul>
      </div>
      <div class="section">
        <div class="section-header"><h3>Artifacts (declared + observed)</h3><a href="command:uwf.openStages">Open webview</a></div>
        <ul>${plannedArtifacts || "<li>No artifact declarations found via uaw_gates.</li>"}</ul>
      </div>
      ${workflowCards || '<p class="empty">No declarative stage archetypes available.</p>'}`;
  },
});

export class DashboardPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
