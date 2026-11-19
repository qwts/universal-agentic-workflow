---
name: uwf-start-project-planning
description: "Bootstrap the UAW project_manager workflow to plan a new project from intake to backlog."
agent: "uwf-core-orchestrator"
---

# Context
Workflow: `project_manager`

# Tasks
Run the complete `project_manager` workflow end-to-end:
1. Read `.github/agents/uwf-core-orchestrator.agent.md`, `.github/skills/uwf-orchestration-engine/SKILL.md`, and `.github/skills/uwf-project_manager/SKILL.md` (plus `docs/guide/copilot-orchestrator.md` when present in a UAW source checkout).
2. Resolve the model profile: `node .github/skills/uwf-model-adaptation/resolve.mjs detect [--profile <profile>] [--model <model_name>]`. Store result: `node .github/skills/uwf-state-manager/state.mjs set-model-profile --profile <p>`.
3. Call `runSubagent` for **every stage** returned by `node .github/skills/uwf-project_manager/run.mjs --list-stages`, in order, without stopping between stages.
4. For new-style stages (`stage_type` present), include `stage_type`, `trait_ids`, `model_profile`, `behavior_policy`, and `steering_policy` in the context block.
5. Emit a single-line trace before each `runSubagent` call.
6. Run the gate check script after each subagent returns; apply the Gate Failure Protocol in `.github/agents/uwf-core-orchestrator.agent.md` if needed.
7. Only stop on permanent gate failure, a required user question (`vscode/askQuestions`), or final workflow completion.

**Do NOT narrate, simulate, or summarize stages. Every stage requires an actual `runSubagent` tool call. Describing or pretending to run a stage without calling the tool is a critical violation.**

> **`runSubagent` is a VS Code Copilot tool call — NOT a terminal command.** Never attempt `node run.mjs --run-stage` or any shell equivalent. The only terminal commands are `--list-stages` and `--check-gate`. There is no `--run-stage` flag anywhere in this workflow.
