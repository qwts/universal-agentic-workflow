---
name: uwf-risk-planner
description: "Produce a project-level risk register covering schedule, dependency, technical-debt, and external risks. Appends to uwf-br layer 1 and flags blocking dependency risks in layer 2."
---

# UWF Risk Planner Skill

Runs in Phase 1 after `adr`, before `security-planner`. Identifies project-level execution risks (schedule, dependency, technical debt, external) before implementation, writes a risk register, appends it to `uwf-br` layer 1, and records blocking dependency risks in layer 2. The register feeds `refinement` through `slippage_risk_signal` on user stories.

Out of scope: threat modeling and security controls (`security-planner`), sprint-level risk (`timeline-planner`), story estimation (`refinement`).

## Inputs and output

Read only these files (a missing file is recorded as a gap; continue with the rest):

- `{output_path}/{role}-intake.md`: goals, constraints, risk tolerance
- `{output_path}/{role}-discovery.md`: findings, debt signals, unknowns
- `{output_path}/{role}-requirements.md`: requirements, NFRs, dependencies
- `docs/adr/ADR-*.md`: decisions, with their reversibility, complexity and external coupling

Output: `{output_path}/{role}-risk-plan.md` (Markdown, committed).

## Risk register schema

| Field | Req. | Constraints |
|---|---|---|
| `risk_id` | yes | Sequential `RSK-0001`, `RSK-0002`, ... in order identified; never reused |
| `category` | yes | `schedule` \| `dependency` \| `technical-debt` \| `external` |
| `description` | yes | One or two sentences: what could go wrong and when |
| `likelihood` | yes | `high` \| `medium` \| `low` |
| `impact` | yes | `high` \| `medium` \| `low` |
| `mitigation_strategy` | yes | Concrete, actionable steps (not "monitor the situation") |
| `owner` | yes | A role (e.g. `tech-lead`), not a person's name |
| `status` | yes | `open` \| `mitigated` \| `accepted` |
| `source` | no | Artifact that surfaced the risk, any format (e.g. `ADR-0002`, `requirements NFR-2`) |
| `blocking` | no | `true` if it could stop a dependent work item; required for every `dependency` entry |
| `linked_story_ids` | no | Comma-separated story IDs that get a `slippage_risk_signal` |

## Instructions

1. **Read the inputs.** For each missing file, put a one-line note at the top of `{role}-risk-plan.md`.
2. **Schedule risks** (`schedule`): from intake (hard deadlines, undefined scope, risk tolerance) and requirements (no estimate, vague acceptance criteria, unresolved external factor).
3. **Dependency risks** (`dependency`): from discovery (third-party libraries, external APIs, shared services, cross-team work), requirements (needs an external party to deliver) and ADRs (external or third-party dependencies that may be unavailable, late or breaking). Set `blocking: true` when unresolved work would stop a dependent deliverable from starting.
4. **Technical-debt risks** (`technical-debt`): from discovery (deferred refactors, quality issues, outdated frameworks, shortcuts) and ADRs recorded as compromises or temporary choices.
5. **External risks** (`external`): regulatory, compliance, contractual or environmental constraints in intake and requirements that the team does not control.
6. **Assign IDs** in order schedule, dependency, technical-debt, external.
7. **Score** `likelihood` and `impact`: `high` = already present or very likely; `medium` = plausible, reasonable mitigation exists; `low` = unlikely or low consequence.
8. **Mitigations**: at least one actionable step per entry.
9. **Slippage candidates**: for entries with `likelihood: high`, or `likelihood: medium` with `impact: high`, fill `linked_story_ids` from the stories in requirements.
10. **Write `{role}-risk-plan.md`** using `docs/workflow-output-templates/risk-plan.md` (if it does not exist, use the sections below). Required sections: **Risk Register** (full table), **Blocking Dependency Summary** (bullets for `dependency` + `blocking: true`; may be empty), **Slippage Risk Signal Map** (`risk_id` to `linked_story_ids`; may be empty), **Missing Inputs**, **Exit Criteria Results** (pass/fail for checks 1-7 below).
11. **Append to `uwf-br` layer 1.** For each entry add to layer `"1"` of `{output_path}/{role}-br.json`: `{"id": "1-R<n>", "source": "risk-planner", "summary": "<risk_id>: <one-sentence summary>", "detail": "<entry as JSON>", "recorded_at": "<ISO 8601>"}`.
12. **Flag blocking dependencies in layer 2.** For each `dependency` + `blocking: true` entry add to layer `"2"`: `{"id": "2-R<n>", "source": "risk-planner", "summary": "<risk_id> BLOCKING: <description>", "detail": "<mitigation_strategy>", "recorded_at": "<ISO 8601>"}`.
    If `{role}-br.json` does not exist yet (blueprint has not run), skip steps 11 and 12 and write in **Exit Criteria Results**: "`uwf-br` not yet initialized — risk entries will be backfilled by the blueprint stage."

## Exit criteria (each pass/fail)

1. `{role}-risk-plan.md` exists and is non-empty.
2. Every entry has `risk_id`, `category`, `description`, `likelihood`, `impact`, `mitigation_strategy`, `owner`, `status`.
3. IDs are `RSK-0001`, `RSK-0002`, ... with no gaps or duplicates.
4. Every `category` is one of the four allowed values.
5. Every `likelihood` and `impact` is `high`, `medium` or `low`.
6. **Blocking Dependency Summary** section present.
7. **Slippage Risk Signal Map** section present.
8. **Exit Criteria Results** lists checks 1-7.

## Error handling

- `{role}-requirements.md` missing: abort and record the error (primary source of schedule and dependency signals).
- `{role}-intake.md`, `{role}-discovery.md` or ADRs missing: continue, record the gap under **Missing Inputs**.
- Zero risks found is valid: write an empty table with a note that no material risks were identified; checks 1, 6, 7 and 8 must still pass.
