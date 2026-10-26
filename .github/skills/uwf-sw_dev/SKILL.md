# Skill: uwf-sw_dev

Persona skill for driving individual work items (issues) from intake through implementation, review, and acceptance.

---

## Persona Configuration

| Property | Value |
|---|---|
| `workflow` | `sw_dev` |
| `role` | `issues` |
| Artifact prefix | `issues-` |
| Output path | the required output paths provided by the runner |

---

## Subagent Roster

| Subagent | Role |
|---|---|
| `uwf-core-project-tracking` | Phase transitions, issue queue management, state management |
| `uwf-stage-intake` | Scope a single work item; produce intake doc |
| `uwf-stage-discovery` | Inspect codebase; update intake with findings |
| `uwf-core-requirements` | Produce requirements doc from intake and discovery |
| `uwf-core-adr` | Create architectural decision records |
| `uwf-core-risk-planner` | Project-level risk register (schedule, dependency, technical-debt, external risks) |
| `uwf-core-security-plan` | Threat model and security controls |
| `uwf-core-test-planner` | Test plan and stubs for all testable behaviour |
| `uwf-core-blueprint` | Synthesize First-phase outputs into uwf-cbs and initialize uwf-br |
| `uwf-sw_dev-work-planner` | Implementation plan with steps and associated tests |
| `uwf-issue-implementer` | Execute the work plan |
| `uwf-sw_dev-reviewer` | Review implementation; produce fix list or clean bill — loads `uwf-reviewer` skill with `Persona: dev` |
| `uwf-core-technical-writer` | Review and update documentation from changed artifacts |
| `uwf-core-acceptance` | Run acceptance gate checklist |
| `uwf-core-refinement` | Groom user stories to production-ready standard before acceptance |
| `uwf-core-snapshot` | Produce uwf-drs; close uwf-br layer 5; append changelog closure entry |
| `uwf-core-retro` | Retrospective |

---

## Stage Sequence

Execute stages **in this exact order** for each active issue. Do not advance past a stage until its gate passes.

| # | Phase (uwf-state) | Subagent | Purpose |
|---|---|---|---|
| 0 | *(queue prep)* | `uwf-core-project-tracking` | Identify the active issue; update workflow context and phase. |
| 1 | `intake` | `uwf-stage-intake` | Scope the active issue; produce `issues-intake.md`. |
| 2 | `intake` → `discovery` | `uwf-core-project-tracking` | Advance phase to `discovery`. |
| 3 | `discovery` | `uwf-stage-discovery` | Inspect codebase; update intake with findings; surface unknowns. |
| 4 | `discovery` → `planning` | `uwf-core-project-tracking` | Advance phase to `planning`. |
| 5 | `planning` | `uwf-core-requirements` | Produce requirements doc based on updated intake and discovery. |
| 6 | `planning` | `uwf-core-adr` | *(Conditional)* Create ADRs if discovery or requirements recommended architectural decisions. |
| 7 | `planning` | `uwf-core-risk-planner` | Produce risk register covering schedule, dependency, technical-debt, and external risks. Appends to uwf-br layer 1; flags blocking dependency risks in layer 2. |
| 8 | `planning` | `uwf-core-security-plan` | *(Conditional)* Produce security plan if the issue is security-sensitive. |
| 9 | `planning` | `uwf-core-test-planner` | Produce test plan and stubs for all testable behaviour. |
| 10 | `planning` | `uwf-core-blueprint` | Synthesize all First-phase outputs into uwf-cbs (Canonical Build Spec) and initialize uwf-br (Build Record) strata 0–4. |
| 11 | `planning` → `execution` | `uwf-sw_dev-work-planner` | Produce work plan with implementation steps and associated tests. |
| 12 | `execution` | `uwf-issue-implementer` | Execute the work plan. The stage gate runs the target repo's build and tests (`verify.mjs`; configure via `.uwf.json` `verify` or `UWF_VERIFY_CMDS`, see [verify gate](../../../docs/guide/verify-gate.md)); the commands use the target repo's own toolchain, so native modules without a prebuilt binary for the runner's Node version (e.g. better-sqlite3 12.11.1 on Node 20) fail the gate. |
| 13 | `execution` | `uwf-sw_dev-reviewer` | Review implementation; produce fix list or recommend acceptance. *(fix-loop — see engine skill)* |
| 14 | `execution` → `acceptance` | `uwf-core-technical-writer` | Review and update the workflow artifacts documentation from new or changed artifacts. |
| 15 | `acceptance` | `uwf-core-acceptance` | Run acceptance gate checklist; produce `issues-acceptance.md`. |
| 16 | `acceptance` → `snapshot` | `uwf-core-snapshot` | Produce `issues-drs.json`; close `issues-br.json` layer 5; append closure entry to `uwf-changelog.md`. |
| 17 | `snapshot` → `closed` | `uwf-core-retro` | Run the retrospective and advance the phase to `closed`. When all issues are closed or skipped, summarize completion before exiting the workflow. |

---

## Gate Enforcement

Gate logic is implemented in [`run.mjs`](run.mjs) — not in this document. The orchestrator checks each stage gate by running:

```sh
node .github/skills/uwf-sw_dev/run.mjs --check-gate <stageName>
```

To see the full stage list with retry limits:

```sh
node .github/skills/uwf-sw_dev/run.mjs --list-stages
```

---

## Persona-Specific Operating Rules

- This persona drives **one issue at a time**. Repeat the sequence for each issue in the queue.
- Do not start implementation (step 10) without a confirmed work plan and test plan.
- After all issues in the queue are closed or skipped, use `uwf-core-retro` to summarize project completion and capture the retrospective before exiting the workflow.
- Ensure all workflow artifacts are scoped to the active issue and maintained in the workflow artifacts directory throughout the issue lifecycle.
