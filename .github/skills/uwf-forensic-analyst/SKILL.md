# Skill: uwf-forensic-analyst

Brownfield pre-phase archetype. Runs before the standard First phase on existing projects where intent was never recorded. Produces a provisional Build Record (`uwf-br`) with confidence scores so that the normal First/Second/Third phases can proceed from a documented baseline.

---

## Persona Configuration

| Property | Value |
|---|---|
| `workflow` | `forensic-analyst` |
| `role` | `forensic` |
| Artifact prefix | `forensic-` |
| Output path default | `./tmp/workflow-artifacts` |

---

## Scope

This skill governs the **brownfield pre-phase only**. It does not replace the standard Phase 1/Phase 2/Phase 3. It runs before them and produces a provisional `uwf-br` that becomes the starting state for Phase 1.

**When to activate:**
- The project target is an existing codebase or set of repositories.
- No formal requirements baseline, ADR set, or design documents exist.
- The user selects `brownfield` as the project type at intake.

**When NOT to activate:**
- New (greenfield) projects with no prior code — start at Phase 1 directly.
- Projects that have a confirmed requirements pack and ADR set already — promote those artifacts and start at Phase 1.

---

## Subagent Roster

| Subagent | Role |
|---|---|
| `uwf-forensic-analyst-repo-audit` | Enumerate repos in scope; map boundaries, seams, and tech stack |
| `uwf-forensic-analyst-artifact-harvest` | Collect all available evidence artifacts |
| `uwf-forensic-analyst-intent-inference` | Infer requirements and decisions from observed behavior |
| `uwf-forensic-analyst-confidence-score` | Formal scoring pass — assign tier to every inferred entry |
| `uwf-forensic-analyst-gap-report` | Surface all gaps; produce the human-review document |

---

## Stage Sequence

> **This table is documentation only — do NOT use it as your stage list.**
> Run `node .github/skills/uwf-forensic-analyst/run.mjs --list-stages` at startup and execute every stage the script returns.

Execute stages **in this exact order**. Do not advance past a stage until its gate passes.

| # | Stage | Subagent | Purpose |
|---|---|---|---|
| 1 | `repo-audit` | `uwf-forensic-analyst-repo-audit` | Enumerate all repos in scope, map service boundaries, identify seams, catalog tech stack per repo. |
| 2 | `artifact-harvest` | `uwf-forensic-analyst-artifact-harvest` | Collect all available evidence: commits, tickets, docs, configs, CI/CD definitions, test suites, existing ADRs. |
| 3 | `intent-inference` | `uwf-forensic-analyst-intent-inference` | Infer requirements and decisions from observed behavior and collected artifacts. Assign preliminary confidence to each entry. |
| 4 | `confidence-score` | `uwf-forensic-analyst-confidence-score` | Formal scoring pass: assign tier (`confirmed`, `inferred-strong`, `inferred-weak`, `gap`) to every entry. |
| 5 | `gap-report` | `uwf-forensic-analyst-gap-report` | Surface all `gap` entries; produce the structured human-review document; block until human resolves or explicitly marks each gap out-of-scope. |

---

## Gate Enforcement

Gate logic is implemented in [`run.mjs`](run.mjs) — not in this document. The orchestrator checks each stage gate by running:

```sh
node .github/skills/uwf-forensic-analyst/run.mjs --check-gate <stageName>
```

To see the full stage list with retry limits:

```sh
node .github/skills/uwf-forensic-analyst/run.mjs --list-stages
```

---

## Confidence Scoring Schema

Every entry in `forensic-intent.md` and `forensic-br.json` must carry a `confidence` field set to exactly one of these tiers.

### Tiers

| Tier | Label | Definition |
|---|---|---|
| `confirmed` | Confirmed | Explicitly documented and human-verified. Source is an ADR, formal spec, or resolved ticket. No inference needed. |
| `inferred-strong` | Inferred — Strong | Multiple independent artifacts agree. Example: the same behavior is reflected consistently in commit messages, test assertions, and CI configuration. |
| `inferred-weak` | Inferred — Weak | Single artifact, or multiple artifacts that partially agree but leave room for alternate interpretation. |
| `gap` | Gap | No evidence found. The entry exists because the absence of evidence is itself meaningful. Human input is required before proceeding. |

### Scoring Rules

1. Start every new entry at `gap`. Promote the tier only when evidence is found.
2. A `confirmed` rating requires at least one traceable human-authored source document (ADR, spec, ticket URL). Do not assign `confirmed` from code alone.
3. An `inferred-strong` rating requires ≥ 2 independent artifact types (e.g., test + config, commit + documentation comment). Correlated artifacts from the same source (e.g., two test files written in the same commit) count as one independent artifact.
4. An `inferred-weak` rating applies when only one artifact type supports the inference, or when evidence is present but ambiguous.
5. Never fabricate rationale. If the evidence is absent, the entry is `gap`. Hallucinated rationale is worse than a gap — it produces false confidence that propagates through the entire downstream workflow.
6. When promoting a tier, record the artifact(s) that justified the promotion in the `evidence` field.

---

## Gap Handling

### What constitutes a `gap` (not `inferred-weak`)

An entry is `gap` when:
- No artifact of any type supports the claim.
- The only available evidence is the complete absence of contradicting signals (i.e., argument-from-silence — this does not count as evidence).
- Conflicting artifacts exist and neither can be considered authoritative.

An entry is `inferred-weak` (not `gap`) when:
- At least one artifact supports the inference, even if that artifact is ambiguous.
- The conflict between artifacts can be resolved by a plausible common explanation (e.g., a feature was added in one commit and tested later).

### Gap escalation

All `gap` entries must be surfaced in the `forensic-gap-report.md`. Each gap entry must include:
- The entry ID and a one-line description of what is unknown.
- Context: what artifacts were checked, what they did and did not say.
- A resolution prompt: a specific, answerable question the human can resolve.
- A suggested default: if the gap cannot be resolved, what the safest assumption is and why.

---

## Human Review Handoff Format

The `forensic-gap-report.md` is the formal handoff to the human reviewer. It must follow this structure:

```markdown
# Forensic Gap Report — {project name}

Generated: {ISO 8601 timestamp}
Pre-phase status: BLOCKED — human review required

## Summary

| Metric | Count |
|---|---|
| Total entries | {n} |
| confirmed | {n} |
| inferred-strong | {n} |
| inferred-weak | {n} |
| gap | {n} |

## Gap Entries Requiring Resolution

### GAP-{id}: {short description}

**Unknown:** {what is missing}
**Checked:** {list of artifact types checked}
**Observation:** {what the artifacts did and did not say}
**Resolution question:** {specific, answerable question for the human}
**Suggested default:** {safe assumption if unresolvable, with rationale}
**Resolution:** [ ] Resolved: {answer} | [ ] Accepted as out-of-scope

---
```

The pre-phase is blocked until every gap entry has either:
- A human-provided resolution answer (promotes to `confirmed` or `inferred-strong`), or
- An explicit "Accepted as out-of-scope" checkbox checked by a human.

---

## Provisional `uwf-br` Output Format

The pre-phase produces `{output_path}/forensic-br.json`. This is the provisional Build Record that Phase 1 reads as its starting state.

Every entry in the Build Record must include a `confidence` field. Phase 1 agents read this field to determine whether prior work needs validation or replacement.

### Schema

```json
{
  "schema_version": "1.0",
  "project_type": "brownfield",
  "pre_phase_completed_at": "<ISO 8601>",
  "gap_report_reviewed": false,
  "strata": {
    "0": {
      "label": "project-scope",
      "entries": [
        {
          "id": "scope-001",
          "type": "goal",
          "description": "<inferred or confirmed goal>",
          "confidence": "inferred-strong",
          "evidence": ["<artifact type>: <artifact path or URL>"],
          "gaps": []
        }
      ]
    },
    "1": {
      "label": "requirements",
      "entries": [
        {
          "id": "req-001",
          "type": "functional",
          "description": "<inferred requirement>",
          "confidence": "inferred-weak",
          "evidence": ["commit: abc1234 — message references this behavior"],
          "gaps": ["No formal spec found. Single commit is the only source."]
        }
      ]
    },
    "2": {
      "label": "decisions",
      "entries": []
    },
    "3": {
      "label": "constraints",
      "entries": []
    },
    "4": {
      "label": "test-scope",
      "entries": []
    },
    "5": {
      "label": "closure",
      "entries": []
    }
  },
  "gap_log": [
    {
      "id": "GAP-001",
      "stratum": 1,
      "entry_id": "req-001",
      "description": "<what is unknown>",
      "resolution": null,
      "out_of_scope": false
    }
  ]
}
```

### Field constraints

| Field | Type | Required | Rule |
|---|---|---|---|
| `schema_version` | string | yes | Must be `"1.0"` |
| `project_type` | string | yes | Must be `"brownfield"` |
| `pre_phase_completed_at` | string | yes | ISO 8601 timestamp |
| `gap_report_reviewed` | boolean | yes | Set to `false` until human marks gaps resolved |
| `strata` | object | yes | Keys `"0"`–`"5"` must all be present |
| `entries[].id` | string | yes | Unique within stratum, format `{stratum-label}-{seq}` |
| `entries[].confidence` | string | yes | One of: `confirmed`, `inferred-strong`, `inferred-weak`, `gap` |
| `entries[].evidence` | array | yes | At least one entry for any tier above `gap`; empty array for `gap` entries |
| `gap_log` | array | yes | One entry per `gap`-tier entry across all strata |
| `gap_log[].resolution` | string or null | yes | `null` until human provides answer |
| `gap_log[].out_of_scope` | boolean | yes | `false` until human explicitly marks it out-of-scope |

---

## Exit Criteria

The pre-phase is complete when **all** of the following are true:

1. `forensic-repo-audit.md` exists and is non-empty.
2. `forensic-artifact-harvest.md` exists and is non-empty.
3. `forensic-intent.md` exists and is non-empty.
4. `forensic-br.json` exists and every entry has a `confidence` field set to a valid tier.
5. `forensic-gap-report.md` exists and lists all `gap` entries.
6. Every `gap` entry in `forensic-gap-report.md` has either:
   - A human-provided resolution (checkbox marked with answer), or
   - An explicit "Accepted as out-of-scope" checkbox checked.
7. `forensic-br.json` field `gap_report_reviewed` is set to `true`.

When exit criteria are met, hand off `forensic-br.json` as input to Phase 1. Phase 1 agents will validate, promote, or replace provisional entries as they run their own stages.

---

## Persona-Specific Operating Rules

- Never assign `confirmed` from code inspection alone. Code shows what was built, not what was decided.
- Never upgrade a `gap` entry without traceable evidence. The presence of a feature in code does not prove the intent was deliberate.
- All `inferred-weak` entries must carry a note explaining what would be needed to promote them to `inferred-strong` or `confirmed`.
- The gap report is not optional — even if there are zero gaps, produce the report with an empty gap table to confirm exhaustive review was performed.
- Do not begin Phase 1 until `gap_report_reviewed` is `true`.
