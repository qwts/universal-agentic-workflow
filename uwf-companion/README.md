# UWF Companion — VS Code Extension & Copilot Plugin Host

Live workflow visibility, question resolution, cost reporting, gate auditing, and formal VS Code AI plugin integration for [Universal Agentic Workflow (UAW)](../), backed exclusively by the `uaw-mcp/v1` Model Context Protocol runtime ([ADR-0008](../docs/adr/ADR-0008-multi-surface-mcp-plugin-runtime-contract.md), [ADR-0010](../docs/adr/ADR-0010-universal-runtime-packaging-and-plugin-distribution.md)).

## Architecture Highlights (Phase 2)

- **Zero direct SQLite reads in UI code:** All panels, Activity Bar tree items, status bar updates, and CSV/JSON exports query the canonical `uaw-mcp/v1` server (`uaw_read_*`, `uaw_gates`, `uaw_cost`, `uaw_question_resolve`), inheriting strict read-only `query_only` DB opens and secret redaction via `redactSecrets()`.
- **VS Code MCP Server Definition Provider:** Registers `uwf.uaw-mcp` via `vscode.lm.registerMcpServerDefinitionProvider`, exposing either the bundled self-contained `dist/uaw-plugin/runtime/bin/uaw-mcp.mjs` (`stdio`) or an authenticated remote HTTPS/loopback Streamable HTTP endpoint (`uwf.mcpServerUrl` + bearer token stored in VS Code `SecretStorage`).
- **Native VS Code AI Contribution Points:** Stages the cross-client plugin bundle at build time via `scripts/stage-bundle.mjs` (powered by `../scripts/pack-plugin.mjs`) into `dist/uaw-plugin/` and declares:
  - `contributes.mcpServerDefinitionProviders`
  - `contributes.chatAgents`
  - `contributes.chatSkills`
  - `contributes.chatPromptFiles`
  - `contributes.chatInstructions`

## Commands

| Command | Description |
|---|---|
| `UWF: Select Active Run / Data Directory` | Switch between registered `run_id`s, `.uaw-runs/*`, legacy `.github/skills/`, or a custom folder |
| `UWF: Open Workflow Dashboard` | Multi-panel workflow summary (state, issues, executed stages, `uaw_gates` artifacts) |
| `UWF: Open Workflow State` | Current workflow phase/status/agent/model profile and phase history timeline |
| `UWF: Open Stages` | Table of stage runs, retries, and gate verdicts |
| `UWF: Open Issues` | Backlog issues table |
| `UWF: Open Requirements` | Requirements viewer (FR/NFR/AC) |
| `UWF: Open ADRs` | Architecture Decision Records |
| `UWF: Open Discoveries` | Discovery findings and open gaps |
| `UWF: Open Review Findings` | Review verdicts and findings |
| `UWF: Open Questions` | Question protocol status table with resolution shortcut |
| `UWF: Resolve Pending Question` | Answer or skip exit-`3` pending questions via `uaw_question_resolve` |
| `UWF: Open Cost & Token Report` | Per-stage token usage, cost, and `!50K`/`!100K`/`!MISS` flags via `uaw_cost` |
| `UWF: Audit Stage Gates` | Declarative gate check prescriptions via `uaw_gates` |
| `UWF: Set Remote MCP Auth Token` | Store or clear the remote HTTP MCP bearer token in VS Code `SecretStorage` |
| `UWF: Export Report (CSV/JSON)` | Export MCP-redacted snapshot to `tmp/reports/` |
| `UWF: Refresh All` | Manually refresh Activity Bar tree, status bar, and open webviews |

## Settings

- `uwf.workflow` (default `"sw_dev"`): Default workflow name for gate audits and cost reporting.
- `uwf.dataDir`: Explicit UAW data directory override.
- `uwf.stateDir`: Optional host UAW state registry directory override (`UAW_STATE_DIR`).
- `uwf.mcpServerPath`: Optional custom `uaw-mcp` script path (defaults to bundled `dist/uaw-plugin/runtime/bin/uaw-mcp.mjs`).
- `uwf.mcpServerUrl`: Optional remote Streamable HTTP MCP URL (`https://` required except loopback hosts).
- `uwf.nodePath`: Optional Node.js >= 22.13.0 executable path for spawning `stdio` `uaw-mcp`.
- `uwf.allowedRoots`: Optional `--allowed-roots` list passed to the `stdio` `uaw-mcp` server.
- `uwf.refreshIntervalMs`: Optional polling interval (ms) for remote HTTP endpoints (`0` disables polling).

## Requirements

- VS Code 1.101+
- Node.js >= 22.13.0

## Building, Staging & Testing

```bash
# Install root runtime dependencies first (required by stage-bundle / pack-plugin)
npm ci --omit=dev

cd uwf-companion
npm ci
npm test               # typecheck + esbuild + stage:bundle + manifest check + real-module MCP tests
npm run package        # produces uwf-companion-0.1.0.vsix with bundled runtime + AI contributions
```
