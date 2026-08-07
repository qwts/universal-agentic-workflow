# UWF Companion — VS Code Extension

Live data from [Universal Agent Workflow](../) SQLite skill databases, surfaced directly inside VS Code.

## Features

| Command | Description |
|---|---|
| `UWF: Open Workflow Dashboard` | Multi-panel workflow insight view (state, stages, planned artifacts, issues, requirements, discoveries) with per-section interactive drill-down buttons |
| `UWF: Open Workflow State` | Current workflow phase/status/agent and phase history timeline |
| `UWF: Open Stages` | Webview table of all workflow stages and their status |
| `UWF: Open Issues` | Webview table of all issues with milestone/sprint/status |
| `UWF: Open Requirements` | Requirements viewer (FR/NFR/AC) |
| `UWF: Open ADRs` | Architecture Decision Records |
| `UWF: Open Discoveries` | Discovery findings and open gaps |
| `UWF: Open Review Findings` | Quality/security review results |
| `UWF: Export Report (CSV/JSON)` | Export a snapshot of all databases to `tmp/reports/` |
| `UWF: Refresh All` | Manually refresh the sidebar tree and panels |

The Activity Bar sidebar ("UWF Companion") shows live workflow state, archetype count, planned artifact count, open issues, and active stages. The dashboard provides a multi-panel summary with each section having an **Open interactive view ↗** action for deeper inspection. All panels auto-refresh within **300 ms** of any database write.

### Declarative configuration

The dashboard reads workflow archetype/stage/artifact expectations from declarative stage configs (`stages.yaml`) under `.github/skills/...`.

## Requirements

- VS Code 1.101+
- A workspace with `.github/skills/` containing UWF skill databases
- Node.js 22.13+ (for building and testing from source)

The minimum runtime ensures that the extension and its tests can use the
unflagged `node:sqlite` API. Standalone UWF skill scripts outside this directory
continue to support Node.js 20+.

## Building from Source

```bash
cd uwf-companion
npm ci
npm test               # builds and runs the complete Node test suite
npm run package        # produces uwf-companion-0.1.0.vsix
```

## Running in Development

1. Open `uwf-companion/` in VS Code (or the parent workspace).
2. Press **F5** — a new Extension Development Host window opens.
3. Open any UWF workspace; the extension activates automatically when `.github/skills/` is detected.

## Packaging a VSIX

```bash
npm run package        # produces uwf-companion-0.1.0.vsix
```

Install the VSIX:

```bash
code --install-extension uwf-companion-0.1.0.vsix
```

## Architecture

```
src/
  extension.ts                 — activation, command & watcher wiring, status bar state
  config/
    StageConfigLoader.ts       — declarative stage/archetype + expected artifact parser
  watchers/DbWatcher.ts        — fs.watch on each skill dir, 300ms debounce
  providers/
    WorkflowTreeProvider.ts    — Activity Bar sidebar (live state + counts + archetypes)
    DashboardPanel.ts          — Webview: primary multi-panel workflow dashboard
    WorkflowInsights.ts        — live DB + declarative config aggregation
    WorkflowStatePanel.ts      — Webview: workflow state and phase history
    WorkflowDashboardPanel.ts  — Alternative dashboard with interactive per-section drill-down
    WorkflowSectionPanel.ts    — Interactive drill-down webview opened per dashboard section
    StagesPanel.ts             — Webview: stage status table
    IssuesPanel.ts             — Webview: issues backlog table
    RequirementsPanel.ts       — Webview: requirements
    ReviewPanel.ts             — Webview: review findings
    AdrPanel.ts                — Webview: ADRs
    DiscoveryPanel.ts          — Webview: discoveries
    PanelRegistry.ts           — Broadcasts DB-change events to all open panels
    webviewUtils.ts            — HTML escaping, badge helpers, page shell
  reporter/
    ReportBuilder.ts           — CSV/JSON export of all DB snapshots
    InterviewerBridge.ts       — Future: launch uwf-interviewer agent
  services/
    WorkflowInsightsService.ts  — Aggregates DB + declarative stages.yaml insights
  db/readers/
    BaseReader.ts              — Read-only node:sqlite wrapper base class
    IssuesReader.ts            — uwf-issues.db
    AdrReader.ts               — uwf-adrs.db
    DiscoveryReader.ts         — uwf-discoveries.db
    RequirementsReader.ts      — uwf-requirements.db
    ReviewReader.ts            — uwf-reviews.db
    QuestionsReader.ts         — uwf-questions.db
    StageReader.ts             — uwf-stages.db
    WorkflowStateReader.ts     — uwf-state.db
```

**Security note:** All webview content is HTML-escaped via `webviewUtils.escHtml`. The extension never writes to any database; all mutations must go through the skill CLI scripts (`*.mjs`).

## Running Tests

```bash
npm test
```

Tests use Node's built-in `node:test` runner with `node:sqlite` directly — no VS Code host required, and include declarative stage-config integrity checks against staged workflow data.
