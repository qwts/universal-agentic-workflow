# GitHub Copilot Chat Orchestrator Guide

This guide documents the single-session chat-orchestrator fallback used when running Universal Agentic Workflow (`UAW`) interactively inside VS Code GitHub Copilot Chat via `.github/agents/uwf-core-orchestrator.agent.md` without an external runner process.

## Scope and Decision Context

`UAW` separates **deterministic engine contracts** from **host loop drivers**:

- **Preferred external loop drivers**: Use the deterministic CLI runner ([`scripts/uwf-runner/README.md`](../../scripts/uwf-runner/README.md)) or reusable pull-request workflow ([`docs/guide/uwf-on-pr.md`](uwf-on-pr.md)) whenever an external harness can own the stage loop, session rotation, retries, and `on_verdict` routing.
- **Shared host-neutral engine contract**: Declarative `stages.yaml` definitions, `stage-tracker.mjs` commands, gate check types, prescriptions, and `stage-result` schemas live in [`.github/skills/uwf-orchestration-engine/SKILL.md`](../../.github/skills/uwf-orchestration-engine/SKILL.md).
- **When to use this guide**: Load this guide alongside `.github/skills/uwf-orchestration-engine/SKILL.md` and `.github/skills/uwf-{workflow}/SKILL.md` when driving a workflow inside a single Copilot Chat orchestrator session (`uwf-core-orchestrator`), or when reproducing the Round 1 / Round 2 single-prompt chat-orchestrator baseline for control-condition benchmarking.

## Invocation Contract (`runSubagent` vs `run.mjs`)

Keep the stage-delegation tool call separate from the gate/stage-listing CLI script:

| Mechanism | What it is | How to invoke |
|---|---|---|
| **`runSubagent`** | A VS Code Copilot **tool call** that delegates one stage to a custom agent | Invoke through the host tool-call interface (same layer as file-read or terminal tools) — **never as a shell command** |
| **`run.mjs` / `stage-tracker.mjs`** | Deterministic Node.js CLI for stage resolution and gate checks | `node .github/skills/uwf-{workflow}/run.mjs --list-stages` or `--check-gate <stageName>` |

`run.mjs` has **no** `--run-stage`, `--execute`, or `--invoke` flag. Never attempt `node ... --run-stage` in a terminal; invoke stage agents through `runSubagent`.

### `runSubagent` Tool Parameters

Every `runSubagent` call takes three parameters and embeds the stage context JSON block inside the plain-text `prompt` string:

- `agentName` (`string`) — exact custom agent identifier from `--list-stages` (for example, `"uwf-stage-intake"`).
- `description` (`string`) — concise 3–5 word task label (for example, `"Run sw_dev intake stage"`).
- `prompt` (`string`) — plain-text stage instructions containing the embedded JSON `Context` block, resolved `inputs` and `outputs`, and task goal.

Do **not** pass raw JSON as the entire `prompt` string (such as `prompt: '{"role":"project"}'`), because the subagent receives no stage instructions. Format the call as:

```yaml
agentName: "uwf-stage-intake"
description: "Run sw_dev intake stage"
prompt: |
  Run the intake stage for the sw_dev workflow.

  Context:
  {
    "workflow":   "sw_dev",
    "role":       "issues",
    "phase":      "intake",
    "outputPath": "./tmp/workflow-artifacts",
    "statePath":  "./tmp/uwf-state.json"
  }

  <goal or issue description>
```

### Legacy vs New-Style Stage Context Block

Read `phase` from `uwf-state.json` via `node .github/skills/uwf-state-manager/state.mjs read` before each stage transition. Legacy stages (`stage_type: null`) include the five base fields:

```jsonc
{
  "workflow":   "<persona_name>",      // e.g. "project_manager", "sw_dev", "solutions_architect"
  "role":       "<role>",              // from the persona skill, e.g. "project" or "issues"
  "phase":      "<current_phase>",     // from state.mjs read
  "outputPath": "./tmp/workflow-artifacts",
  "statePath":  "./tmp/uwf-state.json"
}
```

For stages where `--list-stages` returns a non-null `stage_type` (canonical contract + traits), include the resolved policy fields from `--list-stages`:

```jsonc
{
  "workflow":        "<persona_name>",
  "role":            "<role>",
  "phase":           "<current_phase>",
  "outputPath":      "./tmp/workflow-artifacts",
  "statePath":       "./tmp/uwf-state.json",
  "stage_type":      "<stage_type>",
  "trait_ids":       ["<trait_id>"],
  "model_profile":   "<profile>",
  "behavior_policy": { /* from --list-stages output */ },
  "steering_policy": { /* from --list-stages output */ }
}
```

## Chat-Runtime Principles and Anti-Skipping Guardrails

Unlike `scripts/uwf-runner/runner.mjs`, where a Node.js `for` loop enforces stage order structurally, a chat-hosted orchestrator runs inside an LLM turn. In chat-orchestrator mode (and Round 1 / Round 2 single-prompt control runs), enforce these six rules:

1. **Subagent-only artifact authorship**: The chat orchestrator does not create, edit, or delete stage artifact files directly; every stage artifact is produced by its delegated subagent (unless `runAsSubagent` is explicitly `false`).
2. **Recorded stage transitions**: Before invoking a stage subagent, call `node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-start --workflow <workflow> --stage <stageName>` to record the active stage in SQLite.
3. **Script-enforced gates**: After every subagent returns, run the CLI gate check (`--check-gate <stageName>`). Never judge gate passage by conversational inspection alone. On gate failure, re-invoke the responsible subagent with the gate prescriptions up to `maxRetries` (default `2`), then halt and report if still blocked.
4. **Explicit conditional evaluation**: Never skip stages from memory. Conditional stages (`adr`, `security-plan`, `test-plan`, etc.) still run through the loop; `--check-gate` auto-passes with `conditional — not required` when their trigger marker is absent.
5. **Centralized user questions**: Subagents surface ambiguity upward using `QUESTIONS_NEEDED`; the chat orchestrator logs questions with `questions.mjs`, asks the user via `vscode/askQuestions`, records answers, and re-runs pre-flight before continuing.
6. **Single-turn loop continuity**: Do not yield back to the user between passing stages. Emit only a one-line progress trace (`[Stage N/Total] <stageName> -> invoking <agentName>`) before each `runSubagent` call, and stop only on permanent gate failure, a required `vscode/askQuestions` pause, or full workflow completion.

### Chat-Runtime Violations to Avoid (Retired Engine `FORBIDDEN` List)

When operating in chat-orchestrator mode, never commit any of the following violations:

- **Narrating or simulating stage execution in text** without calling `runSubagent` (for example, writing `"I invoked <agentName>"` or summarizing hypothetical stage work without making the tool call).
- **Invoking subagents via terminal commands** such as `node run.mjs --run-stage` instead of the `runSubagent` tool call.
- **Inventing subagent names** not present in `--list-stages` and `.github/agents/uwf-core-orchestrator.agent.md` `agents:` frontmatter (for example, fabricating `uwf-project_manager-initiate`).
- **Producing a workflow completion summary** before executing every stage returned by `--list-stages`.
- **Emitting `Current Stage/Phase:` or `Recommended Next Stage/Phase:` blocks** from the orchestrator (those hand-off signals belong to subagents only and are consumed internally).
- **Using stage names from memory or prose tables** instead of the JSON stage sequence returned by `run.mjs --list-stages`.

## Startup Procedure

When `.github/agents/uwf-core-orchestrator.agent.md` starts a `UAW` workflow in Copilot Chat:

1. Read `.github/skills/uwf-orchestration-engine/SKILL.md` (engine schema, gates, and CLI contract) and this guide (`docs/guide/copilot-orchestrator.md`).
2. Read the persona skill `.github/skills/uwf-{workflow}/SKILL.md` to obtain `role`, artifact conventions, and persona rules.
3. Resolve and persist the model profile once for the run:
   ```sh
   node .github/skills/uwf-model-adaptation/resolve.mjs detect [--profile <profile>] [--model <model_name>]
   node .github/skills/uwf-state-manager/state.mjs set-model-profile --profile <profile> [--model <model_name>]
   ```
   Expected output: JSON with `"ok": true` and the active `profile` (`compact`, `balanced`, or `reasoning`).
4. Query the authoritative stage list, passing `--model-profile <profile>`:
   ```sh
   node .github/skills/uwf-{workflow}/run.mjs --list-stages [--model-profile <profile>]
   ```
   Expected output: JSON array of resolved stage objects (`name`, `agent`, `resolved_agent`, `inputs`, `outputs`, `maxRetries`, `retryMode`, `onGateFailure`, `onVerdict`, and policy objects). Treat this JSON array as the sole authoritative stage sequence.
5. Initialize or inspect workflow state:
   ```sh
   node .github/skills/uwf-state-manager/state.mjs init --workflow <workflow>
   node .github/skills/uwf-state-manager/state.mjs read
   ```
   Expected output: JSON containing the current `phase` used to determine the starting or resume stage.
6. Execute every stage in order using the Per-Stage Execution Loop below.

## Per-Stage Execution Loop

Apply this loop to every stage returned by `--list-stages`:

```text
FOR EACH stage in the --list-stages JSON array:

  ┌─── PRE-FLIGHT ─────────────────────────────────────────────────────────┐
  │ 1. Inspect resolved stage metadata from --list-stages                  │
  │    -> record agent, inputs[], outputs[], runAsSubagent, maxRetries     │
  │                                                                        │
  │ 2. Check pending required questions                                    │
  │    node .github/skills/uwf-question-protocol/questions.mjs \           │
  │         check --stage <stageName>                                      │
  │    -> exit 1 (pending required questions)?                             │
  │      YES -> ask user via vscode/askQuestions                           │
  │             record each: questions.mjs answer --id <n> --answer "..."  │
  │             REPEAT step 2 until exit 0                                 │
  │      NO  -> continue                                                   │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─── INVOKE ─────────────────────────────────────────────────────────────┐
  │ IF runAsSubagent = true:                                               │
  │   3. Claim agent token and mark stage active                           │
  │      node .github/skills/uwf-state-manager/state.mjs \                 │
  │           set-agent --agent uwf-core-orchestrator                      │
  │      node .github/skills/uwf-orchestration-engine/stage-tracker.mjs \  │
  │           stage-start --workflow <workflow> --stage <stageName>        │
  │                                                                        │
  │   4. Emit one-line progress trace:                                     │
  │      [Stage N/Total] <stageName> -> invoking <agentName>               │
  │                                                                        │
  │   5. Call runSubagent with Context + resolved inputs/outputs:          │
  │      agentName: <agentName>                                            │
  │      description: "Run <workflow> <stageName> stage"                   │
  │      prompt: "Run the <stageName> stage.\n\nContext:\n{ ... }\n\n      │
  │               inputs: [...]\noutputs: [...]"                           │
  │                                                                        │
  │ ELSE (runAsSubagent = false):                                          │
  │   4. Execute inline without runSubagent                                │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─── POST-INVOKE ────────────────────────────────────────────────────────┐
  │ 6. Release agent token                                                 │
  │    node .github/skills/uwf-state-manager/state.mjs release-agent       │
  │                                                                        │
  │ 7. Did the subagent output contain QUESTIONS_NEEDED?                   │
  │    YES -> log each question to SQLite:                                 │
  │           questions.mjs log --stage <stageName> --group "..." \        │
  │                              --question "..." --required true|false    │
  │           -> ask user via vscode/askQuestions                          │
  │           -> record each: questions.mjs answer --id <n> --answer "..." │
  │           -> GOTO step 2 (re-verify questions, then re-invoke stage)   │
  │    NO  -> continue                                                   │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─── GATE ───────────────────────────────────────────────────────────────┐
  │ 8. Evaluate deterministic stage gate                                   │
  │    node .github/skills/uwf-{workflow}/run.mjs --check-gate <stageName> │
  │    exit 0 -> stage-tracker.mjs stage-complete --workflow <workflow>    │
  │                               --stage <stageName>                      │
  │              (and run returned state_actions if advances_phase_to set) │
  │    exit 1 -> stage-tracker.mjs stage-fail --workflow <workflow>        │
  │                               --stage <stageName>                      │
  │              apply Gate Failure Protocol or Review Fix-Loop Protocol   │
  └────────────────────────────────────────────────────────────────────────┘
```

The `GOTO` at step 7 ensures unresolved questions unblock the stage from the inside before the gate can pass.

## Gate Failure Protocol

When `run.mjs --check-gate <stageName>` exits `1` (and the failure is not an `on_verdict` review route):

1. Parse the JSON output (`failures[]`, `prescriptions[]`, `on_gate_failure`, `max_retries`).
2. Record the failed attempt via `stage-tracker.mjs stage-fail --workflow <workflow> --stage <stageName>`.
3. If `on_gate_failure` is `abort`, stop immediately and report the failure; if `skip`, mark `stage-skip` and continue.
4. Otherwise (`retry`), re-invoke the stage subagent using the imperative `prescriptions[]` strings from `--check-gate` (for example, `Gate failure prescriptions: <prescriptions>`), up to `max_retries` retries (default `2`).
5. Re-run `--check-gate <stageName>` after each retry. If the gate still fails after `max_retries`, halt the workflow and report the stage name, `failures[]`, and the subagent's last response.

## Review Fix-Loop Protocol

When a review or acceptance stage writes a non-approved verdict (such as `changes_requested` in `<prefix>-<stage>.result.json` and `verdict: changes_requested` in `<prefix>-<stage>.md`):

1. Inspect the stage's `onVerdict` mapping from `--list-stages` (for example, `changes_requested -> { routeTo: "implementation", maxRoundTrips: 2 }`) and open findings via `node .github/skills/uwf-review/reviews.mjs list-findings --review-id <n> --status open`.
2. If the review output flags `needs-user-decision:` or non-empty `questions`, log and ask those questions via `vscode/askQuestions` before routing.
3. Roll the state phase back to the phase preceding `routeTo`, run `stage-tracker.mjs reset-from --workflow <workflow> --stage <routeTo>`, and re-invoke `routeTo` (and any intermediate stages) with `"Review findings to address"` plus the review artifact path as an extra input.
4. Re-invoke the reviewer stage once fixes are complete and `close-finding` has been recorded for addressed items.
5. Enforce `maxRoundTrips` (default `2` round trips, up to `3` total review cycles). If the review stage still does not reach `approved`, halt and surface the remaining open findings to the user.

## Operating Checklist and Custom-Agent Registration

- Consume subagent `Current Stage/Phase:` and `Recommended Next Stage/Phase:` footers as internal signals only; never echo them or pause between passing stages.
- Never start a stage before prerequisite stage gates have passed.
- Use `uwf-stage-discovery` rather than guessing when repository facts are missing.
- On full workflow completion, summarize final outcomes and run `uwf-core-retro` when included in the workflow's `stages.yaml` or requested by the user.
- When adding a new custom stage agent (`.github/agents/uwf-{name}-{stage}.agent.md`) that must be callable in Copilot Chat, register its agent identifier under `agents:` in `.github/agents/uwf-core-orchestrator.agent.md`.
