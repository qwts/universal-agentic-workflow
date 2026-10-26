# Universal Agentic Workflow (UWF)

UWF is a gate-enforced, role-based stage workflow for AI-assisted project delivery. Each workflow is a `stages.yaml` file: an ordered list of stages, each with a stage agent, the artifacts it must write, and deterministic gate checks. The runner (`scripts/uwf-runner/runner.mjs`) owns the loop, the state and the gates, and a harness CLI (Claude Code or Codex) runs one stage at a time with one short prompt. Sequencing and gate decisions live in tooling, and the instructions live in CLI tools and skill files, so a small model gets the same stage contract as a large one. That premise is what the CLI-offload experiment tests.

**Status.** The smoke suite and the runner and bench tests run in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The first live `sw_dev` run is documented in [issue #128](https://github.com/qwts/universal-agentic-workflow/issues/128). The experiment design is in [`docs/research/cli-offload-design.md`](docs/research/cli-offload-design.md). Copilot chat remains an optional adapter.

---

## Quick start (runner)

**Prerequisites**

- Node.js 20 or newer. CI runs Node 20; the commands below were also checked on Node 24.
- Install dependencies in each skill that ships a `package.json` (nine today). From the repository root:

  ```sh
  for d in .github/skills/uwf-*/; do [ -f "$d/package.json" ] && (cd "$d" && npm ci); done
  ```

- For live runs only: a harness CLI that is logged in, `claude` (Claude Code) or `codex`. Dry runs and tests do not call a model.

**Commands.** `UWF_FAKE_FIXTURE_DIR` selects the offline fake adapter. The runner's stores (stage tracker, state, questions, transcripts) live under `--data-dir` (default `./tmp/uwf`, relative to where you run), so pass the same `--data-dir` to `resume` and `cost`. Commands below run from this checkout; `../my-app` is any git repository.

```sh
# 1. Dry run with the fake adapter: prints the stage plan, writes nothing to the target.
UWF_FAKE_FIXTURE_DIR=scripts/uwf-runner/test/fixtures/sw_dev \
  node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal "Add a DELETE route" \
  --adapter fake --dry-run --repo-root ../my-app

# 2. Real run: one stage at a time through Claude Code, capped at $1 for the run.
node scripts/uwf-runner/runner.mjs run --workflow sw_dev --goal goal.md \
  --adapter claude-code --model <model-id> --repo-root ../my-app \
  --skills-root /path/to/universal-agentic-workflow \
  --data-dir ./tmp/uwf-run --max-cost-usd 1

# 3. Resume after an interruption, a pending question, or a cost stop.
#    The cap is not stored: pass --max-cost-usd again (raise it after exit 4).
node scripts/uwf-runner/runner.mjs resume --workflow sw_dev --adapter claude-code --model <model-id> \
  --repo-root ../my-app --skills-root /path/to/universal-agentic-workflow --data-dir ./tmp/uwf-run \
  --max-cost-usd 1

# 4. Cost report for the run: turns, context per turn, tokens, cost, flags.
node scripts/uwf-runner/runner.mjs cost --data-dir ./tmp/uwf-run --workflow sw_dev --repo-root ../my-app

# 5. Gates audit: every check each stage will run, with its retry prescription. No model call.
node scripts/uwf-runner/runner.mjs gates --workflow sw_dev
```

**Exit codes** (`runner.mjs run` and `resume`):

| Code | Meaning |
| --- | --- |
| 0 | Workflow complete (or, for `run` on an already complete data dir, the stage table is printed) |
| 1 | Gate blocked, `abort`, or an `on_verdict` round-trip budget exhausted |
| 2 | Usage or config error |
| 3 | Questions pending (answer with `.github/skills/uwf-question-protocol/questions.mjs answer`, then `--from-stage <stage>`) |
| 4 | Cost cap exceeded (`--max-cost-usd` or a stage's `max_cost_usd`); raise it and `resume` |

`--max-cost-usd` is read only from the command line; the runner does not store it, so `resume` without it has no cap. The cap counts cumulative cost of the run's transcripts, including those from before the resume.

`--non-interactive` answers no questions. Each pending or newly asked question is marked skipped and the stage continues. Without the flag, a pending required question stops the run with exit 3. On a pull request, [uwf-on-pr](docs/guide/uwf-on-pr.md#questions-and-answers) turns that exit 3 into a PR comment and resumes the run after `/uwf answer` replies.

`--goal` takes a file path or inline text. `--from-stage <s>` re-runs from a stage and rolls the state back. `--force` re-initializes a completed data dir.

---

## How a run works

For each stage in `stages.yaml`, the runner:

1. Stops with exit 3 if the stage has unanswered required questions.
2. Marks the stage active and builds the prompt from the stage agent's body, the context block, the resolved inputs and the required outputs. The stage sees only itself; it does not know the stage order.
3. Invokes the adapter (`claude-code`, `codex` or `fake`) with the stage's permission preset (`read-only`, `edit` or `edit+exec`) and `max_turns` (default 20, implementation 30).
4. Evaluates the gate with the stage tracker. Gate types cover file existence, text and pattern matches, JSON fields and scripts.
5. On failure, retries up to `max_retries` (`on_gate_failure: retry`; `skip` and `abort` act on the first failure). The gate's prescription becomes the retry prompt. `retry_mode: resume` reuses the session; `fresh` starts a new one. If the last turn's context exceeded `--resume-max-context` (default 100000 tokens), the retry starts fresh anyway.
6. Routes instead of retrying when a verdict matches an `on_verdict` key. In `sw_dev`, a review verdict of `changes_requested` routes back to `implementation`, up to two round trips. The findings are passed to the routed stages.

Every transition is recorded in the existing SQLite stores under the data dir. The runner adds no state store of its own. Adapters never write workflow state.

Artifacts are written to `tmp/workflow-artifacts/` in the target repository, with a persona-specific prefix (`issues-` for `sw_dev`).

---

## Repository layout

```
.github/
├── agents/                 Stage agent files (uwf-stage-*, uwf-core-*, uwf-<persona>-*)
├── skills/                 20 skills (uwf-*/): SKILL.md, scripts and SQLite schemas
│                           (persona skills: uwf-sw_dev, uwf-project_manager,
│                            uwf-solutions_architect, uwf-forensic-analyst)
├── prompts/                Copilot entry prompt
├── instructions/           Copilot always-on rules
├── hooks/                  PreToolUse security policy
├── copilot-instructions.md Copilot adapter entry point
└── workflows/              ci.yml, codeql.yml
scripts/
├── uwf-runner/             runner.mjs (run | resume | gates | cost), adapters/, cost.mjs, prompt.mjs, test/
├── uwf-bench/              bench.mjs matrix harness, matrix.example.yaml, test/
├── uwf-smoke/              Repository smoke tests (run by CI)
├── hooks/                  preToolUse.mjs, the hook behind .github/hooks
├── scaffold-skill.mjs      Persona skeleton generator
└── runner-host/            planned (#93): self-hosted runner provisioning; not on main yet
docs/
├── adr/                    Architecture decision records (ADR-0007 is the runner decision)
├── research/               cli-offload-design.md (pre-registered experiment)
├── product/                Product definition and v1 roadmap
├── artifacts/, workflow-output-templates/, uwf-architecture.md, brownfield-path.md
uwf-companion/              VS Code extension: live dashboard over the skill databases
AGENTS.md                   Canonical agent context for this repository
CONTRIBUTING.md             Development guide, test commands, PR conventions
```

---

## Workflows and agents

Each persona is defined by `.github/skills/uwf-<name>/stages.yaml` (the authoritative stage list) and `SKILL.md` (documentation).

- **`sw_dev`**: takes one issue from intake through implementation, review, acceptance, snapshot and retro (15 stages) ([stages.yaml](.github/skills/uwf-sw_dev/stages.yaml)).
- **`project_manager`**: scopes a new effort, writes the requirements pack, plans the roadmap and scaffolds the backlog ([stages.yaml](.github/skills/uwf-project_manager/stages.yaml)).
- **`solutions_architect`**: architecture-first engagements; the deliverable is a System Design Document ([stages.yaml](.github/skills/uwf-solutions_architect/stages.yaml)).
- **`forensic-analyst`**: brownfield pre-phase that infers a provisional Build Record with confidence scores before Phase 1 ([stages.yaml](.github/skills/uwf-forensic-analyst/stages.yaml)).

Agent file names: `uwf-stage-<stage>` for shared stages that traits specialize (`intake`, `discovery`) and `uwf-core-<job>` for cross-cutting infrastructure.
`uwf-<persona>-<job>` names the stages specific to one persona.

Skills are the swappable behavior modules. Each has a `SKILL.md` and agents operate its data through its scripts, never directly on its database.

| Skill | Purpose |
| --- | --- |
| `uwf-adr` | Architecture Decision Records with a 300-point checklist (`adrs.mjs`) |
| `uwf-cbs` | Blueprint stage: Canonical Build Spec database and Build Record initialization |
| `uwf-discovery` | Workspace discovery findings database (`discoveries.mjs`) |
| `uwf-forensic-analyst` | Brownfield pre-phase: five stages and the forensic confidence schema |
| `uwf-local-tracking` | Issue backlog and state in SQLite (`issues.mjs`); the default tracking backend |
| `uwf-model-adaptation` | Resolves a model profile (`compact`, `balanced`, `reasoning`) to a steering policy |
| `uwf-orchestration-engine` | Stage loop, gate enforcement and retry contract; stage-tracker and stage contracts |
| `uwf-project_manager` | Project-manager persona: scope, roadmap and backlog stages |
| `uwf-question-protocol` | Subagent-to-orchestrator questions, persisted with numeric IDs (`questions.mjs`) |
| `uwf-refinement` | Story quality gate: field completeness, nine quality controls |
| `uwf-requirements` | Requirements pack: PRD, NFRs, acceptance criteria, risks (`requirements.mjs`) |
| `uwf-review` | Shared review findings, severity and verdict rules (`reviews.mjs`); a dependency of `uwf-reviewer` |
| `uwf-reviewer` | Archetype-aware reviewer: `--persona pm`, `dev` or `arch` |
| `uwf-risk-planner` | Project-level risk register |
| `uwf-snapshot` | Snapshot stage: Deterministic Reconstruction Spec (`uwf-drs`) and changelog closure |
| `uwf-solutions_architect` | Solutions-architect persona: SDD, interface contracts, traceability |
| `uwf-state-manager` | Workflow phase and state, the source of truth for transitions (`state.mjs`) |
| `uwf-sw_dev` | Software-developer persona: one issue from intake through implementation, review, acceptance and retro (15 stages) |
| `uwf-threat-model` | STRIDE threat models and mitigations for the security-plan stage |
| `uwf-traits` | Behavior overlays (`project_manager`, `sw_dev`, `solutions_architect`, `forensic_analyst`) |

---

## Benchmarking and cost

- **`scripts/uwf-bench`** runs a matrix of cells, fixtures and run indexes unattended. It wraps the runner, records usage and gate outcomes in `results.db`, and exports CSV. Commands: `bench.mjs run --matrix <file> [--resume]`, `bench.mjs export --db <file> --out <dir>`, `bench.mjs rate ...` for blind human ratings. Read [`scripts/uwf-bench/README.md`](scripts/uwf-bench/README.md) for the matrix format and the NULL fields, and start from [`matrix.example.yaml`](scripts/uwf-bench/matrix.example.yaml). That example contains live cells, so running it spends money.
- **`runner.mjs cost`** flags per-stage problems: `!50K` when average context per turn exceeds 50K, `!100K` when the final turn likely crossed the 100K pricing tier, and `!MISS` when cache writes exceed cache reads and 50K.

---

## Other surfaces: Copilot chat (optional adapter)

Per [ADR-0007](docs/adr/ADR-0007-runtime-owns-the-loop.md), the Copilot orchestrator is a thin alternative runtime for chat surfaces that cannot host the loop. It is not the primary path.

- Entry prompt: [`.github/prompts/uwf-start-project-planning.prompt.md`](.github/prompts/uwf-start-project-planning.prompt.md) starts `uwf-core-orchestrator` with `workflow=project_manager`.
- The orchestrator invokes stage agents as custom subagents through `runSubagent`. Custom subagents are experimental in VS Code and must be enabled first.
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md) is the Copilot adapter's entry file. It points to `AGENTS.md`.

**VS Code companion.** [`uwf-companion/`](uwf-companion/README.md) is a VS Code extension that reads the UWF SQLite databases and shows stages, issues, requirements, ADRs, discoveries and review findings as the runner or agents write them. It needs Node 22.13+ and VS Code 1.101+.

---

## Non-negotiables

- **Plan before implementing.** No code or infrastructure changes before the intake and plan artifacts for the active scope exist.
- **Verifiability over speed.** Missing context is discovered or clarified, never assumed.
- **Small, reviewable changes.** Broad rewrites need an explicit request.
- **No secrets in the repo.** If credentials are found, execution stops and secure storage is recommended.
- **Unplanned work is tracked, not silently implemented.** It is recorded as an ungroomed spike in the tracking backend and surfaced for triage.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for prerequisites, the smoke, runner and bench test commands, how to add a persona, stage agent, skill or tracking backend, and pull request guidelines. Architecture reference: [`docs/uwf-architecture.md`](docs/uwf-architecture.md).
