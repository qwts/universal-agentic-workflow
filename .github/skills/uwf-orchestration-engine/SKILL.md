---
name: uwf-orchestration-engine
description: "Host-neutral UAW orchestration engine contract: declarative stages.yaml schema, stage-tracker.mjs CLI, gate check types and prescriptions, structured stage-result verdicts, on_verdict review routing, and artifact handoffs across CLI, PR runner, IDE/browser plugins, and standalone MCP surfaces."
---

# UAW Orchestration Engine (`uwf-orchestration-engine`)

The orchestration engine defines the host-neutral state machine, declarative workflow graph (`stages.yaml`), deterministic gate evaluator, structured verdict schema, and SQLite stage-tracking CLI (`stage-tracker.mjs`) for Universal Agentic Workflow (`UAW`).

## Execution Surfaces and Related Guides

`UAW` decouples workflow state and gate evaluation from how a host runtime invokes individual stage agents. Every surface consumes the same `stages.yaml` definitions and `stage-tracker.mjs` CLI:

- **Deterministic CLI runner** ([`scripts/uwf-runner/README.md`](../../../scripts/uwf-runner/README.md)): `scripts/uwf-runner/runner.mjs` owns the stage loop in Node.js and invokes one isolated stage session per attempt through harness adapters (`claude-code`, `codex`, `grokbot`, `fake`) using prompts materialized by `scripts/uwf-runner/prompt.mjs`.
- **Pull-request workflow runner** ([`docs/guide/uwf-on-pr.md`](../../../docs/guide/uwf-on-pr.md)): Runs the deterministic CLI runner inside reusable GitHub Actions workflows on self-hosted runners ([`docs/guide/self-hosted-runner.md`](../../../docs/guide/self-hosted-runner.md)).
- **IDE / dev-tool plugins, browser plugins, and standalone MCP servers**: Query `stage-tracker.mjs` (directly or behind MCP tools) to resolve stage contracts, persist per-run SQLite state in `--data-dir`, evaluate deterministic gates, and route `on_verdict` round trips without depending on VS Code chat tools.
- **GitHub Copilot chat-orchestrator fallback** ([`docs/guide/copilot-orchestrator.md`](../../../docs/guide/copilot-orchestrator.md)): Single-session chat fallback (`uwf-core-orchestrator`) and Round 1 / Round 2 control reference for hosts that delegate stages interactively inside a single chat session.
- **Target-repo verification gate** ([`docs/guide/verify-gate.md`](../../../docs/guide/verify-gate.md)): Configures `.github/skills/uwf-orchestration-engine/verify.mjs` (`UWF_VERIFY_CMDS` or `.github/uwf-verify.yaml`) for build, lint, and test gates.

## Engine File Map and Two-Root Resolution

| File | Purpose |
|---|---|
| `.github/skills/uwf-orchestration-engine/stage-tracker.mjs` | Central stage resolution, deterministic gate evaluation, prescription audit, and SQLite tracking CLI |
| `.github/skills/uwf-orchestration-engine/stage-schema.yaml` | SQLite table definitions (`stage_runs` and append-only `stage_history`), auto-migrated on open |
| `.github/skills/uwf-orchestration-engine/uwf-stages.db` | Default SQLite stage database when `--db-path` / `--data-dir` / `UWF_DATA_DIR` are unset (gitignored) |
| `.github/skills/uwf-orchestration-engine/stage-contracts/*.yaml` | Canonical stage contracts (`intake.yaml`, `discovery.yaml`) defining `default_agent`, `supported_traits`, and `default_behavior_policy` |
| `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json` | Draft-07 JSON Schema for machine-readable review and acceptance stage verdicts (`<prefix>-<stage>.result.json`) |
| `.github/skills/uwf-orchestration-engine/verify.mjs` | Target-repository verification runner invoked by `run_script` checks on implementation stages |
| `.github/skills/uwf-orchestration-engine/skill-runner.mjs` | Legacy JS gate helpers kept for custom script compatibility |
| `.github/skills/uwf-{workflow}/stages.yaml` | Per-workflow declarative stage graph, inputs/outputs, retry policy, `on_verdict` routes, and gate checks |
| `.github/skills/uwf-{workflow}/run.mjs` | Thin per-workflow CLI shim forwarding `--list-stages` and `--check-gate <stage>` to `stage-tracker.mjs` |

### Skills Root vs Target Repository Root

`stage-tracker.mjs` separates workflow definitions from the repository under modification:

- **Skills root** (`--skills-root <dir>` or `UWF_SKILLS_ROOT`): Directory containing `.github/skills` and `.github/agents`. When a consumer repository carries its own `.github/skills/uwf-{workflow}/stages.yaml`, target-local files take precedence and missing engine scripts or agents fall back to the `UAW` checkout.
- **Target repository root** (`process.cwd()`): Working directory against which `{{cwd}}`, stage `outputs`, and `run_script` checks execute.

### Path Template Variables and Data Directory Precedence

Gate paths, directories, and `run_script` `args` support three template variables:

| Variable | Resolves to |
|---|---|
| `{{output_path}}` | `--output-path` flag value; defaults to `<data-dir>/workflow-artifacts` when `--data-dir` or `UWF_DATA_DIR` is set, otherwise `./tmp/workflow-artifacts` |
| `{{cwd}}` | Target repository working directory (`process.cwd()`) at evaluation time |
| `{{skills_root}}` | Resolved `--skills-root` / `UWF_SKILLS_ROOT`, or `process.cwd()` when unset |

SQLite databases (`uwf-stages.db` and sibling skill stores) resolve in strict order:
1. `--db-path <file>`
2. `--data-dir <dir>` (`<dir>/uwf-stages.db`)
3. `UWF_DATA_DIR` environment variable (`$UWF_DATA_DIR/uwf-stages.db`)
4. The skill's own directory (`.github/skills/uwf-orchestration-engine/uwf-stages.db`)

Concurrent workflow fronts against the same repository must pass distinct `--data-dir` and `--output-path` directories so SQLite stores and stage artifacts stay isolated.

## `stages.yaml` Schema Reference

Each workflow persona declares its stage graph in `.github/skills/uwf-{workflow}/stages.yaml`:

```yaml
workflow: sw_dev
artifact_prefix: issues              # filename stem prefix (e.g. "issues", "project", "arch", "forensic")
output_path: ./tmp/workflow-artifacts

stages:
  - name: discovery
    stage_type: discovery            # mutually exclusive with `agent:`
    traits:                          # required non-empty list when `stage_type` is set
      - codebase_scanning
    advances_phase_to: discovery     # optional phase transition in uwf-state-manager
    inputs:
      - "{{output_path}}/issues-intake.md"
    outputs:
      - "{{output_path}}/issues-discovery.md"
    run_as_subagent: true            # default true; false runs inline in hosts that support it
    max_retries: 2                   # default 2 retries after initial attempt
    on_gate_failure: retry           # retry (default) | abort | skip
    retry_mode: resume               # resume (default) | fresh
    max_turns: 20                    # positive integer; default 20 (implementation defaults to 30)
    max_cost_usd: 2.50               # optional positive number; per-stage attempt cost cap in USD
    model: claude-sonnet-5-5         # optional per-stage model override (--model CLI flag wins)
    gated: true                      # default true; false auto-passes best-effort stages
    conditional: true                # optional; when true, evaluates `condition` before gate checks
    condition:
      type: file_contains            # file_contains | file_contains_any
      path: "{{output_path}}/issues-requirements.md"
      text: "ADR_REQUIRED"           # use `texts: [...]` for `file_contains_any`
    on_verdict:                      # optional map: observed /verdict -> earlier stage route
      changes_requested:
        route_to: implementation     # must name an earlier stage in this workflow
        max_round_trips: 2           # positive integer; default 2
    gate:
      checks:
        - type: require_non_empty
          path: "{{output_path}}/issues-discovery.md"
          label: "issues-discovery.md"
```

### Stage Definition Fields

| Field | Type / Default | Semantics |
|---|---|---|
| `name` | `string` (required) | Unique stage identifier within the workflow |
| `agent` | `string` | Explicit `.github/agents/<agent>.agent.md` name (legacy stage; mutually exclusive with `stage_type`) |
| `stage_type` + `traits` | `string` + `string[]` | Canonical stage contract in `stage-contracts/<stage_type>.yaml` merged with ordered trait policies from `.github/skills/uwf-traits/traits/<trait>.yaml` and model steering from `.github/skills/uwf-model-adaptation/profiles.yaml` |
| `inputs` / `outputs` | `string[]` (`[]`) | Templated artifact paths materialized into stage prompts and permission scopes |
| `advances_phase_to` | `string \| null` (`null`) | Target phase emitted in `state_actions` when `stage-complete` or `stage-skip` succeeds |
| `run_as_subagent` | `boolean` (`true`) | Exposes `runAsSubagent` in `list-stages` and `stage_runs.run_as_subagent` |
| `max_retries` | `integer` (`2`) | Maximum retry attempts before a failing gate escalates |
| `on_gate_failure` | `retry \| abort \| skip` (`retry`) | Policy returned on gate failure (`skip` and `abort` act on the first failure) |
| `retry_mode` | `resume \| fresh` (`resume`) | `resume` reuses `stage_runs.session_id` across retries; `fresh` starts a new adapter session |
| `max_turns` | `integer` (`20`, `implementation`: `30`) | Per-attempt turn ceiling exposed as `maxTurns` |
| `max_cost_usd` | `number \| null` (`null`) | Optional per-stage summed USD cap exposed as `maxCostUsd` |
| `model` | `string \| undefined` | Optional stage-level model selection (overridden by runner `--model`) |
| `on_verdict` | `map \| null` (`null`) | Maps an observed JSON `/verdict` value to `{ route_to, max_round_trips }` (default `2`), exposed as `onVerdict: { <verdict>: { routeTo, maxRoundTrips } }` |
| `gated` | `boolean` (`true`) | When `false`, `check-gate` always exits `0` (`note: "ungated — always passes"`) |
| `conditional` + `condition` | `boolean` + `object` | When `conditional: true` and `condition` (`file_contains` with `text`, or `file_contains_any` with `texts[]`) evaluates `false`, `check-gate` exits `0` (`note: "conditional — not required"`) |

When merging `stage_type` + `traits`, `stage-tracker.mjs` computes `behavior_policy` by taking the ordered union of `priority_order`, `must_address`, and `risk_focus`, and selecting the stricter `question_policy` (`minimal < standard < aggressive`) and `evidence_threshold` (`low < standard < high`).

## Gate Check Types and Prescriptions

Every entry under `gate.checks` is evaluated deterministically by `evaluateCheck` in `stage-tracker.mjs`:

| `type` | Required keys | Pass condition and prescription behavior |
|---|---|---|
| `require_non_empty` | `path` (`label` optional) | File exists at templated `path` and size `> 0`. Prescribes: `Write a non-empty file at <path>.` |
| `require_contains` | `path`, plus `text` or `heading` (`label` optional) | With `text`: file contains exact substring `text`. With `heading` (e.g. `"## Overview"`): line-anchored case-insensitive heading match tolerating optional numeric prefixes such as `## 1. Overview` or `## 3.1) Overview`. Missing files return `null` so `require_non_empty` reports absence once. |
| `require_files_with_prefix` | `dir`, `prefix` (`label` optional) | Directory exists and contains at least one entry starting with `prefix`. |
| `require_file_matching_pattern` | `dir`, `pattern` (`label` optional) | Directory exists and recursive walk finds a path matching `new RegExp(pattern)`. |
| `run_script` | `cmd` (`args` array and `label` optional) | Runs `cmd` with `UWF_DATA_DIR` forwarded when `--data-dir` is set. When `args` is provided, executes `execFileSync(cmd, args)` directly without a shell; templated values (`{{...}}`) **must** be passed via `args` (templating inside a shell-form `cmd` without `args` is rejected). Relative `.github/skills/...` and `.github/agents/...` paths resolve to the target repo when present, otherwise to `--skills-root` / the `UAW` checkout. |
| `require_json_field` | `path`, `pointer`, and **exactly one** of `equals`, `in`, or `exists` (`schema` and `label` optional) | Parses JSON at `path`, optionally validates `schema: stage-result` against `schemas/stage-result.schema.json`, resolves RFC 6901 `pointer` (e.g. `/verdict`), and checks `equals`, `in` (`array`), or `exists` (`boolean`). |

### Gate Output and Verdict-Outcome Prescriptions

`check-gate` writes JSON to stdout and persists it to `stage_runs.gate_result`:

```json
{
  "stage": "review",
  "passed": false,
  "failures": [
    "issues-review.result.json (./tmp/workflow-artifacts/issues-review.result.json) pointer /verdict: observed \"changes_requested\", expected equals \"approved\""
  ],
  "prescriptions": [
    "./tmp/workflow-artifacts/issues-review.result.json records verdict \"changes_requested\" (wanted \"approved\"); the verdict is a review outcome, not something to rewrite, so do not change it to pass the gate."
  ],
  "verdict": "changes_requested",
  "on_gate_failure": "retry",
  "max_retries": 2
}
```

- **Retry prescriptions**: Parallel `prescriptions[]` give one imperative repair instruction per failed check (used directly in retry prompts by `scripts/uwf-runner/runner.mjs` and inspectable via `stage-tracker.mjs gate-prescriptions --workflow <name>`).
- **Verdict non-rewrite protection**: When a `verdict:` markdown line or `/verdict` JSON pointer already records a valid non-matching verdict (and `stage-result` schema validation passes), `prescribeCheck` explicitly states that the verdict is a review outcome rather than asking the agent to overwrite it, and `evaluateGate` attaches top-level `"verdict"` whenever no other non-verdict check failed.

## Structured Stage Results, Verdict Routing, and Question Pauses

### Structured Stage Result Schema (`schemas/stage-result.schema.json`)

Review and acceptance stages write `<prefix>-<stage>.result.json` alongside `<prefix>-<stage>.md`. When a gate specifies `schema: stage-result`, `stage-tracker.mjs` validates the JSON document against `.github/skills/uwf-orchestration-engine/schemas/stage-result.schema.json`:

```json
{
  "verdict": "changes_requested",
  "findings": [
    {
      "severity": "high",
      "summary": "Missing rollback transaction on stage reset",
      "location": "src/tracker.mjs:142"
    }
  ],
  "notes": "1 blocking defect requires an implementation round trip."
}
```

- **Required top-level fields**: `verdict` (`"approved"` | `"changes_requested"` | `"blocked"`) and `findings` (`array`; use `[]` when clean). Optional: `notes` (`string`).
- **Finding item fields**: required `severity` (`"high"` | `"medium"` | `"low"`) and `summary` (`string`); optional `location` (`string`). Review database severities map `critical` -> `high`, `major` -> `medium`, and `minor` -> `low`; database `rejected` maps to `blocked`.
- **Agreement invariant**: The JSON `/verdict` value and the markdown `verdict: <value>` line must agree.

### Verdict Routing (`on_verdict` Fix-Loop Contract)

Workflows with review loops (`*(fix-loop — see engine skill)*` in persona `SKILL.md` tables) declare `on_verdict` on the reviewer stage:

1. **Trigger**: A gated stage fails *only* because its `/verdict` check observed a valid schema-compliant verdict listed in `on_verdict` (for example, `changes_requested`), causing `check-gate` to emit `"verdict": "changes_requested"`. Malformed JSON or missing files omit `"verdict"` and use normal `on_gate_failure` retries instead.
2. **Rollback and reset**: Instead of retrying the reviewer, the host rolls workflow state back to the phase preceding `route_to` (`state.mjs rollback`) and resets `route_to` plus all downstream stages to `pending` via `stage-tracker.mjs reset-from --workflow <name> --stage <route_to>`.
3. **Findings handoff**: The reviewer's primary output (such as `issues-review.md`) is injected as an extra input into `route_to` and every stage up to the reviewer, and the reviewer runs in a fresh session on re-entry. `scripts/uwf-runner/runner.mjs` persists active round-trip counts and findings in `<data-dir>/runner-routing.json` across `resume` and `--from-stage`.
4. **Budget enforcement**: Once `max_round_trips` (default `2`) for that verdict is exhausted, the stage is marked `failed` and execution halts with exit `1`.

### Pending Questions and `needs-user-decision` Pauses

Ambiguity and human decisions are tracked through `.github/skills/uwf-question-protocol/questions.mjs` (see `.github/skills/uwf-question-protocol/SKILL.md`):

- **Pre-stage check**: `node .github/skills/uwf-question-protocol/questions.mjs check --stage <stage>` exits `0` when clear and `1` when required questions for `<stage>` remain unanswered.
- **Stage question emission**: Stages emit a `QUESTIONS_NEEDED` block, a non-empty `questions` array in JSON output, or a `needs-user-decision: <text>` line in markdown output. Runner surfaces log each item via `questions.mjs log` and pause (exit `3` in `runner.mjs`) until answered via `questions.mjs answer --id <n> --answer "..."`.

## `stage-tracker.mjs` CLI Reference

```sh
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs <command> [options]
```

| Command | Required flags | Optional flags | Behavior & JSON stdout |
|---|---|---|---|
| `list-stages` | `--workflow <w>` | `--model-profile <p>`, `--skills-root <dir>`, `--output-path <p>`, `--data-dir <d>` | Validates `stages.yaml`, resolves `stage_type` + `traits` + steering policies, and prints the ordered JSON array of stage descriptors |
| `check-gate` | `--workflow <w> --stage <s>` | `--output-path <p>`, `--data-dir <d>`, `--db-path <f>`, `--skills-root <dir>` | Evaluates stage gate, updates `stage_runs.gate_result` if seeded, prints gate JSON, and exits `0` (`passed: true`) or `1` (`passed: false`) |
| `gate-prescriptions` | `--workflow <w>` | `--output-path <p>`, `--data-dir <d>`, `--skills-root <dir>` | Prints `{ workflow, stages[] }` with every stage's policy fields and audit prescriptions |
| `init` | `--workflow <w>` | `--data-dir <d>`, `--db-path <f>`, `--skills-root <dir>` | Replaces `stage_runs` rows for `<w>` with `pending` rows in YAML order and logs `"Workflow initialized"` in `stage_history` |
| `read` | `--workflow <w>` | `--data-dir <d>`, `--db-path <f>` | Prints `{ ok: true, procedure: "read", workflow, state: stage_runs[] }` |
| `stage-start` | `--workflow <w> --stage <s>` | `--session-id <id>`, `--note <t>`, `--data-dir <d>`, `--db-path <f>` | Marks stage `active`, sets `started_at`, and returns `pre_flight_check` + `state_actions` |
| `stage-complete` | `--workflow <w> --stage <s>` | `--session-id <id>`, `--note <t>`, `--data-dir <d>`, `--db-path <f>` | Marks stage `passed`, sets `completed_at`, and returns `state_actions` (`release-agent` and `advance` when `advances_phase_to` is set) |
| `stage-fail` | `--workflow <w> --stage <s>` | `--note <t>`, `--session-id <id>`, `--data-dir <d>`, `--db-path <f>` | Marks stage `failed`, increments `retry_count`, coalesces `session_id`, and returns `retry_count` + `state_actions` |
| `stage-skip` | `--workflow <w> --stage <s>` | `--session-id <id>`, `--note <t>`, `--data-dir <d>`, `--db-path <f>` | Marks stage `skipped`, sets `completed_at`, and returns `state_actions` |
| `stage-session` | `--workflow <w> --stage <s> --session-id <id>` | `--data-dir <d>`, `--db-path <f>` | Persists adapter `session_id` without changing `status` so crash recovery can resume |
| `reset-from` | `--workflow <w> --stage <s>` | `--note <t>`, `--data-dir <d>`, `--db-path <f>` | Resets `<s>` and all subsequent YAML stages to `pending` (`retry_count = 0`, `session_id = NULL`) and appends `stage_history` rows |
| `reset` | *(none)* | `--data-dir <d>`, `--db-path <f>` | Deletes the resolved `uwf-stages.db` file and prints `{ ok: true, procedure: "reset", deleted }` |

**Exit codes**: `0` = command succeeded (or gate passed for `check-gate`); `1` = gate failed or operational validation error (`{ ok: false, error }` on stdout); `2` = CLI usage error on stderr (`Usage error: ...`).

## Artifact Handoffs, Stage Context, and Adding a Workflow

### Materialized Stage Context Contract

When a runner or plugin invokes a stage agent, it supplies the resolved stage context alongside templated `inputs` and required `outputs` (see `scripts/uwf-runner/prompt.mjs`):

- **Base context**: `workflow`, `role` (artifact/DB namespace from the persona skill), `phase`, and resolved `outputPath`.
- **Canonical stage policy context** (when `stage_type` is non-null): `stage_type`, `trait_ids`, `model_profile`, `behavior_policy`, and `steering_policy` from `list-stages`.
- **Skipped-stage inputs**: When an upstream conditional or `on_gate_failure: skip` stage is skipped, downstream stages treat its declared outputs as unavailable optional inputs rather than missing prerequisites.

### Adding a New Workflow

1. Create `.github/skills/uwf-{name}/stages.yaml` declaring `workflow`, `artifact_prefix`, `output_path`, and `stages` (using canonical `stage_type` + `traits` where a contract exists, or `agent` for persona-specific agents).
2. Create `.github/skills/uwf-{name}/run.mjs` forwarding `--list-stages` and `--check-gate` to `../uwf-orchestration-engine/stage-tracker.mjs` with `--workflow <name>`.
3. Document `mode` / `role`, `Artifact Prefix`, `Stage Sequence`, and `Subagent Roster` in `.github/skills/uwf-{name}/SKILL.md`.
4. Create any new `.github/agents/uwf-{name}-{stage}.agent.md` definitions (and if supporting the Copilot Chat fallback, list them under `agents:` in `.github/agents/uwf-core-orchestrator.agent.md` per [`docs/guide/copilot-orchestrator.md`](../../../docs/guide/copilot-orchestrator.md)).
5. Verify reference and gate integrity:
   ```sh
   node scripts/uwf-smoke/test-skill-reference-integrity.mjs
   node scripts/uwf-smoke/test-prompt-references.mjs
   ```
   Expected output: `0 failed` in `test-skill-reference-integrity.mjs` and `prompt files OK` in `test-prompt-references.mjs`.

### Legacy `skill-runner.mjs` Helpers

`.github/skills/uwf-orchestration-engine/skill-runner.mjs` remains available for standalone Node scripts that call imperative file-check helpers directly (`requireNonEmptyFile`, `requireFileContains`, `requireFilesWithPrefix`, `requireFileMatchingPattern`, `gatePass`, `gateFail`, `runCLI`). Declarative `stages.yaml` workflows should use `stage-tracker.mjs` instead.
