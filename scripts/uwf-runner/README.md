# uwf-runner

Deterministic stage runner for UWF. The runner owns the stage loop, gates and state;
a harness adapter only runs ONE stage agent through a CLI.

## Adapter contract (`adapters/types.d.ts`)

```js
const adapter = await loadAdapter("claude-code"); // or "fake"
const r = await adapter.invokeStage({
  agentFile, systemPrompt, prompt, cwd, inputs, outputs, skillsRoot,
  model, sessionId, timeoutMs, env, permissions, dataDir,
});
// r = { ok, sessionId, transcriptPath, stdout, exitCode, usage|null, costUsd?, error? }
```

- `permissions`: `read-only` | `edit` | `edit+exec` | `read-only+review` (read tools, the review script `node .github/skills/uwf-review/reviews.mjs`, and Write limited to the stage `outputs`; adapter maps to harness tool/permission flags).
- `sessionId` in -> same `sessionId` out (resume across gate retries).
- Transcript is written to `<dataDir>/transcripts/<timestamp>.json`;
  `dataDir` defaults to `UWF_DATA_DIR`, else `./tmp/uwf`.
- Never throws, never evaluates gates, never writes workflow state. Failures
  (non-zero exit, timeout, bad output) return `ok:false` with `error`.
- `usage` is `{ inputTokens, outputTokens }` when the CLI reports it, else `null`.

## Adapters

| name | CLI | notes |
| --- | --- | --- |
| `claude-code` | `claude -p` | `--append-system-prompt`, `--resume`, tool allowlist from `permissions`, reports cost |
| `codex` | `codex exec` | see below |
| `fake` | none | offline fixture replay for CI |
| `grokbot` | none (file handoff) | external agent (e.g. Grok Bot) fulfils each stage; see below |

### What a stage inherits from the machine

The `claude-code` adapter passes `--setting-sources project`, so a stage loads only the target repo's
`.claude/settings.json` and project `CLAUDE.md`. The operator's user-level `~/.claude/CLAUDE.md` and user
settings do not reach the stage. `--bare` would also skip hooks and CLAUDE.md discovery, but it only works
with API-key auth, so the runner does not use it.

### `codex` adapter

Command: `codex exec --cd <cwd> [--model m] --json -c sandbox_mode=".." -c approval_policy="never" --skip-git-repo-check --output-last-message <tmpfile> -`
(prompt on stdin). With `sessionId`: `codex exec resume <sessionId> ...` (no `--cd`; the cwd is set on the child process).

| `permissions` | Codex |
| --- | --- |
| `read-only` | `sandbox_mode="read-only"` |
| `edit` | `sandbox_mode="workspace-write"` |
| `edit+exec` | `sandbox_mode="workspace-write"` |
| `read-only+review` | `sandbox_mode="workspace-write"` (review DB must be writable; the command limit is prompt-enforced) |

Never uses `danger-full-access` or `--dangerously-bypass-*`.

Limitations:
- No per-tool allowlist: `edit` and `edit+exec` are identical (commands always run in the workspace-write sandbox, network off by default).
- No system-prompt flag: `agentFile`/`systemPrompt` are prepended to the prompt under `# Agent instructions`, so they are weaker than a real system prompt.
- `exec resume` has no `--sandbox`/`--cd`; the adapter uses `-c sandbox_mode=...` and the child cwd instead.
- No cost: `costUsd` is omitted. `usage` comes from `turn.completed` events and is `null` if absent.
- `sessionId` is the `thread.started` thread id; if the CLI emits none, the passed-in id (or `null`) is returned.
- The JSONL event names (`thread.started`, `item.completed`/`agent_message`, `turn.completed`) have not been verified against a live run; parsing is defensive and the final message prefers `--output-last-message`.

### `grokbot` adapter

File-based handoff for an agent that runs outside the runner process (no CLI to spawn). The runner keeps
the stage loop, gates, retries, `on_verdict` routing, questions and state; the adapter only hands one attempt over and waits.

Per attempt it writes `<dataDir>/grokbot/requests/<NNNN>-<stage>.{json,md}` (system prompt, stage prompt incl. gate
failure prescriptions on retries, inputs, required outputs, cwd, permissions, session id) and `<dataDir>/grokbot/pending.json`,
then polls (`UWF_GROKBOT_POLL_MS`, default 2000) for `<dataDir>/grokbot/responses/<NNNN>-<stage>.json`:

```json
{ "ok": true, "summary": "final message; may contain the standard questions block", "sessionId": "optional" }
```

`"ok": false, "error": "..."` reports a failed attempt (counts as a gate failure). `--timeout-ms` bounds the wait.
The agent writes the stage outputs into the repo root itself; the runner then runs `--check-gate`.
If the runner is killed while waiting, `runner.mjs resume` re-issues the active stage as a new request.

```sh
node scripts/uwf-runner/runner.mjs run --workflow project_manager --goal goal.md --adapter grokbot \
  --repo-root ../my-app --data-dir ../my-app-uwf &
cat ../my-app-uwf/grokbot/pending.json   # -> request .md + responsePath
```

Limitations: no usage/cost reporting (`usage: null`); `permissions` and `maxTurns` are advisory (written into the request,
not enforced); one pending request at a time per data dir.

## Adding an adapter

1. Create `adapters/<name>.mjs` exporting `name` and `invokeStage(opts)`.
2. Use `writeTranscript`, `buildSystemPrompt` from `adapters/index.mjs`.
3. Add `<name>` to `ADAPTERS` in `adapters/index.mjs`.
4. Add a `contract(...)` block in `test/adapters.test.mjs`
   (gate live CLIs behind `UWF_TEST_LIVE` so CI stays offline).

## Tests

`node scripts/uwf-runner/test/adapters.test.mjs` (live: `UWF_TEST_LIVE=1`; claude uses haiku, codex uses its default model unless `UWF_TEST_CODEX_MODEL` is set).

## Runner (`runner.mjs`)

```sh
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal "Add X" [--adapter claude-code|codex|fake|grokbot] \
  [--model m] [--data-dir d] [--output-path p] [--from-stage s] [--non-interactive] [--dry-run] [--timeout-ms n] \
  [--max-cost-usd n] [--resume-max-context tokens]
```

Exit codes: 0 complete, 1 gate blocked, abort or `on_verdict` round trips exhausted, 2 usage/config error, 3 questions pending (or a review needing a user decision), 4 cost cap exceeded
(answer with `questions.mjs answer`, then rerun with `--from-stage <stage>`).
A run without `--from-stage` re-initializes the stage-tracker and state stores in the data dir,
unless the workflow in that data dir is already complete: then it prints the stage table and exits 0
(`--force` re-initializes anyway). `--from-stage <s>` calls `stage-tracker.mjs reset-from` and rolls
the phase back via `state.mjs rollback`.

## Parallel fronts

Several runs against one repo are supported with these rules:

- **One `--data-dir` per front is required.** The skill SQLite databases (state, stage tracker, blueprint, questions, ...) live in the data dir; two fronts sharing one corrupt each other's state. `run` and `resume` write `<data-dir>/run.lock` (run id and pid) and refuse to start, exit 2, naming the other run when its pid is still alive. The runner never takes a lock over by itself: a lock left by a crashed run (dead pid, or unreadable for more than 10 s) also exits 2 with the remedy, and `--unlock` on a single recovery run removes it (do not start several runs with `--unlock` at once). The lock is removed when the run ends.
- **Pass a distinct `--output-path` per front too.** The default `./tmp/workflow-artifacts` is per target repo, so fronts on one repo would overwrite each other's stage artifacts.
- **ADR numbers are reserved atomically.** `adrs.mjs create` (and `adrs.mjs next-number`) claim the next number with an exclusive file create under `docs/adr/`, so concurrent fronts never get the same number. Use the path the command returns.

`runner.mjs resume --workflow w [--adapter a] [--model m] [--data-dir d] [--output-path p] [--non-interactive] [--timeout-ms n]`
continues from the first stage not passed/skipped without re-initializing stores. The goal is read
from `<data-dir>/runner-goal.md` (written by `run`; exit 2 if missing). An `active` stage (crash) is
re-invoked without counting against retries; a `failed` one restarts with retries reset.
`on_gate_failure: retry` retries `max_retries` times then fails; `skip` and `abort` act on the first failure.
`retry_mode: resume` (default) passes the previous attempt's session id to the adapter on each retry (and on `resume` of a stage whose tracker row has a `session_id`); `retry_mode: fresh` omits it so every attempt starts a new session. The id is recorded in `stage_runs.session_id`.
`max_turns` (positive integer; default 20, `implementation` 30) caps the agent turns of one attempt and is passed to the adapter (`claude -p --max-turns`; the fake adapter fails a fixture whose `turnsNeeded` exceeds it). A stage that stops at the cap is a gate failure whose retry prompt says: "The stage stopped after N turns without producing <outputs>; read only the listed inputs and write the outputs directly." `--list-stages` exposes it as `maxTurns`; `--dry-run` and `gates` print it.
`on_verdict` (optional map, e.g. `on_verdict: { changes_requested: { route_to: implementation, max_round_trips: 2 } }`) turns a review outcome into a route instead of a retry. `route_to` must name an earlier stage of the same workflow and `max_round_trips` (positive integer) defaults to 2; both are validated by `stage-tracker.mjs` and exposed by `--list-stages` as `onVerdict: { <verdict>: { routeTo, maxRoundTrips } }`. When a gated stage fails *only* because its `/verdict` JSON check (`require_json_field`, `equals`/`in`) holds a value that is a key of `on_verdict` (the stage-tracker gate result then carries `verdict`; a missing or invalid verdict is a plain failure and retries as before), the runner does not retry the stage. It rolls the state phase back to the one reached before `route_to` (same logic as `--from-stage`), resets `route_to` and every later stage to pending, and re-runs forward. The stage's first output (e.g. `issues-review.md`) is added as an extra input to `route_to` and every stage between it and the reviewer, with a "Review findings to address" note in their prompts; the reviewer starts a fresh session. When `max_round_trips` for that verdict is used up the stage is marked failed and the run exits 1 with `round-trip budget to <stage> is exhausted`. The summary table adds the extra attempts to the re-run stages (`review  2  passed after 1 round trip(s)`). The round-trip counts and the pending findings are persisted in `<data-dir>/runner-routing.json` when a route happens, so an interrupted run keeps its budget and the routed stages still get the findings on `resume` and `run --from-stage`; the findings are dropped once the reviewing stage passes, and the file is deleted when the workflow completes or a fresh `run` starts.
A stage with `on_verdict` that fails its gate and whose outputs say a finding needs a user decision stops with exit 3 instead of routing or retrying: a non-empty `questions` array in a `.json` output, or a line `needs-user-decision: <text>` (also `needs user decision:`) in a markdown output. Each item is logged as a required question for that stage; answer with `questions.mjs answer`, then rerun with `--from-stage <stage>`.
The "include the text X" prescription for a `verdict: x` / `/verdict` equals check is produced only when the verdict is missing; when a different verdict is recorded it says so and that the verdict is a review outcome, not something to rewrite.
`runner.mjs cost --data-dir d [--workflow w] [--repo-root r]` reads `<d>/transcripts/*.json` and prints per stage the turns, context per turn ((cache_read + cache_write) / turns), cache and output tokens, thinking tokens, reported cost, and flags (`!50K` average context per turn above 50K, `!100K` final turn likely above the 100K pricing tier). With `--workflow` it adds the static prompt size (chars, ~tokens at 4 chars/token) and the size of the agent file plus the `.github/...` files it tells the stage to read.
Tests: `node scripts/uwf-runner/test/runner.test.mjs` (fake adapter, fixtures in `test/fixtures/<workflow>/`).

## Install story for a consumer repo

Nothing to copy. The runner keeps two roots apart:

- **skills root** holds the workflow definitions (`uwf-<workflow>/stages.yaml`), stage contracts, traits, model profiles, schemas, agent files (`.github/agents`) and SKILL docs. It defaults to the runner's own checkout.
- **repo root** (`--repo-root`, default the current checkout) is the target repo: the agent's cwd, where `{{cwd}}` gate paths and `{{output_path}}` resolve, and where `tmp/workflow-artifacts` is written.

Resolution rule for the skills root, first match wins:

1. `--skills-root <dir>` (a directory that contains `.github/skills` and `.github/agents`)
2. env `UWF_SKILLS_ROOT`
3. the target repo's own copy, when `<repo-root>/.github/skills/uwf-<workflow>/stages.yaml` exists (the runner logs `using the target repo's own workflow definitions` once). Use this to override a stage, for example `max_retries`, in one repo. Engine resources and agent files the target does not carry fall back to the runner's checkout.
4. the runner's own checkout

The runner passes the resolved root to every CLI it spawns (`UWF_SKILLS_ROOT`) and to prompt materialization, which rewrites the `.github/skills/...` and `.github/agents/...` paths inside agent text to absolute paths under the skills root, so a stage never looks for them in the target. `run`, `resume`, `--dry-run`, `gates` and `cost` all use the same rule.

Gate commands (`run_script` checks in a `stages.yaml`) resolve skill paths the same way prompts do: the stage tracker reads the root from `--skills-root` or `UWF_SKILLS_ROOT`, and every `.github/skills/...` or `.github/agents/...` path in a check's `cmd` or `args` is replaced by the target repo's own copy when one exists, otherwise by the same path under the skills root. The command still runs with cwd = the repo root, so relative output paths and `{{cwd}}` keep meaning the target; `{{skills_root}}` is also available. Without a skills root the command is left as written.

What the target needs: a git repo and the output path (created on demand). No `.github/`, no skills, no agents.

```
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal goal.md --repo-root ../my-app
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal goal.md --repo-root ../my-app --skills-root ../uwf-fork
```

### Cost caps and resume context threshold

- **Model selection**: the model is resolved as `--model` > the stage's `model:` in `stages.yaml` > an adapter default. Only `claude-code` has one: `claude-sonnet-5-5`, so a run without `--model` never inherits the account's (expensive) default model. `fake`, `grokbot` and `codex` pass no model unless one is set. The run logs the resolved model and where it came from (`model: claude-sonnet-5-5 (default for claude-code; pass --model to override)`), and `--dry-run` shows the same per stage.
- `--max-cost-usd <n>`: after every attempt the runner sums `total_cost_usd` over this run's transcripts; above `n` it stops with **exit 4** (cost cap exceeded). The attempt is recorded first (gate verdict, stage passed/failed/skipped) and the run stops before any further attempt or stage starts, naming the stage status (e.g. "review passed; cost cap exceeded"). "This run" means the transcripts produced by this invocation; a fresh `run` leaves older transcripts in the data dir but does not count them, while `resume` and `run --from-stage` also count the transcripts already present (same run). A stage can carry its own cap with `max_cost_usd: <n>` in `stages.yaml` (summed over that stage's attempts in this invocation; exposed by `--list-stages` as `maxCostUsd`, null when unset). Raise the cap and use `resume` to continue. The cap is a **stop-after** check, not a hard limit: the run stops after the first attempt that pushes the summed cost over `n`, so a single attempt can exceed it (the start banner says so).
- `--resume-max-context <tokens>` (default 100000): `retry_mode: resume` re-submits the whole conversation, and a cache miss re-writes it at cache-write price. When an attempt's last turn held more than this many tokens (input + cache read + cache write), the next retry of that stage starts a fresh session instead, with the gate prescription plus the last 40 lines of the previous attempt's primary output file appended to the prompt. A log line says why it switched.
- `cost` marks attempts whose `cache_write` exceeds `cache_read` with `!MISS` in the flags column when cache_write also exceeds 50K (a real re-bill; the first write of a short stage does not count).
