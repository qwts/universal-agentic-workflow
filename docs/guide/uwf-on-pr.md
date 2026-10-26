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
  issue_comment:           # `/uwf answer` replies to a paused run
    types: [created]

permissions:
  actions: read            # download the paused-state artifact
  contents: read
  issues: read
  pull-requests: write     # the sticky comments, labels and reactions

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
      # on_questions: pause       # default; `skip` marks questions skipped and never pauses
      # uwf_ref: main             # ref of this repo used as the skills root
    secrets: inherit

  uwf-answer:
    # Answers to a paused run. The reusable workflow re-checks the same condition; the caller's `if` keeps the
    # job from being listed for every comment.
    if: >-
      ${{
        github.event_name == 'issue_comment'
        && github.event.issue.pull_request
        && startsWith(github.event.comment.body, '/uwf ')
        && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
      }}
    uses: qwts/universal-agentic-workflow/.github/workflows/uwf-on-pr.yml@main
    with:
      model: claude-haiku-5-5    # the same value as above (the input is required, the answer job does not use it)
    secrets: inherit
    permissions:
      actions: read
      contents: read
      issues: read
      pull-requests: write
```

Then create the labels `uwf:run` and `uwf:needs-input` in the consumer repo (`gh label create uwf:run`,
`gh label create uwf:needs-input`). If the repository restricts which
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
| `on_questions` | `pause` | `pause`: a required question ends the run (exit 3) and is asked on the PR; `skip`: questions are marked skipped and the run continues (the former behaviour) |
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
4. Runs `runner.mjs run --workflow ... --max-cost-usd ...` (plus `--non-interactive` when `on_questions: skip`) with `--repo-root target`,
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
- exit 3: "questions pending", pointing at the separate questions comment (see "Questions and answers");
- exit 4: the cost cap that was hit (`max_cost_usd`).

The comment is written with the job token (`pull-requests: write`). Text from the runner log is untrusted: it is shown
in code spans (no @-mentions, no markdown breakout), scrubbed with the shared secret patterns and never passed through a
shell.

## Questions and answers

With `on_questions: pause` (the default) the runner is started without `--non-interactive`. When a stage logs a
*required* question, or the runner finds one pending, the run ends with exit 3 instead of skipping it. Optional
questions never pause the run; they are recorded and listed in the comment. The round trip:

1. **Pause.** `scripts/uwf-on-pr/pause.mjs` posts (or updates) a second sticky comment, found by the marker
   `<!-- uwf-on-pr:questions -->`, with a checklist `- [ ] **Q<id>** (<stage>, required|optional) <question>` and the
   proposed answer when there is one. It adds the label `uwf:needs-input` and removes `uwf:run`. It writes
   `paused.json` (`headSha`, `stage`, `pausedAt`) and a snapshot of the run's working-tree changes into the data dir, and
   the whole data dir is uploaded (after scrubbing) as the artifact `uwf-state-pr-<number>`, overwritten on each pause and
   kept 14 days. The job still fails with exit code 3.
2. **Answer.** Reply on the PR with one command per line: `/uwf answer <id> <text>` or `/uwf skip <id>`. The caller's
   `uwf-answer` job runs the reusable workflow's `answer` job on a hosted runner: it downloads the state artifact, applies
   the commands with `questions.mjs`, ticks the checklist, uploads the state again and replies with what is still
   pending. Only pending questions can be changed. When no required question is left it marks the state `resume: true`,
   swaps the labels (`uwf:needs-input` off, `uwf:run` on) and reacts with a thumbs-up.
3. **Resume.** The `labeled` event for `uwf:run` starts the `uwf` job. It restores the state artifact and, only when
   `paused.json` has `resume: true` and `headSha` still equals the PR head, runs `runner.mjs resume` (no `--goal`;
   `--max-cost-usd` is passed again because it is not persisted; the costs already in the transcripts count). `resume`
   continues the first unfinished stage, which is the one that stopped on the questions, so `--from-stage` is not needed.
   If the head moved, or the state is missing or expired, the run starts fresh. After a resumed run that does not pause
   again, the artifact is replaced with a `done.json` marker so a later `uwf:run` label cannot resume stale state.
4. A comment with no pause to answer gets "No paused UWF run on this PR."

Requirements and limits:

- **`actions: read`** is needed in the caller's `permissions` (and the workflow's) to list and download the artifact.
- **A bot token is needed for automatic resume.** Events raised with the job token (`GITHUB_TOKEN`) start no workflow, so
  the `uwf:run` label added by the answer job only starts the resume run when `UWF_BOT_TOKEN` (the PAT-backed bot from
  [the bot commits section](#commits-under-the-bot-identity), a `User` sender) is configured. Without it the answer job
  says so and you add the `uwf:run` label yourself.
- **Trust.** Only comments whose `author_association` is OWNER, MEMBER or COLLABORATOR are honoured. The comment body is
  data: it is read from the environment, matched against `^/uwf (answer|skip) (\d+)(?: (.+))?$` line by line, and passed to
  the question CLI as separate argv elements, never through a shell. An answer that starts with `--` is rejected.
- The state stays in the artifact for 14 days; after that a `uwf:run` label starts a fresh run. Answers and the data dir
  are scrubbed with the same patterns as the other artifacts, so do not put secrets in answers.
- **The working-tree snapshot is not scrubbed.** It travels as one tar archive (`target-snapshot.tar`, so dotfiles and
  file modes survive the artifact upload), which `scrub.mjs` skips as binary. That is intended: it holds exactly what
  a successful resume would commit as the bot, and rewriting it would corrupt source files that contain secret-shaped
  test strings. On restore every archive member must be a relative path inside the checkout, or the restore is refused.
- **Several answers at once.** GitHub keeps one pending job per concurrency group, so a newer `/uwf` comment can
  cancel an older pending answer job. Nothing is lost: each job applies every trusted `/uwf ` comment created since the
  pause that `paused.json` (`appliedComments`) does not list yet, in creation order, then records them.
- Fork PRs never run, so they never pause.

## Commits under the bot identity

The sw_dev stages edit files in `target/` and do not run `git commit`, so a finished run leaves a dirty working tree.
After an exit 0, `scripts/uwf-on-pr/push-as-bot.mjs` collects the changes (`git diff HEAD` plus untracked files that
`.gitignore` does not exclude; `tmp/` is never included) and creates ONE commit on the PR head branch through the Git
Data API (blobs, tree, commit, ref update), the procedure of the `signed-commit` skill, so GitHub signs it and it shows
Verified. The message is `uwf(<workflow>): <PR title> (run <run_id>)` plus the `UWF-Run` and `UWF-Model` trailers.

- It needs the repo Actions secret `UWF_BOT_TOKEN` (see [self-hosted-runner.md](self-hosted-runner.md)); only that one
  step reads it, it is never printed or written, and `secrets: inherit` in the caller passes it. Without it nothing is
  pushed and the comment says so.
- It pushes only when the PR head is still the commit the run checked out and the ref update is a fast-forward. If the
  branch moved, nothing is pushed and the comment says so.
- Nothing is ever pushed after exit 1, 2, 3 or 4.
- A run-generated commit never starts a run. The message ends with the trailers `UWF-Run: <run url>` and `UWF-Model:
  <model>`, and a first `guard` job reads the PR head commit through the API and skips the run when a line starts with
  `UWF-Run:`. This holds for a PAT-backed bot too, whose push raises a `synchronize` event with a `User` sender. A human
  push after the bot's commit changes the head, so it does start a run. The job also skips events sent by a `Bot`.
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

Both the `guard` job and the `uwf` job use `concurrency: uwf-pr-<PR number>` with `cancel-in-progress: true`. A second
push to the PR cancels the run in flight. The guard needs the same single self-hosted runner as `uwf`, so it shares the
group: the newer run's guard cancels the older in-flight `uwf` job as soon as it is queued, instead of waiting behind it
for up to 180 minutes. Within one run the guard finishes before `uwf` starts. The new run has a new `run_id`, so its data dir (`$RUNNER_TEMP/uwf-<run_id>`) is new: the stage tracker,
state and transcripts of the cancelled run are not shared. The cancelled run's data dir is removed by its cleanup step
(or left until the runner's temp directory is cleaned, if the cancel killed the cleanup).

## Where to look

- Job summary of the run: stage table and cost report.
- Artifact `uwf-pr-<number>-<run_id>` on the run page: workflow artifacts, transcripts, runner log.
- Artifact `uwf-state-pr-<number>`: the paused run's state (only while a run is paused).

## Not yet verified

This was validated statically (YAML parse, the runtime-policy checker, the repo tests). The acceptance checks of #94
need a live run on a registered runner and are still open:

- a green run on the toy repo from a labeled PR;
- a second push cancels the first run and starts clean;
- the job summary shows the stage table.

The acceptance checks of #95 and #97 also need a live run and are still open: the comment updates in place across runs;
the pushed commit is Verified and attributed to the bot; a grep for the API key pattern over uploaded artifacts finds
nothing; two concurrent labeled PRs on one runner never share files (this needs a live runner).

The acceptance checks of #96 also need a live run: a pause posts the checklist and labels; `/uwf answer` from a
collaborator resumes the run from the right stage; a comment from a non-collaborator is ignored; an optional question
never pauses.
