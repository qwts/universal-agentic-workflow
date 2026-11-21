import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import { ManagedWebviewPanel } from "./PanelRegistry";
import { badge, escHtml, renderDynamicTable } from "./webviewUtils";

const managed = new ManagedWebviewPanel({
  registryId: "cost",
  viewType: "uwf.cost",
  title: "UWF: Cost & Token Report",
  pageTitle: "UWF Cost Report",
  sectionTitle: "Cost & Token Usage",
  openCommand: "uwf.openDashboard",
  renderBody: async (dataService, target) => {
    const cost = await dataService.getCost(undefined, target);
    if (!cost || !cost.stages.length) {
      return `<p class="empty">No transcript usage data found for active run.</p>`;
    }

    const fmtUsd = (v: unknown) =>
      Number.isFinite(Number(v)) ? `$${Number(v).toFixed(3)}` : String(v ?? "-");

    const rows = cost.stages.map((s) => ({
      stage: s.stage,
      turns: s.turns,
      ctx_per_turn: s.ctx_per_turn,
      last_turn: s.last_turn,
      cache_read: s.cache_read,
      cache_write: s.cache_write,
      output: s.output,
      thinking: s.thinking,
      cost_usd: fmtUsd(s.cost_usd),
      flags: s.flags.join(" ") || "-",
    }));

    const cols = [
      "stage",
      "turns",
      "ctx_per_turn",
      "last_turn",
      "cache_read",
      "cache_write",
      "output",
      "thinking",
      "cost_usd",
      "flags",
    ];
    const table = renderDynamicTable(cols, rows, {
      flags: (v) => {
        const text = String(v ?? "-");
        return text !== "-" ? badge(text, "red") : escHtml("-");
      },
    });

    const t = cost.totals;
    const summary = `<p style="margin-bottom:10px;">
      Totals: <b>${escHtml(t.turns)}</b> turns · <b>${escHtml(t.ctx_per_turn)}</b> ctx/turn ·
      <b>${escHtml(t.output)}</b> output · <b>${escHtml(fmtUsd(t.cost_usd))}</b> total cost
      ${cost.flags.length ? ` &nbsp;${badge(cost.flags.join(" "), "red")}` : ""}
    </p>`;

    return `${summary}${table}${cost.report ? `<h3>CLI Report</h3><pre>${escHtml(cost.report)}</pre>` : ""}`;
  },
});

export class CostPanel {
  static show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    managed.show(context, dataService);
  }

  static refresh(dataService: UawDataService): Promise<void> {
    return managed.refresh(dataService);
  }
}
