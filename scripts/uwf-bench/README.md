# uwf-bench

Benchmark harness around `scripts/uwf-runner/runner.mjs` (issue #101). It runs a matrix of
cells x fixtures x run indexes unattended, records usage and gate outcomes in `results.db`
(SQLite via `better-sqlite3`, the engine skill's own driver, so it runs on Node 20) and exports CSV for analysis. Field list:
`docs/research/cli-offload-design.md` section 11.

```sh
node scripts/uwf-bench/bench.mjs run --matrix matrix.yaml [--db results.db] [--work dir] [--resume] [--keep-repos]
node scripts/uwf-bench/bench.mjs export --db results.db --out csv/
node scripts/uwf-bench/bench.mjs rate --db results.db --run 1 --rater alice --dimension plan_completeness --score 4
```

## What a run does

1. Fresh copy of the fixture into `<work>/<cell>/<fixture>/<n>/repo` (`git clone` + `ref` for git repos and URLs,
   plain copy otherwise; committed state only). `.github/agents` and `.github/skills/uwf-<workflow>` are added from
   this checkout when the fixture lacks them.
2. `node runner.mjs run --adapter .. --model .. --data-dir <work>/<cell>/<fixture>/<n>/data --repo-root <copy> --non-interactive --timeout-ms ..`
   with cwd = the copy. Exit code and stderr tail are stored.
3. Tokens and cost come from the adapter transcripts in the data dir; per-stage outcomes from `stage_runs` in
   `<data dir>/uwf-stages.db` (read-only). Both are written to `runs` and `stage_outcomes`.
4. `failure_class`: exit 0 `none`, exit 1 `model_failure`, exit 2/3 or a harness exception `harness_error`,
   killed by the harness timeout `ambiguous`. One failed run never stops the matrix. `run --resume` skips
   (cell, fixture, run_index) already in the db; without it an existing key is replaced.

`block` is the run index; `block_randomize: true` shuffles the cell x fixture order inside each block with a PRNG
seeded by `seed`. The repo copy is deleted after the run (`--keep-repos` keeps it); the data dir with raw
transcripts is kept for audit.

## Matrix YAML

Top level: `workflow` (default `sw_dev`), `runs_per_cell` (default 1), `output_path` (default `./tmp/uwf-bench`;
holds `results.db` and `work/`), `timeout_ms` (per stage, default 1800000; the whole runner process is capped at 30x),
`seed` (optional), `block_randomize` (default false).
`fixtures`: `name`, `repo`, `goal`, optional `ref`, `issue`, `acceptance_cmd` (shell command run in the copy, 120 s limit).
`cells`: `name`, `adapter`, `state_location` (`cli`|`nocli`), optional `model`, and `fake_fixture_dir` for the fake adapter.

Parser subset (no dependency): `key: scalar`, `key:` followed by a list of maps (`- name: x`, further keys indented),
`#` comments, quoted or plain scalars, numbers, booleans, `null`. Nothing else (no nesting, flow style, multiline).
See `matrix.example.yaml`.

## Not implemented / NULL today

- `state_location: nocli` cells are a stub: the run is recorded with `terminal_state='not_implemented'` and skipped.
  The no-CLI protocol is a later issue.
- `seed` is always NULL: Claude Code has no seed flag. The matrix `seed` only orders runs.
- `tokens_*`, `cost_usd`: only the claude-code adapter reports usage (cache read/write and cost included, parsed from the
  CLI JSON in the transcript). `fake` and `codex` give NULL, and `usage_incomplete=1` marks any run with a NULL usage field.
- `max_prompt_tokens` and per-attempt `prompt_tokens`, `wall_seconds`: the adapters do not report them. NULL.
- `claude_cli_version`: `claude --version` for claude-code, else the adapter name.
- `ratings` is empty until humans add rows with `rate`; `run_label` defaults to `run-<run_id>`, so pass a blind `--run-label`.
- `acceptance_pass` is NULL without `acceptance_cmd`; `test_file_modified` is NULL when the fixture is not a git repo.
- `stage_outcomes`: the tracker keeps one row per stage, so only the last attempt of a stage has a recorded status;
  earlier attempts are failed gates, with the reason taken from the next attempt's retry prompt.
- `artifact_missing` counts never-passed stages whose gate failure reads as a missing file.

## Tests

`node scripts/uwf-bench/test/bench.test.mjs` (fake adapter only; never calls a live model).
Needs the runner's skill dependencies installed (`npm ci` in the `.github/skills/uwf-*` dirs, as CI does).
