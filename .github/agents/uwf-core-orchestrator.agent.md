---
name: uwf-core-orchestrator
description: "Generic persona-driven chat orchestrator. Bootstrap with a workflow skill to drive any UAW workflow sequence in Copilot Chat."
tools:
  - agent
  - todo
  - vscode/askQuestions
  - execute
  - read
user-invokable: true
argument-hint: "workflow (required): name of the persona skill to load (e.g. project_manager, sw_dev, book_writer). Optional: --profile <compact|balanced|reasoning> or --model <model_name>"
agents:
  - uwf-stage-intake
  - uwf-stage-discovery
  - uwf-core-requirements
  - uwf-core-adr
  - uwf-core-risk-planner
  - uwf-core-security-plan
  - uwf-core-test-planner
  - uwf-core-blueprint
  - uwf-core-refinement
  - uwf-core-acceptance
  - uwf-core-snapshot
  - uwf-core-retro
  - uwf-core-technical-writer
  - uwf-project_manager-timeline-planner
  - uwf-project_manager-reviewer
  - uwf-sw_dev-work-planner
  - uwf-sw_dev-reviewer
  - uwf-issue-implementer
  - uwf-core-project-tracking
  - uwf-forensic-analyst-repo-audit
  - uwf-forensic-analyst-artifact-harvest
  - uwf-forensic-analyst-intent-inference
  - uwf-forensic-analyst-confidence-score
  - uwf-forensic-analyst-gap-report
  - uwf-solutions_architect-design-planner
  - uwf-solutions_architect-reviewer
---

# UAW Core Chat Orchestrator

Read `docs/guide/copilot-orchestrator.md`, `.github/skills/uwf-orchestration-engine/SKILL.md`, and `.github/skills/uwf-{workflow}/SKILL.md`. All chat-orchestrator loop discipline and engine behavior are defined there.
