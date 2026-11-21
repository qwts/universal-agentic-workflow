import * as vscode from "vscode";
import {
  CompanionSettings,
  resolveServerConfig,
  secretKeyForRemoteUrl,
} from "./McpServerConfig";

export class UawMcpDefinitionProvider
  implements vscode.McpServerDefinitionProvider<vscode.McpServerDefinition>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly getSettings: () => CompanionSettings,
    private readonly version: string,
  ) {}

  notifyChanged(): void {
    this._onDidChange.fire();
  }

  private async loadAuthHeaders(url: string): Promise<Record<string, string>> {
    const secretKey = secretKeyForRemoteUrl(url);
    const authToken = (await this.context.secrets.get(secretKey))?.trim();
    return authToken ? { Authorization: `Bearer ${authToken}` } : {};
  }

  async provideMcpServerDefinitions(
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition[]> {
    if (!vscode.workspace.isTrusted) {
      return [];
    }

    let config;
    try {
      config = resolveServerConfig({
        extensionPath: this.context.extensionPath,
        workspaceRoot: this.getWorkspaceRoot(),
        settings: this.getSettings(),
        allowMonorepoFallback: this.context.extensionMode === vscode.ExtensionMode.Development,
      });
    } catch {
      return [];
    }

    if (config.transport === "http") {
      // Publish auth headers eagerly so background Copilot forwarding stays authenticated
      // even when VS Code skips resolveMcpServerDefinition.
      const headers = await this.loadAuthHeaders(config.url);
      return [
        new vscode.McpHttpServerDefinition(
          "UAW MCP Runtime (Remote)",
          vscode.Uri.parse(config.url),
          headers,
          this.version,
        ),
      ];
    }

    const def = new vscode.McpStdioServerDefinition(
      "UAW MCP Runtime",
      config.command,
      config.args,
      config.env,
      this.version,
    );
    def.cwd = vscode.Uri.file(config.cwd);
    return [def];
  }

  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition | undefined> {
    if (!vscode.workspace.isTrusted) {
      return undefined;
    }
    if (server instanceof vscode.McpHttpServerDefinition) {
      const authHeaders = await this.loadAuthHeaders(server.uri.toString(true));
      const nextHeaders = { ...server.headers };
      if (authHeaders.Authorization) {
        nextHeaders.Authorization = authHeaders.Authorization;
      } else {
        delete nextHeaders.Authorization;
      }
      server.headers = nextHeaders;
    }
    return server;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
