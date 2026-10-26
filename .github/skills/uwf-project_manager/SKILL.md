# Skill: uwf-project_manager

Persona skill for macro-level project planning: scoping a new effort, producing a requirements pack, building a roadmap, and scaffolding the backlog.

---

## Persona Configuration

| Property | Value |
|---|---|
| `workflow` | `project_manager` |
| `role` | `project` |
| Artifact prefix | `project-` |
| Output path | the required output paths provided by the runner |

---

## Subagent Roster

| Subagent | Role |
|---|---|
| `uwf-core-project-tracking` | Phase transitions and state management |
| `uwf-stage-intake` | Capture goals, constraints, stakeholders, work-breakdown strategy |
| `uwf-stage-discovery` | Inspect workspace; surface unknowns |
| `uwf-core-requirements` | Produce PRD, NFRs, acceptance criteria |
| `uwf-core-adr` | Create architectural decision records |
| `uwf-core-risk-planner` | Project-level risk register (schedule, dependency, technical-debt, external risks) |
| `uwf-core-security-plan` | Threat model and security controls |
| `uwf-core-test-planner` | Test strategy, stubs, coverage targets |
| `uwf-core-blueprint` | Synthesize First-phase outputs into uwf-cbs and initialize uwf-br |
| `uwf-project_manager-timeline-planner` | Issues backlog and project roadmap |
| `uwf-project_manager-reviewer` | Quality review of all planning artifacts — loads `uwf-reviewer` skill with `Persona: pm` |
| `uwf-core-acceptance` | Final acceptance gate checks |
| `uwf-core-refinement` | Groom user stories to production-ready standard before acceptance |
| `uwf-core-snapshot` | Produce uwf-drs; close uwf-br layer 5; append changelog closure entry |
| `uwf-core-retro` | Retrospective |

---

## Stage Sequence

> **This table is documentation only — do NOT use it as your stage list.**
> Run `node .github/skills/uwf-project_manager/run.mjs --list-stages` at startup and execute every stage the script returns.
>
> **Conditional stages** (`adr`, `security-plan`) are **never skipped.** Their gate script auto-passes (`PASS — not required`) when the condition is not met, but you must still invoke the subagent. Only the gate script decides whether a stage's work is required.

Execute stages **in this exact order**. Do not advance past a stage until its gate passes.

| # | Phase (uwf-state) | Subagent | Purpose |
|---|---|---|---|
| 0 | `idea` → `intake` | `uwf-core-project-tracking` | Initialize or read `uwf-state.json`; set phase to `intake`. |
| 1 | `intake` | `uwf-stage-intake` | Capture goal, non-goals, constraints, success metrics, stakeholders, environment, risk tolerance, and work-breakdown strategy. |
| 2 | `intake` → `discovery` | `uwf-core-project-tracking` | Advance phase to `discovery`. |
| 3 | `discovery` | `uwf-stage-discovery` | Inspect workspace; update intake with findings; surface unknowns. |
| 4 | `discovery` → `planning` | `uwf-core-project-tracking` | Advance phase to `planning`. |
| 5 | `planning` | `uwf-core-requirements` | Produce PRD, NFRs, and acceptance criteria. |
| 6 | `planning` | `uwf-core-adr` | *(Conditional)* Create ADRs if discovery recommended architectural decisions. |
| 7 | `planning` | `uwf-core-risk-planner` | Produce risk register covering schedule, dependency, technical-debt, and external risks. Appends to uwf-br layer 1; flags blocking dependency risks in layer 2. |
| 8 | `planning` | `uwf-core-security-plan` | *(Conditional)* Produce threat model if project is security-sensitive or discovery flagged security concerns. |
| 9 | `planning` | `uwf-core-test-planner` | Define test strategy, stubs, and coverage targets. |
| 10 | `planning` | `uwf-core-blueprint` | Synthesize all First-phase outputs into uwf-cbs (Canonical Build Spec) and initialize uwf-br (Build Record) strata 0–4. |
| 11 | `planning` | `uwf-project_manager-timeline-planner` | Produce the issues backlog and project roadmap. |
| 12 | `planning` | `uwf-project_manager-reviewer` | Review all planning artifacts for correctness, gaps, and security. Produces a fix list or a clean bill. |
| 12a | `planning` | *(fix-loop — see engine skill)* | If reviewer returned fixes: re-invoke responsible subagent(s), then re-invoke reviewer. Max 3 review cycles. |
| 13 | `planning` → `waiting-acceptance` | `uwf-core-project-tracking` | Track issues in project tracking. |
| 14 | `waiting-acceptance` → `acceptance` | `uwf-core-acceptance` | Run final acceptance checks against all artifacts. |
| 15 | `acceptance` → `snapshot` | `uwf-core-snapshot` | Produce `project-drs.json`; close `project-br.json` layer 5; append closure entry to `uwf-changelog.md`. |
| 16 | `snapshot` → `closed` | `uwf-core-retro` | Produce retrospective and advance phase to `closed`. |
| 17 | `closed` | `uwf-core-project-tracking` | *(Optional)* Record completion in tracking system. |


---

## Gate Enforcement

Gate logic is implemented in [`run.mjs`](run.mjs) — not in this document. The orchestrator checks each stage gate by running:

```sh
node .github/skills/uwf-project_manager/run.mjs --check-gate <stageName>
```

To see the full stage list with retry limits:

```sh
node .github/skills/uwf-project_manager/run.mjs --list-stages
```

---

## Persona-Specific Operating Rules

- Never start timeline planning without a confirmed `project-intake.md`, `project-discovery.md`, and `project-requirements.md`.
- If `uwf-core-project-tracking` reports no eligible open issues after state-tree population, confirm project planning is complete and offer a retrospective.
