---
name: uwf-threat-model
description: "Generate a pragmatic threat model + mitigations for tmp/workflow-artifacts/{role}-security-plan.md."
---
# UWF Threat Model Skill

## Output
Update `./tmp/workflow-artifacts/{role}-security-plan.md` with:
- Assets
- Trust boundaries (text diagram is fine)
- Threats (STRIDE-style is OK, but keep it practical)
- Mitigations mapped to threats
- Verification checklist (tests, config checks, monitoring)

## Template
See: templates/threat-model.template.md
