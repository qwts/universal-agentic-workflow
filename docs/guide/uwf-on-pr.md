# Running UWF on a pull request

`.github/workflows/uwf-on-pr.yml` is a reusable workflow (`on: workflow_call`). It does not fire on this repository's
own PRs. A consumer repository (the first is `qwts/uwf-toy-app`) adds a thin caller workflow that triggers on its PRs
and calls this one. The job runs on a self-hosted runner labelled `self-hosted,uwf` (see
[self-hosted-runner.md](self-hosted-runner.md)).

## Install the caller in a consumer repo

Create `.github/workflows/uwf.yml` in the consumer repo:

```yaml
name: UWF

on:
  pull_request:
    types: [opened, synchronize, labeled, edited]

permissions:
  contents: read
  issues: read
  pull-requests: write    # the sticky report comment

jobs:
  uwf:
    # Runs cost money: an edit starts a run only when it newly adds `/uwf run` to the description.
    if: >-
      ${{
        (github.event.action != 'edited'
          && (contains(github.event.pull_request.labels.*.name, 'uwf:run')
              || contains(github.event.pull_request.body, '/uwf run')))
        || (github.event.action == 'edited'
            && github.event.changes.body != null
            && contains(github.event.pull_request.body, '/uwf run')
            && !contains(github.event.changes.body.from, '/uwf run'))
      }}
    uses: qwts/universal-agentic-workflow/.github/workflows/uwf-on-pr.yml@main
    with:
      model: claude-haiku-5-5    # required; the model id your adapter accepts
      # workflow: sw_dev          # default
      # adapter: claude-code      # default
      # max_cost_usd: 1           # default
      # uwf_ref: main             # ref of this repo used as the skills root
    secrets: inherit
```

Then create the label `uwf:run` in the consumer repo (`gh label create uwf:run`). If the repository restricts which
actions and reusable workflows may run, allow `qwts/universal-agentic-workflow/.github/workflows/uwf-on-pr.yml`.

A PR starts a run when it carries the label `uwf:run` or its description contains `/uwf run`. Adding the label to an
already open PR starts a run through the `labeled` event; a push to a PR that already qualifies starts a new one, and so does editing the description to add `/uwf run` (the `edited` event). Other edits of a qualifying PR do not restart the run: the caller's condition requires the description to have changed (`changes.body` present; a title-only edit has none, and an empty previous description still counts as a change) and `/uwf run` to be absent from the previous description, because every run spends model budget.
PRs from forks never run: the job is skipped, because it would execute untrusted code on a self-hosted machine.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `workflow` | `sw_dev` | UWF workflow to run |
| `adapter` | `claude-code` | harness adapter (`claude-code`, `codex`) |
| `model` | none, required | model passed to the adapter |
| `max_cost_usd` | `1` | run cost cap; the runner stops with exit 4 above it |
| `uwf_ref` | `main` | ref of this repo checked out as the skills root |
| `runner_labels` | `uwf` | reserved; `runs-on` is fixed to `[self-hosted, uwf]` |

## API keys

The keys reach the runner from the self-hosted machine's service environment (`<runner dir>/.env`, written by
provisioning; see [self-hosted-runner.md](self-hosted-runner.md)). The workflow does not need them as repo secrets.
If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` exist as secrets (hence `secrets: inherit`), the workflow passes them to the
runner, and sets `CODEX_API_KEY` from `OPENAI_API_KEY`, so a hosted runner can be tried later. An empty or missing
secret is not exported, so it never shadows the machine's value.

## What a run does

1. Checks out the PR head commit into `target/` and `qwts/universal-agentic-workflow` at `uwf_ref` into `uwf/`.
2. Installs the skill dependencies in `uwf/` (the same bounded `npm ci` steps as `ci.yml`).
3. Builds `$RUNNER_TEMP/goal.md` from the PR title, the PR description and the linked issues (`#12`, `owner/repo#12`,
   `Closes #12`; at most 10, fetched with `gh issue view` using the job token; an unreadable one is marked as such).
4. Runs `runner.mjs run --workflow ... --non-interactive --max-cost-usd ...` with `--repo-root target`,
   `--skills-root uwf` and `--data-dir $RUNNER_TEMP/uwf-<run_id>`. The exit code is captured, not failed on yet.
5. Writes the stage table and the per-stage cost report to the job summary. On a non-zero exit the runner prints no table, so the summary shows the failure message and the per-stage result lines instead.
6. On exit 0 only, pushes the changes the run left in `target/` as one commit under the bot identity (see below).
7. Posts or updates the sticky PR comment (see below).
8. Scrubs secret-shaped strings from the transcripts and the runner log (see below).
9. Uploads one artifact, `uwf-pr-<number>-<run_id>`, with `target/tmp/workflow-artifacts`, the transcripts and
   workflow artifacts under the data dir and the runner log (kept 14 days), then removes the data dir unless the PR
   carries the `uwf:keep` label.
10. Fails the job with the runner's exit code and an `::error::` line: 1 gate blocked or aborted, 2 usage or config,
   3 questions pending, 4 cost cap exceeded. Exit 0 passes.

## Report on the PR

`scripts/uwf-on-pr/report.mjs` keeps one comment on the PR, found by the hidden marker `<!-- uwf-on-pr:report -->`
and edited in place on every run (a new one is created only when none exists). It shows the run link and runner exit
code, a table of stage, attempts and gate result, and the artifact link. By outcome:

- exit 0: whether a commit was pushed, and an @-mention of the PR author asking for review;
- exit 1: the gate that blocked, its failures and the runner's prescription for fixing it;
- exit 3: "questions pending" (the questions themselves are posted by #96; until then they are in the artifact);
- exit 4: the cost cap that was hit (`max_cost_usd`).

The comment is written with the job token (`pull-requests: write`). Text from the runner log is untrusted: it is shown
in code spans (no @-mentions, no markdown breakout), scrubbed with the shared secret patterns and never passed through a
shell.

## Commits under the bot identity

The sw_dev stages edit files in `target/` and do not run `git commit`, so a finished run leaves a dirty working tree.
After an exit 0, `scripts/uwf-on-pr/push-as-bot.mjs` collects the changes (`git diff HEAD` plus untracked files that
`.gitignore` does not exclude; `tmp/` is never included) and creates ONE commit on the PR head branch through the Git
Data API (blobs, tree, commit, ref update), the procedure of the `signed-commit` skill, so GitHub signs it and it shows
Verified. The message is `uwf(<workflow>): <PR title> (run <run_id>)` plus a `Co-Authored-By` trailer.

- It needs the repo Actions secret `UWF_BOT_TOKEN` (see [self-hosted-runner.md](self-hosted-runner.md)); only that one
  step reads it, it is never printed or written, and `secrets: inherit` in the caller passes it. Without it nothing is
  pushed and the comment says so.
- It pushes only when the PR head is still the commit the run checked out and the ref update is a fast-forward. If the
  branch moved, nothing is pushed and the comment says so.
- Nothing is ever pushed after exit 1, 2, 3 or 4.
- Use a GitHub App token for the bot. A push made with an App token raises a `synchronize` event whose sender is a bot,
  and the workflow's job condition skips bot senders, so the bot's own push does not start another (paid) run. A
  personal access token of a user account would not be skipped.
- The API refuses a review request for the PR author, so the comment @-mentions the author asking for review. The
  workflow never merges.

## Isolation, scrubbing and retention

Isolation: each run works in `$RUNNER_TEMP/uwf-<run_id>` (stage tracker, state, transcripts) and its own `target/` and
`uwf/` checkouts under that job's `$GITHUB_WORKSPACE`. `run_id` is unique per run, so two PRs running at once on one
runner never share a file; the concurrency group is per PR number, so only the same PR's older run is cancelled.

Scrubbing: before upload, `scripts/uwf-on-pr/scrub.mjs` rewrites every text file under the data dir, the runner log and
`target/tmp/workflow-artifacts`, replacing matches of the patterns in `scripts/hooks/secret-patterns.mjs` (Anthropic
and OpenAI style keys, GitHub tokens, AWS access keys, Slack tokens, bearer tokens, private key blocks) with
`[redacted:<kind>]`. Binary files such as SQLite databases are skipped, so the `uwf:keep` artifact can still contain
them; only keep runs you are willing to store.

Retention: artifacts are kept 14 days (`retention-days: 14`). Golden runs are committed to the repo, not retained here.

`uwf:keep` label: when the PR carries it, the data dir is not removed and the artifact contains the whole data dir
(stage tracker, state, transcripts, workflow artifacts) instead of the selected files. The label is read from the event
that started the run, so add it before the run starts.

## Concurrency and clean starts

The job uses `concurrency: uwf-pr-<PR number>` with `cancel-in-progress: true`. A second push to the PR cancels the
run in flight. The new run has a new `run_id`, so its data dir (`$RUNNER_TEMP/uwf-<run_id>`) is new: the stage tracker,
state and transcripts of the cancelled run are not shared. The cancelled run's data dir is removed by its cleanup step
(or left until the runner's temp directory is cleaned, if the cancel killed the cleanup).

## Where to look

- Job summary of the run: stage table and cost report.
- Artifact `uwf-pr-<number>-<run_id>` on the run page: workflow artifacts, transcripts, runner log.

## Not yet verified

This was validated statically (YAML parse, the runtime-policy checker, the repo tests). The acceptance checks of #94
need a live run on a registered runner and are still open:

- a green run on the toy repo from a labeled PR;
- a second push cancels the first run and starts clean;
- the job summary shows the stage table.

The acceptance checks of #95 and #97 also need a live run and are still open: the comment updates in place across runs;
the pushed commit is Verified and attributed to the bot; a grep for the API key pattern over uploaded artifacts finds
nothing; two concurrent labeled PRs on one runner never share files (this needs a live runner).
