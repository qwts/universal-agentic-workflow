# UAW MCP Runtime (`uaw-mcp/v1`)

Standalone Model Context Protocol server implementing [ADR-0008](../../docs/adr/ADR-0008-multi-surface-mcp-plugin-runtime-contract.md) for Universal Agentic Workflow (`UAW`).

## Transports

- **Local `stdio` (default)**:
  ```bash
  node scripts/uaw-mcp/server.mjs --transport stdio
  ```
- **Streamable HTTP / SSE**:
  ```bash
  UAW_MCP_AUTH_TOKEN="replace-me" \
  node scripts/uaw-mcp/server.mjs --transport http --host 127.0.0.1 --port 8787 \
    --allowed-roots /path/to/workspace \
    --allowed-origins chrome-extension://*,http://127.0.0.1:*
  ```

## Command Tools

All command tools preserve `scripts/uwf-runner/runner.mjs` exit codes (`0` OK, `1` GATE, `2` USAGE, `3` QUESTIONS, `4` COST):

- `uaw_run`: Runs a workflow via `runner.mjs run`, persisting durable `run_id` and resolved `output_path` (defaulting to `<data-dir>/workflow-artifacts`) in `<data-dir>/run-meta.json` and enforcing out-of-tree ownership in `<uaw-state-dir>/output-owners/<sha256(realpath(output_path))>.{json,lock}`.
- `uaw_resume`: Reloads persisted `run_id` and `output_path` and invokes `runner.mjs resume`.
- `uaw_gates`: Evaluates stage gates or lists stage definitions and gate prescriptions without advancing workflow state.
- `uaw_cost`: Summarizes per-stage and total tokens, cost, and `!50K` / `!100K` / `!MISS` threshold flags from `<data-dir>/transcripts/*.json`.
- `uaw_stage_transition`: Executes explicit `state.mjs` or `stage-tracker.mjs` transitions while refusing mutation with exit code `2` if an active `run.lock` is held.
- `uaw_question_resolve`: Wraps `questions.mjs` (`list`, `check`, `answer`, `skip`) to resolve exit-`3` `QUESTIONS` pauses before `uaw_resume`.

## Read-Only CQRS Resources & Query Tools

All eight SQLite stores are opened strictly read-only (`readonly: true`, `PRAGMA query_only = ON`), and free-text notes/transcripts are scrubbed through `redactSecrets()` in `scripts/hooks/secret-patterns.mjs`:

| Resource URI | Query Tool | Backing Store |
| --- | --- | --- |
| `uaw://<run>/state` | `uaw_read_state` | `uwf-state.db` + `run-meta.json` |
| `uaw://<run>/stages` | `uaw_read_stages` | `uwf-stages.db` + `runner-routing.json` |
| `uaw://<run>/gates/<stage>` | `uaw_read_stages` (`stage`) | `uwf-stages.db` + `runner-routing.json` |
| `uaw://<run>/requirements` | `uaw_read_requirements` | `uwf-requirements.db` |
| `uaw://<run>/adrs` | `uaw_read_adrs` | `uwf-adrs.db` |
| `uaw://<run>/discoveries` | `uaw_read_discoveries` | `uwf-discoveries.db` |
| `uaw://<run>/issues` | `uaw_read_issues` | `uwf-issues.db` |
| `uaw://<run>/reviews` | `uaw_read_reviews` | `uwf-reviews.db` |
| `uaw://<run>/questions` | `uaw_read_questions` | `uwf-questions.db` |
| `uaw://<run>/transcripts` | `uaw_read_transcript` | `<data-dir>/transcripts/*.json` (index) |
| `uaw://<run>/transcripts/<id>` | `uaw_read_transcript` (`transcript_id`) | `<data-dir>/transcripts/<id>.json` (redacted) |
