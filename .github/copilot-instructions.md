# GitHub Copilot adapter

When contributing to this UAW source repository, start with the root
`AGENTS.md`; it is the canonical repository context, and
[docs/guide/copilot-orchestrator.md](../docs/guide/copilot-orchestrator.md)
documents the full chat-orchestrator reference and Round 1 / Round 2 control
baseline. Installed copies of the `.github/` bundle remain self-contained via
[agents/uwf-core-orchestrator.agent.md](agents/uwf-core-orchestrator.agent.md)
and [skills/uwf-orchestration-engine/SKILL.md](skills/uwf-orchestration-engine/SKILL.md),
and use the downstream repository's own root context.

When UAW delegates a stage in GitHub Copilot:

- Invoke the named custom agent with the `runSubagent` tool. Do not substitute a
  shell command or a narrated or simulated invocation.
- Follow the `runSubagent` parameter structure and chat-orchestrator loop in
  [agents/uwf-core-orchestrator.agent.md](agents/uwf-core-orchestrator.agent.md)
  (and [docs/guide/copilot-orchestrator.md](../docs/guide/copilot-orchestrator.md)
  when working in the UAW source checkout), and enforce the stage and gate
  contracts in
  [skills/uwf-orchestration-engine/SKILL.md](skills/uwf-orchestration-engine/SKILL.md).
- If `runSubagent` is unavailable, stop and ask the user to enable Copilot
  custom subagents (or run the workflow through `scripts/uwf-runner/runner.mjs`
  from a UAW checkout). Do not imitate the missing tool.
