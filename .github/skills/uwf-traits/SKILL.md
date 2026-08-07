---
name: uwf-traits
description: "Structured behavior overlays that shape how a stage capability is executed for a given persona."
---

# UWF Traits Skill

## Overview

A **trait** is a structured behavior overlay that customizes how a canonical stage capability
(e.g. `discovery`) executes for a specific persona perspective (e.g. `project_manager`, `sw_dev`).

Traits are resolved centrally by the orchestration layer — stage agents never read trait files
directly. The resolved `behavior_policy` is injected into every new-style stage invocation as
part of the stage context.

---

## Trait Registry

Trait files live at:

```
.github/skills/uwf-traits/traits/<trait_id>.yaml
```

| Trait ID | File | Persona |
|---|---|---|
| `project_manager` | `traits/project_manager.yaml` | Project manager persona |
| `sw_dev` | `traits/sw_dev.yaml` | Software developer persona |
| `solutions_architect` | `traits/solutions_architect.yaml` | Solutions architect persona |
| `forensic_analyst` | `traits/forensic_analyst.yaml` | Forensic analyst persona |

---

## Trait File Schema

Each trait file must conform to the following structure:

```yaml
trait_id: <id>       # must match the filename (without .yaml)
version: 1
stage_policies:
  <stage_type>:      # e.g. discovery
    priority_order:  # ordered list of focus areas
      - <focus>
    must_address:    # required sections in the stage output
      - <section>
    question_policy: minimal | standard | aggressive
    risk_focus:      # risk categories to emphasize
      - <category>
    evidence_threshold: low | standard | high
```

---

## Trait Merge Rules

When a stage lists multiple `traits`, the orchestration layer merges their stage policies in
the order listed. The base `default_behavior_policy` from the stage contract is always applied
first.

| Field | Merge rule |
|---|---|
| `priority_order` | ordered union — first appearance wins |
| `must_address` | ordered union — first appearance wins |
| `risk_focus` | ordered union — first appearance wins |
| `question_policy` | strictest wins: `minimal < standard < aggressive` |
| `evidence_threshold` | strictest wins: `low < standard < high` |

Traits may **add** behavior. They may not remove items established by the stage defaults or
earlier traits in the merge sequence.

---

## Non-negotiable Rules

1. Trait IDs must be **structured identifiers** (lowercase, underscores) — not prose.
2. Trait behavior is resolved centrally by `stage-tracker.mjs` — never by stage agents.
3. A stage may list multiple traits; the merge is deterministic and order-sensitive.
4. Traits must not contradict each other's `must_address` entries — they can only add items.
5. Adding a new trait requires: a new YAML file here, registration in the stage contract's
   `supported_traits` list, and smoke test coverage.
