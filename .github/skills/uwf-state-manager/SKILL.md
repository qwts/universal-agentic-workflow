---
name: uwf-state-manager
description: "Read, validate, and mutate workflow state in a SQLite database and the file-system state tree. Provides canonical procedures for phase transitions, agent hand-offs, artifact path resolution, and history recording."
---
# UWF State Manager Skill

## Overview

Workflow state is stored in a SQLite database:

```
.github/skills/uwf-state-manager/uwf-state.db
```

The database schema is defined by a YAML file in the same directory:

| File | Purpose |
|---|---|
| `workflow-schema.yaml` | Defines `workflow_state` and `workflow_history` tables |

On first run (or after `init`), the script reads the YAML file and creates all tables via `CREATE TABLE IF NOT EXISTS`.

> **Note:** `uwf-state.db` is in `.gitignore` and should not be committed.

> **Issue management** lives in `uwf-local-tracking` — see `issues.mjs` there.

## When to use
Invoke this skill whenever an agent needs to:
- Read the current workflow phase or status
- Advance or roll back a phase (`idea → intake → discovery → planning → execution → acceptance → snapshot → closed`)
- Record a hand-off between agents (`current_agent` field)
- Mark `ready_for_implementation` after both `{role}-intake.md` and `{role}-plan.md` are confirmed present
- Append an entry to the history log

**All state operations MUST be performed by running the deterministic script:**
```
node .github/skills/uwf-state-manager/state.mjs <command> [options]
```
Agents must never write to the database directly. Call the script via terminal and parse the JSON output it prints to stdout.

---

## Script reference

### Workflow commands

| Command | Purpose |
|---|---|
| `read` | Read current state |
| `init [--mode <mode>]` | Initialize fresh DB — clears all data and resets to `idea` |
| `advance --to <phase> --agent <id> [--note <text>] [--phases <a,b,c>] [--force]` | Advance to the next phase of the workflow (see below) |
| `rollback --to <phase> --agent <id> [--note <text>]` | Roll back to earlier phase |
| `set-agent --agent <id> [--force]` | Claim the agent token |
| `release-agent` | Release the agent token |
| `check-ready` | Verify prereqs and mark `ready_for_implementation` |
| `set-status --status <s> --agent <id>` | Set status (`idle`\|`active`\|`blocked`) |
| `set-model-profile --profile <p> [--model <model_name>]` | Store resolved model profile for the session |
| `sync` | Derive `status`/`phase` from `issues.mjs list` counts |
| `note --agent <id> --note <text>` | Append a history entry |

Global option: `--output-path <path>` (default `./tmp/workflow-artifacts`).

All output is JSON. Exit code `0` = success, `1` = operational error, `2` = usage error.

### Example invocations
```sh
# Read current state
node .github/skills/uwf-state-manager/state.mjs read

# Initialize a new workflow
node .github/skills/uwf-state-manager/state.mjs init --mode sw_dev

# Advance from intake → discovery
node .github/skills/uwf-state-manager/state.mjs advance --to discovery --agent uwf-stage-discovery --note "Intake complete"

# Claim / release the agent token
node .github/skills/uwf-state-manager/state.mjs set-agent --agent uwf-sw_dev-work-planner
node .github/skills/uwf-state-manager/state.mjs release-agent

# Mark ready for implementation
node .github/skills/uwf-state-manager/state.mjs check-ready

# Sync derived fields after state transitions
node .github/skills/uwf-state-manager/state.mjs sync

# Append a note
node .github/skills/uwf-state-manager/state.mjs note --agent uwf-core-orchestrator --note "Pausing for user review"
```

---

## Schema reference

### workflow_state (single row, id=1)

Defined by `workflow-schema.yaml`.

| Column | Type | Description |
|---|---|---|
| `phase` | TEXT | Current workflow phase |
| `mode` | TEXT | Workflow mode (e.g. `sw_dev`) |
| `status` | TEXT | `idle` \| `active` \| `blocked` |
| `current_agent` | TEXT | Agent presently holding the token |
| `artifact_path` | TEXT | Base path for per-stage docs |
| `ready_for_implementation` | INTEGER | `1` when gate conditions are met |
| `model_profile` | TEXT | Resolved model profile (`compact`\|`balanced`\|`reasoning`); set at startup |
| `model_name` | TEXT | Raw model name string passed at startup (optional) |

### workflow_history (append-only)

Defined by `workflow-schema.yaml`.

| Column | Type | Description |
|---|---|---|
| `ts` | TEXT | ISO-8601 timestamp |
| `from_phase` | TEXT | Phase before the transition |
| `to_phase` | TEXT | Phase after the transition |
| `agent` | TEXT | Agent that triggered the entry |
| `note` | TEXT | Free-text annotation |

### Phase lifecycle

```
idea → intake → discovery → planning → execution → acceptance → snapshot → closed
```

This is the canonical chain, used when `advance` gets no `--phases`. A workflow that does not visit every phase (the planning-only personas `project_manager` and `solutions_architect` have no `execution`) passes the phases it visits, in lifecycle order, as `--phases intake,discovery,planning,acceptance,snapshot,closed`; the legal next phase is then the first listed phase after the current one, so `planning → acceptance` is legal there but still rejected for `sw_dev`, whose sequence contains `execution`. The runner derives the list from the ordered `advances_phase_to` values of the workflow's `stages.yaml`. Moving backwards or skipping a phase inside the sequence is always rejected without `--force`; `rollback` is unaffected.

---

## Validation rules
- `phase` must be one of: `idea`, `intake`, `discovery`, `planning`, `execution`, `acceptance`, `snapshot`, `closed`.
- `status` must be one of: `idle`, `active`, `blocked`.
- `workflow_history` is append-only — never remove or mutate existing rows.
- Phase advances must follow the workflow's phase sequence (`--phases`, default: the canonical chain) unless `--force` is supplied.
- All writes are wrapped in SQLite transactions — no partial state.

---

## Error conditions and responses

| Condition | Response |
|---|---|
| DB missing | Auto-created on first run via `workflow-schema.yaml` |
| Unknown phase value | Reject with validation error; do not write |
| Token conflict (agent claim) | Return conflict error; do not overwrite |
| Illegal phase skip | Return lifecycle-order error; do not write |
| Artifact prereqs unmet for `ready_for_implementation` | Return missing-file list; do not set flag |

---

## Required output from skill invocations
The script prints structured JSON to stdout for every command. Agents must capture and relay the key fields to the orchestrator:
- `ok` — `true` for success, `false` for error
- `procedure` — command that ran
- `state.phase`, `state.status`, `state.current_agent`, `state.ready_for_implementation` — state snapshot after the operation
- `history_entry` — the new history entry appended (where applicable)
- `error` — error message (only present when `ok: false`)

## Data directory

Databases resolve in this order: `--db-path <file>`, then `--data-dir <dir>`, then the `UWF_DATA_DIR` environment variable, then the skill's own folder. The data directory is created if it does not exist.
