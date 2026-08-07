---
name: uwf-snapshot
description: "Snapshot stage skill: produce uwf-drs as a point-in-time reconstruction record, close uwf-br layer 5, and append a closure entry to uwf-changelog."
---

# UWF Snapshot Skill — Snapshot Stage

## Role and Purpose

The snapshot stage is the final output stage of Phase 3. It runs after `acceptance` and before `retro`. Its purpose is to serialize the accepted system state into a single backward-looking artifact — the **Deterministic Reconstruction Spec (uwf-drs)** — that gives a cold-starting AI agent enough context to understand what was built, why decisions were made, and how to reconstruct or extend the system without re-deriving everything from scratch.

Unlike `uwf-cbs` (the forward-looking construction blueprint produced in Phase 1), `uwf-drs` is backward-looking: it records what actually happened, what was delivered, what the environment looked like at closure, and where execution diverged from the plan.

This stage also formally closes the Build Record (`uwf-br`) by populating stratum 5 and appends a closure entry to `uwf-changelog`.

---

## Inputs

Read all of the following artifacts before producing any output. If a file does not exist, record the gap in the `gap_log` and continue with available data.

| File | Content |
|---|---|
| `{output_path}/{role}-br.json` | Build Record with strata 0–4 initialized by `blueprint` stage |
| `{output_path}/{role}-acceptance.md` | Acceptance gate output — the accepted state this snapshot records |
| `{output_path}/{role}-blueprint.md` | Blueprint summary from Phase 1 — used for divergence detection |
| `{output_path}/{role}-intake.md` | Original project or issue scope, goals, constraints, environment |
| `{output_path}/{role}-requirements.md` | Functional requirements and NFRs as originally specified |
| `docs/adr/ADR-*.md` | ADR set with full decision rationale |
| `{output_path}/{role}-risk-plan.md` | Risk register — source of any gaps carried forward (if produced) |
| `{output_path}/{role}-discovery.md` | Discovery findings — source of brownfield confidence scores (if produced) |
| `{output_path}/uwf-changelog.md` | Existing changelog to append the closure entry to (create if absent) |

---

## Outputs

| Artifact | Path | Format | Committed |
|---|---|---|---|
| Deterministic Reconstruction Spec | `{output_path}/{role}-drs.json` | JSON | Yes |
| Updated Build Record | `{output_path}/{role}-br.json` | JSON (layer 5 appended) | Yes |
| Updated Changelog | `{output_path}/uwf-changelog.md` | Markdown append | Yes |

---

## uwf-drs JSON Schema

Produce `{output_path}/{role}-drs.json` using this as its base schema. All top-level fields shown in this schema are required, but you may add additional top-level fields (such as `exit_criteria`) when instructed elsewhere in this skill. No defined field may be omitted — use `null` for fields where data is genuinely absent rather than omitting them entirely.

```json
{
  "schema_version": "<string — semver, e.g. '1.0.0'>",
  "produced_at": "<string — ISO 8601 timestamp>",
  "workflow": "<string — persona name, e.g. 'sw_dev' or 'project_manager'>",
  "role": "<string — artifact prefix, e.g. 'issues' or 'project'>",
  "acceptance_ref": "<string — path to the acceptance artifact that this snapshot records>",
  "components": [
    {
      "id": "<string — component ID from uwf-cbs components table, or inferred>",
      "name": "<string — component name>",
      "type": "<string — enum: service | library | module | database | cli | external | interface | other>",
      "description": "<string>",
      "version_pinned": "<string | null — actual version delivered; null if not version-tracked>",
      "status": "<string — enum: delivered | partial | deferred | dropped>",
      "source_story_ids": "<string | null — comma-separated story IDs>",
      "source_adr_ids": "<string | null — comma-separated ADR numbers>",
      "confidence": "<number — 0.0–1.0; 1.0 for directly evidenced; lower for brownfield-inferred>",
      "confidence_basis": "<string | null — reason for confidence score; null when confidence is 1.0>"
    }
  ],
  "environment": {
    "runtime": "<string | null — e.g. 'Node.js 20.x', 'Python 3.12', 'JVM 21'>",
    "os": "<string | null — e.g. 'ubuntu-22.04'>",
    "package_manager": "<string | null — e.g. 'npm 10.x', 'pip 24.x'>",
    "pinned_dependencies": [
      {
        "name": "<string>",
        "version": "<string>",
        "scope": "<string — enum: runtime | dev | test | peer>"
      }
    ],
    "environment_variables": [
      {
        "key": "<string>",
        "required": "<boolean>",
        "description": "<string>"
      }
    ],
    "notes": "<string | null — free-text environment notes; null if none>"
  },
  "dependency_graph": {
    "description": "Resolved dependency graph as actually executed — not as planned in uwf-cbs.",
    "edges": [
      {
        "from": "<string — component name or ID>",
        "to": "<string — component name or ID>",
        "type": "<string — enum: build-time | run-time | test-time>",
        "resolved": "<boolean — true if confirmed present at acceptance; false if assumed>"
      }
    ]
  },
  "build_sequence": [
    {
      "step": "<integer — 1-based>",
      "component": "<string — component name>",
      "phase": "<string — enum: foundation | core | integration | verification | release>",
      "status": "<string — enum: executed | skipped | deferred>",
      "notes": "<string | null>"
    }
  ],
  "adrs": [
    {
      "id": "<string — ADR number, e.g. 'ADR-0001'>",
      "title": "<string>",
      "status": "<string — enum: accepted | deprecated | superseded>",
      "decision_summary": "<string — one sentence: what was decided>",
      "rationale_summary": "<string — one sentence: why this decision was made>",
      "linked_story_ids": "<string | null — comma-separated story IDs>"
    }
  ],
  "gap_log": [
    {
      "id": "<string — gap ID, e.g. 'GAP-0001'>",
      "description": "<string — what could not be resolved>",
      "source": "<string — stage or artifact that flagged this gap, e.g. 'discovery', 'risk-plan'>",
      "impact": "<string — enum: blocked | degraded | unresolved | accepted>",
      "resolution_notes": "<string | null — how it was handled or why it was accepted unresolved>"
    }
  ],
  "divergence_log": [
    {
      "id": "<string — divergence ID, e.g. 'DIV-0001'>",
      "description": "<string — what differed from the blueprint>",
      "blueprint_ref": "<string — which uwf-cbs entry or blueprint section described the original plan>",
      "actual": "<string — what was done instead>",
      "reason": "<string | null — why the divergence occurred>",
      "impact": "<string — enum: scope-change | deferral | substitution | addition | removal>"
    }
  ]
}
```

### Field Constraints

| Field | Constraint |
|---|---|
| `schema_version` | Must be `"1.0.0"` for this version of the skill |
| `produced_at` | ISO 8601 with timezone offset (e.g., `2025-01-01T12:00:00Z`) |
| `components[].status` | Must use the defined enum; never free text |
| `components[].confidence` | `1.0` for components directly evidenced by code, tests, or ADRs; `0.0–0.9` for brownfield-inferred entries |
| `components[].confidence_basis` | Required when `confidence < 1.0`; explains the inference basis |
| `environment.pinned_dependencies` | List every dependency found in lock files or requirements files; empty array `[]` if none found |
| `gap_log` | Carry forward all unresolved gaps from `{role}-risk-plan.md` and `{role}-discovery.md`; empty array `[]` if none |
| `divergence_log` | **Required — must not be omitted.** If no divergences were detected, populate as an explicit empty array `[]`. The field must always be present. |

---

## uwf-br Layer 5 Closure Format

Append stratum 5 to the existing `{output_path}/{role}-br.json`. Stratum 5 represents the final closed state of the Build Record.

Add the following block inside `strata` after stratum 4:

```json
"5": {
  "label": "Final State",
  "description": "Point-in-time closure record. Populated by the snapshot stage after acceptance. Records what was delivered, what was deferred, and where execution diverged from the blueprint.",
  "closed_at": "<ISO 8601 timestamp>",
  "entries": []
}
```

Populate `entries` with the following records (one entry per item):

| Entry | Source | Content |
|---|---|---|
| Delivery summary | `{role}-acceptance.md` | One entry summarising what was accepted: component count, story count, verdict |
| Deferred items | `{role}-drs.json` `components[]` where `status == "deferred"` | One entry listing component names and deferral rationale |
| Dropped items | `{role}-drs.json` `components[]` where `status == "dropped"` | One entry listing component names and drop rationale |
| Divergence count | `{role}-drs.json` `divergence_log` | One entry: total divergence count and the IDs of any divergences with `impact == "scope-change"` |
| Gap carry-forward | `{role}-drs.json` `gap_log` where `impact != "accepted"` | One entry: list of unresolved gap IDs and their impact levels |
| DRS reference | `{output_path}/{role}-drs.json` | One entry recording the path to the produced DRS file |

Each entry must conform to the stratum entry schema:

```json
{
  "id":          "5-<sequential_integer>",
  "source":      "<stage or artifact name>",
  "summary":     "<single sentence: what this entry records>",
  "detail":      "<full text, reference, or structured content>",
  "recorded_at": "<ISO 8601 timestamp>"
}
```

---

## uwf-changelog Append Format

Append the following record to `{output_path}/uwf-changelog.md`. If the file does not exist, create it with a heading before appending.

```markdown
## [SNAPSHOT] {role} — {ISO 8601 date}

- **Event:** Workflow closure — snapshot produced
- **Artifact:** `{output_path}/{role}-drs.json`
- **Components delivered:** {count of components where status == "delivered"}
- **Components deferred:** {count of components where status == "deferred"}
- **Components dropped:** {count of components where status == "dropped"}
- **Divergences recorded:** {count of divergence_log entries} ({count where impact == "scope-change"} scope-changes)
- **Gaps carried forward:** {count of gap_log entries where impact != "accepted"}
- **uwf-br layer 5 closed at:** {ISO 8601 timestamp}
- **Accepted by:** `{output_path}/{role}-acceptance.md`
```

---

## Step-by-Step Instructions

Execute these steps in order. Do not skip a step. Do not advance to the next step until the current step is complete.

1. **Verify the acceptance gate has passed.** Read `{output_path}/{role}-acceptance.md`. Confirm it contains `verdict: approved`. If it does not, abort and record the error — the snapshot stage must only run on accepted state.

2. **Read all inputs.** Load each file listed in the Inputs table. For each file that is absent, record a gap entry in the `gap_log` using `"source": "snapshot-stage"` and `"impact": "unresolved"`, then continue.

3. **Build the component list.**
   - Read the `components` table summary from `{role}-blueprint.md` (or from `{role}-br.json` stratum 3 entries if the blueprint summary is absent).
   - For each component, determine its actual delivery status: `delivered` (present in acceptance), `partial` (partially delivered), `deferred` (explicitly deferred during the run), or `dropped` (removed from scope).
   - Set `confidence` to `1.0` for any component directly evidenced by the acceptance document, test results, or ADR. Set `confidence < 1.0` and populate `confidence_basis` for any component inferred from brownfield discovery findings.
   - Populate `version_pinned` from lock files, package manifests, or version tags found in the workspace. Use `null` if no version information is available.

4. **Record the environment.**
   - Detect the runtime, OS, and package manager from workspace files (e.g., `.nvmrc`, `package.json`, `pyproject.toml`, `Gemfile`, `go.mod`, Dockerfiles, CI configuration files).
   - List all pinned dependencies from lock files (`package-lock.json`, `yarn.lock`, `Pipfile.lock`, `go.sum`, etc.). If no lock file exists, list what is available from manifest files and note the absence of a lock file in `environment.notes`.
   - List environment variables from `.env.example`, README, or inline documentation. Mark each as `required: true` or `required: false`.
   - If no environment information can be determined, set `runtime`, `os`, and `package_manager` to `null` and record a gap.

5. **Build the resolved dependency graph.**
   - Use the `dependencies` table from `{role}-blueprint.md` as the planned graph.
   - For each edge, set `resolved: true` if the dependency was present and functioning at acceptance, `resolved: false` if it was assumed but not confirmed.
   - Add any additional edges discovered during the run that were not in the original plan.

6. **Record the build sequence as executed.**
   - Read the `sequencing` table from `{role}-blueprint.md` or stratum 3 of `{role}-br.json`.
   - For each planned step, set `status` to `executed`, `skipped`, or `deferred` based on what actually happened during the run.

7. **Compile the ADR set.**
   - Read each `docs/adr/ADR-*.md` file.
   - For each ADR, extract `id`, `title`, `status`, a one-sentence `decision_summary`, and a one-sentence `rationale_summary`.
   - Populate `linked_story_ids` from any story references found in the ADR text.

8. **Populate the gap log.**
   - Read `{role}-risk-plan.md` (if present). Carry forward any risk entries with `status: open` or `status: unresolved` as gap entries using `"source": "risk-planner"`.
   - Read `{role}-discovery.md` (if present). Carry forward any unknowns or unresolved findings as gap entries using `"source": "discovery"`.
   - Include any gaps recorded in steps 2–7 of these instructions.
   - If there are no gaps, set `gap_log` to an explicit empty array `[]`.

9. **Populate the divergence log.**
   - Compare each component in the `components` array against the planned component list in `{role}-blueprint.md`.
   - For each component that was `deferred`, `dropped`, or delivered differently than planned, create a divergence entry.
   - Compare the executed build sequence against the planned sequence. Record any reordering or skipped steps as divergences.
   - Compare ADR decisions against requirements. If any requirement was not fulfilled as specified, record a divergence.
   - **This field is required.** If no divergences are detected, set `divergence_log` to an explicit empty array `[]`. The field must be present in every produced DRS.

10. **Write `{output_path}/{role}-drs.json`.**
    - Serialize the complete uwf-drs object as JSON with 2-space indentation.
    - Validate that all required fields are present and that `divergence_log` is explicitly set (even if empty).

11. **Close uwf-br layer 5.**
    - Read `{output_path}/{role}-br.json`.
    - Append stratum 5 using the format defined in the uwf-br Layer 5 Closure Format section above.
    - Write the updated `{role}-br.json` back to disk.

12. **Append to uwf-changelog.**
    - Append the closure record to `{output_path}/uwf-changelog.md` using the format defined in the uwf-changelog Append Format section above.
    - If the file does not exist, create it with the heading `# UWF Changelog` before appending.

13. **Run exit criteria checks** (see Exit Criteria section). Record the result of each check in `{role}-drs.json` — add a top-level `"exit_criteria"` object (see Exit Criteria section).

---

## Exit Criteria

The stage is not complete until all of the following are true. Each check is binary: pass or fail.

| # | Check | Pass Condition |
|---|---|---|
| 1 | `acceptance` gate passed | `{role}-acceptance.md` exists and contains `verdict: approved` |
| 2 | `components` array populated | `components` has ≥ 1 entry |
| 3 | All components have a status | Every `components[]` entry has a non-null `status` from the defined enum |
| 4 | All brownfield entries have `confidence_basis` | Every entry with `confidence < 1.0` has a non-null `confidence_basis` |
| 5 | `divergence_log` explicitly set | `divergence_log` is present in the JSON and is either a non-empty array or an explicit empty array `[]` — field absence is a failure |
| 6 | `gap_log` present | `gap_log` is present and is either a non-empty array or an explicit empty array `[]` |
| 7 | uwf-br layer 5 written | `{role}-br.json` contains `strata["5"]` with a `closed_at` timestamp and ≥ 1 entry |
| 8 | Changelog appended | `uwf-changelog.md` contains a `[SNAPSHOT]` entry with the current `role` and date |
| 9 | DRS file is valid JSON | `{role}-drs.json` parses without error |

Record the outcome of each check in a top-level `"exit_criteria"` object appended to the DRS:

```json
"exit_criteria": {
  "1_acceptance_gate_passed":              "<pass | fail>",
  "2_components_populated":                "<pass | fail>",
  "3_all_components_have_status":          "<pass | fail>",
  "4_brownfield_confidence_basis_present": "<pass | fail>",
  "5_divergence_log_explicitly_set":       "<pass | fail>",
  "6_gap_log_present":                     "<pass | fail>",
  "7_uwf_br_layer5_written":               "<pass | fail>",
  "8_changelog_appended":                  "<pass | fail>",
  "9_drs_file_is_valid_json":              "<pass | fail>"
}
```

---

## Error Handling

| Condition | Action |
|---|---|
| `{role}-acceptance.md` is absent or does not contain `verdict: approved` | Abort. Do not produce a DRS on unaccepted state. Record the error and block the stage. |
| `{role}-br.json` is absent | Abort. The Build Record must exist before it can be closed. Record the error. |
| `{role}-blueprint.md` is absent | Continue with a warning. Derive component and sequence data from `{role}-br.json` strata 3–4 alone. Record the absence in the gap log. |
| `{role}-risk-plan.md` is absent | Continue. No risk-sourced gaps will be carried forward. Record the absence in the gap log. |
| `{role}-discovery.md` is absent | Continue. No discovery-sourced gaps will be carried forward. Record the absence in the gap log. |
| No lock files found | Continue. Set `pinned_dependencies` to `[]`. Record the absence in `environment.notes`. |
| No ADR files found | Continue. Set `adrs` to `[]`. Record the absence in the gap log with `"source": "adr-set"`. |
| DRS JSON serialization fails | Abort. Record the error. Do not write a partial DRS. |
