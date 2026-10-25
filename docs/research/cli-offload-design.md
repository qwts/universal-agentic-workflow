---
title: "CLI offload experiment: pre-registered design"
status: Draft — pre-registration
date: 2026-10-25
issue: "#100"
epic: "#99"
---

# CLI offload experiment: pre-registered design

This document fixes the hypotheses, conditions, fixtures, metrics, sample size,
stopping rules and analysis for the CLI offload experiment **before any run is
recorded**. Changes after the first recorded run are amendments, listed in
[Amendments](#amendments) with a date and reason; they are never silent edits.

## 1. Question and thesis

[ADR-0007](../adr/ADR-0007-runtime-owns-the-loop.md) moves the stage loop out of
a model and into `scripts/uwf-runner/runner.mjs`. Its premise (epic #99) is that
long-horizon instruction following scales worst with model size. If workflow
state, sequencing and gate decisions live in the CLI runner, each model call is a
short prompt with explicit inputs and one deliverable. A small model should then
approach a large model on first-try gate pass rate, with far fewer tokens.

This experiment tests that premise directly. It does not test whether the runner
is correct (its CI suite does) or whether UWF output is good in absolute terms.

## 2. Hypotheses

| ID | Hypothesis | Direction |
| --- | --- | --- |
| H1 | The first-try gate pass-rate gap between the small and large model is smaller when the CLI runner holds state than when it does not. | Interaction (model size x state location) is positive for the small model |
| H2 | Total tokens per run are lower in the CLI condition than in the no-CLI condition. | Main effect of state location, both models |
| H3 | Blind-rated artifact quality of small-with-CLI is within one rubric point of large-with-CLI. | Equivalence, margin 1.0 on a 1-5 scale |

H1 is the primary hypothesis. H2 and H3 are secondary and are reported
regardless of the H1 outcome.

## 3. Conditions

2 x 2 factorial, four cells.

| Cell | Model | State location | What the model receives |
| --- | --- | --- | --- |
| S-CLI | small | runner | One prompt per stage: agent file body, context block, resolved inputs, required outputs. The runner sequences, checks gates, retries. |
| S-NOCLI | small | prompt | One long prompt holding all 15 stage rules, gate conditions, ordering and run state. The model sequences and self-judges gates. |
| L-CLI | large | runner | As S-CLI. |
| L-NOCLI | large | prompt | As S-NOCLI. |

Planned model ids (recorded per run; any substitution is an amendment):

- small: `claude-haiku-5-5`
- large: `claude-opus-5-5`

Both are driven through the `claude-code` adapter. For every run the harness
records the model id, the `claude` CLI version, the runner commit SHA, the
`stages.yaml` hash, and the adapter name. Runs whose recorded model id differs
from the planned id are excluded and re-run.

Held constant across all cells: fixture, fixture starting commit, `stages.yaml`,
agent files, permission presets, tool allowlist, timeout, working directory
layout, and gate evaluation. In the NOCLI cells the **gate checks are the same
scripts**, run by the harness after the model declares the run finished (see
[3.1](#31-no-cli-condition-protocol)); only who sequences and who decides to
retry changes.

### 3.1 No-CLI condition protocol

The no-CLI prompt is generated from the same `stages.yaml` and agent files as the
CLI condition, so content is identical and only the delivery differs. The model
gets one session, the full stage list, every stage's inputs, outputs and gate
text, the goal, and tool access. It is told to complete the workflow and to
decide for itself when each stage passes. It is not given `stage-tracker.mjs`,
`state.mjs` or `run.mjs`. The prompt requires the model to run
`node <bench>/mark-stage.mjs <stage>` the moment it considers a stage complete.
On each such **stage-completion event** the harness copies every path a gate
check can read (the artifacts directory and each `{{cwd}}` path named in
`stages.yaml`, for `sw_dev` that is `docs/adr`) into an immutable snapshot and
records the event. After the session,
every gate is evaluated with `stage-tracker.mjs` against the snapshot taken at
that stage's first event, so a first-try pass is scored identically in both
conditions; later events for the same stage are scored as retries. A stage with
no event is scored against the end-of-session state and flagged `never_marked`,
which counts as a first-try failure. File modification times are never used. A session ends when the model stops, hits
the turn or time cap, or exhausts the budget cap.

## 4. Fixtures

The three seeded issues in the toy repo `qwts/uwf-toy-app` (an inventory service), one each of feature, bug and refactor:

| Fixture | Issue | Summary |
| --- | --- | --- |
| F1 | toy issue 1 | feature: `DELETE /items/:id` backed by a new `Inventory.remove(id)`; 204 on success, 404 when unknown, later GET must 404 |
| F2 | toy issue 2 | bug: `Inventory.adjust()` lets quantity go negative; must throw `RangeError` and leave qty unchanged |
| F3 | toy issue 3 | refactor: add `Inventory.toJSON()` and have `GET /items` serialize the inventory directly; route behaviour unchanged |

The fixtures are held fixed: same repo commit before each run, same issue text,
same `--goal` string. Each run starts from a fresh clone at that commit with an
empty data dir (`UWF_DATA_DIR`) and an empty `./tmp/workflow-artifacts`.

The **objective acceptance test** for every fixture is the toy repo's
`test/seeded-issues.test.mjs`. It fails at the starting commit and must pass at
the end of a successful run. It is run by the harness, not by the model, in a
pristine checkout of the run's final tree, and its result is the boolean
`acceptance_pass`. The test file is read-only for the stage agents (enforced by
the harness diffing it against the starting commit; a modified test file voids
`acceptance_pass`).

## 5. Workflow under test

`sw_dev` from `.github/skills/uwf-sw_dev/stages.yaml`, 15 stages.

| # | Stage | Gated | Conditional | Retries | On gate failure |
| --- | --- | --- | --- | --- | --- |
| 1 | intake | yes | no | 2 | retry |
| 2 | discovery | yes | no | 2 | retry |
| 3 | requirements | yes | no | 2 | retry |
| 4 | adr | yes | yes (`ADR:` in requirements) | 2 | retry |
| 5 | risk-plan | yes | no | 2 | retry |
| 6 | security-plan | yes | yes (security markers in requirements) | 2 | retry |
| 7 | test-plan | yes | no | 2 | retry |
| 8 | blueprint | yes | no | 2 | retry |
| 9 | work-plan | yes | no | 2 | retry |
| 10 | implementation | yes | no | 1 | retry |
| 11 | review | yes (`verdict: approved` + JSON result) | no | 3 | retry |
| 12 | technical-writing | no | no | 1 | abort |
| 13 | acceptance | yes (`verdict: approved` + JSON result) | no | 2 | retry |
| 14 | snapshot | yes | no | 2 | retry |
| 15 | retro | no | no | 1 | skip |

Conditional stages that are skipped by their condition are `skipped`, not
failed, and are excluded from the denominators of the stage-level pass rate for
that run. The `implementation` gate only checks that `issues-plan.md` is
non-empty; it does not check the code. That is deliberate to record: the
objective acceptance test, not any gate, is what measures whether the fix works.

## 6. Metrics

All metrics are recorded per run in `runs` and per stage attempt in
`stage_outcomes`. A *stage attempt* is one invocation of the stage agent (CLI
condition) or one gate evaluation of the stage's snapshot (no-CLI condition).

| Metric | Definition | Unit / type | Level |
| --- | --- | --- | --- |
| `first_try_pass` (stage) | The first attempt at a gated, non-skipped stage passes its gate with no retry. Ungated stages (technical-writing, retro) count as passed if the stage completes without agent error. | boolean | stage x run |
| `first_try_pass_rate` (run) | Count of stages with `first_try_pass` divided by count of gated, non-skipped stages in the run. Ungated stages are excluded from numerator and denominator. | proportion in [0, 1] | run |
| `retries_to_pass` | Number of failed attempts before the first passing attempt of a stage. Stages that never pass are recorded as `max_retries + 1` and flagged `never_passed`. Run level: sum over stages. | integer >= 0 | stage, run |
| `tokens_input` | Input tokens summed over all model calls in the run, excluding cache read and cache write tokens. | tokens | run, stage |
| `tokens_output` | Output tokens summed over all model calls. | tokens | run, stage |
| `tokens_cache_read` | Tokens served from prompt cache. | tokens | run, stage |
| `tokens_cache_write` | Tokens written to prompt cache. | tokens | run, stage |
| `tokens_total` | the sum of the four counts above, i.e. every token the model processed. This is the H2 primary measure. `tokens_input + tokens_output` is reported as a secondary measure. | tokens | run |
| `cost_usd` | Sum of `costUsd` reported by the adapter per call. Where the adapter reports no cost, computed from token counts and the published per-model price table frozen at pre-registration. | USD | run, stage |
| `wall_seconds` | Wall clock from runner start (or session start) to final gate evaluation, including retries and model latency. Excludes fixture clone time and the post-run acceptance test. | seconds | run, stage |
| `quality_*` | Blind rubric scores, section 9: `plan_completeness`, `review_accuracy`, `acceptance_correctness`, each integer 1-5; `quality_mean` is the mean of the three, averaged over the two raters after reconciliation. | 1-5 | run |
| `acceptance_pass` | Objective test `test/seeded-issues.test.mjs` passes on the final tree and the test file is unmodified. | boolean | run |

Usage source: the figures are those **reported by the adapter**
(`invokeStage` -> `usage`, `costUsd`). The `claude-code` adapter's `usage` carries
`{ inputTokens, outputTokens }` only, but each transcript keeps the CLI's full
JSON, from which the harness (#101) reads cache read, cache write and cost per
attempt.
A run with `usage: null` on any call is flagged `usage_incomplete` and excluded
from H2 and from cost analysis (kept for H1 and H3).

## 7. Sample size and stopping rules

**Initial design.** 5 runs x 3 fixtures x 4 cells = **60 runs**. Run order is
randomized within blocks of one run per cell per fixture (12 runs), with the
random seed for the order recorded in the repo before the first run, so drift in
provider-side behavior is spread across cells.

**Stopping rules** (fixed now):

1. **Harness-error halt.** If 3 consecutive runs in a cell end in a harness error
   (section 9.5 classification: adapter crash, timeout with no model output,
   store corruption, fixture setup failure) rather than a model failure, stop
   that cell, fix the harness, and restart the cell's run count from zero.
   Discarded harness-error runs are listed in the final report, not deleted.
2. **Fixed sample.** The sample is 60 valid runs and is not extended on the
   basis of the observed H1 interval; the 95% interval in section 8.1 is a
   single fixed-sample interval. An interval that straddles zero is reported as
   *not supported at this sample*, with the point estimate, the interval and the
   sample that would be needed to resolve it. Any further runs are a new,
   separately pre-registered experiment, analyzed on their own.
3. **Budget cap.** Hard cap of **$CAP_PLACEHOLDER USD per cell**, to be set
   before the first run and committed in this file as an amendment dated before
   the first run's timestamp. A cell that reaches its cap stops; its completed
   runs are analyzed and the shortfall is reported. The no-CLI large cell is
   expected to be the most expensive, so the cap applies per cell, not per
   experiment.
4. **No other early stopping.** No interim peeks at H1, H2 or H3 effect sizes to
   decide whether to continue. Operational monitoring (error rates, spend) is
   allowed.

A run counts toward the sample when it reaches a terminal state: all stages
passed, a stage exhausted its retries, or the session hit its caps. A run that
ends because a stage failed is a valid run with `first_try_pass_rate < 1`, not a
discard.

## 8. Analysis plan

Fixed before any run is recorded. The analysis script is committed alongside the
harness and takes only `results.db` (or the CSV export) as input.

### 8.1 H1: difference-in-differences on first-try pass rate

Unit: run. Outcome: `first_try_pass_rate`. Let `p(m, s)` be the mean for model
`m` and state location `s`.

```
gap_NOCLI = p(large, NOCLI) - p(small, NOCLI)
gap_CLI   = p(large, CLI)   - p(small, CLI)
DiD       = gap_NOCLI - gap_CLI
```

H1 predicts `DiD > 0`: the small-vs-large gap is smaller with the runner.
Estimation: a linear model of `first_try_pass_rate` on the indicators
`small` (1 for the small model, 0 for the large) and `cli` (1 for the CLI
condition, 0 for NOCLI), their interaction, and fixture as a fixed effect. With
this coding the interaction coefficient equals `DiD` as defined above (the
opposite coding, `large = 1`, flips its sign); the analysis script asserts the
coding and reports `DiD` with the sign given here. The 95% CI is a stratified (by fixture) bootstrap percentile interval,
10,000 resamples, seed fixed in the analysis script. A binomial GLM on
stage-level `first_try_pass` with a run-level random intercept is reported as a
sensitivity analysis.

**Support for H1:** the lower bound of the 95% CI of `DiD` is above 0 **and**
`gap_CLI` is smaller than `gap_NOCLI` in each fixture individually (direction
consistency). Point estimate and CI are reported either way. A CI that includes
0 is reported as *not supported*, not as "trend"; the sample is not extended
(section 7, rule 2).

### 8.2 H2: paired comparison of tokens

Pairing: for each model and fixture, run index `i` in the CLI cell is paired
with run index `i` in the NOCLI cell (same fixture, same block). Outcome:
`log(tokens_total)` (primary) and `tokens_input + tokens_output` (secondary).
Test: paired comparison of the log-ratio `log(CLI / NOCLI)` via a paired
t-interval, with a Wilcoxon signed-rank test as a robustness check, reported
separately for small and large and pooled (model as a blocking factor).
Cost in USD gets the same treatment as a descriptive companion.

**Support for H2:** the pooled 95% CI of the mean log-ratio is entirely below 0
(CLI uses fewer tokens), and the point estimate is below 0 for both models. The
effect size is reported as a ratio, e.g. "CLI uses X% of NOCLI tokens". "Far
fewer" in the thesis is operationalized as a ratio of 0.5 or lower; a
significant reduction smaller than that is reported as supported but modest.

### 8.3 H3: equivalence test on rubric scores

Outcome: `quality_mean` per run, small-CLI vs large-CLI. Test: two one-sided
tests (TOST) with equivalence margin of +/-1.0 rubric point, alpha 0.05, using
Welch's t statistic with fixture as a blocking covariate. Equivalent to checking
that the 90% CI of the difference lies inside (-1.0, +1.0). Each rubric
dimension is also tested separately, same margin, as a secondary analysis.

**Support for H3:** the 90% CI of `quality_mean(small, CLI) - quality_mean(large, CLI)`
lies inside (-1, +1). Failing to reject non-equivalence is reported as
*inconclusive* when the CI is wider than the margin and as *refuted* when the
whole CI lies below -1.

Every valid run is rated. Raters score the artifacts that exist
(`issues-plan.md`, `issues-review.md`, `issues-acceptance.md`); a missing
artifact scores 1 on its dimension and the run is flagged `artifact_missing`.
`quality_mean` is therefore defined for every valid run and incomplete runs stay
in the primary H3 analysis. A complete-case sensitivity analysis drops the
flagged runs.

### 8.4 Pre-specified secondary and descriptive analyses

- `acceptance_pass` rate per cell with Wilson 95% intervals. This is the only
  objective outcome and is reported next to H1-H3, not folded into them.
- Stage-level first-try pass rate per cell, to show which stages the NOCLI
  condition loses.
- Retries to pass, wall time and cost per cell (medians and IQR).
- Per-stage token share, to identify the cost drivers (pilot suggests
  per-turn context size).
- Inter-rater agreement (section 9).

### 8.5 Multiplicity and interpretation

H1 is the single primary test; H2 and H3 are labeled secondary and each is
evaluated at its own alpha without adjustment, with this stated in the report.
Per-dimension and per-fixture analyses are exploratory and labeled so. The
experiment's overall conclusion follows the table in section 12.

## 9. Blind rating rubric

Two raters, blinded to cell. The harness copies each run's three artifacts into
a rating packet under a random run label; model id, state location, token
counts, cost, timing, the transcript, and any runner-specific footers or
`.result.json` files are stripped. Packets are shuffled per rater with
independent orders. A rater also receives, per run, the actual diff the run
produced (for review accuracy) and the objective acceptance test result (for
acceptance correctness), but not the cell. Where artifact style leaks the model
(for example verbosity), raters are asked to note a guess of the cell after
rating; the guess accuracy is reported as a check on blinding.

Each dimension is scored 1-5 against anchors.

### 9.1 Plan completeness (`issues-plan.md`)

| Score | Anchor |
| --- | --- |
| 5 | Covers every acceptance criterion from the issue; names the right file(s) and function(s) to change; includes the test to add or run; states ordering and one explicit verification step; no invented scope. |
| 4 | All criteria covered and the right location named; one minor gap (for example no explicit verification step) or minor extra scope. |
| 3 | Core change is identified but one acceptance criterion is missing, or the location is vague (module-level only). |
| 2 | Plan is generic or partly wrong: misses more than one criterion or targets the wrong function, though the issue theme is recognized. |
| 1 | Missing, empty, off-topic, or a restatement of the issue with no plan. |

### 9.2 Review accuracy (`issues-review.md` vs the actual diff)

| Score | Anchor |
| --- | --- |
| 5 | Every claim about the change matches the diff; correctly identifies what the diff does and does not cover; flags real defects or risks present in the diff (or correctly states none); verdict is justified by the evidence. |
| 4 | Claims match the diff; at most one imprecise statement or a missed minor point; verdict justified. |
| 3 | Mostly accurate but contains one material misstatement about the diff, or misses a real defect that a careful reviewer would catch; or approves with weak evidence. |
| 2 | Several inaccuracies or describes changes that are not in the diff; verdict not supported by what the diff shows. |
| 1 | Review does not correspond to the diff (wrong files, invented changes), is missing, or only boilerplate. |

### 9.3 Acceptance correctness (`issues-acceptance.md` vs the objective test)

| Score | Anchor |
| --- | --- |
| 5 | The acceptance verdict agrees with the objective test result; each cited criterion is checked against evidence that exists; no criterion is declared met without support. |
| 4 | Verdict agrees with the objective test; one criterion is thinly evidenced. |
| 3 | Verdict agrees by luck or with mostly unsupported assertions; or verdict disagrees but the document correctly surfaces the actual shortfall in the body. |
| 2 | Verdict disagrees with the objective test (approves a failing fix, or rejects a passing one) with little relevant evidence. |
| 1 | Missing, or approves a fix the objective test shows fails, with fabricated evidence. |

### 9.4 Procedure and agreement

- Both raters rate all runs independently, after a calibration round on 6
  non-experiment (pilot) packets to align on anchors. Calibration packets are
  excluded from analysis.
- Agreement: quadratic-weighted Cohen's kappa per dimension and Krippendorff's
  alpha overall, with bootstrap 95% CIs, reported with H3. Percent exact and
  within-one agreement are also reported.
- Disagreements of **at most one point** are resolved by averaging the two
  scores (so half-points occur). Disagreements of **two points or more** go to
  a reconciliation discussion between the two raters, still blinded; if they
  cannot agree, a third blinded rater scores and the median of the three is
  used. The pre-reconciliation scores are kept in `ratings` and the analysis
  also runs on them as a sensitivity check.
- If quadratic kappa for any dimension is below 0.6, that dimension is
  re-calibrated and re-rated once; the report states this.
- Raters are not the person who built the harness or edited the agent files, and
  neither rater sees model-comparison results before rating is complete.

### 9.5 Failure classification (used by stopping rule 1)

Every failed or aborted run is labeled by one reviewer, blind to cell, into
`model_failure` (the model produced a wrong, empty, or off-format artifact or
stopped early), `harness_error` (runner or adapter bug, infra or provider
outage, fixture setup, timeout with no output), or `ambiguous`. See 10.4.

## 10. Threats to validity and mitigations

### 10.1 Fixture leakage

*Threat:* the models may have seen the toy repo or equivalent fixes, so pass
rates reflect memorization rather than instruction following.
*Mitigation:* `qwts/uwf-toy-app` is private and its fixes are not published. We
check anyway: (a) before the first run, ask each model, with no tools, to
complete the seeded functions from the issue text alone and compare to the real
fix; (b) search the repo identifiers and issue text against public code search;
(c) record in `runs` whether the final diff is textually near-identical to the
reference fix, as a descriptive stat. Any evidence of leakage is an amendment
and triggers fixture replacement, not post-hoc exclusion. The residual risk is
that three fixtures of one small service limit generality; this is stated as a
limit in the report, not mitigated.

### 10.2 Model nondeterminism

*Threat:* run-to-run variance swamps the effect.
*Mitigation:* fixed seeds where the CLI supports them (none are assumed; if the
`claude` CLI exposes no seed or temperature control, nothing is claimed about
determinism); otherwise repeated runs, which is what the 5 runs per
cell-fixture are for. Variance is reported per cell, and the bootstrap in 8.1
resamples runs, not stages.

### 10.3 Prompt length confound

*Threat:* the NOCLI condition necessarily has a much longer prompt, so a pass-rate
drop could come from prompt length rather than from state being held by the model.
Conversely, a CLI win could be "shorter prompts are better" with nothing specific
to state.
*Mitigations and how we separate the two:*
1. **Record prompt length.** Input size of every call is logged; the analysis
   includes `log(max_prompt_tokens)` as a covariate in the stage-level
   sensitivity model for H1. If the interaction vanishes after adjusting for
   length, that is reported as the confound explaining the effect.
2. **Optional ablation cell (not part of the 60 runs, pre-declared).** *NOCLI-padded
   control*: the CLI condition's per-stage prompt padded with the unrelated text
   of the NOCLI prompt's stage rules for the other 14 stages, matched in token
   length to NOCLI, with the runner still holding state. If budget allows after
   the primary analysis, 5 runs x 3 fixtures with the small model quantify how
   much of the CLI effect is length alone. It is analyzed descriptively; it is
   not used for H1-H3.
3. **Interpretation rule.** The claim supported by H1 is that *moving state and
   sequencing into the CLI* closes the gap as a package, which includes shorter
   prompts. The report does not claim an effect of state location independent of
   prompt length unless the ablation supports it.

### 10.4 Harness bugs counted as model failures

*Threat:* runner or adapter bugs lower the CLI pass rate, or NOCLI scoring
artifacts lower the NOCLI pass rate.
*Mitigation:* the failure classification in 9.5, applied blind to cell; the
fake-adapter CI suite must pass at the pinned commit; the harness-error halt
rule (7.1); the NOCLI gate snapshot logic is tested against synthetic
transcripts with known outcomes before the first run; all `harness_error` runs
are re-run and listed. Classification disputes default to `ambiguous`, and
results are reported with `ambiguous` counted both as failure and as excluded.

### 10.5 Rater bias

*Threat:* raters infer the cell from artifact style and rate accordingly.
*Mitigation:* stripped packets, shuffled order, independent rating, a
cell-guess check on blinding (9), anchored rubric, calibration, and reporting of
agreement. Rating is done after all runs complete and before any comparative
analysis is run.

### 10.6 Cache effects on cost

*Threat:* prompt caching changes cost per token between cells (the CLI condition
re-sends a stable agent prefix per call; the NOCLI condition grows one long
session), so cost and token counts are not proportional.
*Mitigation:* token counts are reported split by cache read, cache write, input
and output; H2 uses the all-token total, and cost is analyzed as a
separate descriptive outcome using adapter-reported USD. Runs are spaced so the
cache's time-to-live is not systematically warm for one cell; block
randomization (7) handles ordering. The report states cache hit share per cell.

### 10.7 Other

- **Operator environment leakage.** The `claude-code` adapter uses
  `--setting-sources project`, so user-level `CLAUDE.md` and settings do not
  reach stages. NOCLI runs use the same flags.
- **Provider drift.** Model behavior or serving may change during the
  experiment; block randomization and the recorded CLI and model ids
  help detect it. A recorded model id change halts the cell.
- **Judge sensitivity of "first try".** `first_try_pass` depends on gate
  strictness. Gates are fixed and the same scripts score both conditions.
- **Context diet.** The pilot (below) led to a context-diet change in the
  runner. The experiment runs on the commit pinned in `runs.runner_sha`; the
  context diet is part of the CLI condition. NOCLI is not given an equivalent
  diet, which favors CLI and is stated as a limit.

## 11. Data recording

Results are written to `scripts/uwf-bench/results.db` (SQLite) and exported to
CSV. The harness is issue #101 and is built separately; this section lists only
the fields the analysis needs, not DDL.

| Table | One row per | Fields needed by the analysis |
| --- | --- | --- |
| `runs` | run | `run_id`, `cell` (S-CLI, S-NOCLI, L-CLI, L-NOCLI, or `ablation`), `model` (id as reported), `state_location`, `fixture`, `run_index`, `block`, `claude_cli_version`, `runner_sha`, `stages_yaml_sha`, `fixture_sha`, `started_at`, `ended_at`, `wall_seconds`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`, `cost_usd`, `max_prompt_tokens`, `usage_incomplete`, `terminal_state`, `failure_class` (`none`, `model_failure`, `harness_error`, `ambiguous`), `acceptance_pass`, `test_file_modified`, `first_try_pass_rate`, `retries_total`, `artifact_missing`, `notes` |
| `stage_outcomes` | stage attempt | `run_id`, `stage`, `attempt`, `skipped`, `gated`, `passed`, `first_try_pass` (on attempt 1), `never_passed`, `gate_failure_reason`, per-attempt `tokens_*`, `cost_usd`, `wall_seconds`, `prompt_tokens`, `session_id` |
| `ratings` | run x rater x dimension | `run_label` (blind), `run_id` (held apart from raters), `rater`, `dimension` (`plan_completeness`, `review_accuracy`, `acceptance_correctness`), `score_initial`, `score_final`, `reconciliation` (`none`, `averaged`, `discussed`, `third_rater`), `cell_guess`, `rated_at` |

CSV export: one file per table, UTF-8, header row, written by a harness command
that is deterministic given the database, so the analysis script's input hash can
be recorded in the report. The `results.db` file is the source of truth; raw
transcripts are kept as artifacts for audit and scrubbed before any sharing
(ADR-0007 security notes).

## 12. Interpretation

| Outcome | Reading |
| --- | --- |
| H1 supported, H2 supported, H3 supported | Thesis holds: a small model behind the runner matches a large model on gated work at lower cost. |
| H1 supported, H3 refuted (90% CI entirely below -1) | Gates pass but artifacts are worse. The runner fixes sequencing, not content quality. Report the quality gap. |
| H1 supported, H3 inconclusive (CI wider than the margin) | Quality not shown equivalent and not shown worse. Report the interval and point estimate; make no quality claim either way. |
| H1 not supported, H2 supported | The runner saves tokens but does not close the gap. Value is cost, not capability. |
| H1 not supported, H2 not supported | Thesis not supported at this scale on these fixtures. |
| Gap already near zero in the NOCLI cells | Floor/ceiling effect: the fixtures are too easy to discriminate. Report; the thesis is untested rather than refuted. |

Thesis-level wording in any report is limited to what the three tests and the
sample support. The report states the sample as "3 fixtures, one small service,
one model pair".

## 13. What changes if the hypothesis holds or fails

**If it holds (H1, H2 and H3 all supported):**

- Add per-stage `model:` routing in each `stages.yaml`, defaulting stages to the
  small model and promoting only those with persistent first-try failure (the
  experiment's stage-level pass rates choose which; `review` and `acceptance`
  are the likely candidates because they judge another stage's output).
- Make the runner the documented primary path and retire the "FORBIDDEN
  Behaviors" list in the orchestration engine SKILL, as ADR-0007 anticipates.
- Set the small model as the default adapter model for PR-triggered runs and
  keep the large model as an escalation tier after N failed retries.

**If H1 and H2 are supported but H3 is inconclusive:** no default changes. The
quality safeguard is not established, so the small model is offered only as an
opt-in per stage; a separate, pre-registered quality validation (larger rating
sample, same rubric) must support H3 before the defaults above change.

**If it fails (H1 not supported):**

- Keep the runner for its other benefits (resumability, CI testability, no
  loop-skipping failures) and stop claiming a capability transfer to small models.
- Use the stage-level results to find which stages cause the small-model gap and
  fix those prompts or inputs, then re-test in a new pre-registered round.
- Record the negative result in an ADR that amends ADR-0007's context section.

**If it is inconclusive:** report the interval and what sample would resolve
it. A larger sample is a new registration, not an extension of this one.

## 14. Pilot (not a result)

A single live run of the `sw_dev` loop on toy issue 2 with `claude-haiku-5-5`
through the runner passed 13 of 15 stages on the first try, cost $0.71, took about
21 minutes, and produced the correct fix. The cost driver was per-turn context
above 100K tokens in three stages, since addressed by a context diet. This is one
run, one fixture, one cell, with no comparison, run before this design was
fixed. It was used to size the budget cap and to choose what to record. It is
**not** included in any analysis and supports none of H1-H3.

## 15. Prerequisites before the first run

1. Harness (#101) complete: writes the three tables, exports CSV, tests the
   NOCLI gate snapshot logic.
2. Cache read and cache write tokens recorded per attempt: the harness reads them
   from the Claude Code JSON kept in each transcript (#101), so the adapter
   needs no change; confirmed on the first live run.
3. Per-cell budget cap set and committed as an amendment.
4. Randomization seed and run order committed.
5. Fixture leakage checks (10.1) done and recorded.
6. Rater calibration done (9.4); analysis script committed.
7. Model ids confirmed available (section 3).

## Amendments

None. Entries are added as `YYYY-MM-DD, section, change, reason`.
