---
name: uwf-cbs
description: "Blueprint stage skill: synthesize First-phase outputs into the Canonical Build Spec (uwf-cbs) SQLite database and initialize the Build Record (uwf-br)."
---

# UWF CBS Skill — Blueprint Stage

## Role and Purpose

The blueprint stage is the final stage of Phase 1. It runs after `test-planner` and before handoff to Phase 2. Its purpose is to synthesize all prior First-phase outputs — discovery findings, requirements, ADRs, security constraints, and test scope — into a single structured artifact: the **Canonical Build Spec (uwf-cbs)**.

`uwf-cbs` is the handoff artifact from Phase 1 to Phase 2. It provides a machine-readable build model so that Phase 2 agents (PM timeline planner, Dev work planner) know exactly what components exist, how they communicate, what depends on what, and in what order they must be built.

This stage also initializes the **Build Record (uwf-br)** — an append-only layered execution log — with strata 0–4.

---

## Inputs

Read all of the following artifacts before producing any output. If a file does not exist, record the gap in the blueprint summary and continue with available data.

| File (role prefix varies by persona) | Content |
|---|---|
| `{output_path}/{role}-intake.md` | Project or issue scope, goals, constraints |
| `{output_path}/{role}-discovery.md` | Codebase findings, existing components, unknowns |
| `{output_path}/{role}-requirements.md` | Functional requirements, NFRs, acceptance criteria |
| `docs/adr/ADR-*.md` | Architectural decisions and their rationale |
| `{output_path}/{role}-risk-plan.md` | Risk register with schedule, dependency, technical-debt, and external risks (if produced) |
| `{output_path}/{role}-security-plan.md` | Threat model, security constraints, controls (if produced) |
| `{output_path}/{role}-test-plan.md` | Test strategy, coverage targets, test scope |

---

## Outputs

| Artifact | Path | Format | Committed |
|---|---|---|---|
| Blueprint summary | `{output_path}/{role}-blueprint.md` | Markdown | Yes |
| Canonical Build Spec | `.github/skills/uwf-cbs/uwf-cbs.db` | SQLite | No (gitignored) |
| Build Record | `{output_path}/{role}-br.json` | JSON | Yes |

---

## uwf-cbs SQLite Schema

The database is located at `.github/skills/uwf-cbs/uwf-cbs.db`. Create it if it does not exist. Apply this schema exactly.

### Table: `components`

Every discrete piece of the system — services, libraries, modules, databases, CLI tools, external integrations.

```sql
CREATE TABLE IF NOT EXISTS components (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  type               TEXT    NOT NULL CHECK(type IN (
                       'service', 'library', 'module', 'database',
                       'cli', 'external', 'interface', 'other')),
  description        TEXT    NOT NULL,
  owner              TEXT,
  status             TEXT    NOT NULL DEFAULT 'planned'
                             CHECK(status IN ('planned','in-progress','done','deferred')),
  source_story_ids   TEXT,
  source_adr_ids     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Field constraints:**
- `name`: unique per database; use `{domain}.{component}` dot notation for disambiguation
- `type`: must be one of the enum values above
- `source_story_ids`: comma-separated story IDs (e.g., `US-0001,US-0003`)
- `source_adr_ids`: comma-separated ADR numbers (e.g., `ADR-0001,ADR-0002`)

**Example row:**
```json
{
  "id": 1,
  "name": "api.auth-service",
  "type": "service",
  "description": "Handles user authentication and token issuance via JWT.",
  "owner": "backend-team",
  "status": "planned",
  "source_story_ids": "US-0001,US-0002",
  "source_adr_ids": "ADR-0001",
  "created_at": "2025-01-01T00:00:00"
}
```

---

### Table: `interfaces`

How components communicate — every API boundary, event contract, shared database, or CLI protocol.

```sql
CREATE TABLE IF NOT EXISTS interfaces (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  type                   TEXT    NOT NULL CHECK(type IN (
                           'rest', 'grpc', 'graphql', 'event',
                           'shared-db', 'cli', 'file', 'other')),
  provider_component_id  INTEGER NOT NULL REFERENCES components(id),
  consumer_component_id  INTEGER NOT NULL REFERENCES components(id),
  contract               TEXT,
  status                 TEXT    NOT NULL DEFAULT 'draft'
                                 CHECK(status IN ('draft','defined','deprecated')),
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Field constraints:**
- `provider_component_id`: the component that exposes the interface
- `consumer_component_id`: the component that calls or listens to the interface
- `contract`: human-readable description or reference to an ADR or spec document

**Example row:**
```json
{
  "id": 1,
  "name": "api.auth-service → api.user-service (JWT validation)",
  "type": "rest",
  "provider_component_id": 1,
  "consumer_component_id": 2,
  "contract": "POST /auth/validate — returns { valid: bool, userId: string }. See ADR-0001.",
  "status": "draft",
  "created_at": "2025-01-01T00:00:00"
}
```

---

### Table: `dependencies`

What must exist before something else can be built — build-time, run-time, or test-time dependencies.

```sql
CREATE TABLE IF NOT EXISTS dependencies (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id             INTEGER NOT NULL REFERENCES components(id),
  depends_on_component_id  INTEGER NOT NULL REFERENCES components(id),
  dependency_type          TEXT    NOT NULL CHECK(dependency_type IN (
                             'build-time', 'run-time', 'test-time')),
  rationale                TEXT,
  created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Field constraints:**
- No circular dependencies are permitted. If a circular dependency is detected, record it as a constraint with `type = 'dependency-conflict'` and flag it for resolution.
- `rationale`: explain why the dependency exists (e.g., "auth-service must be deployed before user-service can validate tokens")

**Example row:**
```json
{
  "id": 1,
  "component_id": 2,
  "depends_on_component_id": 1,
  "dependency_type": "run-time",
  "rationale": "user-service calls auth-service to validate JWT tokens on every request.",
  "created_at": "2025-01-01T00:00:00"
}
```

---

### Table: `sequencing`

The ordered construction plan — what gets built first, in which phase, and estimated effort.

```sql
CREATE TABLE IF NOT EXISTS sequencing (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  step_number       INTEGER NOT NULL UNIQUE,
  component_id      INTEGER NOT NULL REFERENCES components(id),
  phase             TEXT    NOT NULL CHECK(phase IN (
                      'foundation', 'core', 'integration',
                      'verification', 'release')),
  notes             TEXT,
  estimated_effort  TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Field constraints:**
- `step_number`: globally unique, 1-based, ordered by build sequence
- `phase`: coarse phase bucket — foundation (infra/schema), core (business logic), integration (cross-component wiring), verification (testing/QA), release (packaging/deployment)
- `estimated_effort`: free text (e.g., `2 days`, `S`, `1 sprint`)

**Example row:**
```json
{
  "id": 1,
  "step_number": 1,
  "component_id": 1,
  "phase": "foundation",
  "notes": "Build auth-service first; all other services depend on it.",
  "estimated_effort": "3 days",
  "created_at": "2025-01-01T00:00:00"
}
```

---

### Table: `constraints`

Security, compliance, NFR, and other constraints that affect how and when components are built.

```sql
CREATE TABLE IF NOT EXISTS constraints (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT    NOT NULL,
  type                      TEXT    NOT NULL CHECK(type IN (
                              'security', 'compliance', 'nfr',
                              'performance', 'accessibility',
                              'dependency-conflict', 'other')),
  description               TEXT    NOT NULL,
  source                    TEXT,
  applies_to_component_ids  TEXT,
  severity                  TEXT    NOT NULL CHECK(severity IN (
                              'critical', 'high', 'medium', 'low')),
  status                    TEXT    NOT NULL DEFAULT 'open'
                                    CHECK(status IN ('open','mitigated','accepted')),
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Field constraints:**
- `source`: reference to the artifact that introduced this constraint (e.g., `ADR-0001`, `security-plan §3.2`, `GDPR Art. 5`)
- `applies_to_component_ids`: comma-separated component IDs; NULL or empty means the constraint applies to all components

**Example row:**
```json
{
  "id": 1,
  "name": "All tokens must expire within 24 hours",
  "type": "security",
  "description": "JWT access tokens must have a maximum TTL of 24 hours to limit blast radius of credential leakage.",
  "source": "security-plan §2.1",
  "applies_to_component_ids": "1",
  "severity": "critical",
  "status": "open",
  "created_at": "2025-01-01T00:00:00"
}
```

---

## uwf-br Initialization Format

The Build Record (`{output_path}/{role}-br.json`) is an append-only layered execution log. Initialize it with strata 0–4 populated from First-phase artifacts.

### JSON Structure

```json
{
  "version": "1.0",
  "created_at": "<ISO 8601 timestamp>",
  "role": "<artifact role prefix, e.g. project or issues>",
  "strata": {
    "0": {
      "label": "Context",
      "description": "Project identity, goals, scope, and stakeholders.",
      "entries": []
    },
    "1": {
      "label": "Decisions and Risk Register",
      "description": "Architectural decisions, technology choices, rationale, and project-level risk register entries (schedule, dependency, technical-debt, external).",
      "entries": []
    },
    "2": {
      "label": "Dependencies",
      "description": "External libraries, services, and internal component dependencies.",
      "entries": []
    },
    "3": {
      "label": "Actions",
      "description": "Ordered implementation steps, tasks, and their outcomes.",
      "entries": []
    },
    "4": {
      "label": "Verification",
      "description": "Test results, acceptance criteria outcomes, and quality gate logs.",
      "entries": []
    }
  }
}
```

### Stratum Entry Schema

Each entry in a stratum's `entries` array must conform to this schema:

```json
{
  "id":         "<stratum_number>-<sequential_integer>",
  "source":     "<artifact file or stage name that produced this entry>",
  "summary":    "<single sentence: what this entry records>",
  "detail":     "<full text, reference, or structured content>",
  "recorded_at": "<ISO 8601 timestamp>"
}
```

### Stratum Population Rules

| Stratum | Label | Populate From |
|---|---|---|
| 0 | Context | `{role}-intake.md` — project goal, non-goals, constraints, stakeholders, risk tolerance |
| 1 | Decisions and Risk Register | `docs/adr/ADR-*.md` — one entry per ADR, summarising the decision and its rationale; `{role}-risk-plan.md` — one entry per risk register row (appended after ADR entries) |
| 2 | Dependencies | `{role}-discovery.md` + `{role}-requirements.md` — external libraries, APIs, and services identified; `{role}-risk-plan.md` — one additional entry per blocking dependency risk (`category: dependency`, `blocking: true`) |
| 3 | Actions | `{role}-requirements.md` + sequencing table in uwf-cbs — ordered build steps (populated from the sequencing table) |
| 4 | Verification | `{role}-test-plan.md` — test strategy, coverage targets, and test IDs |

---

## Step-by-Step Instructions

Execute these steps in order. Do not skip a step. Do not advance to the next step until the current step is complete.

1. **Read all First-phase inputs.** Load each file listed in the Inputs table. For each file that is missing, write a one-line note at the top of `{role}-blueprint.md` recording which file was absent and continue.

2. **Extract components from requirements and discovery.**
   - Read `{role}-requirements.md` and `{role}-discovery.md`.
   - For each distinct system component, service, module, database, or external integration identified, create one row in the `components` table.
   - Assign `source_story_ids` from user story IDs found in requirements. Assign `source_adr_ids` from any ADR references found.

3. **Extract interfaces from requirements and ADRs.**
   - For each inter-component communication boundary identified in requirements or ADRs, create one row in the `interfaces` table.
   - Set `provider_component_id` and `consumer_component_id` using the IDs assigned in step 2.

4. **Build the dependency graph.**
   - For each pair of components where one must exist before the other can be built or run, create one row in the `dependencies` table.
   - Check for circular dependencies. If any are found, create a `constraints` row with `type = 'dependency-conflict'`, `severity = 'high'`, and a description of the cycle.

5. **Derive the build sequence.**
   - Perform a topological sort of the dependency graph.
   - Assign `step_number` to each component in dependency order.
   - Assign `phase` using these rules: components with no dependencies → `foundation`; components with only foundation dependencies → `core`; components requiring multiple core components → `integration`; test harnesses → `verification`; packaging/deployment components → `release`.
   - Insert one row per component into the `sequencing` table.

6. **Register constraints.**
   - Read `{role}-security-plan.md` (if present). For each security constraint, control, or compliance requirement, create one row in the `constraints` table with `type = 'security'` or `type = 'compliance'`.
   - Read `{role}-requirements.md`. For each NFR (performance, accessibility, reliability), create one row with `type = 'nfr'` or `type = 'performance'` or `type = 'accessibility'`.
   - Set `applies_to_component_ids` to the relevant component IDs identified in steps 2–4.

7. **Initialize the Build Record (uwf-br).**
   - Create `{output_path}/{role}-br.json` using the JSON structure defined above.
   - Populate stratum 0 from `{role}-intake.md`: record the project goal, non-goals, and key constraints as entries.
   - Populate stratum 1 from `docs/adr/ADR-*.md`: one entry per ADR found. Then, if `{role}-risk-plan.md` exists, append one entry per risk register row using `"source": "risk-planner"` and the risk entry detail.
   - Populate stratum 2 from `{role}-discovery.md` and `{role}-requirements.md`: one entry per external dependency or integration identified. Then, if `{role}-risk-plan.md` exists, append one additional entry for each risk with `category: dependency` and `blocking: true`, using `"source": "risk-planner"`.
   - Populate stratum 3 from the `sequencing` table: one entry per row, in step_number order.
   - Populate stratum 4 from `{role}-test-plan.md`: one entry per test ID or test scenario found.

8. **Write the blueprint summary.**
   - Create `{output_path}/{role}-blueprint.md` with the following sections:
     - **Component Inventory** — table with columns: id, name, type, status, source_story_ids
     - **Interface Contracts** — table with columns: id, name, type, provider, consumer, status
     - **Dependency Graph** — list of `component → depends on → component (type)` triples
     - **Build Sequence** — ordered list: step_number, component name, phase, estimated_effort
     - **Constraint Registry** — table with columns: id, name, type, severity, status, source
     - **Build Record Summary** — entry count per stratum (0–4)
     - **Missing Inputs** — list any files that were absent when the stage ran (used by exit criteria checks to determine `pass — not applicable` outcomes)
     - **Completeness Check** — the results of the exit criteria checks (see Exit Criteria below)

9. **Run exit criteria checks** (see Exit Criteria section). Record the result of each check in the Completeness Check section of `{role}-blueprint.md`.

---

## Exit Criteria

The stage is not complete until all of the following are true. Each check is binary: pass or fail.

| # | Check | Pass Condition |
|---|---|---|
| 1 | `components` table populated | `SELECT COUNT(*) FROM components` returns ≥ 1 |
| 2 | `sequencing` table covers all components | Every component ID in `components` appears in `sequencing.component_id` |
| 3 | No circular dependencies | No cycles exist in the `dependencies` graph; OR all cycles are recorded as `dependency-conflict` constraints |
| 4 | All constraints sourced | Every row in `constraints` has a non-null `source` field |
| 5 | uwf-br strata 0–4 initialized | `{role}-br.json` exists and each stratum has ≥ 1 entry — **or** the stratum's source artifact was absent (recorded in the **Missing Inputs** section of `{role}-blueprint.md`), in which case zero entries is `pass — not applicable` |
| 6 | Blueprint summary written | `{role}-blueprint.md` exists, is non-empty, and contains all eight sections listed in step 8 |
| 7 | All checks recorded | The Completeness Check section of `{role}-blueprint.md` lists the result (pass/fail) of checks 1–6 |

If any check fails and the failure is due to a missing upstream artifact (e.g., no security plan was produced because the project is not security-sensitive), record the gap and mark the check as `pass — not applicable`. Do not block the stage on conditionally absent inputs.

---

## Error Handling

| Condition | Action |
|---|---|
| `{role}-intake.md` is missing | Abort. Record the error in the blueprint summary. Do not proceed without an intake document — it is required for stratum 0. |
| `{role}-requirements.md` is missing | Abort. Record the error. Requirements are required to populate the components table. |
| `{role}-discovery.md` is missing | Continue with a warning. Record the gap in **Missing Inputs**. Components extracted from requirements alone. |
| `docs/adr/` is empty or no ADR files exist | Continue with a warning. Stratum 1 will have zero entries; record this in **Missing Inputs**. |
| `{role}-security-plan.md` is missing | Continue with a warning. No security constraints will be registered; record this in **Missing Inputs**. |
| `{role}-risk-plan.md` is missing | Continue with a warning. No risk register entries will be appended to stratum 1 and no blocking dependency entries to stratum 2; record this in **Missing Inputs**. |
| `{role}-test-plan.md` is missing | Continue with a warning. Stratum 4 will have zero entries; record this in **Missing Inputs**. |
| Circular dependency detected | Do not abort. Record the cycle as a `dependency-conflict` constraint and continue. |
| `uwf-cbs.db` already exists from a prior run | Drop and recreate all five tables before populating. This stage is idempotent. |
