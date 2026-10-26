# Skill: uwf-solutions_architect

Persona skill for architecture-first engagements: designing platforms, evaluating migration strategies, defining service boundaries, producing ADR sets, and delivering a System Design Document (SDD) as the primary deliverable.

---

## Persona Configuration

| Property | Value |
|---|---|
| `workflow` | `solutions_architect` |
| `role` | `design` |
| Artifact prefix | `design-` |
| Output path | the required output paths provided by the runner |

---

## Subagent Roster

| Subagent | Role |
|---|---|
| `uwf-core-project-tracking` | Phase transitions and state management |
| `uwf-solutions_architect-design-planner` | Capture architectural goal, constraints, engagement scope, and produce the System Design Document (SDD) |
| `uwf-stage-discovery` | Inspect workspace; surface unknowns |
| `uwf-core-requirements` | Produce PRD, NFRs, acceptance criteria |
| `uwf-core-adr` | Create architectural decision records |
| `uwf-core-risk-planner` | Project-level risk register (schedule, dependency, technical-debt, external risks) |
| `uwf-core-security-plan` | Threat model and security controls |
| `uwf-core-test-planner` | Test strategy, stubs, coverage targets |
| `uwf-core-blueprint` | Synthesize First-phase outputs into uwf-cbs and initialize uwf-br |
| `uwf-solutions_architect-reviewer` | Architecture review gate — loads `uwf-reviewer` skill with `Persona: arch` |
| `uwf-core-acceptance` | Final acceptance gate checks |
| `uwf-core-snapshot` | Produce uwf-drs; close uwf-br layer 5; append changelog closure entry |
| `uwf-core-retro` | Retrospective |

---

## Stage Sequence

> **This table is documentation only — do NOT use it as your stage list.**
> Run `node .github/skills/uwf-solutions_architect/run.mjs --list-stages` at startup and execute every stage the script returns.
>
> **Conditional stages** (`adr`, `security-plan`) are **never skipped.** Their gate script auto-passes (`PASS — not required`) when the condition is not met, but you must still invoke the subagent. Only the gate script decides whether a stage's work is required.

Execute stages **in this exact order**. Do not advance past a stage until its gate passes.

| # | Phase (uwf-state) | Subagent | Purpose |
|---|---|---|---|
| 0 | `idea` → `intake` | `uwf-core-project-tracking` | Initialize or read `uwf-state.json`; set phase to `intake`. |
| 1 | `intake` | `uwf-solutions_architect-design-planner` | Capture architectural goal, engagement scope, system boundaries, key constraints, and quality attribute priorities. |
| 2 | `intake` → `discovery` | `uwf-core-project-tracking` | Advance phase to `discovery`. |
| 3 | `discovery` | `uwf-stage-discovery` | Inspect workspace; update intake with findings; surface unknowns. |
| 4 | `discovery` → `planning` | `uwf-core-project-tracking` | Advance phase to `planning`. |
| 5 | `planning` | `uwf-core-requirements` | Produce PRD, NFRs as measurable criteria, and acceptance criteria. |
| 6 | `planning` | `uwf-core-adr` | *(Conditional)* Create ADRs for each architectural decision surface identified in requirements or discovery. |
| 7 | `planning` | `uwf-core-risk-planner` | Produce risk register covering schedule, dependency, technical-debt, and external risks. Appends to uwf-br layer 1; flags blocking dependency risks in layer 2. |
| 8 | `planning` | `uwf-core-security-plan` | *(Conditional)* Produce threat model if the system is security-sensitive or discovery flagged security concerns. |
| 9 | `planning` | `uwf-core-test-planner` | Define testability strategy: which NFRs are testable, what contracts are verifiable, and what integration tests must exist. |
| 10 | `planning` | `uwf-core-blueprint` | Synthesize all First-phase outputs into uwf-cbs (Canonical Build Spec) and initialize uwf-br (Build Record) strata 0–4. |
| 11 | `planning` | `uwf-solutions_architect-design-planner` | Produce the System Design Document (SDD): elaborated ADRs, interface contracts, measurable NFRs, component dependency graph, cross-domain risk mapping, and full requirement traceability. |
| 12 | `planning` | `uwf-solutions_architect-reviewer` | Review the SDD for completeness, NFR coverage, traceability, and constraint compliance. Produces a fix list or a clean bill. *(fix-loop — see engine skill)* |
| 12a | `planning` | *(fix-loop — see engine skill)* | If reviewer returned fixes: re-invoke `uwf-solutions_architect-design-planner`, then re-invoke reviewer. Max 3 review cycles. |
| 13 | `planning` → `waiting-acceptance` | `uwf-core-project-tracking` | Track issues in project tracking. |
| 14 | `waiting-acceptance` → `acceptance` | `uwf-core-acceptance` | Run final acceptance checks against all artifacts. |
| 15 | `acceptance` → `snapshot` | `uwf-core-snapshot` | Produce `design-drs.json`; close `design-br.json` layer 5; append closure entry to `uwf-changelog.md`. |
| 16 | `snapshot` → `closed` | `uwf-core-retro` | Produce retrospective and advance phase to `closed`. |

---

## Gate Enforcement

Gate logic is implemented in [`run.mjs`](run.mjs) — not in this document. The orchestrator checks each stage gate by running:

```sh
node .github/skills/uwf-solutions_architect/run.mjs --check-gate <stageName>
```

To see the full stage list with retry limits:

```sh
node .github/skills/uwf-solutions_architect/run.mjs --list-stages
```

---

## Persona-Specific Operating Rules

- Never start the SDD stage (`design-planning`) without confirmed `design-intake.md`, `design-discovery.md`, `design-requirements.md`, and at least one ADR in `docs/adr/`.
- Every NFR in `design-requirements.md` must carry a measurable criterion — prose-only NFRs are incomplete and block the review gate.
- Every design decision in the SDD must trace to a requirement ID or ADR ID from First phase — ungrounded decisions are a `critical` finding.
- Every component boundary in the SDD must have a defined interface contract — undefined contracts are a `critical` finding.
- This archetype produces more detailed ADR entries than the default First-phase `adr` stage alone. The `design-planner` stage elaborates each First-phase ADR with full decision rationale, rejected alternatives, and downstream constraints.
