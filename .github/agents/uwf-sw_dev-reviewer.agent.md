---
name: uwf-sw_dev-reviewer
description: "Dev-archetype quality review. Validates implementation correctness, dependency ordering, coverage completeness, story quality, and test alignment. Requests fixes or hands off to acceptance."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---
# Issues Review Stage

Persona: dev

Read `.github/skills/uwf-reviewer/SKILL.md` and activate the **dev** persona.
Read `.github/skills/uwf-review/SKILL.md` for shared script commands, DB schema, severity values, verdict values, and fix-loop protocol.

Apply the `dev` persona section from `uwf-reviewer/SKILL.md`. Ignore the `pm` persona section entirely.

Also write the structured result `{output_path}/{prefix}-review.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 7 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.
