# GitHub Copilot adapter

When contributing to this UAW source repository, start with the root
`AGENTS.md`; it is the canonical repository context. Installed copies of the
`.github/` bundle remain self-contained and use the downstream repository's
own root context.

When UAW delegates a stage in GitHub Copilot:

- Invoke the named custom agent with the `runSubagent` tool. Do not substitute a
  shell command or a narrated or simulated invocation.
- Follow the `runSubagent` parameter structure and chat-orchestrator loop in
  [docs/guide/copilot-orchestrator.md](../docs/guide/copilot-orchestrator.md), and
  enforce the stage and gate contracts in
  [.github/skills/uwf-orchestration-engine/SKILL.md](skills/uwf-orchestration-engine/SKILL.md).
- If `runSubagent` is unavailable, stop and ask the user to enable Copilot
  custom subagents, or run the workflow through `scripts/uwf-runner/runner.mjs`
  instead. Do not imitate the missing tool.
