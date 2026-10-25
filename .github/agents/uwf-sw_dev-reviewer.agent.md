---
name: uwf-sw_dev-reviewer
description: "Dev-archetype quality review. Validates implementation correctness, dependency ordering, coverage completeness, story quality, and test alignment. Requests fixes or hands off to acceptance."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---
# Issues Review Stage

Persona: dev

Read `.github/skills/uwf-reviewer/SKILL.md` (shared procedure) and `.github/skills/uwf-reviewer/personas/dev.md` (the **dev** persona: scope, checklist, severity). Do not read the other persona files.
Read `.github/skills/uwf-review/SKILL.md` for script commands, severity and verdict values, and the fix-loop protocol.

Also write the structured result `{output_path}/{prefix}-review.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 6 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.
