# ADR-0008: Multi-surface MCP and plugin runtime contract

Date: 2026-11-19
Status: Accepted
Supersedes: [ADR-0001-vs-code-extension-architecture.md](./ADR-0001-vs-code-extension-architecture.md)
and [#109](https://github.com/qwts/universal-agentic-workflow/issues/109)

## Context
- [ADR-0007](./ADR-0007-runtime-owns-the-loop.md) moved stage sequencing, gate
  evaluation, and retry budgets out of conversational prompts and into the
  deterministic runner
  ([`scripts/uwf-runner/runner.mjs`](../../scripts/uwf-runner/runner.mjs)).
  However, invoking that runner and inspecting its eight SQLite stores still
  assumes direct local shell access or a single-editor companion view
  ([ADR-0001](./ADR-0001-vs-code-extension-architecture.md),
  [#109](https://github.com/qwts/universal-agentic-workflow/issues/109)).
- UAW workflows declared in `stages.yaml` (such as
  [`.github/skills/uwf-sw_dev/stages.yaml`](../../.github/skills/uwf-sw_dev/stages.yaml))
  must execute identically across three host surfaces without duplicating gate
  logic or coupling state to any host UI
  ([#177](https://github.com/qwts/universal-agentic-workflow/issues/177)):
  1. **Standalone MCP servers** over local `stdio` or authenticated remote
     Streamable HTTP / SSE for headless chat clients, CI agents, and
     orchestrators.
  2. **Dev-tool and IDE plugins** (`plugin.json` packages bundling hooks, stage
     subagents, progressive-disclosure skills, and shareable `.uaw-pack.yaml`
     workflow packs).
  3. **Browser extension hosts** (Manifest V3 service workers and side panels)
     that cannot load native Node SQLite addons (`better-sqlite3`) or spawn
     local processes directly without an MCP transport boundary.
- Interactive workflows pause with runner exit code `3` (`QUESTIONS`) whenever a
  stage emits `QUESTIONS_NEEDED` or review `questions[]` /
  `needs-user-decision:` entries into
  [`questions.mjs`](../../.github/skills/uwf-question-protocol/questions.mjs).
  Without a surface-neutral protocol for reading pending questions, recording
  answers, and resuming execution, non-CLI surfaces either block indefinitely or
  invent host-specific state shims.
- Concurrent runs on a shared workstation or remote MCP host collide unless
  every command and read resource scopes strictly to an isolated data directory
  ([#81](https://github.com/qwts/universal-agentic-workflow/issues/81),
  [#97](https://github.com/qwts/universal-agentic-workflow/issues/97)) and
  respects the runner's atomic per-run lock.

## Decision
- **One canonical MCP runtime contract (`uaw-mcp/v1`) fronts the runner and
  stores.** UAW exposes deterministic command tools and CQRS read resources/tools
  over the Model Context Protocol. Every host surface—standalone `stdio`/remote
  MCP server, IDE/dev-tool plugin, or browser extension—speaks this contract
  rather than shelling out ad hoc or opening SQLite files directly in UI code.
- **Command tools expose deterministic execution, transitions, and question
  resolution.** Mutating MCP tools wrap the existing CLIs, require an explicit
  `run_id` or resolved `data_dir`, and return structured JSON envelopes
  preserving [`runner.mjs`](../../scripts/uwf-runner/runner.mjs) exit codes
  (`0` `OK`, `1` `GATE`, `2` `USAGE`, `3` `QUESTIONS`, `4` `COST`):
  - `uaw_run`: invokes `runner.mjs run` (`workflow`, `goal`, `adapter`
    `claude-code|codex|fake|grokbot`, `model`, `data_dir`, `output_path`,
    `from_stage`, `force`, `unlock`, `non_interactive`, `dry_run`, `timeout_ms`,
    `repo_root`, `skills_root`, `max_cost_usd`, `resume_max_context`) and
    returns `{ run_id, data_dir, exit_code, status, phase, failed_stage,
    pending_questions, cost_summary }`.
  - `uaw_resume`: invokes `runner.mjs resume` from the first non-`passed`,
    non-`skipped` stage recorded in `uwf-stages.db`.
  - `uaw_gates`: invokes `runner.mjs gates` and
    [`stage-tracker.mjs`](../../.github/skills/uwf-orchestration-engine/stage-tracker.mjs)
    (`check-gate`, `gate-prescriptions`) to evaluate `require_non_empty`,
    `require_contains`, `require_files_with_prefix`,
    `require_file_matching_pattern`, `run_script`, and `require_json_field`
    checks without advancing state.
  - `uaw_cost`: invokes
    [`scripts/uwf-runner/cost.mjs`](../../scripts/uwf-runner/cost.mjs) over
    `<data-dir>/transcripts/*.json`, returning per-stage and total `turns`,
    `ctx/turn`, `last-turn`, `cache_read`, `cache_write`, `output`, `thinking`,
    `cost`, and `!50K` / `!100K` / `!MISS` threshold flags.
  - `uaw_stage_transition`: executes explicit operator or thin-orchestrator
    transitions across
    [`state.mjs`](../../.github/skills/uwf-state-manager/state.mjs) (`init`,
    `advance`, `rollback`, `set-status`, `sync`, `note`) and
    [`stage-tracker.mjs`](../../.github/skills/uwf-orchestration-engine/stage-tracker.mjs)
    (`init`, `stage-start`, `stage-complete`, `stage-fail`, `stage-skip`,
    `reset-from`), refusing mutation with code `2` if an active `run.lock` is
    held by another process.
  - `uaw_question_resolve`: wraps `uwf-question-protocol`
    ([`questions.mjs`](../../.github/skills/uwf-question-protocol/questions.mjs)
    `list`, `check`, `answer`, `skip`) so any host surface can resolve exit-`3`
    `QUESTIONS` pauses and immediately call `uaw_resume`.
- **CQRS read resources and query tools open all eight SQLite stores strictly
  read-only.** Read endpoints resolve database paths through
  [`data-dir.mjs`](../../.github/skills/uwf-state-manager/data-dir.mjs)
  (`--db-path` > `--data-dir` > `UWF_DATA_DIR`) and open WAL snapshots with
  `readonly: true` and `PRAGMA query_only = ON`, ensuring UI polling and chat
  inspection never block or mutate an active writer:
  - `uaw://<run>/state` (`uaw_read_state`) → `uwf-state.db` (`workflow_state`
    phase `idea → intake → discovery → planning → execution → acceptance →
    snapshot → closed`, active agent lock, model profile, and
    `workflow_history`).
  - `uaw://<run>/stages` and `uaw://<run>/gates/<stage>` (`uaw_read_stages`) →
    `uwf-stages.db` (`stage_runs`, `stage_history`, retry counts, session IDs,
    gate verdicts, and retry prescriptions) plus `runner-routing.json`
    (`on_verdict` round-trip budgets).
  - `uaw://<run>/requirements` (`uaw_read_requirements`) → `uwf-requirements.db`
    (`FR-*`, `NFR-*`, `DR-*`, `AC-*`, `RK-*` records via
    [`requirements.mjs`](../../.github/skills/uwf-requirements/requirements.mjs)).
  - `uaw://<run>/adrs` (`uaw_read_adrs`) → `uwf-adrs.db` (`ADR-NNNN` records and
    claim state via [`adrs.mjs`](../../.github/skills/uwf-adr/adrs.mjs)).
  - `uaw://<run>/discoveries` (`uaw_read_discoveries`) → `uwf-discoveries.db`
    (discoveries and open `gap` items via
    [`discoveries.mjs`](../../.github/skills/uwf-discovery/discoveries.mjs)).
  - `uaw://<run>/issues` (`uaw_read_issues`) → `uwf-issues.db` (local work items
    via [`issues.mjs`](../../.github/skills/uwf-local-tracking/issues.mjs)).
  - `uaw://<run>/reviews` (`uaw_read_reviews`) → `uwf-reviews.db` (reviews and
    `critical|major|minor` findings via
    [`reviews.mjs`](../../.github/skills/uwf-review/reviews.mjs)).
  - `uaw://<run>/questions` (`uaw_read_questions`) → `uwf-questions.db`
    (`pending|answered|skipped` decision items).
  - `uaw://<run>/transcripts` and `uaw://<run>/transcripts/<id>`
    (`uaw_read_transcript`) → `<data-dir>/transcripts/*.json`, scrubbed through
    `redactSecrets()` in
    [`scripts/hooks/secret-patterns.mjs`](../../scripts/hooks/secret-patterns.mjs)
    prior to serialization (matching read-only MCP resources for hosts that only
    support tool calls).
- **Three host surfaces share identical `stages.yaml` execution with zero
  host-UI coupling:**
  - **Standalone MCP server (`stdio` and remote Streamable HTTP / SSE):** runs
    as a self-contained Node process hosting `uaw-mcp/v1`. Local CLI/chat hosts
    attach over `stdio`; remote multi-client agents connect over authenticated
    HTTP/SSE with per-run `data_dir` sandboxing.
  - **Dev-tool and IDE plugin (`plugin.json` + `.uaw-pack.yaml`):** packages
    [`scripts/hooks/preToolUse.mjs`](../../scripts/hooks/preToolUse.mjs)
    guardrails, stage subagent definitions, progressive-disclosure skills
    ([ADR-0004](./ADR-0004-skills-live-in-the-monorepo.md)), and declarative
    `.uaw-pack.yaml` workflow/eval overlays (`archetype`, `stages_patch`,
    `eval_gates`, `skills_root`) while delegating state and execution to the
    local `stdio` MCP server.
  - **Browser extension host:** connects to a remote HTTP/SSE UAW MCP endpoint
    (or a local native-messaging `stdio` bridge) to render live stage/gate
    status, inspect scrubbed transcripts, answer `uaw_question_resolve` prompts,
    and trigger `uaw_run` / `uaw_resume` without bundling Node or SQLite in the
    browser runtime.
- **Per-run `run.lock` and workspace isolation prevent cross-run interference.**
  Every run allocates an isolated `data_dir` containing the eight SQLite files,
  `runner-goal.md`, `runner-routing.json`, `transcripts/`, and
  `<data-dir>/workflow-artifacts/`. Mutating tools acquire `<data-dir>/run.lock`
  (`{ runId, pid, workflow, startedAt }`) atomically via temp-file write +
  `linkSync`; locks are never stolen automatically and are cleared on crash only
  via explicit `unlock: true` when the owner PID is dead or unreadable past the
  stale window. Multi-repo or concurrent single-repo runs use separate git
  worktrees + distinct `data_dir` paths so parallel MCP sessions never contend.

## Alternatives considered
1) **Build bespoke UI-coupled companions per host** (a VS Code extension reading
   SQLite directly as in [ADR-0001](./ADR-0001-vs-code-extension-architecture.md)
   / [#109](https://github.com/qwts/universal-agentic-workflow/issues/109), a
   separate browser REST backend, and a CLI wrapper). Duplicates SQLite query,
   secret-redaction, and question-resume logic three times and breaks browser
   hosts that cannot load native SQLite bindings.
2) **Expose raw SQL or generic filesystem MCP tools over `<data-dir>`.**
   Minimal server code, but leaks internal table schemas to clients, bypasses
   CQRS `query_only` and `run.lock` invariants, and risks unsanitized transcript
   exposure.
3) **Compile `stages.yaml` into host-specific plugin workflows** (separate IDE
   slash-command loops vs. browser state machines). Violates
   [ADR-0007](./ADR-0007-runtime-owns-the-loop.md) by moving loop ownership back
   into host glue and guarantees behavioral drift across surfaces.

## Consequences
- Positive: one `stages.yaml` workflow runs unchanged across standalone MCP chat
  clients, IDE plugins, CI runners, and browser extensions; read-only CQRS
  queries never contend with active stage writers; `QUESTIONS` exit-`3`
  human-in-the-loop pauses become portable across every UI surface; `.uaw-pack.yaml`
  packs share domain archetypes without forking the core monorepo.
- Negative: the MCP server schema (`uaw-mcp/v1`) becomes a versioned public
  surface that must stay synchronized with CLI flags in `runner.mjs`,
  `state.mjs`, and `stage-tracker.mjs`; remote HTTP/SSE deployments require
  explicit bearer-token authentication, workspace path allowlists, and per-run
  retention cleanup ([#97](https://github.com/qwts/universal-agentic-workflow/issues/97)).
- Follow-ups: implement the `uaw-mcp` server entrypoint and contract test suite
  under [#177](https://github.com/qwts/universal-agentic-workflow/issues/177);
  package the reference `plugin.json` and `.uaw-pack.yaml` loader; expose
  `uaw://<run>/manifest` once [ADR-0009](./ADR-0009-provenance-manifest-context-hub-sink.md)
  lands ([#178](https://github.com/qwts/universal-agentic-workflow/issues/178));
  update [product-definition.md](../product/product-definition.md) and
  [roadmap-v1.md](../product/roadmap-v1.md) to reflect the three-surface MCP
  architecture.

## Security / Privacy / Compliance notes
- **Mandatory transcript and state redaction:** every transcript resource/tool
  response and free-text note served over MCP passes through `redactSecrets()`
  in [`scripts/hooks/secret-patterns.mjs`](../../scripts/hooks/secret-patterns.mjs)
  (`private-key`, `anthropic-key`, `openai-key`, `github-token`,
  `aws-access-key`, `slack-token`, `bearer-token`) before leaving the server.
- **Transport & path boundaries:** `stdio` servers inherit local user
  permissions; remote HTTP/SSE servers MUST bind to `127.0.0.1` by default,
  require constant-time bearer authentication plus `Origin` validation when
  exposed to browser extensions, and constrain `repo_root`, `data_dir`, and
  `output_path` to configured workspace roots to prevent path traversal.
- **Hook parity across surfaces:** stage execution triggered via `uaw_run` or
  `uaw_resume` enforces the same
  [`scripts/hooks/preToolUse.mjs`](../../scripts/hooks/preToolUse.mjs) destructive
  command blocks and sensitive path guards (`/.github/`, `/.vscode/`,
  `/infra/prod`, `/terraform/prod`, `/k8s/prod`) as direct CLI runs.

## Verification
- Contract test runs an identical `sw_dev` fixture workflow with `--adapter fake`
  through (a) direct CLI, (b) `stdio` MCP client calls (`uaw_run` → exit `3` →
  `uaw_question_resolve` → `uaw_resume` → exit `0`), and (c) HTTP/SSE MCP client
  calls, asserting identical `uwf-state.db` and `uwf-stages.db` terminal rows.
- Concurrency test launches two parallel `uaw_run` calls against the same
  `data_dir` (asserting the second fails immediately with exit code `2` without
  clobbering `run.lock`) and two parallel calls against distinct `data_dir`
  paths (asserting both complete `closed` with zero cross-talk).
- Security test injects synthetic API tokens matching every pattern in
  `secret-patterns.mjs` into a fixture transcript and verifies `uaw_read_transcript`
  and `uaw://<run>/transcripts/<id>` return `[redacted:<kind>]` placeholders with
  zero raw secret substrings.
