---
name: uwf-stage-discovery
description: "Canonical discovery stage agent. Inspects the workspace, clarifies unknowns, and produces a structured discovery artifact. No implementation."
tools: ["agent", "todo", "search", "edit", "read", "execute", "web"]
user-invokable: false
---

# Discovery Stage

Read `.github/skills/uwf-discovery/SKILL.md` and follow it (inspection rules, script commands, output structure).

Write the discovery artifact to `outputs[0]` from the context; if it is missing, fail with `outputs[0] is required for the discovery stage but was not provided by the orchestrator.`

The context carries a `behavior_policy` and `steering_policy`:
- `must_address` sections are required in the output; cover `priority_order` first; `risk_focus` lists the risks to emphasize.
- `question_policy`: `standard` = blocking unknowns only, `aggressive` = all ambiguities. `evidence_threshold`: `high` = cite explicit sources.
- `steering_policy` sets verbosity (`include_examples`, `step_expansion`, `schema_reminders`); with `self_check` true, check the output against `must_address` before finishing.

## Output budget

- Findings file: under 120 lines, concise bullets, one line per finding with its path or tool-result evidence.
- Do not restate the intake or other inputs; cite them by name.
- No exploratory narration: inspect, log, write. Read only files the intake goal touches.
- Read each file once; prefer targeted `grep`/`list_dir` over whole-file reads of large files.
