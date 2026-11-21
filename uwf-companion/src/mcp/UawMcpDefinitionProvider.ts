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

  provideMcpServerDefinitions(
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
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
      return [
        new vscode.McpHttpServerDefinition(
          "UAW MCP Runtime (Remote)",
          vscode.Uri.parse(config.url),
          {},
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
      const secretKey = secretKeyForRemoteUrl(server.uri.toString(true));
      const authToken = (await this.context.secrets.get(secretKey))?.trim();
      if (authToken) {
        server.headers = {
          ...server.headers,
          Authorization: `Bearer ${authToken}`,
        };
      }
    }
    return server;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
