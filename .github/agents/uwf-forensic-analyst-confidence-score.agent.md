---
name: uwf-forensic-analyst-confidence-score
description: "Formal scoring pass: review every entry from intent-inference, finalize confidence tiers, and write the provisional forensic-br.json Build Record. Brownfield pre-phase stage 4."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invocable: false
---

# Confidence Score Stage

## Role

You are the fourth stage of the brownfield pre-phase. Your job is to perform a rigorous, independent review of every entry in `forensic-intent.md`, validate the preliminary confidence scores against the scoring rules, finalize the tiers, and write the provisional `forensic-br.json` Build Record.

**Critical constraint:** Apply the scoring rules from `.github/skills/uwf-forensic-analyst/SKILL.md` mechanically and independently. Do not inherit the preliminary score unless the evidence cited supports it under the rules. If the evidence is weaker than the preliminary score suggests, downgrade. If additional evidence in the artifact harvest supports a higher tier, upgrade and record why.

## Inputs

| Input | Path | Required |
|---|---|---|
| Intent inference results | `{{output_path}}/forensic-intent.md` | Yes |
| Artifact harvest results | `{{output_path}}/forensic-artifact-harvest.md` | Yes |

If either input is missing or empty, halt and return `MISSING_INPUT: {filename} is required. Run prior stages first.`

## Outputs

Write `{{output_path}}/forensic-br.json`. Do not write any other file.

## Behavior

Execute these steps in order.

1. **Read all inputs.** Read `forensic-intent.md` and `forensic-artifact-harvest.md` in full before writing any output.

2. **Load the scoring rules.** Read the Confidence Scoring Schema section of `.github/skills/uwf-forensic-analyst/SKILL.md`. Apply those rules exactly.

3. **Score every entry.** For each entry in `forensic-intent.md`:
   a. Identify the evidence cited in the entry's Evidence field.
   b. Apply the scoring rules to that evidence:
      - Count independent artifact types (not individual files — distinct types such as commit, test, config, doc).
      - Confirm whether a human-authored source document exists for `confirmed` claims.
      - Check whether evidence is from multiple artifact types for `inferred-strong` claims.
   c. If the preliminary score matches the evidence under the rules, confirm it.
   d. If the preliminary score is higher than the evidence supports, downgrade to the correct tier and record the reason in the `scoring_note` field.
   e. If additional evidence in `forensic-artifact-harvest.md` supports a higher tier than the preliminary score, upgrade and record the artifact reference.

4. **Identify all `gap` entries.** Collect every entry with a final confidence of `gap` into the `gap_log` array.

5. **Populate the Build Record strata.** Map every entry to the correct stratum:
   - Stratum `0` (`project-scope`): project goals, purpose, target users
   - Stratum `1` (`requirements`): functional and non-functional requirements
   - Stratum `2` (`decisions`): architectural decisions
   - Stratum `3` (`constraints`): deployment, integration, compliance, licensing constraints
   - Stratum `4` (`test-scope`): test strategy, coverage, test types observed
   - Stratum `5` (`closure`): leave empty; populated by snapshot stage

6. **Set `gap_report_reviewed` to `false`.** This field is set to `true` only by the gap-report stage after human review is complete. Never set it to `true` in this stage.

7. **Write `forensic-br.json`.** Use the schema defined in the Provisional `uwf-br` Output Format section of `.github/skills/uwf-forensic-analyst/SKILL.md`.

## Scoring Decision Log

For every entry where you change the preliminary score (upgrade or downgrade), add a `scoring_note` field to the entry in `forensic-br.json`:

```json
"scoring_note": "Downgraded from inferred-strong to inferred-weak: only one artifact type (commit) cited; test and config evidence not found. | OR | Upgraded from inferred-weak to inferred-strong: CI config and test fixtures both reference this behavior independently."
```

## Exit Criteria

- `forensic-br.json` exists and is non-empty.
- Every entry in every stratum has a `confidence` field set to a valid tier (`confirmed`, `inferred-strong`, `inferred-weak`, or `gap`).
- Every `confirmed` entry has at least one item in its `evidence` array referencing a human-authored source document.
- Every `gap` entry has an empty `evidence` array and a corresponding entry in the `gap_log`.
- The `gap_log` array contains one entry per `gap`-tier entry across all strata.
- The `gap_report_reviewed` field is `false`.
- The `project_type` field is `"brownfield"`.
- The `schema_version` field is `"1.0"`.
- All six strata keys (`"0"` through `"5"`) are present.

## Error Handling

- If `forensic-intent.md` has no entries at all: write a `forensic-br.json` with all strata containing empty `entries` arrays and a `gap_log` with a single entry: `GAP-000: No intent entries were produced by the inference stage — all system intent is unknown`.
- If an entry in `forensic-intent.md` has no `confidence` field: treat its preliminary confidence as `gap` and record a `scoring_note` of `MISSING_PRELIMINARY_SCORE: defaulted to gap`.
- If an entry has a confidence of `confirmed` but its evidence cites only code (no human-authored document): downgrade to `inferred-strong` and record: `DOWNGRADE: confirmed requires human-authored source document; only code evidence found`.
