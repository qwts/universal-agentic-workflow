---
name: uwf-requirements
description: "Write and track the requirements pack: PRD + NFRs + acceptance criteria + risks."
---

# UWF Requirements Skill

## Overview

Requirements are stored in a SQLite database:

```
.github/skills/uwf-requirements/uwf-requirements.db
```

The schema is defined by `requirements-schema.yaml` in the same directory. Numbers are auto-assigned per type and role (e.g. `FR-001`, `NFR-002`, `AC-003`).

> **Note:** `uwf-requirements.db` is in `.gitignore` and must not be committed. The requirements markdown artifact in `tmp/workflow-artifacts/` is committed.

**All requirements operations MUST use the deterministic script:**
```
node .github/skills/uwf-requirements/requirements.mjs <command> [options]
```
Agents must never write to the database directly.

---

## Script reference

| Command | Purpose |
|---|---|
| `add --role <r> --title <text> [--type <t>] [--description <text>] [--priority <p>] [--source <text>] [--stage <s>]` | Add a requirement; returns `requirement_id` and auto-assigned `number` |
| `update --id <n> [field flags…]` | Update fields on an existing requirement |
| `get --id <n>` | Get a single requirement record |
| `list [--role <r>] [--type <t>] [--status <s>] [--priority <p>]` | List with optional filters |
| `accept --id <n>` | Mark requirement as `accepted` |
| `defer --id <n>` | Mark requirement as `deferred` |
| `reject --id <n>` | Mark requirement as `rejected` |

**Update field flags:** `--title`, `--type`, `--description`, `--priority`, `--status`, `--source`, `--stage`

**Valid types:**

| Type | Prefix | Description |
|---|---|---|
| `functional` | `FR` | What the system must do |
| `non_functional` | `NFR` | Performance, security, reliability, cost, operability |
| `data` | `DR` | Data shape, retention, classification |
| `acceptance_criteria` | `AC` | Testable pass/fail conditions |
| `risk` | `RK` | Risks and mitigations |

**Valid priorities (MoSCoW):** `must` · `should` · `could` · `wont`

**Valid statuses:** `draft` · `accepted` · `deferred` · `rejected`

All output is JSON. Exit code `0` = success, `1` = operational error, `2` = usage error.

### Example invocations

```sh
# Add a functional requirement
node .github/skills/uwf-requirements/requirements.mjs add \
  --role issues \
  --type functional \
  --title "User can create an issue from the CLI" \
  --description "The CLI must accept a title and description and persist the issue to SQLite" \
  --priority must \
  --source "intake section: Goal"

# Add an acceptance criterion
node .github/skills/uwf-requirements/requirements.mjs add \
  --role issues \
  --type acceptance_criteria \
  --title "Issue is queryable by status after creation" \
  --priority must

# Add a risk
node .github/skills/uwf-requirements/requirements.mjs add \
  --role issues \
  --type risk \
  --title "SQLite file corruption on concurrent writes" \
  --description "WAL mode mitigates but does not eliminate risk under high concurrency" \
  --priority should

# List all functional requirements
node .github/skills/uwf-requirements/requirements.mjs list --role issues --type functional

# Accept a requirement
node .github/skills/uwf-requirements/requirements.mjs accept --id 1
```

---

## Requirements procedure

1. **Read the intake** (`{outputPath}/{role}-intake.md`) and **discovery** (`{outputPath}/{role}-discovery.md`) artifacts.
2. **Add requirements** via `requirements.mjs add` as you derive them — one record per requirement. Use `--source` to cite the intake section or discovery `id` that motivated it.
3. **Write the output document** `{outputPath}/{role}-requirements.md` using the sections below, drawing content from the DB (`list --role {role}`).
4. **Accept** requirements that are well-defined and in scope via `requirements.mjs accept --id <n>`.
5. **Defer or reject** out-of-scope items via `defer` / `reject` rather than deleting them.

---

## Output document structure

`{outputPath}/{role}-requirements.md` must contain these sections, populated from the DB:

### Goal / Non-goals
- State the primary goal in one sentence.
- List explicit non-goals (things intentionally out of scope).

### Functional Requirements
Drawn from `list --type functional`. Format each as:
```
**FR-NNN** *(priority)* — <title>
<description>
Source: <source>
```

### Non-Functional Requirements
Drawn from `list --type non_functional`. Cover at minimum:
- Performance
- Security
- Reliability
- Cost
- Operability

### Data Requirements
Drawn from `list --type data`. Include data shape, retention policy, and classification where relevant.

### Acceptance Criteria
Drawn from `list --type acceptance_criteria`. Each criterion must be testable (pass/fail verifiable).

### Risks + Mitigations
Drawn from `list --type risk`. Format each as:
```
**RK-NNN** *(priority)* — <title>
Risk: <description>
Mitigation: <how it is addressed>
```

---

## Schema reference

### requirements

Defined by `requirements-schema.yaml`.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment row ID |
| `role` | TEXT | Workflow role artifact prefix (e.g. `issues`, `project`) |
| `number` | TEXT | Auto-assigned typed number (e.g. `FR-001`, `NFR-002`) |
| `type` | TEXT | `functional` · `non_functional` · `data` · `acceptance_criteria` · `risk` |
| `title` | TEXT | Short requirement title |
| `description` | TEXT | Full description |
| `priority` | TEXT | MoSCoW: `must` · `should` · `could` · `wont` |
| `status` | TEXT | `draft` · `accepted` · `deferred` · `rejected` |
| `source` | TEXT | Intake section or discovery `id` that motivated this requirement |
| `stage` | TEXT | Workflow stage this was captured in (optional) |
| `created_at` | TEXT | ISO-8601 timestamp |
| `updated_at` | TEXT | ISO-8601 timestamp |

---

## Error conditions

| Condition | Response |
|---|---|
| DB missing | Auto-created on first run via `requirements-schema.yaml` |
| `--type` not in allowed set | Reject with validation error |
| `--priority` not in allowed set | Reject with validation error |
| `--status` not in allowed set | Reject with validation error |
| Requirement `id` not found | Return not-found error |
| No update fields provided | Return usage error |
