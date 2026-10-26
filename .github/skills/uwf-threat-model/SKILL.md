---
name: uwf-threat-model
description: "Generate a pragmatic threat model + mitigations for the `{role}-security-plan.md` stage output."
---
# UWF Threat Model Skill

## Output
Update `{role}-security-plan.md` (at the required output path listed in the prompt) with:
- Assets
- Trust boundaries (text diagram is fine)
- Threats (STRIDE-style is OK, but keep it practical)
- Mitigations mapped to threats
- Verification checklist (tests, config checks, monitoring)

## Template
See: templates/threat-model.template.md
