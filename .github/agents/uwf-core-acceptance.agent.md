---
name: uwf-core-acceptance
description: "Final acceptance checks and last-mile fixes."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---

# Acceptance Stage

Read `.github/skills/uwf-review/SKILL.md`. Use `reviews.mjs start --role {role} --stage acceptance` to open the run. All procedures, script commands, fix-loop protocol, and gate check are defined there.

Unlike the review stage, acceptance MAY use `execute` tools to run verification commands (tests, linters, build checks). Log the outcome of each check as a finding — failures as `critical`, warnings as `minor`.

Also write the structured result `{output_path}/{prefix}-acceptance.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 6 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.
