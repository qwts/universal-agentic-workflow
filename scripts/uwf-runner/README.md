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
Tests: `node scripts/uwf-runner/test/runner.test.mjs` (fake adapter, fixtures in `test/fixtures/<workflow>/`).
