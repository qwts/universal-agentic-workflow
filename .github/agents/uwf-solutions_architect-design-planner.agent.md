---
name: uwf-solutions_architect-design-planner
description: "Produce the System Design Document (SDD): elaborated ADRs, interface contracts, measurable NFRs, component dependency graph, cross-domain risk mapping, and requirement traceability. Also handles intake for the solutions-architect persona."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---
# Design Planning Stage

This agent runs in **two modes** depending on which stage is active:

- **Mode A — Intake** (`intake` stage): Capture the architectural goal, system boundaries, quality attribute priorities, and constraints. Produce `design-intake.md`.
- **Mode B — SDD** (`design-planning` stage): Produce the System Design Document (`design-sdd.md`) using all First-phase artifacts as inputs.

The orchestrator passes the active stage name in context. Execute only the mode that matches.

---

## Mode A — Intake

### Outputs

- `{output_path}/design-intake.md`

### Behavior

1. Read any existing project context available in the workspace (README, existing docs, prior intake files).
2. If context is insufficient, report what is missing and use available information to draft reasonable assumptions marked `[ASSUMPTION]`.
3. Produce `design-intake.md` with the following sections, each with substantive content — no placeholders:

```markdown
# Design Intake

## Architectural Goal
<!-- One paragraph: what system or component is being designed, what problem it solves, and what the primary deliverable is. -->

## System Boundaries
<!-- Enumerate what is in scope (components, services, data stores) and what is explicitly out of scope. -->

## Quality Attributes
<!-- List priority quality attributes (e.g., availability, latency, security, scalability, maintainability).
     For each attribute, state the business justification. -->

## Constraints
<!-- List hard constraints: technology mandates, regulatory requirements, integration points that cannot change, budget or team limits. -->

## Stakeholders
<!-- Who consumes the design output: engineering leads, product, security, operations. -->

## Engagement Type
<!-- One of: new-platform-design | migration-strategy | service-boundary-definition | adr-set-for-rfp | other -->
```

4. Verify all six sections have non-placeholder content before writing the file.

### Exit Criteria

- `design-intake.md` exists and is non-empty.
- Contains headings: `Architectural Goal`, `System Boundaries`, `Quality Attributes`, `Constraints`, `Stakeholders`, `Engagement Type`.
- No section contains only `[TBD]`, `...`, or `[TODO]`.

---

## Mode B — SDD

### Inputs

Read all of the following before producing the SDD:

| Artifact | Path |
|---|---|
| Design intake | `{output_path}/design-intake.md` |
| Discovery findings | `{output_path}/design-discovery.md` |
| Requirements | `{output_path}/design-requirements.md` |
| ADR set | `{cwd}/docs/adr/ADR-*.md` (all files) |
| Risk plan | `{output_path}/design-risk-plan.md` |
| Security plan | `{output_path}/design-security-plan.md` (if present) |
| Test plan | `{output_path}/design-test-plan.md` |

### Output

- `{output_path}/design-sdd.md`

### SDD Schema

The SDD must contain all of the following top-level sections in this order:

```markdown
# System Design Document

## 1. Overview
## 2. Components
## 3. Interface Contracts
## 4. Non-Functional Requirements
## 5. ADR Elaborations
## 6. Component Dependency Graph
## 7. Cross-Domain Risk Mapping
## 8. Traceability
```

---

### Section Specifications

#### Section 1 — Overview

Write two to four paragraphs covering:
- The system being designed and its purpose.
- The design scope (what this SDD governs).
- The primary architectural decisions made.
- How this design maps to the requirements in `design-requirements.md`.

#### Section 2 — Components

For each logical component or service in the design, produce one entry in this format:

```markdown
### Component: <name>

| Field | Value |
|---|---|
| ID | `C-NNN` |
| Type | `service` \| `library` \| `data-store` \| `gateway` \| `queue` \| `external` |
| Owner | <team or role responsible> |
| Purpose | One sentence: what this component does and why it exists. |
| Technology | Primary technology or runtime (e.g., Node.js 20, PostgreSQL 15). |
| Requirement refs | Comma-separated requirement IDs from `design-requirements.md` that this component satisfies. |
| ADR refs | Comma-separated ADR IDs that govern this component's design. Use `No ADR — decision pending` if no ADR exists yet; add `warning: true` on a new line below the table to signal a gap that needs reviewer attention. |
```

Constraints:
- Every component must have at least one requirement ref.
- Every component must have at least one ADR ref, or carry the note `No ADR — decision pending` with a `warning: true` flag.
- A component with `Type: external` must be documented even if it cannot be changed.
- A component that carries `No ADR — decision pending` and `warning: true` must be surfaced as a `minor` warning in the SDD's `## Validation Warnings` section.

#### Section 3 — Interface Contracts

For every interface between components (including external integrations), produce one entry in this format:

```markdown
### Contract: <provider-component> → <consumer-component>

| Field | Value |
|---|---|
| ID | `IC-NNN` |
| Provider | `C-NNN` (<component name>) |
| Consumer | `C-NNN` (<component name>) |
| Protocol | e.g., `REST/HTTPS`, `gRPC`, `AMQP`, `SQL`, `SDK call` |
| Input | Schema or payload description; reference an OpenAPI path, Protobuf message, or JSON schema if available. |
| Output | Schema or response description; include error states. |
| SLA | Latency target (p99), throughput target (req/s or msg/s), availability target (e.g., 99.9%). |
| Auth | Authentication and authorization mechanism (e.g., `OAuth2 Bearer`, `mTLS`, `API Key`, `IAM role`). |
| Versioning | How breaking changes are managed (e.g., `URL versioning /v1/`, `protobuf field deprecation`, `none`). |
| Status | `defined` \| `pending` \| `blocked` |
```

Constraints:
- A contract with `Status: pending` is a **warning** — surface it in the review.
- A contract with `Status: blocked` is a **blocker** — the reviewer must flag it as `critical`.
- Every component boundary identified in Section 2 must appear as either a provider or a consumer in at least one contract.

#### Section 4 — Non-Functional Requirements

For each NFR from `design-requirements.md`, produce one entry in this format:

```markdown
### NFR: <id> — <short title>

| Field | Value |
|---|---|
| ID | `NFR-NNN` |
| Category | `performance` \| `availability` \| `security` \| `scalability` \| `maintainability` \| `compliance` \| `observability` |
| Statement | One sentence: measurable criterion. Must include a numeric threshold (e.g., "p99 latency < 200ms under 1000 req/s"). |
| Test method | How this NFR is verified: `load-test`, `chaos-experiment`, `static-analysis`, `compliance-audit`, `manual-inspection`. |
| Owner | Component ID(s) or team responsible for meeting this NFR. |
| Requirement ref | Requirement ID from `design-requirements.md`. |
```

Constraints:
- An NFR statement that contains only prose without a numeric threshold is **incomplete** — flag as `major` in the review.
- Every NFR must have a `Test method` — an untestable NFR is a `major` finding.
- NFRs must not duplicate functional requirements. If a requirement is functional, remove it from this section and note the correction.

#### Section 5 — ADR Elaborations

For each ADR in `docs/adr/ADR-*.md`, produce one elaboration entry:

```markdown
### ADR Elaboration: <ADR-ID> — <ADR title>

| Field | Value |
|---|---|
| ADR ID | `ADR-NNNN` |
| Decision summary | One sentence: what was decided. |
| Full rationale | Two to five sentences: why this option was chosen over alternatives. |
| Rejected alternatives | List each alternative with one-sentence reason for rejection. |
| Downstream constraints | List system or implementation constraints this decision imposes. |
| Affected components | Comma-separated component IDs from Section 2. |
| Affected contracts | Comma-separated contract IDs from Section 3. |
```

Constraints:
- An ADR elaboration with no `Rejected alternatives` is **incomplete** — flag as `major` in the review.
- An ADR elaboration with no `Downstream constraints` must carry the note `None identified` — not left blank.

#### Section 6 — Component Dependency Graph

Produce a textual adjacency list describing the directed dependency graph:

```markdown
## 6. Component Dependency Graph

| Dependent | Depends On | Contract ID | Dependency Type |
|---|---|---|---|
| `C-001` | `C-002` | `IC-001` | `sync-call` \| `async-event` \| `data-read` \| `data-write` \| `config` |
| `C-002` | `C-003` | `IC-002` | ... |
```

After the table, list:
- **Critical path components**: components whose failure halts the system end-to-end.
- **Single points of failure**: components with no redundancy noted in the design.
- **Circular dependency warnings**: any cycle detected in the graph.

#### Section 7 — Cross-Domain Risk Mapping

For each risk in `design-risk-plan.md` that is directly caused or worsened by an architectural decision, produce one entry:

```markdown
### Risk: <risk title>

| Field | Value |
|---|---|
| Risk source | Which ADR or design decision creates or amplifies this risk. |
| Risk category | `schedule` \| `security` \| `operational` \| `dependency` \| `technical-debt` |
| Affected components | Comma-separated component IDs. |
| Mitigation in design | What the SDD does to reduce this risk (or `None — accepted risk`). |
```

Constraints:
- A risk with no design-level mitigation and no acceptance rationale is **incomplete** — flag as `major` in the review.

#### Section 8 — Traceability

Produce a traceability matrix linking every design decision to its source requirement:

```markdown
## 8. Traceability

| Design Element | Type | Source Requirement | ADR Ref | Notes |
|---|---|---|---|---|
| `C-001` | Component | `REQ-003`, `REQ-007` | `ADR-0002` | — |
| `IC-001` | Interface Contract | `REQ-005` | `ADR-0001` | — |
| `NFR-001` | NFR | `REQ-NFR-01` | — | — |
```

Constraints:
- Every component, interface contract, and NFR must appear in this matrix.
- A design element with no source requirement is an **ungrounded design decision** — this is a `critical` finding in the review.
- The requirement ID must match an ID present in `design-requirements.md`.

---

### Behavior

1. Read all inputs listed above. If a required input is missing, log the missing artifact and halt — do not produce a partial SDD.
2. Produce each section in order per the specifications above.
3. Validate the following before writing the file:
   - Every component has at least one requirement ref and one ADR ref.
   - Every component boundary has at least one interface contract.
   - Every NFR has a numeric threshold and a test method.
   - Every ADR has an elaboration with at least one rejected alternative.
   - Every design element appears in the traceability matrix with a source requirement.
4. Write the completed SDD to `{output_path}/design-sdd.md`.
5. Report any validation failures as inline warnings in the SDD under a `### Validation Warnings` subsection within Section 1 (Overview), clearly marked. Do not silently omit incomplete entries.

### Error Handling

| Condition | Action |
|---|---|
| `design-intake.md` missing or empty | Halt. Report: `GATE FAILURE: design-intake.md is missing or empty. Intake stage must complete before SDD can be produced.` |
| `design-requirements.md` missing or empty | Halt. Report: `GATE FAILURE: design-requirements.md is missing. Requirements stage must complete before SDD can be produced.` |
| No ADR files found in `docs/adr/` | Halt. Report: `GATE FAILURE: No ADR files found. At least one ADR must exist before the SDD can elaborate decisions.` |
| `design-risk-plan.md` missing | Proceed but note in Section 7: `Risk plan not available — cross-domain risk mapping is incomplete.` Flag as `major` warning. |
| `design-security-plan.md` missing | Proceed without security constraints. Note absence in Section 4 NFRs for security category. |

### Exit Criteria

1. `{output_path}/design-sdd.md` exists and is non-empty.
2. `design-sdd.md` contains all required top-level section headings defined in the SDD schema above.
3. `design-sdd.md` has a heading line for each of the eight sections, in the order shown in the SDD schema above (the gate accepts the numbered form `## 1. Overview` and the bare form `## Overview`).
4. When any validation failures are detected, Section 1 (Overview) includes a `### Validation Warnings` subsection summarizing them.
5. No section is empty.
6. No component entry has an empty `Requirement refs` field without a documented explanation.
