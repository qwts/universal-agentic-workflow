---
name: uwf-cbs
description: "Blueprint stage skill: synthesize First-phase outputs into the Canonical Build Spec (uwf-cbs) SQLite database and initialize the Build Record (uwf-br)."
---

# UWF CBS Skill — Blueprint Stage

Last stage of Phase 1. Builds the **Canonical Build Spec (uwf-cbs)** (components, interfaces, dependencies, build order, constraints) for Phase 2 planners and initializes the **Build Record (uwf-br)** strata 0-4.

## Inputs and outputs

Read only: `{output_path}/{role}-intake.md`, `-discovery.md`, `-requirements.md`; `docs/adr/ADR-*.md`; `{role}-risk-plan.md`, `-security-plan.md`, `-test-plan.md` (if produced). A missing file is listed under **Missing Inputs** and the stage continues, except where Error handling says abort.

Outputs: `{output_path}/{role}-blueprint.md` (committed), `.github/skills/uwf-cbs/uwf-cbs.db` (gitignored), `{output_path}/{role}-br.json` (committed).

## uwf-cbs schema

Apply exactly to `.github/skills/uwf-cbs/uwf-cbs.db`; if it exists, drop and recreate all five tables.

```sql
CREATE TABLE components (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, -- unique; {domain}.{component}
  type TEXT NOT NULL CHECK(type IN ('service','library','module','database','cli','external','interface','other')),
  description TEXT NOT NULL, owner TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in-progress','done','deferred')),
  source_story_ids TEXT, source_adr_ids TEXT, -- comma-separated, e.g. US-0001,US-0003 / ADR-0001
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE interfaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('rest','grpc','graphql','event','shared-db','cli','file','other')),
  provider_component_id INTEGER NOT NULL REFERENCES components(id), consumer_component_id INTEGER NOT NULL REFERENCES components(id),
  contract TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','defined','deprecated')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, -- no cycles
  component_id INTEGER NOT NULL REFERENCES components(id), depends_on_component_id INTEGER NOT NULL REFERENCES components(id),
  dependency_type TEXT NOT NULL CHECK(dependency_type IN ('build-time','run-time','test-time')), rationale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE sequencing (id INTEGER PRIMARY KEY AUTOINCREMENT, step_number INTEGER NOT NULL UNIQUE, -- global, 1-based
  component_id INTEGER NOT NULL REFERENCES components(id),
  phase TEXT NOT NULL CHECK(phase IN ('foundation','core','integration','verification','release')),
  notes TEXT, estimated_effort TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('security','compliance','nfr','performance','accessibility','dependency-conflict','other')),
  description TEXT NOT NULL, source TEXT, -- e.g. ADR-0001, security-plan §3.2
  applies_to_component_ids TEXT, -- comma-separated; NULL/empty = all
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigated','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
```

## uwf-br format

`{output_path}/{role}-br.json`:

```json
{"version": "1.0", "created_at": "<ISO 8601>", "role": "<role prefix>",
 "strata": {
   "0": {"label": "Context", "description": "Project identity, goals, scope, and stakeholders.", "entries": []},
   "1": {"label": "Decisions and Risk Register", "description": "Architectural decisions, technology choices, rationale, and project-level risk register entries (schedule, dependency, technical-debt, external).", "entries": []},
   "2": {"label": "Dependencies", "description": "External libraries, services, and internal component dependencies.", "entries": []},
   "3": {"label": "Actions", "description": "Ordered implementation steps, tasks, and their outcomes.", "entries": []},
   "4": {"label": "Verification", "description": "Test results, acceptance criteria outcomes, and quality gate logs.", "entries": []}}}
```

Entry: `{"id": "<stratum>-<n>", "source": "<artifact or stage>", "summary": "<one sentence>", "detail": "<text>", "recorded_at": "<ISO 8601>"}`.

| Stratum | Populate from |
|---|---|
| 0 | intake: goal, non-goals, key constraints, stakeholders, risk tolerance |
| 1 | one entry per ADR (decision, rationale); then one per risk-plan row (`"source": "risk-planner"`) |
| 2 | one per external dependency/integration (discovery, requirements); then one per risk with `category: dependency` and `blocking: true` (`"source": "risk-planner"`) |
| 3 | one per `sequencing` row, in `step_number` order |
| 4 | one per test ID or scenario in the test plan |

## Steps

1. Read the inputs once.
2. **Components**: one row per distinct component, service, module, database or external integration; set `source_story_ids`, `source_adr_ids`.
3. **Interfaces**: one row per inter-component boundary in requirements or ADRs.
4. **Dependencies**: one row per must-exist-first pair. On a cycle add a `constraints` row (`type='dependency-conflict'`, `severity='high'`).
5. **Build sequence**: topological sort; `step_number` in dependency order; `phase`: no dependencies = `foundation`; only foundation dependencies = `core`; several core dependencies = `integration`; test harnesses = `verification`; packaging/deployment = `release`. One row per component.
6. **Constraints**: from the security plan `security`/`compliance`; from requirements NFRs `nfr`/`performance`/`accessibility`; set `applies_to_component_ids`.
7. **Build Record**: create `{role}-br.json`, fill strata 0-4.
8. **Write `{role}-blueprint.md`** with eight sections: **Component Inventory** (id, name, type, status, source_story_ids), **Interface Contracts** (id, name, type, provider, consumer, status), **Dependency Graph** (`component → depends on → component (type)`), **Build Sequence** (step_number, component, phase, estimated_effort), **Constraint Registry** (id, name, type, severity, status, source), **Build Record Summary** (entries per stratum), **Missing Inputs**, **Completeness Check**.
9. Run the exit criteria and record each result in **Completeness Check**.

## Exit criteria (each pass/fail)

1. `components` has at least 1 row.
2. Every component ID appears in `sequencing.component_id`.
3. No cycles in `dependencies`, or each is recorded as a `dependency-conflict` constraint.
4. Every `constraints` row has a non-null `source`.
5. `{role}-br.json` exists and each stratum has at least 1 entry, or its source artifact was absent (in **Missing Inputs**): then zero entries is `pass — not applicable`.
6. `{role}-blueprint.md` exists, is non-empty, and has all eight sections.
7. **Completeness Check** lists checks 1-6.

## Error handling

- `{role}-intake.md` or `{role}-requirements.md` missing: abort and record the error.
- Any other input missing: continue, list under **Missing Inputs**; dependent rows/strata stay empty.
