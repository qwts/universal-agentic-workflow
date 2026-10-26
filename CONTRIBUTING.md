# Contributing to Universal Agentic Workflow (UWF)

Thank you for your interest in contributing. This guide covers everything you need to add new workflow personas, agents, skills, and tracking backends — as well as the development utilities that make iteration easier.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Repository Overview](#repository-overview)
- [Development Setup](#development-setup)
- [How to Add a New Workflow Persona](#how-to-add-a-new-workflow-persona)
- [How to Add a New Stage Agent](#how-to-add-a-new-stage-agent)
- [How to Add a New Skill](#how-to-add-a-new-skill)
- [How to Add a New Tracking Backend](#how-to-add-a-new-tracking-backend)
- [Script Reference](#script-reference)
- [Pull Request Guidelines](#pull-request-guidelines)

---

## Prerequisites

- **Node.js 20+** — required for the runner, the bench harness, the skill scripts and the
  repository smoke suite (CI runs Node 20)
- **A harness CLI** — `claude` (Claude Code) or `codex`, logged in. Only live runs need it;
  the tests use the offline `fake` adapter and never call a model
- **VS Code with GitHub Copilot** — optional. Only the Copilot chat adapter needs it; custom
  agents / subagents must be enabled in settings (currently experimental)
- **Node.js 22.13+** and **VS Code 1.101+** — required for the UWF Companion;
  its database readers use the unflagged `node:sqlite` API available in the
  VS Code extension host from this release line
- Familiarity with the UWF phase model described in [`docs/uwf-architecture.md`](docs/uwf-architecture.md)

---

## Repository Overview

```
.github/
├── agents/          # Stage agents — uwf-stage-*, uwf-core-*, uwf-{persona}-*
├── skills/          # Behavior modules — each has SKILL.md + Node.js scripts + SQLite DB
├── prompts/         # Copilot entry prompts
└── instructions/    # Always-on workspace rules
docs/                # ADRs, research, product docs, architecture spec, artifact schemas
scripts/
├── uwf-runner/      # Deterministic runner (runner.mjs), adapters, cost report, tests
├── uwf-bench/       # Benchmark matrix harness, tests
├── uwf-smoke/       # Repository smoke tests (CI)
└── scaffold-skill.mjs
uwf-companion/       # VS Code extension — live UWF dashboard
```

The **runner** (`scripts/uwf-runner/runner.mjs`) is the primary runtime (see [ADR-0007](docs/adr/ADR-0007-runtime-owns-the-loop.md)). It owns the stage loop, gates and retries, and reads each persona's authoritative stage list from `.github/skills/uwf-{name}/stages.yaml`; persona behavior is declared in `.github/skills/uwf-{name}/SKILL.md`. The **Copilot orchestrator** (`uwf-core-orchestrator`) is a secondary runtime for chat surfaces and uses the same files.

---

## Development Setup

Most skills are self-contained Node.js packages. Install dependencies for every skill that ships a `package.json` (the same set CI installs):

```bash
for d in .github/skills/uwf-*/; do [ -f "$d/package.json" ] && (cd "$d" && npm ci); done
```

### Running the tests

These are the exact loops CI runs (`.github/workflows/ci.yml`). They run offline: the runner tests use the `fake` adapter and the bench tests never call a live model. Run them from the repository root after installing dependencies.

```bash
set -euo pipefail
for test_file in scripts/uwf-smoke/*.mjs; do
  node "$test_file"
done
for test_file in scripts/uwf-runner/test/*.test.mjs; do
  node "$test_file"
done
for test_file in scripts/uwf-bench/test/*.test.mjs; do
  node "$test_file"
done
```

The adapter contract tests skip the live `claude` and `codex` checks unless `UWF_TEST_LIVE=1` is set and the CLI is on `PATH`. Leave `UWF_TEST_LIVE` unset for routine work. Do not run live tests unless you intend to spend model budget.

The VS Code extension has its own setup:

```bash
cd uwf-companion
npm ci
npm test
npm run package
```

### Resetting state between test runs

Use `reset-all.mjs` to wipe all skill SQLite databases back to a clean state:

```bash
# Clear all *.db files under .github/skills/
node .github/skills/reset-all.mjs

# Also delete tmp/workflow-artifacts/
node .github/skills/reset-all.mjs --artifacts
```

See [Script Reference — reset-all.mjs](#reset-allmjs) for full details.

---

## How to Add a New Workflow Persona

A **persona** defines a complete workflow: which stages run, in what order, and what gates must pass between stages. Examples: `sw_dev`, `project_manager`, `solutions_architect`.

### Step 1 — Scaffold the skill directory

Use the scaffolder to generate a skeleton:

```bash
node scripts/scaffold-skill.mjs --name <your-persona-name> --stages "stage1,stage2,stage3"
```

This creates:
- `.github/skills/uwf-<name>/SKILL.md` — persona spec template
- `.github/skills/uwf-<name>/stages.yaml` — stage and gate definitions (generated with stubs)
- `.github/skills/uwf-<name>/run.mjs` — thin gate-enforcement shim (copy of the generic shim)

> **Alternatively**, copy an existing persona directory (e.g. `uwf-sw_dev/`) and rename files and workflow IDs.

### Step 2 — Fill in `stages.yaml`

`stages.yaml` is the **authoritative stage list**. The orchestrator reads it via `run.mjs`; the SKILL.md stage table is documentation only and may be stale.

```yaml
workflow: <name>           # Must match the directory name: uwf-<name>
artifact_prefix: <prefix>  # e.g. "issues", "project", "design"
output_path: ./tmp/workflow-artifacts

stages:
  - name: intake
    agent: uwf-<name>-intake
    max_retries: 2
    on_gate_failure: retry   # retry | abort | skip
    retry_mode: resume       # resume (default) | fresh: reuse or restart the adapter session on retry
    max_turns: 20            # positive integer, per-attempt turn cap (default 20; implementation 30)
    run_as_subagent: true
    advances_phase_to: intake
    inputs: []
    outputs:
      - "{{output_path}}/<prefix>-intake.md"
    gated: true
    gate:
      checks:
        - type: require_non_empty
          path: "{{output_path}}/<prefix>-intake.md"
          label: "<prefix>-intake.md"
```

**Gate check types:**

| Type | Required fields | Passes when |
|---|---|---|
| `require_non_empty` | `path` | File exists and is non-empty |
| `require_contains` | `path`, `text` or `heading` | File contains the given string; `heading: "## Title"` instead matches a heading line with an optional number prefix (`## 1. Title`) |
| `require_files_with_prefix` | `dir`, `prefix` | At least one file in `dir` starts with `prefix` |
| `require_file_matching_pattern` | `dir`, `pattern` | At least one file in `dir` matches the regex |
| `run_script` | `cmd` | Script exits 0 |

**Conditional stages** auto-pass when the condition evaluates to false:

```yaml
    conditional: true
    condition:
      type: file_contains        # file_contains | file_contains_any
      path: "{{output_path}}/<prefix>-requirements.md"
      text: "ADR:"
```

**Template variables** available in any `path` or `dir` value:

| Variable | Resolves to |
|---|---|
| `{{output_path}}` | `--output-path` CLI flag value (default `./tmp/workflow-artifacts`) |
| `{{cwd}}` | `process.cwd()` at runtime |

### Step 3 — Write the `SKILL.md`

Fill in the scaffolded `SKILL.md`. The required sections are:

| Section | Content |
|---|---|
| Persona Configuration | `workflow`, `role`, artifact prefix, output path |
| Subagent Roster | Every agent this persona invokes |
| Stage Sequence | Ordered table mirroring `stages.yaml` (documentation only) |
| Gate Enforcement | Reference to `run.mjs` commands |
| Persona-Specific Operating Rules | Any rules beyond the engine defaults |

### Step 4 — Create stage agent files

For each stage, create `.github/agents/uwf-<name>-<stage>.agent.md`:

```markdown
---
name: uwf-<name>-<stage>
description: "One-line description."
tools:
  - read
  - edit
  - execute
---

# UWF <Name> — <Stage> Stage

## Role
<What this agent does>

## Inputs
- `{output_path}/<prefix>-intake.md`

## Outputs
- `{output_path}/<prefix>-<stage>.md`

## Behavior
1. Read all input artifacts.
2. ...
3. Write the output artifact.

## Current Stage/Phase
<stage-name>

## Recommended Next Stage/Phase
<next-stage-name>
```

> **Important:** Subagents must end their response with `Current Stage/Phase` / `Recommended Next Stage/Phase` blocks. The orchestrator never emits these — only subagents do.

### Step 5 — Register agents in the orchestrator (Copilot only)

The runner needs no registration: it reads `stages.yaml` and the stage's `agent:` field. Only the Copilot orchestrator needs this step. Add every new agent name to the `agents:` frontmatter list in `.github/agents/uwf-core-orchestrator.agent.md`. If an agent is not listed there, the orchestrator cannot invoke it.

```yaml
agents:
  - uwf-<name>-intake
  - uwf-<name>-<next-stage>
  # ... all other existing agents
```

### Step 6 — Test

```bash
# Verify the stage list is readable
node .github/skills/uwf-<name>/run.mjs --list-stages

# Check a specific gate (before running the workflow)
node .github/skills/uwf-<name>/run.mjs --check-gate intake
```

Then bootstrap the orchestrator:

```
@uwf-core-orchestrator workflow=<name>
```

---

## How to Add a New Stage Agent

A **stage agent** is a scoped agent profile that performs one stage of a workflow. Core agents (`uwf-core-*`) are shared across all personas; persona-specific agents are used by one persona only.

1. Create `.github/agents/uwf-{role}-{job}.agent.md` following the template in the previous section.
2. If the agent will be used by an existing persona, add the stage to that persona's `stages.yaml` and update its `SKILL.md` subagent roster.
3. Add the agent name to `uwf-core-orchestrator.agent.md` `agents:` list.

**Agent naming convention:**
- Canonical stage agents: `uwf-stage-<stage>` (e.g. `uwf-stage-intake`, `uwf-stage-discovery`) — for stages migrated to the `stage_type` capability architecture
- Infrastructure / core agents: `uwf-core-<job>` (e.g. `uwf-core-requirements`) — reserved for cross-cutting infrastructure
- Legacy workflow-specific stage agents: `uwf-<persona>-<job>` — for stages not yet migrated to canonical `stage_type`

---

## How to Add a New Skill

A **skill** encapsulates a discrete behavior — usually a SQLite-backed data store with a CLI interface. Skills are invoked by agents via terminal commands; agents must never write to a skill database directly.

### Minimal skill structure

```
.github/skills/uwf-<name>/
├── SKILL.md              # Agent-readable behavior spec
├── <name>.mjs            # CLI script (the primary interface)
├── <name>-schema.yaml    # SQLite schema definition
├── package.json          # "type": "module", lists better-sqlite3 dependency
└── package-lock.json
```

### CLI script conventions

Every skill script must:
- Accept `--help` or print usage on error
- Exit `0` on success, `1` on operational error, `2` on usage error
- Output JSON to stdout
- Never write to any database except its own

Look at existing scripts for reference: `uwf-adr/adrs.mjs`, `uwf-local-tracking/issues.mjs`, `uwf-requirements/requirements.mjs`.

### Registering the skill

- Reference the skill from your agent's instructions: `Load the uwf-<name> skill from `.github/skills/uwf-<name>/SKILL.md`.
- If the skill backs an existing core agent (e.g. a new ADR implementation), update the agent's instructions to load the new skill name instead.

---

## How to Add a New Tracking Backend

The default tracking backend (`uwf-local-tracking`) uses a local SQLite database operated via `issues.mjs`. To use a different backend (e.g. GitHub Issues, Linear, Jira):

1. Create a new skill directory, e.g. `.github/skills/uwf-github-tracking/`.
2. Implement an `issues.mjs` CLI with the same command interface as `uwf-local-tracking/issues.mjs`:

   | Command | Description |
   |---|---|
   | `create --id <id> --title <text> [options]` | Create a new issue |
   | `update --id <id> [field flags]` | Update fields on an existing issue |
   | `list [--status <s>] [--milestone <m>] [--sprint <s>]` | List issues |
   | `close --id <id>` | Set issue status to `closed` |
   | `activate --id <id>` | Set issue status to `active` |
   | `skip --id <id> [--reason <text>]` | Set issue status to `skipped` |
   | `next [--milestone <m>] [--sprint <s>]` | Find next eligible open issue |

3. Write a `SKILL.md` describing the backend and any required environment variables or tokens.
4. Update `uwf-core-project-tracking`'s instructions to reference your new skill instead of `uwf-local-tracking`.

No other agent files need to change.

---

## Script Reference

### `reset-all.mjs`

**Location:** `.github/skills/reset-all.mjs`

Wipes all UWF skill SQLite databases back to a clean state. Use this before starting a fresh workflow run or when databases have become corrupted or out-of-sync.

```bash
# Clear all *.db files under .github/skills/ (DBs recreate themselves on next use)
node .github/skills/reset-all.mjs

# Also delete tmp/workflow-artifacts/ (removes all generated stage outputs)
node .github/skills/reset-all.mjs --artifacts
```

**What gets deleted:**
- All `*.db` files found recursively under `.github/skills/` (excluding `node_modules`)
- `tmp/workflow-artifacts/` — only when `--artifacts` flag is passed

**What is preserved:**
- All `*.mjs`, `*.yaml`, `*.json`, and `*.md` files — skill scripts and schema are never deleted
- `tmp/uwf-state.json` — workflow phase state is **not** reset by this script; use `node .github/skills/uwf-state-manager/state.mjs init` to reset state separately

**Output:** JSON summary of deleted paths and already-absent paths.

> **When to use:**
> - Before a clean demo or test run
> - After a failed or interrupted workflow run left DBs in an inconsistent state
> - When switching between unrelated projects in the same workspace

### `scaffold-skill.mjs`

**Location:** `scripts/scaffold-skill.mjs`

Generates a new persona skill skeleton. See [How to Add a New Workflow Persona](#how-to-add-a-new-workflow-persona) for the full walkthrough.

```bash
node scripts/scaffold-skill.mjs --name <skill-name> --stages "stage1,stage2,stage3"
```

**Produces:**
- `.github/skills/uwf-<name>/run.mjs` — gate enforcement shim with TODO stubs
- `.github/skills/uwf-<name>/SKILL.md` — minimal persona skill doc template

### `stage-tracker.mjs` (internal)

**Location:** `.github/skills/uwf-orchestration-engine/stage-tracker.mjs`

Central stage management CLI used by all `run.mjs` shims. Called indirectly via `node .github/skills/uwf-{workflow}/run.mjs`; agents do not call it directly.

```bash
# List all stages for a workflow
node .github/skills/uwf-sw_dev/run.mjs --list-stages

# Check a specific gate
node .github/skills/uwf-sw_dev/run.mjs --check-gate intake
```

### Skill CLIs (quick reference)

Each skill's primary script follows the same pattern — run with no arguments or `--help` to see full usage.

| Script | Database | Purpose |
|---|---|---|
| `.github/skills/uwf-adr/adrs.mjs` | `uwf-adrs.db` | Architecture Decision Records |
| `.github/skills/uwf-discovery/discoveries.mjs` | `uwf-discoveries.db` | Workspace discovery findings |
| `.github/skills/uwf-local-tracking/issues.mjs` | `uwf-issues.db` | Issue backlog and state |
| `.github/skills/uwf-question-protocol/questions.mjs` | `uwf-questions.db` | Orchestrator Q&A protocol |
| `.github/skills/uwf-requirements/requirements.mjs` | `uwf-requirements.db` | FR / NFR / AC requirements |
| `.github/skills/uwf-review/reviews.mjs` | `uwf-reviews.db` | Review runs and findings |
| `.github/skills/uwf-state-manager/state.mjs` | `uwf-state.db` | Workflow phase and agent token |
| `.github/skills/uwf-orchestration-engine/stage-tracker.mjs` | `uwf-stages.db` | Stage execution and gate history |

---

## Pull Request Guidelines

1. **One concern per PR.** A PR that adds a new persona should not also refactor an existing skill.
2. **Update SKILL.md and stages.yaml together.** If you change a stage name or gate condition, update both files.
3. **Add your new agents to `uwf-core-orchestrator.agent.md`** if the Copilot path must run them. Forgetting this makes the Copilot orchestrator silently unable to invoke unlisted agents; the runner is unaffected.
4. **Run the stage list check** before opening a PR:
   ```bash
   node .github/skills/uwf-<your-workflow>/run.mjs --list-stages
   ```
5. **Test with a real workflow run** in an Extension Development Host (press **F5** from the workspace). Verify the orchestrator reaches every stage and all gates pass.
6. **Keep agent descriptions honest.** If a stage is marked as conditional in `stages.yaml`, document that in the agent file's description.
