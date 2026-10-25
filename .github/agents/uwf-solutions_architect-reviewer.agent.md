---
name: uwf-solutions_architect-reviewer
description: "Architecture review gate. Validates design completeness, NFR coverage, requirement traceability, and constraint compliance. Flags unresolved interface contracts and ungrounded design decisions as blockers. Requests fixes or hands off to acceptance."
tools: ["agent", "todo", "search", "read"]
user-invokable: false
---
# Architecture Review Stage

Persona: arch

Read `.github/skills/uwf-reviewer/SKILL.md` and activate the **arch** persona.
Read `.github/skills/uwf-review/SKILL.md` for shared script commands, DB schema, severity values, verdict values, and fix-loop protocol.

Apply the `arch` persona section from `uwf-reviewer/SKILL.md`. Ignore the `pm` and `dev` persona sections entirely.

Also write the structured result `{output_path}/{prefix}-review.result.json` (schema: `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`; see step 7 of `uwf-review/SKILL.md`) alongside the markdown. The gate requires both.
