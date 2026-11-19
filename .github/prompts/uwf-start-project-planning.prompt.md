---
name: "uwf-start-project_manager-planning"
description: "Start project planning for an idea, concept, or digital product."
argument-hint: "New project: describe what you want to build + constraints. Returning: leave blank to continue working through open issues. Optional: --profile <compact|balanced|reasoning> or --model <model_name>."
agent: "uwf-core-orchestrator"
---
## Input
- workflow_persona: "project_manager"
- A concept, project proposal, feature proposal, wireframe, or other idea for a digital product or feature to build, ideally with some constraints or acceptance criteria.

# Tasks
Run the complete `project_manager` workflow end-to-end:
1. Read `docs/guide/copilot-orchestrator.md`, `.github/skills/uwf-orchestration-engine/SKILL.md`, and `.github/skills/uwf-project_manager/SKILL.md`.
2. Resolve the model profile: `node .github/skills/uwf-model-adaptation/resolve.mjs detect [--profile <profile>] [--model <model_name>]`. Store result: `node .github/skills/uwf-state-manager/state.mjs set-model-profile --profile <p>`.
3. Call `runSubagent` for **every stage** returned by `node .github/skills/uwf-project_manager/run.mjs --list-stages`, in order, without stopping between stages.
4. For new-style stages (`stage_type` present), include `stage_type`, `trait_ids`, `model_profile`, `behavior_policy`, and `steering_policy` in the context block.
5. Emit a single-line trace before each `runSubagent` call.
6. Run the gate check script after each subagent returns; apply the Gate Failure Protocol in `docs/guide/copilot-orchestrator.md` if needed.
7. Only stop on permanent gate failure, a required user question (`vscode/askQuestions`), or final workflow completion.

**Do NOT narrate, simulate, or summarize stages. Every stage requires an actual `runSubagent` tool call. Describing or pretending to run a stage without calling the tool is a critical violation.**

> **`runSubagent` is a VS Code Copilot tool call — NOT a terminal command.** Never attempt `node run.mjs --run-stage` or any shell equivalent. The only terminal commands are `--list-stages` and `--check-gate`. There is no `--run-stage` flag anywhere in this workflow.
