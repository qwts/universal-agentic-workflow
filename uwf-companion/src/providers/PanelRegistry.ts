import * as vscode from "vscode";
import { ResolvedRunTarget, UawDataService } from "../services/UawDataService";
import { escHtml, pageShell, sectionHeader } from "./webviewUtils";

export const ALLOWED_WEBVIEW_COMMANDS: readonly string[] = [
  "uwf.openDashboard",
  "uwf.openWorkflowState",
  "uwf.openStages",
  "uwf.openIssues",
  "uwf.openRequirements",
  "uwf.openQuestions",
  "uwf.resolveQuestion",
  "uwf.openCost",
  "uwf.checkGates",
  "uwf.selectRun",
];

/** Collects open panel refresh callbacks so RuntimeWatcher and manual refresh can update them. */
export class PanelRegistry {
  private static callbacks: Map<
    string,
    (dataService: UawDataService, target?: ResolvedRunTarget) => Promise<void> | void
  > = new Map();

  static register(
    id: string,
    fn: (dataService: UawDataService, target?: ResolvedRunTarget) => Promise<void> | void,
  ): void {
    PanelRegistry.callbacks.set(id, fn);
  }

  static unregister(id: string): void {
    PanelRegistry.callbacks.delete(id);
  }

  static async refreshAll(dataService: UawDataService): Promise<void> {
    if (PanelRegistry.callbacks.size === 0) return;
    const sharedTarget = await dataService.resolveActiveTarget().catch(() => undefined);
    await Promise.all(
      [...PanelRegistry.callbacks.values()].map(async (fn) => {
        try {
          await fn(dataService, sharedTarget);
        } catch {
          /* panel may have closed */
        }
      }),
    );
  }
}

export interface ManagedPanelOptions {
  registryId: string;
  viewType: string;
  title: string;
  pageTitle: string;
  sectionTitle: string;
  openCommand?: string;
  renderBody: (dataService: UawDataService, target?: ResolvedRunTarget) => Promise<string>;
}

/** Shared singleton webview lifecycle with monotonic `renderSeq` async race protection. */
export class ManagedWebviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private renderSeq = 0;

  constructor(private readonly options: ManagedPanelOptions) {}

  show(context: vscode.ExtensionContext, dataService: UawDataService): void {
    if (this.panel) {
      this.panel.reveal();
      void this.refresh(dataService);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      this.options.viewType,
      this.options.title,
      vscode.ViewColumn.One,
      {
        enableScripts: false,
        enableCommandUris: ALLOWED_WEBVIEW_COMMANDS,
        retainContextWhenHidden: true,
      },
    );

    PanelRegistry.register(this.options.registryId, (ds, sharedTarget) =>
      this.refresh(ds, sharedTarget),
    );
    this.panel.onDidDispose(
      () => {
        PanelRegistry.unregister(this.options.registryId);
        this.panel = undefined;
      },
      null,
      context.subscriptions,
    );

    void this.refresh(dataService);
  }

  async refresh(dataService: UawDataService, target?: ResolvedRunTarget): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const seq = ++this.renderSeq;
    let body: string;
    try {
      body = await this.options.renderBody(dataService, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      body = `<p class="empty">Error: ${escHtml(message)}</p>`;
    }
    if (!this.panel || this.panel !== panel || seq !== this.renderSeq) {
      return;
    }
    const header = this.options.sectionTitle
      ? sectionHeader(this.options.sectionTitle, this.options.openCommand)
      : "";
    panel.webview.html = pageShell(this.options.pageTitle, `${header}${body}`);
  }
}
