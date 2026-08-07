---
name: uwf-risk-planner
description: "Produce a project-level risk register covering schedule, dependency, technical-debt, and external risks. Appends to uwf-br layer 1 and flags blocking dependency risks in layer 2."
---

# UWF Risk Planner Skill

## Role and Purpose

The risk-planner stage runs in Phase 1, after `adr` and before `security-planner`. Its purpose is to identify and document project-level execution risks — schedule slippage, external and internal dependency exposure, and technical-debt drag — before any implementation work begins.

This stage produces a **risk register** and appends it to the Build Record (`uwf-br` layer 1). Dependency risks flagged as blocking are additionally recorded in `uwf-br` layer 2. The risk register feeds the `refinement` stage in Phase 3 via the `slippage_risk_signal` field on user stories.

---

## Scope Boundary

### What this stage IS responsible for

| Responsibility | Description |
|---|---|
| Schedule risk | What could cause timeline slippage? Missing estimates, unclear scope, hard deadlines with unresolved unknowns. |
| Dependency risk | What external or internal dependencies could block progress? Third-party APIs, unreleased libraries, cross-team hand-offs. |
| Technical-debt risk | What existing design decisions, code quality issues, or deferred refactors create execution risk? |
| External risk | Regulatory changes, vendor instability, environment constraints, or third-party contractual blockers. |

### What this stage is NOT responsible for

| Out of scope | Handled by |
|---|---|
| Threat modeling (adversarial, attack-surface thinking) | `security-planner` stage |
| Sprint-level risk (velocity, team capacity fluctuation) | `timeline-planner` stage in Phase 2 |
| Story-level effort estimation | `refinement` stage in Phase 3 |
| Security controls and mitigations | `security-planner` stage |

---

## Inputs

Read all of the following artifacts before producing any output. If a file does not exist, record the gap in the risk plan and continue with available data.

| File | Content |
|---|---|
| `{output_path}/{role}-intake.md` | Project goals, constraints, risk tolerance, stakeholders |
| `{output_path}/{role}-discovery.md` | Codebase findings, existing components, technical debt signals, unknowns |
| `{output_path}/{role}-requirements.md` | Functional requirements, NFRs, dependencies, acceptance criteria |
| `docs/adr/ADR-*.md` | Architectural decisions — each decision carries execution risk signals (reversibility, complexity, external coupling) |

---

## Outputs

| Artifact | Path | Format | Committed |
|---|---|---|---|
| Risk plan | `{output_path}/{role}-risk-plan.md` | Markdown | Yes |

---

## Risk Register Schema

Every risk register entry must include all required fields below. Optional fields should be populated when information is available.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `risk_id` | string | **required** | Deterministic, sequential: `RSK-0001`, `RSK-0002`, … Assign IDs in the order risks are identified. Never reuse an ID within a project. |
| `category` | enum | **required** | Must be one of: `schedule` \| `dependency` \| `technical-debt` \| `external` |
| `description` | string | **required** | One or two sentences. State the risk condition clearly — what could go wrong and under what circumstances. |
| `likelihood` | enum | **required** | Must be one of: `high` \| `medium` \| `low` |
| `impact` | enum | **required** | Must be one of: `high` \| `medium` \| `low` |
| `mitigation_strategy` | string | **required** | Concrete, actionable steps to reduce likelihood or impact. Not "monitor the situation." |
| `owner` | string | **required** | Role or team responsible for mitigation (e.g., `tech-lead`, `product-owner`, `infra-team`). Must be a role, not a person's name. |
| `status` | enum | **required** | Must be one of: `open` \| `mitigated` \| `accepted` |
| `source` | string | optional | Reference to the artifact that surfaced this risk. Any format is acceptable (e.g., `discovery §3`, `ADR-0002`, `requirements NFR-2`, `intake: risk tolerance`). The goal is traceability, not format compliance. |
| `blocking` | boolean | optional | `true` if this risk could prevent progress on a dependent work item. Required for all `dependency` category entries. |
| `linked_story_ids` | string | optional | Comma-separated story IDs for which this risk triggers a `slippage_risk_signal`. |

### Example Entry

```markdown
| RSK-0001 | dependency | Auth provider SDK has no stable v2 release; current v1 is deprecated Q3. | high | high | Pin to v1 with automated alert on v2 GA; assign spike story to evaluate migration. | tech-lead | open | ADR-0001 | true | US-0003,US-0007 |
```

---

## Instructions

Execute these steps in order. Do not skip a step.

1. **Read all inputs.** Load each file listed in the Inputs table. For each file that is missing, write a one-line note at the top of `{role}-risk-plan.md` recording which file was absent and continue.

2. **Scan for schedule risk signals.**
   - Read `{role}-intake.md`. Identify any hard deadlines, undefined scope areas, or risk tolerance statements that imply schedule pressure.
   - Read `{role}-requirements.md`. Flag any requirement that lacks an estimate, has vague acceptance criteria, or depends on an unresolved external factor.
   - For each signal found, create one risk register entry with `category: schedule`.

3. **Scan for dependency risk signals.**
   - Read `{role}-discovery.md`. Identify any third-party libraries, external APIs, shared services, or cross-team dependencies referenced.
   - Read `{role}-requirements.md`. Identify any NFR or functional requirement that depends on an external party delivering something.
   - Read `docs/adr/ADR-*.md`. For each ADR that introduces a dependency on an external or third-party system, assess the risk of that dependency being unavailable, delayed, or breaking.
   - For each signal found, create one risk register entry with `category: dependency`.
   - Set `blocking: true` for any dependency risk that, if not resolved, would prevent work on a dependent deliverable from starting.

4. **Scan for technical-debt risk signals.**
   - Read `{role}-discovery.md`. Identify any deferred refactors, known code quality issues, outdated frameworks, or architectural shortcuts noted as debt.
   - Read `docs/adr/ADR-*.md`. For each ADR where the decision was marked as a compromise or temporary choice, assess execution risk.
   - For each signal found, create one risk register entry with `category: technical-debt`.

5. **Scan for external risk signals.**
   - Read `{role}-intake.md` and `{role}-requirements.md`. Identify any regulatory, compliance, contractual, or environmental constraints that are outside the team's direct control.
   - For each signal found, create one risk register entry with `category: external`.

6. **Assign Risk IDs.** Number all entries sequentially starting at `RSK-0001`. Assign IDs in the order entries were identified (schedule → dependency → technical-debt → external).

7. **Score likelihood and impact.** For each entry, assign `likelihood` and `impact` using these guidelines:
   - `high`: The condition is already present or very likely given known facts.
   - `medium`: Plausible given current information; a reasonable mitigation exists.
   - `low`: Possible but unlikely given current evidence; low consequence if it occurs.

8. **Write mitigation strategies.** For each entry, write a concrete mitigation strategy — at minimum one actionable step the owner can execute.

9. **Identify slippage risk candidates.** For each risk entry where `likelihood` is `high` or (`likelihood` is `medium` AND `impact` is `high`), identify which user stories (from `{role}-requirements.md`) are affected. Populate `linked_story_ids` for those entries.

10. **Write `{role}-risk-plan.md`.** Use the template in `docs/workflow-output-templates/risk-plan.md`. The file must contain:
    - **Risk Register** — the full table of all entries
    - **Blocking Dependency Summary** — a list of all entries where `category: dependency` and `blocking: true`, formatted as bullet points
    - **Slippage Risk Signal Map** — a table mapping `risk_id` to `linked_story_ids` for all entries with `linked_story_ids` populated
    - **Missing Inputs** — list any files that were absent when the stage ran
    - **Exit Criteria Results** — pass/fail for each exit criterion (see Exit Criteria section)

11. **Append risk register entries to `uwf-br` layer 1.** For each risk register entry, add one stratum entry to the `"1"` (Decisions and Risk Register) layer of `{output_path}/{role}-br.json` using this format:
    ```json
    {
      "id": "1-R<n>",
      "source": "risk-planner",
      "summary": "<risk_id>: <one-sentence summary>",
      "detail": "<full risk register entry as JSON>",
      "recorded_at": "<ISO 8601 timestamp>"
    }
    ```
    If `{role}-br.json` does not yet exist (blueprint has not run), skip this step and add a note to the **Exit Criteria Results** section of `{role}-risk-plan.md` stating: "`uwf-br` not yet initialized — risk entries will be backfilled by the blueprint stage."

12. **Flag blocking dependency risks in `uwf-br` layer 2.** For each entry where `category: dependency` and `blocking: true`, add one stratum entry to the `"2"` (Dependencies) layer of `{output_path}/{role}-br.json` using this format:
    ```json
    {
      "id": "2-R<n>",
      "source": "risk-planner",
      "summary": "<risk_id> BLOCKING: <description>",
      "detail": "<mitigation_strategy>",
      "recorded_at": "<ISO 8601 timestamp>"
    }
    ```
    If `{role}-br.json` does not yet exist, skip this step and add the same note as in step 11.

---

## Exit Criteria

The stage is not complete until all of the following are true. Each check is binary: pass or fail.

| # | Check | Pass Condition |
|---|---|---|
| 1 | Risk plan file exists and is non-empty | `{role}-risk-plan.md` exists and is non-empty |
| 2 | All required fields populated | Every risk register entry has `risk_id`, `category`, `description`, `likelihood`, `impact`, `mitigation_strategy`, `owner`, and `status` |
| 3 | Risk IDs are sequential and unique | IDs follow `RSK-0001`, `RSK-0002`, … with no gaps or duplicates |
| 4 | Category values are valid | Every `category` value is one of `schedule`, `dependency`, `technical-debt`, `external` |
| 5 | Likelihood and impact values are valid | Every `likelihood` and `impact` value is one of `high`, `medium`, `low` |
| 6 | Blocking dependency summary present | `{role}-risk-plan.md` contains a **Blocking Dependency Summary** section (may be empty if no blocking dependencies exist) |
| 7 | Slippage risk signal map present | `{role}-risk-plan.md` contains a **Slippage Risk Signal Map** section (may be empty if no high-likelihood/high-impact risks exist) |
| 8 | Exit criteria results recorded | The **Exit Criteria Results** section of `{role}-risk-plan.md` lists the pass/fail result for checks 1–7 |

---

## Error Handling

| Condition | Action |
|---|---|
| `{role}-intake.md` is missing | Continue with a warning. Record the gap in **Missing Inputs**. Proceed with available inputs. |
| `{role}-discovery.md` is missing | Continue with a warning. Record the gap. Risk signals from discovery will be absent; note this limitation. |
| `{role}-requirements.md` is missing | Abort. Record the error. Requirements are the primary source for schedule and dependency risk signals. |
| `docs/adr/` is empty or no ADR files exist | Continue with a warning. Record the gap. Technical-debt and dependency risk from ADRs will be absent. |
| `{role}-br.json` is missing | Expected — blueprint has not yet run. Skip steps 11 and 12. Add a note in the **Exit Criteria Results** section. The blueprint stage will initialize `uwf-br` and must read `{role}-risk-plan.md` to backfill risk entries. |
| Zero risk entries produced | This is a valid outcome. Write the risk plan with an empty table and a note stating no material risks were identified. Still pass exit criteria checks 1, 6, 7, and 8. |
