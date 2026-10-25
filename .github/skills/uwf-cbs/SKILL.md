---
name: uwf-cbs
description: "Blueprint stage skill: synthesize First-phase outputs into the Canonical Build Spec (uwf-cbs) SQLite database and initialize the Build Record (uwf-br)."
---

# UWF CBS Skill — Blueprint Stage

Final stage of Phase 1 (after `test-planner`, before Phase 2). It synthesizes the First-phase outputs into the **Canonical Build Spec (uwf-cbs)**, the machine-readable build model that Phase 2 planners use (components, communication, dependencies, build order), and initializes the append-only **Build Record (uwf-br)** with strata 0-4.

## Inputs and outputs

Read only these (a missing file is noted at the top of `{role}-blueprint.md` and the stage continues, except where Error handling says abort):

- `{output_path}/{role}-intake.md`, `{output_path}/{role}-discovery.md`, `{output_path}/{role}-requirements.md`
- `docs/adr/ADR-*.md`
- `{output_path}/{role}-risk-plan.md`, `{output_path}/{role}-security-plan.md`, `{output_path}/{role}-test-plan.md` (if produced)

| Output | Path | Committed |
|---|---|---|
| Blueprint summary (Markdown) | `{output_path}/{role}-blueprint.md` | yes |
| Canonical Build Spec (SQLite) | `.github/skills/uwf-cbs/uwf-cbs.db` | no (gitignored) |
| Build Record (JSON) | `{output_path}/{role}-br.json` | yes |

## uwf-cbs schema

Database `.github/skills/uwf-cbs/uwf-cbs.db`; create it if missing and apply exactly. If it exists from a prior run, drop and recreate all five tables (idempotent).

```sql
CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                       -- unique; {domain}.{component}
  type TEXT NOT NULL CHECK(type IN ('service','library','module','database','cli','external','interface','other')),
  description TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in-progress','done','deferred')),
  source_story_ids TEXT,                    -- comma-separated, e.g. US-0001,US-0003
  source_adr_ids TEXT,                      -- comma-separated, e.g. ADR-0001,ADR-0002
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS interfaces (     -- how components communicate
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('rest','grpc','graphql','event','shared-db','cli','file','other')),
  provider_component_id INTEGER NOT NULL REFERENCES components(id),   -- exposes it
  consumer_component_id INTEGER NOT NULL REFERENCES components(id),   -- calls/listens
  contract TEXT,                            -- description or ADR/spec reference
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','defined','deprecated')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS dependencies (   -- no cycles; record a cycle as a 'dependency-conflict' constraint
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id),
  depends_on_component_id INTEGER NOT NULL REFERENCES components(id),
  dependency_type TEXT NOT NULL CHECK(dependency_type IN ('build-time','run-time','test-time')),
  rationale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS sequencing (     -- ordered construction plan
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_number INTEGER NOT NULL UNIQUE,      -- global, 1-based, build order
  component_id INTEGER NOT NULL REFERENCES components(id),
  phase TEXT NOT NULL CHECK(phase IN ('foundation','core','integration','verification','release')),
  notes TEXT,
  estimated_effort TEXT,                    -- free text: '2 days', 'S', '1 sprint'
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS constraints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('security','compliance','nfr','performance','accessibility','dependency-conflict','other')),
  description TEXT NOT NULL,
  source TEXT,                              -- introducing artifact, e.g. ADR-0001, security-plan §3.2
  applies_to_component_ids TEXT,            -- comma-separated; NULL/empty = all components
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigated','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
```

## uwf-br format

`{output_path}/{role}-br.json`:

```json
{"version": "1.0", "created_at": "<ISO 8601>", "role": "<role prefix, e.g. issues>",
 "strata": {
   "0": {"label": "Context", "description": "Project identity, goals, scope, and stakeholders.", "entries": []},
   "1": {"label": "Decisions and Risk Register", "description": "Architectural decisions, technology choices, rationale, and project-level risk register entries (schedule, dependency, technical-debt, external).", "entries": []},
   "2": {"label": "Dependencies", "description": "External libraries, services, and internal component dependencies.", "entries": []},
   "3": {"label": "Actions", "description": "Ordered implementation steps, tasks, and their outcomes.", "entries": []},
   "4": {"label": "Verification", "description": "Test results, acceptance criteria outcomes, and quality gate logs.", "entries": []}}}
```

Entry schema: `{"id": "<stratum>-<n>", "source": "<artifact or stage>", "summary": "<one sentence>", "detail": "<text or structured content>", "recorded_at": "<ISO 8601>"}`.

| Stratum | Populate from |
|---|---|
| 0 | `{role}-intake.md`: goal, non-goals, key constraints, stakeholders, risk tolerance |
| 1 | `docs/adr/ADR-*.md`: one entry per ADR (decision and rationale); then, if `{role}-risk-plan.md` exists, one entry per risk row with `"source": "risk-planner"` |
| 2 | discovery + requirements: one entry per external dependency or integration; then one more per risk with `category: dependency` and `blocking: true` (`"source": "risk-planner"`) |
| 3 | `sequencing` table: one entry per row, in `step_number` order |
| 4 | `{role}-test-plan.md`: one entry per test ID or scenario |

## Steps (in order)

1. **Read the inputs.**
2. **Components.** From requirements and discovery, one `components` row per distinct component, service, module, database or external integration. Set `source_story_ids` and `source_adr_ids`.
3. **Interfaces.** One row per inter-component boundary in requirements or ADRs, using the IDs from step 2.
4. **Dependencies.** One row per pair where one must exist before the other can be built or run. On a cycle, add a `constraints` row (`type = 'dependency-conflict'`, `severity = 'high'`) describing it.
5. **Build sequence.** Topologically sort the graph; assign `step_number` in dependency order and `phase`: no dependencies = `foundation`; only foundation dependencies = `core`; several core dependencies = `integration`; test harnesses = `verification`; packaging/deployment = `release`. One `sequencing` row per component.
6. **Constraints.** From the security plan (if present): `type = 'security'` or `'compliance'`. From requirements NFRs: `'nfr'`, `'performance'` or `'accessibility'`. Set `applies_to_component_ids`.
7. **Build Record.** Create `{role}-br.json` and fill strata 0-4 per the table above.
8. **Write `{output_path}/{role}-blueprint.md`** with these eight sections: **Component Inventory** (id, name, type, status, source_story_ids), **Interface Contracts** (id, name, type, provider, consumer, status), **Dependency Graph** (`component → depends on → component (type)` triples), **Build Sequence** (step_number, component, phase, estimated_effort), **Constraint Registry** (id, name, type, severity, status, source), **Build Record Summary** (entry count per stratum 0-4), **Missing Inputs** (absent files), **Completeness Check** (results of the exit criteria).
9. **Run the exit criteria** and record each result in **Completeness Check**.

## Exit criteria (each pass/fail)

1. `components` has at least 1 row.
2. Every component ID appears in `sequencing.component_id`.
3. No cycles in `dependencies`, or every cycle is recorded as a `dependency-conflict` constraint.
4. Every `constraints` row has a non-null `source`.
5. `{role}-br.json` exists and each stratum has at least 1 entry, or its source artifact was absent (listed in **Missing Inputs**), in which case zero entries is `pass — not applicable`.
6. `{role}-blueprint.md` exists, is non-empty, and has all eight sections from step 8.
7. **Completeness Check** lists the result of checks 1-6.

A failure caused only by a conditionally absent upstream artifact (e.g. no security plan for a non-security-sensitive change) is recorded as `pass — not applicable`; do not block on it.

## Error handling

- `{role}-intake.md` missing: abort and record the error (needed for stratum 0).
- `{role}-requirements.md` missing: abort and record the error (needed for components).
- Any other input missing (discovery, ADRs, security plan, risk plan, test plan): continue, list it under **Missing Inputs**; the dependent rows or strata stay empty (no security constraints, no risk entries in strata 1/2, no stratum 4 entries).
- Circular dependency: do not abort; record the `dependency-conflict` constraint and continue.
