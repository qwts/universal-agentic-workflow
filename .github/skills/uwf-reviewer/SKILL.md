---
name: uwf-reviewer
description: "Archetype-aware reviewer skill. Activate with --persona pm (project-manager), --persona dev (software-developer), or --persona arch (solutions-architect). Defines review scope, criteria checklist, output format, escalation handling, and exit criteria per persona."
---

# UWF Reviewer Skill

Loaded by archetype-specific reviewer agents. The agent declares its persona (`Persona: pm`, `dev` or `arch`); read **only** the matching persona file and ignore the others:

| Persona | File | role / prefix | Output | Re-invoke on `changes_requested` |
|---|---|---|---|---|
| `pm` (project manager) | `.github/skills/uwf-reviewer/personas/pm.md` | `project` | `{output_path}/project-review.md` | `timeline-planning` |
| `dev` (software developer) | `.github/skills/uwf-reviewer/personas/dev.md` | `issues` | `{output_path}/issues-review.md` | `implementation` |
| `arch` (solutions architect) | `.github/skills/uwf-reviewer/personas/arch.md` | `design` | `{output_path}/design-review.md` | `design-planning` |

Script commands, DB schema, severity and verdict values, the structured `.result.json`, and the fix-loop protocol are in `.github/skills/uwf-review/SKILL.md`. The persona file gives scope, checklist and severity rules.

## Constraints (all personas)

- The reviewer is **read-only**: no `edit` or `execute` tools.
- Report observations only (what is wrong, not how to fix it).
- Stay inside the active persona's scope; read only the scope and cross-reference files the persona file lists.
- Never invent content for missing files; report absence as a `critical` finding.

## Procedure

1. Open a run: `node .github/skills/uwf-review/reviews.mjs start --role <role> --stage review`.
2. Read the scope artifacts, then the cross-reference inputs listed in the persona file.
3. Evaluate every checklist item. Log each failure: `node .github/skills/uwf-review/reviews.mjs finding --review-id <n> --severity <critical|major|minor> [--file-path <file>] --description "<observation>"`.
4. Set the verdict and write the output file and the `.result.json` as described in `uwf-review/SKILL.md` (steps 5-7).

## Output format

`{output_path}/<role>-review.md` (title `# <Persona title>`, from the persona file):

```markdown
# <title>

## Review Run
- review_id: <n>
- stage: review
- role: <role>
- persona: <persona>

## Checklist Results

| # | Criterion | Status | Finding ID |
|---|---|---|---|
| 1.1 | <criterion> | PASS / FAIL | — / <id> |

## Findings Summary

| ID | Severity | Description |
|---|---|---|
| <n> | critical | ... |

## Verdict

verdict: approved
```

(The `dev` persona adds a `File` column to the findings table.) The verdict line is `verdict: approved`, `verdict: changes_requested` or `verdict: rejected`.

## Escalation (all personas)

| Condition | Action |
|---|---|
| Any `critical` or `major` finding | `changes_requested`; return finding IDs to the orchestrator; re-invoke the stage in the table above |
| Only `minor` findings | `approved`; list the finding IDs in the review file |
| Work fundamentally ignores the requirements, intake or ADRs | `rejected`; escalate to the orchestrator; no fix loop |
| Required input file missing or empty | `critical` finding; `changes_requested`; cite the missing artifact |

## Exit criteria

1. The output file exists, is non-empty, and contains the line `verdict: approved`.
2. No open `critical` or `major` findings: `node .github/skills/uwf-review/reviews.mjs list-findings --review-id <n> --status open` exits `0` (exit `1` means blocking findings remain).
