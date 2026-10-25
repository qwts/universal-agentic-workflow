# uwf-runner

Deterministic stage runner for UWF. The runner owns the stage loop, gates and state;
a harness adapter only runs ONE stage agent through a CLI.

## Adapter contract (`adapters/types.d.ts`)

```js
const adapter = await loadAdapter("claude-code"); // or "fake"
const r = await adapter.invokeStage({
  agentFile, systemPrompt, prompt, cwd, inputs, outputs,
  model, sessionId, timeoutMs, env, permissions, dataDir,
});
// r = { ok, sessionId, transcriptPath, stdout, exitCode, usage|null, costUsd?, error? }
```

- `permissions`: `read-only` | `edit` | `edit+exec` (adapter maps to harness tool/permission flags).
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

### `codex` adapter

Command: `codex exec --cd <cwd> [--model m] --json -c sandbox_mode=".." -c approval_policy="never" --skip-git-repo-check --output-last-message <tmpfile> -`
(prompt on stdin). With `sessionId`: `codex exec resume <sessionId> ...` (no `--cd`; the cwd is set on the child process).

| `permissions` | Codex |
| --- | --- |
| `read-only` | `sandbox_mode="read-only"` |
| `edit` | `sandbox_mode="workspace-write"` |
| `edit+exec` | `sandbox_mode="workspace-write"` |

Never uses `danger-full-access` or `--dangerously-bypass-*`.

Limitations:
- No per-tool allowlist: `edit` and `edit+exec` are identical (commands always run in the workspace-write sandbox, network off by default).
- No system-prompt flag: `agentFile`/`systemPrompt` are prepended to the prompt under `# Agent instructions`, so they are weaker than a real system prompt.
- `exec resume` has no `--sandbox`/`--cd`; the adapter uses `-c sandbox_mode=...` and the child cwd instead.
- No cost: `costUsd` is omitted. `usage` comes from `turn.completed` events and is `null` if absent.
- `sessionId` is the `thread.started` thread id; if the CLI emits none, the passed-in id (or `null`) is returned.
- The JSONL event names (`thread.started`, `item.completed`/`agent_message`, `turn.completed`) have not been verified against a live run; parsing is defensive and the final message prefers `--output-last-message`.

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
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal "Add X" [--adapter claude-code|fake] \
  [--model m] [--data-dir d] [--output-path p] [--from-stage s] [--non-interactive] [--dry-run] [--timeout-ms n]
```

Exit codes: 0 complete, 1 gate blocked or abort, 2 usage/config error, 3 questions pending
(answer with `questions.mjs answer`, then rerun with `--from-stage <stage>`).
A run without `--from-stage` re-initializes the stage-tracker and state stores in the data dir,
unless the workflow in that data dir is already complete: then it prints the stage table and exits 0
(`--force` re-initializes anyway). `--from-stage <s>` calls `stage-tracker.mjs reset-from` and rolls
the phase back via `state.mjs rollback`.

`runner.mjs resume --workflow w [--adapter a] [--model m] [--data-dir d] [--output-path p] [--non-interactive] [--timeout-ms n]`
continues from the first stage not passed/skipped without re-initializing stores. The goal is read
from `<data-dir>/runner-goal.md` (written by `run`; exit 2 if missing). An `active` stage (crash) is
re-invoked without counting against retries; a `failed` one restarts with retries reset.
`on_gate_failure: retry` retries `max_retries` times then fails; `skip` and `abort` act on the first failure.
`retry_mode: resume` (default) passes the previous attempt's session id to the adapter on each retry (and on `resume` of a stage whose tracker row has a `session_id`); `retry_mode: fresh` omits it so every attempt starts a new session. The id is recorded in `stage_runs.session_id`.
`max_turns` (positive integer; default 20, `implementation` 30) caps the agent turns of one attempt and is passed to the adapter (`claude -p --max-turns`; the fake adapter fails a fixture whose `turnsNeeded` exceeds it). A stage that stops at the cap is a gate failure whose retry prompt says: "The stage stopped after N turns without producing <outputs>; read only the listed inputs and write the outputs directly." `--list-stages` exposes it as `maxTurns`; `--dry-run` and `gates` print it.
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

What the target needs: a git repo and the output path (created on demand). No `.github/`, no skills, no agents.

```
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal goal.md --repo-root ../my-app
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal goal.md --repo-root ../my-app --skills-root ../uwf-fork
```
