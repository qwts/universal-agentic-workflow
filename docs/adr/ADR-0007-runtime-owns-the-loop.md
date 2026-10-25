# ADR-0007: The runtime owns the stage loop; models execute stages only

Date: 2026-10-25
Status: Accepted
Supersedes in part: the orchestrator contract in
[`uwf-orchestration-engine/SKILL.md`](../../.github/skills/uwf-orchestration-engine/SKILL.md)

## Context
- Round 1 ran UWF as VS Code Copilot custom agents: an orchestrator agent
  invoked stage agents as subagents and judged gates from memory.
- Round 2 moved state, gates and tracking into CLIs (`state.mjs`,
  `stage-tracker.mjs`, `issues.mjs`, `questions.mjs`) driven by declarative
  `stages.yaml` files. The gates became deterministic. The loop did not: a model
  is still told, in prose, to call `run.mjs --list-stages`, invoke each stage
  agent, run `check-gate`, retry, and advance.
- The engine SKILL's "FORBIDDEN Behaviors" list is the record of how that fails:
  narrating a stage instead of invoking it, skipping stages the model believes
  are done, yielding between stages, judging a gate without running it. Each rule
  exists because a model once did the opposite. Stronger prompts shrink the
  failure rate; they do not remove the class.
- Long-horizon instruction following is the capability that scales worst with
  model size. The project thesis (see the Round 3 epics, issues
  [#80](https://github.com/qwts/universal-agentic-workflow/issues/80) and
  [#99](https://github.com/qwts/universal-agentic-workflow/issues/99)) is that
  when sequencing, state and gate decisions live in tooling, each model call is
  a short prompt with explicit inputs and one deliverable, and a small model
  should approach a frontier model on gated work.

## Decision
- **A deterministic runner executes `stages.yaml`.** `scripts/uwf-runner/runner.mjs`
  lists stages, checks pending questions, marks the stage active, materializes
  the stage prompt, invokes the stage agent through a harness adapter, releases
  the agent token, evaluates the gate with `stage-tracker.mjs`, and retries,
  skips or aborts exactly as the stage declares. It records every transition in
  the existing SQLite stores. It adds no new state store.
- **Stage agents only ever see one stage.** The prompt is the agent file body,
  the context block, resolved inputs and required outputs. Agents do not learn
  the stage order, do not advance phases, and do not evaluate gates.
- **Harness adapters are the only model boundary.** An adapter runs one stage
  through one CLI (`claude-code`, `codex`, `fake` for CI) and returns a
  transcript, a session id and usage. Adapters never write workflow state.
- **The orchestrator agent becomes a thin alternative runtime**, kept for chat
  surfaces that cannot host the loop (Copilot chat). Its rules move to a guide
  and are no longer the primary contract. The "FORBIDDEN Behaviors" list retires
  with it once the runner is the documented path.
- **Gates stay script-evaluated and grow structured.** Verdict gates move from
  grepping `verdict: approved` to a JSON result file validated against a schema;
  gate failures carry a prescription that doubles as the retry prompt.

## Alternatives considered
1) **Keep the LLM orchestrator and harden the prompt.** Cheapest; already tried
   across two rounds. The failure class remains and it ties correctness to the
   largest available model, which is the opposite of the thesis.
2) **Use GitHub Actions jobs as the stages** (one job per stage, `needs:` as the
   order). Attractive for the PR trigger, but gates, retries and questions would
   be re-implemented in YAML and lose the local run. Actions remain the trigger
   and the host; the runner is the step.
3) **Adopt an external workflow engine** (Temporal, Prefect, a pipeline DSL).
   Durable and observable, but a dependency and a second schema for a loop that
   is forty lines over CLIs the repo already owns. Revisit if resume and
   multi-machine fan-out outgrow SQLite.

## Consequences
- Positive: the loop is testable without a model (fake adapter in CI); runs are
  resumable from recorded state; per-stage model routing becomes a config field;
  the same runner serves local, PR-triggered and benchmark runs.
- Negative: every store must be relocatable (`UWF_DATA_DIR`,
  [#81](https://github.com/qwts/universal-agentic-workflow/issues/81)) before two
  runs can share a machine; stage agents written for Copilot subagent invocation
  need a prompt materializer; the Copilot path becomes second-class and will
  drift unless the smoke suite keeps exercising its files.
- Follow-ups: Round 3 milestones R3-M1 through R3-M4 on
  [project 15](https://github.com/users/qwts/projects/15);
  update [product-definition.md](../product/product-definition.md) so the
  runner is the primary runtime and Copilot an adapter; update
  [roadmap-v1.md](../product/roadmap-v1.md) M1 and M3 to point at the R3 issues
  that now carry them.

## Security / Privacy / Compliance notes
- Adapters receive provider credentials from the environment only; the runner
  never reads harness config files or subscription tokens.
- Transcripts are artifacts and may contain repository content; the PR-trigger
  workflow scrubs them before upload and retains them briefly
  ([#97](https://github.com/qwts/universal-agentic-workflow/issues/97)).
- The PreToolUse hook policy in `scripts/hooks/` continues to apply inside each
  stage agent; the runner adds the permission preset per stage on top.

## Verification
- `node scripts/uwf-runner/runner.mjs run --workflow sw_dev --adapter fake`
  completes on the toy fixture in CI with every stage `passed` and the phase
  `closed`, and the same command with `--adapter claude-code` completes locally.
- Deleting one fixture output fails the matching gate in the CI test, proving
  the gate rather than the transcript decides advancement.
