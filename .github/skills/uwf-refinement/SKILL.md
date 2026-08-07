---
name: uwf-refinement
description: "Groom user stories to production-ready standard. Field completeness gate, nine quality controls, and brownfield confidence-promotion logic."
---

# UWF Refinement Skill

## Role and Purpose

The refinement stage runs in Phase 3, after `project-tracking` and before `acceptance`. Its purpose is to enforce the quality standard on every user story before it can be accepted. Refinement is the primary quality gate in the entire workflow — acceptance has no objective standard to enforce unless refinement has passed first.

Refinement operates on two dimensions:

1. **Field completeness** — every story must have all required fields populated and valid.
2. **Quality controls** — every story must pass nine binary checks covering grounding, sourcing, traceability, disambiguation, decomposition, dependency resolution, constraint compliance, slippage risk, and NFR coverage.

Stories that pass both dimensions are promoted to `refined` status. Stories that fail are set to `blocked` and handled per the Rejection Handling section.

---

## Scope Boundary

### What this stage IS responsible for

| Responsibility | Description |
|---|---|
| Field completeness | Every story field is present, non-empty, and conforms to its validation rule. |
| Quality control enforcement | All nine quality controls are evaluated per story with a binary pass/fail result. |
| Brownfield confidence promotion | `inferred-weak` stories are promoted to `confirmed` or flagged; `gap` stories are surfaced for human resolution. |
| Slippage risk linkage | Stories linked to risk register entries (`RSK-*`) are flagged and have their `slippage_risk_signal` field populated. |
| Traceability update | The traceability matrix (`uwf-tm`) is updated to record refinement pass/fail for each story. |

### What this stage is NOT responsible for

| Out of scope | Handled by |
|---|---|
| Implementing stories | `uwf-issue-implementer` |
| Estimating story points | Estimation is optional at refinement; if absent, the story is not blocked unless the archetype requires it. |
| Generating missing acceptance criteria | Refinement flags the gap; the requirements stage is responsible for authoring criteria. |
| Running code tests or linters | `uwf-core-acceptance` |
| Producing the risk register | `uwf-core-risk-planner` (Phase 1) |

---

## Inputs

Read all of the following artifacts before producing any output. Treat **required** inputs as hard entry criteria: if a required file does not exist, follow the abort behavior defined in Error Handling/Entry Criteria. For **optional** inputs, if a file does not exist, record the gap in the refinement report and continue with available data.

| File | Content | Required? |
|---|---|---|
| `{output_path}/{role}-requirements.md` | Source of user stories — all stories in `draft` status are candidates for refinement | Yes |
| `{output_path}/{role}-risk-plan.md` | Risk register — source of `RSK-*` IDs for slippage risk signal population | No |
| `{output_path}/{role}-discovery.md` | Brownfield: source of confidence scores (`confirmed`, `inferred-strong`, `inferred-weak`, `gap`) | No |
| `docs/adr/ADR-*.md` | Architectural decisions — used for traceability and constraint compliance checks | No |
| `{output_path}/{role}-traceability.md` | Traceability matrix — updated by this stage with refinement results | No |

---

## Outputs

| Artifact | Path | Format | Committed |
|---|---|---|---|
| Refinement Report (stage gate artifact) | `{output_path}/{role}-refinement-report.md` | Markdown | Yes |
| Updated requirements (story statuses) | `{output_path}/{role}-requirements.md` | Markdown (in-place update) | Yes |
| Updated traceability matrix | `{output_path}/{role}-traceability.md` | Markdown (in-place update) | Yes |

---

## Field Completeness Schema

Every user story must contain all required fields below. Optional fields must be consistently present (either always populated or never populated across the full story set).

| Field | Type | Required | Validation Rule |
|---|---|---|---|
| `id` | string | **required** | Deterministic, sequential: `US-0001`, `US-0002`, … No gaps. No duplicates. Zero-padded to 4 digits. |
| `title` | string | **required** | Concise. Verb-first. Maximum 80 characters. Must not be a noun phrase (e.g., "Authentication" fails; "Add OAuth authentication" passes). |
| `role` | string | **required** | Names a concrete actor or persona. Must not be generic (e.g., "User" alone fails; "Authenticated user", "Admin", "CI pipeline" pass). |
| `goal` | string | **required** | One sentence stating what the actor wants to accomplish. Must describe an outcome, not a task (e.g., "so that I can log in without a password" passes; "implement OAuth" fails). |
| `rationale` | string | **required** | The "so that" business rationale. Must be substantive — explains business value. Filler phrases such as "so that I can use the feature" or "for ease of use" are invalid. |
| `acceptance_criteria` | list | **required** | One or more structured, binary, testable conditions. Each criterion is prefixed with a sequential ID: `AC-0001`, `AC-0002`, … Criteria must not contain ambiguous language (see Quality Control 4). |
| `priority` | enum | **required** | Must be one of: `Critical` \| `High` \| `Medium` \| `Low`. |
| `domain_tag` | string | **required** | Bounded context, module, or service name the story belongs to. Must match a domain established in the requirements or discovery artifact. |
| `dependencies` | string | **required** | Comma-separated list of story IDs (`US-*`) or ADR numbers (`ADR-*`) this story depends on. Use `none` (the literal string) when there are no dependencies. Must not be blank. |
| `status` | enum | **required** | Must be one of: `draft` \| `refined` \| `in-progress` \| `review` \| `done` \| `blocked`. Stories enter refinement as `draft`; they exit as `refined` or `blocked`. |
| `story_points` | integer | **optional** | If any story in the set has a `story_points` value, then **all** stories in the set must have one (consistency rule). Value must be a positive integer from the Fibonacci sequence: 1, 2, 3, 5, 8, 13, 21. |
| `slippage_risk_signal` | string | **optional** | Comma-separated `RSK-*` IDs from the risk register where `linked_story_ids` includes this story. Populated during refinement from `{role}-risk-plan.md`. Use `none` when no applicable risks exist. |
| `confidence` | enum | **brownfield only** | Must be one of: `confirmed` \| `inferred-strong` \| `inferred-weak` \| `gap`. Required when `{role}-discovery.md` is present and contains confidence scores. Absent for greenfield projects. |
| `confidence_basis` | string | **brownfield only** | Required when `confidence` is `inferred-strong`, `inferred-weak`, or `gap`. One sentence citing the artifact or observation that produced the confidence level. |

### Example Entry

```markdown
**US-0003** | Add password-reset email flow | `Authenticated user` | `High` | `auth`

**Goal:** Send a reset link to the registered email address.
**Rationale:** So that users can recover access without contacting support, reducing support ticket volume.

**Acceptance Criteria:**
- AC-0007: When a user submits a valid email, a reset link is sent within 60 seconds. PASS/FAIL.
- AC-0008: When a user submits an unregistered email, no email is sent and no error is revealed. PASS/FAIL.
- AC-0009: Reset links expire after 24 hours. PASS/FAIL.

**Dependencies:** US-0001, ADR-0002
**Status:** draft
**Story Points:** 5
**Slippage Risk Signal:** RSK-0003
```

---

## Quality Controls

All nine controls are binary: each story either passes or fails each control. A single failed control blocks the story.

| # | Control | Pass Condition | Fail Condition |
|---|---|---|---|
| 1 | **Grounding** | The story maps to at least one explicit requirement in `{role}-requirements.md` (functional or non-functional). The requirement ID is cited in the story or traceability matrix. | No requirement citation exists; story scope cannot be traced to the requirements artifact. |
| 2 | **Sourcing** | The requirement source is explicitly cited in committed artifacts: an ADR number, a discovery finding ID, a stakeholder statement in intake, or — for brownfield — an inferred artifact reference. At least one of the following contains a non-empty source reference: the story text (for example, a `Source:` line), the corresponding requirement entry in `{role}-requirements.md`, or the traceability matrix (`uwf-tm`). | No committed artifact (story, `{role}-requirements.md`, or traceability matrix) cites a source for the underlying requirement. Story scope was invented without a traceable origin. |
| 3 | **Traceability** | The story links to at least one ADR (`ADR-*`) OR at least one requirement entry in `uwf-tm`. The link must be bidirectional: the traceability matrix records the story → ADR or story → requirement relationship. | No ADR and no traceability matrix entry exists for this story. |
| 4 | **Disambiguation** | No acceptance criterion contains ambiguous language. Prohibited terms: "should", "might", "as needed", "as appropriate", "where possible", "reasonable", "in a timely manner", "user-friendly", "easy to use", "properly". Each criterion is verifiable as an unambiguous binary pass/fail. | One or more acceptance criteria contain at least one prohibited ambiguous term. |
| 5 | **Decomposition correctness** | The story represents a single, independently deliverable unit of work. It cannot be split into two or more stories that each stand alone. It has exactly one `role`, one `goal`, and one coherent set of acceptance criteria. | The story bundles multiple independent goals, has acceptance criteria that span unrelated capabilities, or its `goal` can be trivially decomposed into two complete stories. |
| 6 | **Dependency resolution** | Every ID listed in `dependencies` (other than `none`) exists in the story set or the ADR set. No circular dependencies exist among stories. All declared dependencies have a resolvable path to completion (not permanently blocked). | At least one declared dependency ID does not exist; or a circular dependency chain is detected; or a dependency is permanently blocked with no resolution path. |
| 7 | **Constraint compliance** | The story does not contradict any NFR or security constraint recorded in Phase 1 (`{role}-requirements.md` non-functional requirements, `{role}-security-plan.md`). Any applicable constraint is explicitly addressed in the acceptance criteria or explicitly deferred with a recorded rationale. | The story's acceptance criteria are silent on an applicable NFR or security constraint, AND no explicit deferral rationale exists. |
| 8 | **Slippage risk signal** | If any risk register entry (`RSK-*`) in `{role}-risk-plan.md` lists this story's ID in `linked_story_ids`, then the story's `slippage_risk_signal` field is populated with that RSK ID. If no risk entry applies, the field is set to `none`. In either case, stories with a non-`none` slippage risk signal have been reviewed for re-scoping or contingency planning before refinement completes. | A matching RSK entry exists with `linked_story_ids` containing this story's ID, but the story's `slippage_risk_signal` field is blank or absent. |
| 9 | **NFR coverage** | Any non-functional requirement (performance, security, reliability, accessibility, cost, operability) that applies to this story's domain is captured as an explicit acceptance criterion. NFRs are not implied — they are stated. | An applicable NFR exists in the requirements artifact for this story's domain, but no acceptance criterion in this story references or satisfies it. |

---

## Brownfield Behavior

This section applies when `{role}-discovery.md` is present and contains confidence scores. If the discovery artifact is absent or does not contain confidence scores, treat the project as greenfield and skip this section.

### Confidence Levels

| Level | Meaning | Can pass refinement? |
|---|---|---|
| `confirmed` | Explicitly documented and human-verified | Yes — proceed with standard quality controls |
| `inferred-strong` | Multiple artifacts agree; high confidence | Yes — proceed with standard quality controls |
| `inferred-weak` | Single artifact; ambiguous or low confidence | No — must be promoted or flagged before passing |
| `gap` | Cannot be inferred; requires human input | No — must be resolved by human or closed as out-of-scope |

### Promotion Logic

Execute the following for every story whose `confidence` is `inferred-weak` or `gap`:

#### `inferred-weak` stories

1. Re-read all discovery artifacts (`{role}-discovery.md`, any referenced source files) to determine whether additional corroborating evidence exists.
2. If corroborating evidence is found that elevates confidence: promote the story to `inferred-strong` and update `confidence_basis` to cite the new evidence. If multiple artifacts now agree: promote to `confirmed`.
3. If no additional evidence is found: mark the story as unresolvable within this stage. Set `status: blocked` and write a gap entry in the refinement report with `resolution_required: true`.
4. Do not invent evidence. Do not promote a story unless a concrete artifact supports the promotion.

#### `gap` stories

1. Write the story to the **Gap Resolution Table** in the refinement report (see Refinement Report Format below).
2. Set `status: blocked` on the story.
3. Return the gap list to the orchestrator for human resolution before acceptance proceeds.
4. If the human provides resolution evidence: re-run step 1 of the `inferred-weak` promotion logic.
5. If the human explicitly closes the story as out-of-scope: set `status: blocked`, add a closure rationale, and exclude from acceptance.

### Brownfield Exit Gate

Refinement cannot pass on a brownfield project if any of the following are true:
- At least one story has `confidence: inferred-weak` and was not promoted or explicitly flagged as unresolvable.
- At least one story has `confidence: gap` and has not been resolved by a human or explicitly closed as out-of-scope.

---

## Entry Criteria

The following conditions must be evaluated before refinement begins. Criteria 1, 4, and 5 are **hard gates**: if any of them fail, abort and record the failure in the refinement report with `verdict: blocked`. Criteria 2 and 3 are **soft gates**: if they fail, follow the behavior defined in this table and in the Error Handling section instead of blocking the stage.

| # | Condition | Check |
|---|---|---|
| 1 | Project-tracking stage completed (hard gate) | `{role}-requirements.md` exists and is non-empty |
| 2 | Draft stories evaluated (soft gate) | Scan `{role}-requirements.md` for stories with `status: draft`. If at least one exists, continue with refinement. If none exist, record “No stories with status: draft” and immediately emit a refinement report with `verdict: pass` (no work items to refine); do not treat this as a failure. |
| 3 | Traceability matrix available (soft gate) | If `{role}-traceability.md` exists (may be a stub), load it. If it does not exist, create a new `{role}-traceability.md` stub, record that it was synthesized by refinement, and proceed; do not block entry on absence. |
| 4 | Risk register available (hard gate) | `{role}-risk-plan.md` exists OR a note is recorded that no risk register was produced (slippage checks will be skipped) |
| 5 | ADR set available (hard gate, presence-only) | `docs/adr/` directory exists (may be empty; absence is recorded as a gap but does not block entry) |

---

## Step-by-Step Instructions

Execute these steps in order. Do not skip a step. Do not advance to the next step until the current step is complete.

1. **Verify entry criteria.** Evaluate each entry criterion in the Entry Criteria table. If any **hard-gate** criterion (1, 4, or 5) fails, write a refinement report with `verdict: blocked` citing the failed criterion and abort. For **soft-gate** criteria (2 and 3), follow the behavior described in the table and in Error Handling (early `verdict: pass` when there are no draft stories, or synthesis of `{role}-traceability.md` when missing) instead of blocking. Do not attempt to refine stories when an early-pass exit has been triggered.

2. **Read all inputs.** Load each file listed in the Inputs table. For each file that is absent, record a gap in the refinement report under **Missing Inputs** and continue with available data.

3. **Detect project type.**
   - If `{role}-discovery.md` is present and contains confidence scores: this is a **brownfield** project. The Brownfield Behavior section applies.
   - Otherwise: this is a **greenfield** project. Skip the Brownfield Behavior section.

4. **Build the candidate story list.** Collect every story from `{role}-requirements.md` with `status: draft`. These are the candidates for refinement. Stories with any other status are out of scope for this run.

5. **For each candidate story — run field completeness check.**
   - Evaluate every field in the Field Completeness Schema table.
   - Record a `FAIL` for any field that is absent, empty, or violates its validation rule.
   - Record a `PASS` for every field that meets its validation rule.
   - If the `story_points` consistency rule is triggered (at least one story in the set has story points), verify that all stories in the full candidate list have story points populated.
   - Brownfield only: verify that `confidence` and `confidence_basis` are present where required.
   - A story with any field completeness `FAIL` does not proceed to quality controls — mark it as blocked immediately and record the specific failed fields.

6. **For each candidate story that passed field completeness — run quality controls.**
   - Evaluate each of the 9 quality controls in order.
   - For Control 8 (Slippage Risk Signal): read `{role}-risk-plan.md`. For each risk entry where `linked_story_ids` contains the current story's ID, populate the story's `slippage_risk_signal` field with that RSK ID. If multiple risk IDs apply, join them with commas. If no risk entries reference this story, set `slippage_risk_signal` to `none`.
   - Record a `PASS` or `FAIL` result for each control.
   - A story with any quality control `FAIL` is marked as blocked.

7. **Brownfield only — execute confidence promotion logic.** For every story with `confidence: inferred-weak` or `confidence: gap`, follow the Brownfield Behavior section. Promote where evidence permits; block and add to the Gap Resolution Table where it does not.

8. **Update story statuses.**
   - Stories that passed all field completeness checks and all 9 quality controls: set `status: refined`.
   - Stories that failed any check: set `status: blocked`.
   - Write the updated statuses back to `{role}-requirements.md` (in-place update of the status field for each story).

9. **Update the traceability matrix.**
   - Open `{role}-traceability.md`.
   - For each story processed, add or update its row to include: story ID, refinement result (`refined` or `blocked`), and for blocked stories, the first failed control or field.
   - Do not remove existing traceability links.

10. **Write `{output_path}/{role}-refinement-report.md`.** Use the template in `docs/workflow-output-templates/refinement.md`. The file must contain:
    - **Summary** — total stories processed, total `refined`, total `blocked`.
    - **Field Completeness Results** — per-story table with PASS/FAIL per field.
    - **Quality Control Results** — per-story table with PASS/FAIL per control.
    - **Brownfield Gap Resolution Table** — (brownfield only) list of all `gap` stories requiring human resolution. Omit this section entirely for greenfield projects.
    - **Brownfield Promotion Log** — (brownfield only) list of all `inferred-weak` stories and their promotion outcome. Omit this section entirely for greenfield projects.
    - **Rejected Stories** — list of all blocked stories with their blocking reason.
    - **Missing Inputs** — list any files that were absent when the stage ran.
    - **Exit Criteria Results** — pass/fail for each exit criterion.
    - The file must contain the line `verdict: pass` when all exit criteria are met, or `verdict: blocked` when any exit criterion fails.

11. **Run exit criteria checks.** Evaluate each exit criterion in the Exit Criteria table. Record the result of each check in the **Exit Criteria Results** section of the refinement report.

---

## Exit Criteria

The stage is not complete until all of the following are true. Each check is binary: pass or fail.

| # | Check | Pass Condition |
|---|---|---|
| 1 | Refinement report exists and is non-empty | `{role}-refinement-report.md` exists and contains content |
| 2 | All candidate stories have been evaluated | Every story that entered with `status: draft` now has `status: refined` or `status: blocked` |
| 3 | No story remains in `draft` status | Zero stories with `status: draft` in `{role}-requirements.md` after this stage runs |
| 4 | All `refined` stories pass field completeness | Every story with `status: refined` has all required fields populated and valid |
| 5 | All `refined` stories pass all 9 quality controls | Every story with `status: refined` has `PASS` on all 9 controls |
| 6 | Slippage risk signals populated | Every story whose ID appears in a risk register `linked_story_ids` has a non-empty `slippage_risk_signal` |
| 7 | Brownfield: no unresolved `inferred-weak` stories | (Brownfield only) Zero stories have `confidence: inferred-weak` without a promotion decision recorded |
| 8 | Brownfield: all `gap` stories resolved or closed | (Brownfield only) Zero stories have `confidence: gap` without a human resolution or out-of-scope closure recorded |
| 9 | Traceability matrix updated | `{role}-traceability.md` contains a refinement result row for every story processed |
| 10 | Exit criteria results recorded | The **Exit Criteria Results** section of `{role}-refinement-report.md` lists the pass/fail result for checks 1–9 |

---

## Rejection Handling

A story is rejected (set to `blocked`) when it fails any field completeness check or any of the nine quality controls. The following applies to every blocked story:

1. **Document the failure.** Record the story ID, the specific failed check(s), and the failure reason in the **Rejected Stories** section of `{role}-refinement-report.md`. Be precise — state which field is missing or which quality control failed and why.

2. **Set status to `blocked`.** Update the story's `status` field to `blocked` in `{role}-requirements.md`. Do not delete the story.

3. **Escalate to the orchestrator.** Return the list of blocked stories to the orchestrator. The orchestrator must decide one of three outcomes for each blocked story before acceptance can proceed:
   - **Promote**: assign ownership to a stage agent to fix the specific failure (e.g., return to requirements to add acceptance criteria), then re-run refinement for that story.
   - **Defer**: move the story out of the current acceptance scope. Set `status: blocked` with a deferral note. It will not be included in this acceptance run.
   - **Close as out-of-scope**: remove the story from the acceptance scope. Document the rationale.

4. **Acceptance gate dependency.** The acceptance stage must not proceed if any blocked story has not been resolved per step 3. A story in `blocked` status with no orchestrator disposition recorded is an open issue that prevents the acceptance gate from passing.

---

## Error Handling

| Condition | Action |
|---|---|
| `{role}-requirements.md` is missing | Abort. Record the error in the refinement report. Entry criterion 1 is failed. |
| No stories with `status: draft` exist | Complete immediately with `verdict: pass` — there is nothing to refine. Write a minimal report noting zero candidates. |
| `{role}-risk-plan.md` is missing | Continue. Skip quality control 8 (Slippage Risk Signal) for all stories. Record the gap in **Missing Inputs**. |
| `{role}-discovery.md` is missing | Treat as greenfield. Skip the Brownfield Behavior section. |
| `{role}-traceability.md` is missing | Create it with a minimal header before writing. Record the absence in **Missing Inputs**. |
| `docs/adr/` is empty or absent | Continue. Quality control 3 (Traceability) may still pass via requirement links. Record the gap in **Missing Inputs**. |
| A story references a dependency ID that does not exist | Quality control 6 (Dependency Resolution) fails for that story. Record the missing ID in the failure reason. |
| Circular dependency detected | Quality control 6 fails for all stories in the cycle. Record the cycle IDs in the failure reason. |
| Brownfield: `{role}-discovery.md` contains confidence scores but the story has no `confidence` field | Treat as `gap` and apply gap promotion logic. Record the missing field as a field completeness failure. |
