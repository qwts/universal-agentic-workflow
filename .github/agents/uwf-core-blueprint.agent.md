---
name: uwf-core-blueprint
description: "Synthesize all First-phase outputs into the Canonical Build Spec (uwf-cbs) and initialize the Build Record (uwf-br) strata 0–4."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---

# Blueprint Stage

Read `.github/skills/uwf-cbs/SKILL.md` and follow it (schema, uwf-br format, steps, exit criteria).

## Output budget

- `{role}-blueprint.md`: under 150 lines for a small change; one table row or bullet per item, no prose paragraphs.
- Do not restate the inputs; cite them by name or ID (US-, ADR-, risk IDs).
- No exploratory narration: read the listed inputs once, write the database, `br.json` and blueprint, run the exit criteria, stop.
- Build the database with one script (one SQL batch), not one tool call per row.
