---
name: uwf-snapshot
description: "Snapshot stage skill: produce uwf-drs as a point-in-time reconstruction record, close uwf-br layer 5, and append a closure entry to uwf-changelog."
---

# UWF Snapshot Skill — Snapshot Stage

Final output stage of Phase 3 (after `acceptance`, before `retro`). It serializes the accepted state into the **Deterministic Reconstruction Spec (uwf-drs)**, a backward-looking record (what was built, why, the environment at closure, where execution diverged from the plan) that lets a cold-starting agent understand and extend the system. It also closes the Build Record (`uwf-br`) with stratum 5 and appends a closure entry to `uwf-changelog`.

## Inputs and outputs

Read these (a missing one becomes a `gap_log` entry with `"source": "snapshot-stage"`, `"impact": "unresolved"`):

- Required: `{output_path}/{role}-acceptance.md`, `{output_path}/{role}-br.json`
- `{output_path}/{role}-blueprint.md`: planned components, dependencies, sequence (divergence baseline)
- Only when a section needs them: `docs/adr/ADR-*.md` (for `adrs`), `{output_path}/{role}-risk-plan.md` and `{output_path}/{role}-discovery.md` (gap carry-forward), `{output_path}/{role}-intake.md` / `{role}-requirements.md` (original scope), workspace manifests and lock files (environment)
- `{output_path}/uwf-changelog.md`: existing changelog (create if absent)

| Output | Path |
|---|---|
| Reconstruction spec | `{output_path}/{role}-drs.json` |
| Build Record with stratum 5 appended | `{output_path}/{role}-br.json` |
| Changelog with closure entry appended | `{output_path}/uwf-changelog.md` |

## uwf-drs schema

All top-level fields are required (use `null` where data is genuinely absent, `[]` for empty lists); `exit_criteria` is added at the end.

```json
{
  "schema_version": "1.0.0",
  "produced_at": "<ISO 8601 with timezone, e.g. 2025-01-01T12:00:00Z>",
  "workflow": "<persona, e.g. sw_dev>",
  "role": "<artifact prefix, e.g. issues>",
  "acceptance_ref": "<path to the acceptance artifact>",
  "components": [{
    "id": "<uwf-cbs component ID, or inferred>", "name": "", "description": "",
    "type": "service | library | module | database | cli | external | interface | other",
    "version_pinned": "<string | null>",
    "status": "delivered | partial | deferred | dropped",
    "source_story_ids": "<comma-separated | null>", "source_adr_ids": "<comma-separated | null>",
    "confidence": "<0.0-1.0; 1.0 = directly evidenced by code, tests or ADRs; below 1.0 = brownfield-inferred>",
    "confidence_basis": "<string; required when confidence < 1.0, else null>"
  }],
  "environment": {
    "runtime": "<e.g. Node.js 20.x | null>", "os": "<string | null>", "package_manager": "<string | null>",
    "pinned_dependencies": [{"name": "", "version": "", "scope": "runtime | dev | test | peer"}],
    "environment_variables": [{"key": "", "required": true, "description": ""}],
    "notes": "<string | null>"
  },
  "dependency_graph": {
    "description": "Resolved dependency graph as actually executed, not as planned in uwf-cbs.",
    "edges": [{"from": "<component>", "to": "<component>", "type": "build-time | run-time | test-time", "resolved": true}]
  },
  "build_sequence": [{"step": 1, "component": "", "phase": "foundation | core | integration | verification | release", "status": "executed | skipped | deferred", "notes": "<string | null>"}],
  "adrs": [{"id": "ADR-0001", "title": "", "status": "accepted | deprecated | superseded", "decision_summary": "<one sentence>", "rationale_summary": "<one sentence>", "linked_story_ids": "<comma-separated | null>"}],
  "gap_log": [{"id": "GAP-0001", "description": "", "source": "<stage or artifact, e.g. discovery, risk-plan>", "impact": "blocked | degraded | unresolved | accepted", "resolution_notes": "<string | null>"}],
  "divergence_log": [{"id": "DIV-0001", "description": "<what differed from the blueprint>", "blueprint_ref": "<uwf-cbs entry or blueprint section>", "actual": "", "reason": "<string | null>", "impact": "scope-change | deferral | substitution | addition | removal"}]
}
```

Constraints: enums are exact (never free text). `pinned_dependencies` lists every dependency in lock/requirements files (`[]` if none). `gap_log` carries forward unresolved gaps from the risk plan and discovery (`[]` if none). **`divergence_log` must always be present**; use `[]` when there are no divergences (the gate checks for the field).

## uwf-br stratum 5

Add to `strata` in `{output_path}/{role}-br.json` after stratum 4:

```json
"5": {"label": "Final State",
      "description": "Point-in-time closure record. Populated by the snapshot stage after acceptance. Records what was delivered, what was deferred, and where execution diverged from the blueprint.",
      "closed_at": "<ISO 8601>", "entries": []}
```

Entries use `{"id": "5-<n>", "source": "<stage or artifact>", "summary": "<one sentence>", "detail": "<text or structured content>", "recorded_at": "<ISO 8601>"}`, one each for:

1. Delivery summary (from acceptance): component count, story count, verdict.
2. Deferred items: names and rationale of `components[]` with `status == "deferred"`.
3. Dropped items: names and rationale of `components[]` with `status == "dropped"`.
4. Divergence count: total, plus the IDs with `impact == "scope-change"`.
5. Gap carry-forward: IDs and impact levels of `gap_log` entries with `impact != "accepted"`.
6. DRS reference: the path of the produced DRS file.

## uwf-changelog entry

Append to `{output_path}/uwf-changelog.md` (if absent, create it starting with `# UWF Changelog`):

```markdown
## [SNAPSHOT] {role} — {ISO 8601 date}

- **Event:** Workflow closure — snapshot produced
- **Artifact:** `{output_path}/{role}-drs.json`
- **Components delivered:** {count where status == "delivered"}
- **Components deferred:** {count where status == "deferred"}
- **Components dropped:** {count where status == "dropped"}
- **Divergences recorded:** {divergence_log count} ({count where impact == "scope-change"} scope-changes)
- **Gaps carried forward:** {count of gap_log where impact != "accepted"}
- **uwf-br layer 5 closed at:** {ISO 8601 timestamp}
- **Accepted by:** `{output_path}/{role}-acceptance.md`
```

## Steps (in order)

1. **Verify acceptance.** `{role}-acceptance.md` must contain `verdict: approved`; otherwise abort and report the error (never snapshot unaccepted state).
2. **Read the inputs.**
3. **Components.** Take the component list from `{role}-blueprint.md` (or `{role}-br.json` stratum 3 if the blueprint is absent). Set `status` from what was actually delivered. Set `confidence`/`confidence_basis` per the schema. Set `version_pinned` from lock files, manifests or version tags (`null` if unknown).
4. **Environment.** Detect runtime, OS and package manager from workspace files (`.nvmrc`, `package.json`, `pyproject.toml`, `go.mod`, Dockerfiles, CI config). List pinned dependencies from lock files; without a lock file, use the manifest and say so in `environment.notes`. List environment variables from `.env.example` or the README. If nothing can be determined, set `runtime`, `os`, `package_manager` to `null` and add a gap.
5. **Dependency graph.** Start from the blueprint's `dependencies`; set `resolved` true if present and working at acceptance, false if only assumed; add edges discovered during the run.
6. **Build sequence.** Start from the blueprint `sequencing` (or br stratum 3); set each step's `status` to what actually happened.
7. **ADRs.** For each `docs/adr/ADR-*.md`: `id`, `title`, `status`, one-sentence `decision_summary` and `rationale_summary`, `linked_story_ids`.
8. **Gap log.** Carry forward open/unresolved risk-plan entries (`"source": "risk-planner"`), unresolved discovery findings (`"source": "discovery"`), and gaps from steps 2-7.
9. **Divergence log.** Record each component that was deferred, dropped or delivered differently than the blueprint; reordered or skipped build steps; requirements not fulfilled as specified.
10. **Write `{role}-drs.json`** (2-space indent) with every required field and an explicit `divergence_log`.
11. **Close br layer 5.** Append stratum 5 to `{role}-br.json` and write it back.
12. **Append the changelog entry.**
13. **Exit criteria.** Add the results to the DRS as a top-level `exit_criteria` object.

## Exit criteria (each pass/fail)

```json
"exit_criteria": {
  "1_acceptance_gate_passed": "<pass|fail>",              // acceptance.md contains verdict: approved
  "2_components_populated": "<pass|fail>",                // components has >= 1 entry
  "3_all_components_have_status": "<pass|fail>",          // every component has a non-null status from the enum
  "4_brownfield_confidence_basis_present": "<pass|fail>", // confidence < 1.0 implies non-null confidence_basis
  "5_divergence_log_explicitly_set": "<pass|fail>",       // field present, array or []
  "6_gap_log_present": "<pass|fail>",                     // field present, array or []
  "7_uwf_br_layer5_written": "<pass|fail>",               // strata["5"] has closed_at and >= 1 entry
  "8_changelog_appended": "<pass|fail>",                  // [SNAPSHOT] entry with current role and date
  "9_drs_file_is_valid_json": "<pass|fail>"
}
```

Write plain JSON (no comments) in the actual file.

## Error handling

- Acceptance absent or without `verdict: approved`, or `{role}-br.json` absent: abort and report; do not produce a DRS.
- Blueprint absent: continue; derive components and sequence from br strata 3-4; add a gap.
- Risk plan, discovery or ADR files absent: continue; add a gap (`"source": "adr-set"` for ADRs, `adrs: []`).
- No lock files: continue; `pinned_dependencies: []`, note it in `environment.notes`.
- DRS serialization fails: abort; never write a partial DRS.
