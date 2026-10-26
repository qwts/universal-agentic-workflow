---
name: uwf-core-acceptance
description: "Final acceptance checks and last-mile fixes."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---

# Acceptance Stage

Read `.github/skills/uwf-review/SKILL.md`. Use `reviews.mjs start --role {role} --stage acceptance` to open the run. All procedures, script commands, fix-loop protocol, and gate check are defined there.

Unlike the review stage, acceptance MAY use `execute` tools to run verification commands (tests, linters, build checks). Log the outcome of each check as a finding — failures as `critical`, warnings as `minor`. These are the `reviews.mjs` database severities; the result JSON uses a different scale (below).

Also write the structured result `{output_path}/{prefix}-acceptance.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 6 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.

In the result JSON, `findings[].severity` MUST be one of `high`, `medium`, `low` (never `critical`, `major`, or `minor`): map `critical` to `high`, `major` to `medium`, `minor` to `low`. Every finding MUST have a non-empty `summary` string (`location` is optional); `verdict` is `approved`, `changes_requested`, or `blocked`. Use `"findings": []` when there are none. Example:

```json
{ "verdict": "approved", "findings": [ { "severity": "low", "summary": "Linter warning in build step", "location": "path:line" } ], "notes": "..." }
```
