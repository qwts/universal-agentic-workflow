---
name: uwf-review
description: "Shared review infrastructure: SQLite-backed findings, script commands, fix-loop gate support. Loaded as a dependency by uwf-reviewer; do not load directly in new agents."
deprecated: true
superseded_by: uwf-reviewer
---

> **Deprecated — shared infrastructure only.** Reviewer agents load `.github/skills/uwf-reviewer/SKILL.md` and use this file for the script commands and fix-loop protocol below.

# UWF Review Skill

Review runs and findings live in a SQLite database (`.github/skills/uwf-review/uwf-reviews.db`, gitignored, schema in `review-schema.yaml`; tables `reviews` and `findings`). **All review operations MUST use the script:** `node .github/skills/uwf-review/reviews.mjs <command> [options]`.

## Script reference

| Command | Purpose |
|---|---|
| `start --role <r> --stage <s> [--notes <text>]` | Open a review run; returns `review_id` |
| `finding --review-id <n> --description <text> [--severity critical\|major\|minor] [--file-path <path>]` | Add a finding; returns `finding_id` |
| `verdict --review-id <n> --verdict approved\|changes_requested\|rejected [--notes <text>]` | Set the final verdict |
| `get --review-id <n>` | A review with all its findings |
| `list [--role <r>] [--stage <s>] [--verdict <v>]` | List review runs |
| `list-findings --review-id <n> [--severity <s>] [--status <s>]` | List findings; **exits `1` if any open `critical`/`major` finding exists** |
| `close-finding --id <n>` / `reopen --id <n>` | Mark a finding `fixed` / reopen it |

Severities: `critical` · `major` · `minor`. Verdicts: `approved` · `changes_requested` · `rejected` · `pending`. Finding statuses: `open` · `fixed` · `wontfix`. Output is JSON; exit `0` = success/gate-pass, `1` = error/gate-fail, `2` = usage error. Databases resolve from `--db-path`, then `--data-dir`, then `UWF_DATA_DIR`, then the skill folder.

## Review procedure

The reviewer is **read-only** (no `edit` or `execute`); it reads artifacts and logs findings, never fixes.

1. `reviews.mjs start --role {role} --stage {stage}`.
2. Read the stage's artifacts in `{outputPath}/` and the inputs declared for the stage in `stages.yaml`; evaluate completeness, consistency, acceptance criteria, and security/quality gaps.
3. Log every finding with `reviews.mjs finding` (one per issue, `--file-path` where applicable).
4. Set the verdict with `reviews.mjs verdict`: `approved` (no open `critical`/`major`; recommend Acceptance), `changes_requested` (one or more `critical`/`major`; return finding IDs only, no fix instructions), `rejected` (fundamental scope or approach problem; escalate to the orchestrator).
5. **Write the output file** (e.g. `{outputPath}/{prefix}-review.md`) summarizing the DB. It MUST contain the line `verdict: approved` (or `verdict: changes_requested` / `verdict: rejected`). This is the stage gate artifact.
6. **Also write the structured result** with the same stem and a `.result.json` suffix (`{outputPath}/{prefix}-review.md` becomes `{outputPath}/{prefix}-review.result.json`; for acceptance, `{prefix}-acceptance.result.json`). It MUST match `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`:
   ```json
   { "verdict": "approved", "findings": [ { "severity": "high", "summary": "...", "location": "path:line" } ], "notes": "..." }
   ```
   `verdict` is `approved` | `changes_requested` | `blocked` (DB `rejected` maps to `blocked`); `findings[].severity` is `high` | `medium` | `low` (DB `critical` maps to `high`, `major` to `medium`, `minor` to `low`); `location` and `notes` are optional; use `"findings": []` when there are none. The JSON `verdict` and the markdown `verdict:` line MUST agree.

Severity guide: `critical` = correctness bug, security vulnerability, data loss risk, missing required artifact; `major` = significant gap that blocks acceptance (missing section, broken logic, untested path); `minor` = polish or non-blocking improvement.

## Fix loop and gate

On `changes_requested` the orchestrator returns to the implementer with `list-findings --review-id <n> --status open`; the implementer fixes and calls `close-finding` per fix; the reviewer is re-invoked on the same `review_id` (or a new run). `list-findings --status open` exits `0` only when no open `critical`/`major` finding remains.

The stage gate checks `/verdict` equals `approved` in `{prefix}-<stage>.result.json` (`require_json_field`) AND `verdict: approved` in the markdown file. The reviewer MUST write both; the file check is authoritative, not `list-findings`.

## Hard constraints

- Never use `edit` or `execute`; read files only.
- Never prescribe implementation ("create X with Y", "add section A to file B"); report the gap only.
- Never invent content for missing files; report the absence and why the file is expected.
- Stay within the stage named in the review run; do not review other stages' artifacts unless they are declared `inputs` for this stage.
