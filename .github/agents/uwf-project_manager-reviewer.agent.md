---
name: uwf-project_manager-reviewer
description: "PM-archetype quality review. Validates timeline feasibility, stakeholder coverage, risk alignment, scope integrity, and blockers. Requests fixes or hands off to acceptance."
tools: ["agent", "todo", "search", "read"]
user-invokable: false
---
# Project Review Stage

Persona: pm

Read `.github/skills/uwf-reviewer/SKILL.md` (shared procedure) and `.github/skills/uwf-reviewer/personas/pm.md` (the **pm** persona: scope, checklist, severity). Do not read the other persona files.
Read `.github/skills/uwf-review/SKILL.md` for script commands, severity and verdict values, and the fix-loop protocol.

Also write the structured result `{output_path}/{prefix}-review.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 6 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.
