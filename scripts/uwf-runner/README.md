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

## Adding an adapter

1. Create `adapters/<name>.mjs` exporting `name` and `invokeStage(opts)`.
2. Use `writeTranscript`, `buildSystemPrompt` from `adapters/index.mjs`.
3. Add `<name>` to `ADAPTERS` in `adapters/index.mjs`.
4. Add a `contract(...)` block in `test/adapters.test.mjs`
   (gate live CLIs behind `UWF_TEST_LIVE` so CI stays offline).

## Tests

`node scripts/uwf-runner/test/adapters.test.mjs` (live: `UWF_TEST_LIVE=1`, uses haiku).

## Runner (`runner.mjs`)

```sh
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal "Add X" [--adapter claude-code|fake] \
  [--model m] [--data-dir d] [--output-path p] [--from-stage s] [--non-interactive] [--dry-run] [--timeout-ms n]
```

Exit codes: 0 complete, 1 gate blocked or abort, 2 usage/config error, 3 questions pending
(answer with `questions.mjs answer`, then rerun with `--from-stage <stage>`).
A run without `--from-stage` re-initializes the stage-tracker and state stores in the data dir.
`on_gate_failure: retry` retries `max_retries` times then fails; `skip` and `abort` act on the first failure.
Tests: `node scripts/uwf-runner/test/runner.test.mjs` (fake adapter, fixtures in `test/fixtures/<workflow>/`).
