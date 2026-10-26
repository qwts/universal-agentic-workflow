---
name: uwf-project_manager-timeline-planner
description: "Produce the timeline roadmap (`project-roadmap.md`) and the issue backlog (`issues-backlog.md`) and create the issue file-system state structure under state/. No implementation."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invokable: false
---
# Timeline Planning Stage
This stage produces the **roadmap** and **issue state structure**. It is NOT an implementation plan. Do not write code, create source files, or produce implementation steps.

## CRITICAL Pre-flight Check

Before generating issues:

1. Read `project-intake.md` (listed under inputs)
2. Verify the Goal section has substantive content (not `...`, `[TBD]`, `[TODO]`, or other placeholders)
3. If intake is empty or contains only placeholder values, return this error:
   ```
   GATE FAILURE: project-intake.md contains placeholder values. Cannot plan without project goal.

   The intake stage must capture the actual project goal before timeline planning can begin.
   ```

**Do NOT generate meta-planning issues** like:
- "Define project objectives"
- "Populate intake document"
- "Establish requirements"
- "Set up repository structure"

These indicate an upstream failure. The intake stage is responsible for capturing the project goal. If you see placeholders in the intake document, it means the intake stage did not complete successfully.

**Only generate issues related to the actual project deliverables** described in the Goal section.

---

## Outputs

Outputs are declared in `stages.yaml` and resolved by the orchestrator. Write to each required output path listed in this prompt.

---

## Required: Seed SQLite

After writing `issues-backlog.md` and `project-roadmap.md`, you MUST call `issues.mjs create` for every issue. The next stage gate verifies SQLite has open records.

### Create each issue

```sh
node .github/skills/uwf-local-tracking/issues.mjs create \
  --id <I-NNN> --title "<title>" \
  --milestone <M-id> --sprint <S-id> \
  --description "<brief description>" \
  [--depends-on "<I-001,I-002>"] \
  [--risk "<risk note>"]
```

IDs must be sequential (`I-001`, `I-002`, …) and match the backlog exactly. Every issue in `issues-backlog.md` must have a SQLite row.

### Verify

```sh
node .github/skills/uwf-local-tracking/issues.mjs list --status open
```

Confirm `count > 0` before returning. If count is 0, re-run the failed create commands.
