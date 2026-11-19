# ADR-0009: Content-addressed run provenance manifest and global AI context hub sink

Date: 2026-11-19
Status: Accepted

## Context
- A completed UAW `sw_dev` run produces rich intermediate and closure artifacts
  across fifteen stages in
  [`.github/skills/uwf-sw_dev/stages.yaml`](../../.github/skills/uwf-sw_dev/stages.yaml)—intake,
  discovery, requirements (`FR-*` / `NFR-*` / `DR-*` / `AC-*` / `RK-*`), ADRs,
  risk/security/test plans, blueprint (`*-br.json` strata `0`–`4`), work plan,
  implementation verification, adversarial review (`*-review.result.json`),
  acceptance (`*-acceptance.result.json`), `snapshot` (`*-drs.json` and
  `*-br.json` stratum `5` via
  [`uwf-snapshot/SKILL.md`](../../.github/skills/uwf-snapshot/SKILL.md) and
  [`uwf-cbs/SKILL.md`](../../.github/skills/uwf-cbs/SKILL.md)), and `retro`—plus
  structured records across the eight SQLite stores.
- Today those artifacts live in ephemeral per-run directories (`--data-dir` /
  `./tmp/workflow-artifacts`, cleaned up under
  [#97](https://github.com/qwts/universal-agentic-workflow/issues/97)) with no
  cryptographic digest manifest binding the intermediate reasoning, gate
  verdicts, and `DRS`/`BR` architectural strata to the shipped deliverable
  identity (git commit SHA, pull request URL, release tag, or build artifact
  URI) ([#178](https://github.com/qwts/universal-agentic-workflow/issues/178)).
- Downstream AI-maintained global context hubs and multi-repo portfolio agents
  need structured, verifiable, secret-scrubbed project updates when runs reach
  `snapshot` / `retro`—without scraping raw transcripts, re-ingesting duplicate
  stage retries, or breaking offline/air-gapped local runs when no external hub
  is configured.

## Decision
- **Finalize a deterministic content-addressed `uaw-manifest.json` and SQLite
  lineage record at `snapshot` / `retro`.** During `snapshot` (`phase: snapshot`)
  and sealed on `retro` completion (`phase: closed`), UAW materializes
  `{{output_path}}/uaw-manifest.json` serialized in RFC 8785 canonical JSON
  (lexicographically sorted keys, UTF-8 NFC, no insignificant whitespace) and
  upserts a matching row into `run_manifests` in `uwf-state.db` (`run_id`,
  `workflow`, `phase`, `manifest_sha256`, `deliverable_key`, `manifest_json`,
  `sink_status`, `finalized_at`), exposed read-only via `uaw://<run>/manifest`
  (`uaw_read_manifest` in
  [ADR-0008](./ADR-0008-multi-surface-mcp-plugin-runtime-contract.md)).
- **`uaw-manifest.json` (`schema_version: "1.0.0"`) cryptographically binds
  every stage, domain store, and `DRS`/`BR` stratum to the deliverable:**
  - **Self-addressing envelope:** `manifest_sha256` equals the lowercase hex
    SHA-256 over the canonical JSON payload with `manifest_sha256` omitted,
    paired with `run_id`, `workflow`, `goal_sha256` (`runner-goal.md`), `phase`,
    `started_at`, and `finalized_at`.
  - **Deliverable identity (`deliverable`):** records `{ repository,
    base_commit_sha, head_commit_sha, git_tree_sha, branch, pr_url, release_tag,
    artifact_uris[] }`, computing `deliverable_key` from the primary verifiable
    target (`head_commit_sha` + `pr_url` or `artifact_uris[0]`).
  - **Executed stage ledger (`stages[]`):** ordered entries from `uwf-stages.db`
    ([`stage-tracker.mjs`](../../.github/skills/uwf-orchestration-engine/stage-tracker.mjs))
    and `runner-routing.json` capturing `stage`, `status`, `retry_count`,
    `round_trips`, `session_id`, `gate_verdict`, `started_at`, `completed_at`,
    `transcript_sha256`, cost/token totals from
    [`cost.mjs`](../../scripts/uwf-runner/cost.mjs), and `{ path, sha256,
    bytes }` for every declared stage output file (including structured
    `*.result.json` verdict files).
  - **Domain-store lineage (`stores`):** canonical SHA-256 digests and scrubbed
    record summaries across `uwf-requirements.db` (accepted/deferred/rejected
    counts and IDs by `FR`/`NFR`/`DR`/`AC`/`RK`), `uwf-adrs.db` (`ADR-NNNN`
    numbers, slugs, statuses, `superseded_by`, and markdown file `sha256`
    digests), `uwf-discoveries.db` (category counts and unresolved `gap` IDs),
    `uwf-reviews.db` (verdicts and `critical|major|minor` finding resolution
    counts), `uwf-issues.db` (local tracking counts), and `uwf-questions.db`
    (resolved/skipped decision counts).
  - **Architectural state strata (`architecture`):** exact `{ path, sha256,
    schema_version }` plus structural summaries for `{{artifact_prefix}}-drs.json`
    (`components`, `dependency_graph`, `gap_log`, `divergence_log`,
    `exit_criteria`) and `{{artifact_prefix}}-br.json` across all six strata
    (`0` Context, `1` Decisions and Risk Register, `2` Dependencies,
    `3` Actions, `4` Verification, and `5` Final State), alongside the
    `[SNAPSHOT]` entry digest in `uwf-changelog.md`.
- **An optional, idempotent Context Hub Sink publishes scrubbed provenance
  envelopes and is a clean no-op when unset.** Sink configuration reads
  `UAW_CONTEXT_HUB_SINK` (`none` default, `mcp`, or `webhook`),
  `UAW_CONTEXT_HUB_URL`, `UAW_CONTEXT_HUB_TOKEN`, and
  `UAW_CONTEXT_HUB_MODE` (`best_effort` default or `strict`):
  - **Zero-overhead no-op default:** when `UAW_CONTEXT_HUB_SINK` is unset or
    `none`, `uaw-manifest.json` and `run_manifests` still finalize locally with
    `sink_status: "disabled"`, making zero network calls.
  - **Deterministic idempotency (`run_id + stage + sha256`):** every emitted
    checkpoint (`stage.completed`) or terminal (`run.finalized`) envelope carries
    `dedup_tuple: { run_id, stage, sha256 }` and `idempotency_key =
    sha256("${run_id}:${stage}:${sha256}")`. Re-running `retro`, replaying a
    failed delivery, or resuming via `uaw_resume` produces the exact same key so
    the receiving AI Context Hub deduplicates without side effects.
  - **Pluggable `mcp` and `webhook` sink adapters:** the `mcp` adapter invokes
    `context_hub.ingest_manifest` on a configured remote/local MCP server; the
    `webhook` adapter sends an HTTPS `POST` carrying `Idempotency-Key` and
    `X-UAW-Signature-256` (`HMAC-SHA256` over the canonical JSON body using
    `UAW_CONTEXT_HUB_TOKEN`) with bounded retry backoff.
  - **Failure isolation (`best_effort` vs. `strict`):** `best_effort` records
    delivery errors in `run_manifests.sink_status` (`failed`) and logs a warning
    without failing a passing local or PR run; `strict` fails the post-`snapshot`
    / `retro` sink check with exit code `1` (`GATE`) when audited release
    pipelines require guaranteed hub ingestion.

## Alternatives considered
1) **Upload raw `<data-dir>` tarballs and transcripts to the context hub.**
   Simple archival, but ships high-volume unindexed prose, increases secret-leak
   blast radius, and forces every downstream AI consumer to re-parse internal
   UAW filenames and SQLite tables.
2) **Reconstruct provenance post hoc from git commits and PR comments.** Misses
   ephemeral intermediate artifacts (`discovery`, `risk-plan`, gate retry
   counts, `DRS` `divergence_log`, and `BR` strata) that are intentionally kept
   out of git history under
   [#97](https://github.com/qwts/universal-agentic-workflow/issues/97).
3) **Make remote Context Hub ingestion mandatory on every run.** Breaks offline
   local development, benchmark suites, and unauthenticated fork PRs; keeping
   local manifest generation mandatory while making remote sink delivery opt-in
   preserves local-first determinism.

## Consequences
- Positive: every shipped commit, PR, or release produced by UAW carries a
  tamper-evident SHA-256 lineage chain back to its requirements, ADRs,
  discoveries, reviews, and `DRS`/`BR` strata; global AI context hubs ingest
  compact, schema-versioned updates idempotently; offline and CI runs pay zero
  external dependency cost when the sink is unset.
- Negative: canonical JSON hashing and stage file digesting add a small I/O pass
  at `snapshot` and `retro`; schema changes to `uaw-manifest.json` must follow
  explicit semver (`schema_version`) so context hub ingesters remain backward
  compatible.
- Follow-ups: implement `scripts/uwf-runner/provenance.mjs` and sink adapters
  under [#178](https://github.com/qwts/universal-agentic-workflow/issues/178);
  wire `uaw://<run>/manifest` into the `uaw-mcp/v1` server from
  [ADR-0008](./ADR-0008-multi-surface-mcp-plugin-runtime-contract.md)
  ([#177](https://github.com/qwts/universal-agentic-workflow/issues/177)); align
  manifest retention with `<data-dir>` cleanup policies in
  [#97](https://github.com/qwts/universal-agentic-workflow/issues/97).

## Security / Privacy / Compliance notes
- **Mandatory pre-persistence and pre-sink secret scrubbing:** every string
  extracted from stage notes, requirements, discoveries, review findings,
  question answers, and deliverable metadata passes through `redactSecrets()` in
  [`scripts/hooks/secret-patterns.mjs`](../../scripts/hooks/secret-patterns.mjs)
  before writing `uaw-manifest.json` or transmitting to a Context Hub Sink.
- **Digest-only transcript provenance by default:** `uaw-manifest.json` records
  only `transcript_sha256`, turn counts, and token/cost aggregates—never raw
  prompt or tool-output transcripts—preventing accidental exfiltration of
  proprietary source snippets to portfolio-wide context hubs.
- **Authenticated, integrity-protected sink transport:** remote `webhook` sinks
  require `https://` endpoints (allowing `http://127.0.0.1` only for local
  loopback testing) and authenticate payloads via `HMAC-SHA256`
  (`X-UAW-Signature-256`); sink credentials are read exclusively from
  environment variables and never persisted in SQLite or manifests.

## Verification
- Determinism test runs `sw_dev` (`--adapter fake`) and verifies generating
  `uaw-manifest.json` twice over identical stage outputs yields byte-for-byte
  identical JSON and matching `manifest_sha256`, while flipping one byte in
  `issues-drs.json` or `issues-review.result.json` changes both the stage/stratum
  digest and `manifest_sha256`.
- Sink contract test verifies: (a) unset `UAW_CONTEXT_HUB_SINK` makes zero
  outbound requests and records `sink_status = "disabled"`, (b) `webhook` /
  `mcp` sink replay of the same finalized stage emits an identical
  `idempotency_key` (`run_id + stage + sha256`), and (c) injected secret tokens
  matching `secret-patterns.mjs` are replaced with `[redacted:<kind>]` in both
  `uaw-manifest.json` and the outbound sink payload.
