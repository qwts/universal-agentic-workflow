# GitHub Copilot adapter

Start with [`../AGENTS.md`](../AGENTS.md); it is the canonical repository
context.

When UWF delegates a stage in GitHub Copilot:

- Invoke the named custom agent with the `runSubagent` tool. Do not substitute a
  shell command or a narrated or simulated invocation.
- Pass the parameters and stage context required by the
  [orchestration-engine skill](skills/uwf-orchestration-engine/SKILL.md).
- If `runSubagent` is unavailable, stop and ask the user to enable Copilot
  custom subagents. Do not imitate the missing tool.
