# Self-hosted runner for UWF jobs

UWF pull-request jobs (epic #92) run on a machine we control, not on GitHub-hosted runners: the job runs
`scripts/uwf-runner/runner.mjs`, which drives the `claude` and `codex` CLIs. This guide covers provisioning that
machine, the secrets it needs, and how to keep it healthy.

Supported: macOS and Linux (x64 and arm64). Windows is best-effort and not covered here.

## What the machine needs

| Need | Why |
| --- | --- |
| Node >= 24 | `runner.mjs` and the UWF scripts |
| `claude` (`@anthropic-ai/claude-code`) | the Claude agent adapter |
| `codex` (`@openai/codex`) | the Codex agent adapter |
| `gh` | the bot's GitHub access and the registration token |
| GitHub Actions runner, registered with labels `self-hosted,uwf` | receives the jobs |
| runner installed as a service | survives reboots, starts idle |
| >= 10 GB free disk | job workspaces and `UWF_DATA_DIR` |

## One-command provisioning

On the machine, with the secrets exported (see below):

```bash
export GH_TOKEN=...              # the bot token (UWF_BOT_TOKEN also accepted)
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
scripts/runner-host/provision.sh --repo qwts/uwf-toy-app --name uwf-mac-01
```

Flags:

- `--repo owner/name` or `--org name`: where to register the runner (exactly one).
- `--name NAME`: runner name (default `uwf-<hostname>`).
- `--labels LIST`: default `self-hosted,uwf`.
- `--dir PATH`: install directory (default `$HOME/actions-runner-<name>`).
- `--dry-run`: print every command instead of running it. This is the plan for a fresh machine; review it first.
- `--check`: run `doctor.sh` and exit with its status.

What it does, in order: install Node 24 (nvm if present, else Homebrew on macOS, else nvm on Linux), `npm i -g` the two
CLIs, install `gh` (Homebrew, apt or dnf), confirm `gh auth status` as the bot, download the runner for the platform and
architecture, write `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` (set from `OPENAI_API_KEY` unless you export it; it is what `codex exec` reads headlessly) and a `PATH` covering the directories of node, npm, claude, codex and gh into the runner's `.env` (mode 600), register with
`config.sh --unattended`, run `./svc.sh install && ./svc.sh start`, then run the doctor.

It is idempotent: every step checks current state first (installed tools, unpacked runner, `.runner`, `.service`,
service running) and skips what is done, so re-running on a provisioned machine changes nothing. `GH_TOKEN`,
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read from the environment only and are never printed; the registration
token is redacted in the command log.

### Bot permission for registration

The registration token comes from `gh api --method POST repos/<owner>/<repo>/actions/runners/registration-token`
(or `orgs/<org>/actions/runners/registration-token`). The bot token needs:

- repository runner: fine-grained token with repository permission **Administration: Read and write** on that repo
  (classic token: `repo` scope);
- organization runner: organization permission **Self-hosted runners: Read and write** (classic: `admin:org`).

Nothing more. Use a fine-grained token scoped to the single repo where you can.

## Verifying: doctor

```bash
scripts/runner-host/doctor.sh --name uwf-mac-01      # or --dir <runner dir>
```

Checks node >= 24, `claude`, `codex`, `gh`; `gh auth status` as the bot; the three API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`) present (values never echoed;
read from the environment or the runner's `.env`); free disk >= 10 GB; runner registered (`.runner`); service installed
and running (`./svc.sh status`); and whether a job is running (`Runner.Worker`). Exit 0 when all is good. Otherwise
exit 1 with one named fix per failure, for example:

```
missing: codex - run: npm i -g @openai/codex
```

A running job is reported as a warning (the runner is busy, not broken); `--strict-idle` makes it a failure.

The runner listener applies every line of `<runner dir>/.env` to its environment at startup, `PATH` included
(`LoadAndSetEnv` in actions/runner `Runner.Listener/Program.cs`). That is why `PATH` lives in `.env` rather than only in
the runner's `.path` file, and why the doctor resolves the CLIs against the `PATH` from `.env`.

## Secrets: what goes where

| Secret | Repo Actions secret | Machine env (runner service) |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes, only if a workflow step needs it directly | yes: `<runner dir>/.env`, written by provisioning |
| `OPENAI_API_KEY` | same | same |
| `CODEX_API_KEY` | no | yes: `.env`, derived from `OPENAI_API_KEY` by provisioning |
| Bot GitHub token | yes, as `UWF_BOT_TOKEN` for workflow steps that call `gh` | provisioning shell only (not stored on disk) |

The runner service does not load shell profiles; it reads `<runner dir>/.env`. That is why provisioning writes the API
keys and a `PATH` that resolves every required CLI there (the doctor checks this PATH, not just your shell's). The bot token is needed only while provisioning and when running the doctor;
jobs receive it from repo Actions secrets.

### Deliberately not used

Per the org SOP (ENG-0016) the runner machine uses **API-key billing and a bot identity**:

- no personal subscription tokens or OAuth logins for Claude or Codex (`claude login`, `codex login`, ChatGPT or Claude
  subscription sessions);
- no personal GitHub token and no `gh auth login` as a human; `gh` authenticates only through `GH_TOKEN` from the bot;
- no secrets baked into scripts, workflow files, or logs.

## Rotation

1. Create the new key or token (Anthropic Console, OpenAI platform, or the bot's token settings).
2. Update the repo Actions secrets (`gh secret set UWF_BOT_TOKEN`, etc.).
3. On the machine, export the new values and re-run `scripts/runner-host/provision.sh --repo ... --name ...`: it
   rewrites the changed lines in `.env` and leaves everything else alone. Then restart the service so it picks up the
   new environment: `cd <runner dir> && ./svc.sh stop && ./svc.sh start` (prefix with `sudo` on Linux).
4. Run `scripts/runner-host/doctor.sh`.
5. Revoke the old key or token.

To retire a runner: `./svc.sh stop && ./svc.sh uninstall`, then `./config.sh remove --token <removal token>` (same API
as registration, endpoint `.../actions/runners/remove-token`).

## How `uwf-on-pr.yml` uses the runner

`uwf-on-pr.yml` (#94, see [uwf-on-pr.md](uwf-on-pr.md)) targets this runner. Its job has this shape:

```yaml
jobs:
  uwf:
    runs-on: [self-hosted, uwf]
    env:
      UWF_DATA_DIR: ${{ runner.temp }}/uwf-${{ github.run_id }}
    steps:
      - uses: actions/checkout@...
      - run: node scripts/uwf-runner/runner.mjs
```

`UWF_DATA_DIR=$RUNNER_TEMP/uwf-<run_id>` gives each run its own scratch state, so concurrent or repeated runs on one machine do not collide.
API keys come from the service environment above; the job itself should not need personal credentials.
