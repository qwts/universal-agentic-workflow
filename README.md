# Universal Agentic Workflow (UWF)

> **⚠️ Project status (2026-08): cleanup in progress — not yet CI-proven.**
> The skill sources lost during a partial extraction have been restored from the
> monorepo history; reference-integrity enforcement and CI proof remain tracked in
> [M0](docs/product/roadmap-v1.md#m0--truth). Historical findings and the restore
> source are recorded in
> [docs/product/repo-audit-2026-08-03.md](docs/product/repo-audit-2026-08-03.md).
> Direction, scope, and milestones to v1 are defined in
> [docs/product/product-definition.md](docs/product/product-definition.md) and
> [docs/product/roadmap-v1.md](docs/product/roadmap-v1.md); decisions are recorded
> as ADRs 0004–0006 in [docs/adr/](docs/adr/). The skill descriptions below
> reflect the intended (restored) state, not the current tree.

> **Before first use:** Enable **custom subagents** in VS Code Copilot settings (it is currently experimental). Without this, subagents will not execute and no artifacts will be produced.

A composable, role-based agent workflow framework for AI-assisted project delivery. Copy the `.github/` directory into any repository, choose the workflow persona that matches your goal, and get a consistent, gate-enforced development lifecycle — fully autonomous or human-paced — out of the box.

---

## Orchestration Modes

UWF supports two modes. You choose based on how much you want to drive versus observe.

### Autonomous (Agent-Orchestrated)

The `uwf-core-orchestrator` agent runs the full stage sequence end-to-end without stopping between stages. You provide the goal; the orchestrator invokes every subagent in order, enforces gates, retries on failure, and only pauses when it needs your input (via `vscode/askQuestions`) or when a gate permanently fails.

**Trigger:** Use the prompt file `.github/prompts/uwf-start-project-planning.prompt.md` or invoke `uwf-core-orchestrator` directly with `workflow=<persona>`.

### Human-Orchestrated

You control stage sequencing manually by invoking individual stage agents on demand. This is useful when you want to inspect and edit artifacts between stages, run only selected stages, or integrate UWF into an existing workflow.

**Trigger:** Use `uwf-core-orchestrator` as the stable entry point and pass the workflow name as an argument.

---

## Quick Start

### New project — project-manager workflow

1. Copy `.github/` into your repository.
2. Enable custom agents in VS Code Copilot settings.
3. Open the Copilot chat panel and run:
   ```
   @uwf-core-orchestrator workflow=project_manager
   ```
   Describe what you want to build when prompted.

### Existing issue — software-developer workflow

```
@uwf-core-orchestrator workflow=sw_dev
```
Describe the issue or paste its content when prompted.

### Architecture engagement — solutions-architect workflow

```
@uwf-core-orchestrator workflow=solutions_architect
```
Describe the architectural goal or system to design.

### Existing codebase with no prior requirements — brownfield forensic analysis

```
@uwf-core-orchestrator workflow=forensic-analyst
```
Provide the repository path or URL when prompted. See [Brownfield Projects](#brownfield-projects) for the full sequence.

---

## Repository Layout

```
.github/
├── agents/               # Stage agents (uwf-stage-{stage}.agent.md for canonical stages; uwf-core-* for infrastructure; uwf-{role}-{job}.agent.md for legacy workflow-specific stages)
├── skills/               # Swappable behavior modules (uwf-{name}/SKILL.md + scripts)
│   ├── uwf-orchestration-engine/   # Core engine: gate enforcement, stage loop, runSubagent contract
│   │   └── stage-contracts/        # Canonical stage capability contracts (intake.yaml, discovery.yaml, …)
│   ├── uwf-sw_dev/                 # Persona: software developer workflow (stages.yaml + run.mjs)
│   ├── uwf-project_manager/        # Persona: project manager workflow (stages.yaml + run.mjs)
│   ├── uwf-solutions_architect/    # Persona: solutions architect workflow & archetype (stages.yaml + run.mjs)
│   ├── uwf-forensic-analyst/       # Persona: brownfield forensic pre-phase (stages.yaml + run.mjs)
│   ├── uwf-model-adaptation/       # Model profile resolution + steering policy (resolve.mjs)
│   ├── uwf-traits/                 # Trait registry (traits/*.yaml) — behavior overlays per persona
│   ├── uwf-adr/                    # ADR creation with 300-point checklist (adrs.mjs)
│   ├── uwf-cbs/                    # Blueprint stage: Canonical Build Spec DB
│   ├── uwf-discovery/              # Discovery findings DB (discovery.mjs)
│   ├── uwf-local-tracking/         # Issue state management DB (issues.mjs)
│   ├── uwf-question-protocol/      # Question/answer protocol (questions.mjs)
│   ├── uwf-refinement/             # Story quality gate behavior
│   ├── uwf-requirements/           # Requirements DB (requirements.mjs)
│   ├── uwf-review/                 # Shared review infrastructure DB (review.mjs)
│   ├── uwf-reviewer/               # Archetype-aware reviewer (pm / dev / arch personas)
│   ├── uwf-risk-planner/           # Risk register behavior
│   ├── uwf-snapshot/               # Snapshot stage: uwf-drs producer
│   ├── uwf-state-manager/          # Workflow state (state.mjs)
│   └── uwf-threat-model/           # STRIDE threat model templates
├── prompts/              # Entry-point prompts to trigger a workflow run
├── instructions/         # Always-on rules applied across the workspace
└── copilot-instructions.md
docs/
├── adr/                  # Architecture Decision Records (ADR-####-<slug>.md)
├── artifacts/            # Schema docs for uwf-br and uwf-drs
├── brownfield-path.md    # Brownfield workflow diagram and Phase 1 handoff contract
├── uwf-architecture.md   # Full architecture spec
└── workflow-output-templates/  # Read-only example templates for each stage output
uwf-companion/            # VS Code extension — live UWF dashboard (see below)
```

---

## Non-Negotiables

- **Plan before implementing.** No code or infrastructure changes before `tmp/workflow-artifacts/{prefix}-intake.md` and `tmp/workflow-artifacts/{prefix}-plan.md` exist for the active scope.
- **Verifiability over speed.** Correctness takes priority. Missing context is discovered or clarified, never assumed.
- **Small, reviewable changes.** Broad rewrites are prohibited unless explicitly requested.
- **Template preservation.** `./docs/workflow-output-templates/` are read-only examples. Active artifacts live in `tmp/workflow-artifacts/`.
- **No secrets in the repo.** If credentials are encountered, execution stops and secure storage is recommended.
- **Unplanned work is not silently implemented.** It is tracked as an ungroomed spike in the default tracking backend (see `.github/skills/uwf-local-tracking/SKILL.md`) and surfaced for triage.

---

## Agent Bundles (`.github/agents`)

Agents follow two naming conventions:

- **Canonical stage agents** (`uwf-stage-{stage}.agent.md`) — stages that have been migrated to the `stage_type` capability architecture. Behavioral differences are provided by traits; the agent is shared across all workflows.
- **Infrastructure agents** (`uwf-core-{name}.agent.md`) — agents that handle cross-cutting concerns (orchestration, tracking, acceptance, snapshot, etc.).
- **Legacy workflow-specific stage agents** (`uwf-{role}-{job}.agent.md`) — stages not yet migrated to the canonical `stage_type` architecture. These keep their current names until their own migration.

The single orchestrator (`uwf-core-orchestrator`) coordinates all stage agents; stage agents are not invoked directly in autonomous mode.

### Canonical Stage Agents — `uwf-stage-*`

Canonical stage agents serve all workflows; trait YAML files supply the behavioral variation.

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-stage-intake.agent.md` | Captures goal, constraints, and scope for the active workflow. Writes the intake artifact to `outputs[0]`. Trait determines the required sections and question policy. |
| `uwf-stage-discovery.agent.md` | Inspects the workspace to identify unknowns and constraints without making implementation changes. Writes discovery artifact to `outputs[0]`. |

### Core Bundle — `uwf-core-*`

Infrastructure agents reusable by any orchestrator, regardless of workflow persona.

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-core-acceptance.agent.md` | Runs final acceptance checks, verifies commands, and documents known issues before closing work. |
| `uwf-core-adr.agent.md` | Produces Architecture Decision Records via the `uwf-adr` skill (300-point checklist). |
| `uwf-core-blueprint.agent.md` | Synthesizes all Phase 1 outputs into the Canonical Build Spec (uwf-cbs) and initializes the Build Record (uwf-br) strata 0–4. Final Phase 1 stage. |
| `uwf-core-project-tracking.agent.md` | Manages workflow state transitions using whichever tracking skill is configured. |
| `uwf-core-refinement.agent.md` | Grooms user stories to production-ready standard: field completeness gate, nine quality controls, and brownfield confidence-promotion logic. |
| `uwf-core-requirements.agent.md` | Writes PRDs, Non-Functional Requirements, and testable acceptance criteria. |
| `uwf-core-retro.agent.md` | Runs end-of-cycle retrospectives and surfaces workflow or implementation improvements. |
| `uwf-core-risk-planner.agent.md` | Produces a project-level risk register covering schedule, dependency, technical-debt, and external risks. Runs after `adr`, before `security-plan`. |
| `uwf-core-security-plan.agent.md` | Generates STRIDE-style threat models and security control plans via the `uwf-threat-model` skill. |
| `uwf-core-snapshot.agent.md` | Produces `uwf-drs` (Deterministic Reconstruction Spec); closes `uwf-br` layer 5; appends changelog closure entry. |
| `uwf-core-technical-writer.agent.md` | Reviews and propagates changes from `tmp/workflow-artifacts/` into permanent `./docs/` documentation. |
| `uwf-core-test-planner.agent.md` | Defines test stubs, integration scenarios, and coverage targets before implementation begins. |

### Software Developer Bundle — `uwf-sw_dev-*` / `uwf-issue-*`

Drives individual work items (issues) from intake through implementation, review, and acceptance.

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-sw_dev-work-planner.agent.md` | Assembles upstream artifacts (tests, security controls, scope) into an ordered implementation plan. |
| `uwf-issue-implementer.agent.md` | Executes code and infrastructure changes strictly against the approved plan and ADRs. |
| `uwf-sw_dev-reviewer.agent.md` | Evaluates implementation quality, test coverage, and security controls. Produces a fix list or hands off to acceptance. Loads `uwf-reviewer` with `Persona: dev`. |

### Project Manager Bundle — `uwf-project_manager-*`

Macro-level work: scoping a new effort, building a roadmap, and scaffolding the backlog.

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-project_manager-timeline-planner.agent.md` | Translates the project scope into a milestone/sprint/issue roadmap and creates the issues backlog. |
| `uwf-project_manager-reviewer.agent.md` | Audits the macro plan for completeness, feasibility, and consistency. Loads `uwf-reviewer` with `Persona: pm`. |

### Solutions Architect Bundle — `uwf-solutions_architect-*`

Architecture-first engagements: designing platforms, evaluating migration strategies, defining service boundaries, or producing an ADR set. The primary deliverable is a System Design Document (SDD).

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-solutions_architect-design-planner.agent.md` | Captures architectural goal, system boundaries, quality attributes, and constraints. Also produces the SDD: elaborated ADRs, interface contracts, measurable NFRs, component dependency graph, cross-domain risk mapping, and full traceability matrix. |
| `uwf-solutions_architect-reviewer.agent.md` | Architecture review gate: validates design completeness, NFR coverage, traceability, interface contract status, and constraint compliance. Loads `uwf-reviewer` with `Persona: arch`. |

### Forensic Analyst Bundle — `uwf-forensic-analyst-*`

Brownfield pre-phase that runs **before Phase 1** on existing projects. Produces a provisional Build Record (`forensic-br.json`) with confidence-scored entries. Phase 1 then uses that record as its starting state.

See [`docs/brownfield-path.md`](docs/brownfield-path.md) for the full workflow diagram and Phase 1 handoff contract.

| Agent file | Responsibility |
| :--- | :--- |
| `uwf-forensic-analyst-repo-audit.agent.md` | Stage 1 — Enumerate all repositories in scope, map service boundaries and seams, catalog tech stack per repo. |
| `uwf-forensic-analyst-artifact-harvest.agent.md` | Stage 2 — Collect all available evidence artifacts: commits, tickets, docs, configs, CI/CD definitions, test suites, existing ADRs. |
| `uwf-forensic-analyst-intent-inference.agent.md` | Stage 3 — Infer requirements and architectural decisions from observed behavior and artifacts. Assign preliminary confidence to each entry. |
| `uwf-forensic-analyst-confidence-score.agent.md` | Stage 4 — Formal scoring pass: finalize confidence tiers (`confirmed`, `inferred-strong`, `inferred-weak`, `gap`) and write the provisional `forensic-br.json` Build Record. |
| `uwf-forensic-analyst-gap-report.agent.md` | Stage 5 — Surface all `gap` entries; produce the structured human-review document; block until every gap is resolved or accepted as out-of-scope. |

---

## Skills (`.github/skills`)

Skills encapsulate discrete behaviors. Agents load skills by name; swapping a skill changes the behavior without touching the agent file. This is the primary extension point for integrating UWF with external tooling.

Every skill directory contains a `SKILL.md` (agent-readable behavior spec) and one or more Node.js scripts that agents call via terminal to read/write the skill's SQLite database. Agents must use the scripts — never write to any database directly.

| Skill | Purpose |
| :--- | :--- |
| `uwf-orchestration-engine` | Engine governing how the orchestrator operates: invocation contract, stage loop, gate enforcement, retry logic, and the fix-loop. Loaded by `uwf-core-orchestrator` at startup. |
| `uwf-adr` | Creates high-rigor ADRs at `./docs/adr/ADR-####-<slug>.md` using a 300-point checklist covering security, ops, compliance, and testability. SQLite-backed; operated via `adrs.mjs`. |
| `uwf-cbs` | Blueprint stage: synthesizes Phase 1 outputs into the Canonical Build Spec (uwf-cbs) SQLite database (components, interfaces, dependencies, sequencing, constraints) and initializes `uwf-br`. Used by `uwf-core-blueprint`. |
| `uwf-discovery` | Discovery findings SQLite database. Operated via `discovery.mjs`. |
| `uwf-forensic-analyst` | Brownfield pre-phase persona. Governs the five forensic stages and defines the confidence scoring schema and `forensic-br.json` output format. Loaded when `workflow=forensic-analyst`. |
| `uwf-local-tracking` | Issue state management using a local SQLite database. Operated via `issues.mjs`. Default tracking skill; swap with a GitHub Issues skill to change backends without touching agent files. |
| `uwf-question-protocol` | Question/answer protocol for subagent-to-orchestrator communication. Questions persisted in SQLite with a numeric ID. Operated via `questions.mjs`. |
| `uwf-refinement` | Story quality gate: field completeness, nine quality controls, and brownfield confidence-promotion logic. |
| `uwf-requirements` | Requirements SQLite database (FR / NFR / DR / AC / RK). Operated via `requirements.mjs`. |
| `uwf-review` | Shared review infrastructure: SQLite-backed findings DB, severity rules, verdict values, and fix-loop protocol. Loaded as a dependency by `uwf-reviewer`. |
| `uwf-reviewer` | Archetype-aware reviewer. Loaded by archetype-specific reviewer agents. Personas: `pm` (project-manager), `dev` (software-developer), `arch` (solutions-architect). Each persona activates a distinct criteria checklist, scope, output format, and escalation path. |
| `uwf-risk-planner` | Produces a project-level risk register (`{prefix}-risk-plan.md`) covering schedule, dependency, technical-debt, and external risks. Appends to `uwf-br` layer 1; flags blocking dependency risks in layer 2. |
| `uwf-snapshot` | Snapshot stage behavior: produces `uwf-drs` as a point-in-time reconstruction record; closes `uwf-br` layer 5; appends changelog closure entry. |
| `uwf-solutions_architect` | Solutions-architect persona. Governs the architecture-first workflow and defines the SDD schema, interface contract format, NFR format, and traceability matrix requirements. Loaded when `workflow=solutions_architect`. |
| `uwf-state-manager` | Authoritative source for reading and mutating workflow state (`tmp/uwf-state.json`) and managing phase lifecycle transitions. Operated via `state.mjs`. |
| `uwf-threat-model` | Generates STRIDE-style threat models with assets, trust boundaries, mitigations, and a verification checklist. Output: `tmp/workflow-artifacts/{prefix}-security-plan.md`. |
| `uwf-model-adaptation` | Resolves the model profile (`compact`\|`balanced`\|`reasoning`) once at orchestrator startup and emits a structured `steering_policy` injected into every stage invocation. Operated via `resolve.mjs`. |
| `uwf-traits` | Registry of structured behavior overlays (`project_manager`, `sw_dev`, `solutions_architect`, `forensic_analyst`). Traits are merged by the orchestration layer into a `behavior_policy` for new-style stages. |

> **Swapping skills:** The default tracking skill (`uwf-local-tracking`) uses a local SQLite database. To integrate with GitHub Issues, drop in an alternative skill that maps the same `issues.mjs` interface to the GitHub Issues API. No agent files change.

---

## Stage Capabilities, Traits, and Model Profiles

UWF introduces a three-layer architecture for structured stage behavior:

### 1. Stage Capability (`stage_type`)

A **stage capability** is a canonical, reusable stage contract defined independently of any workflow.
Currently one stage type is defined: `discovery`. The contract lives at:

```
.github/skills/uwf-orchestration-engine/stage-contracts/<stage_type>.yaml
```

Each contract declares the default behavior policy, the list of supported traits, and the default
agent to invoke.

### 2. Trait Overlay (`traits`)

A **trait** is a structured behavior overlay that customizes how a stage capability runs for a
specific persona perspective. Traits live at:

```
.github/skills/uwf-traits/traits/<trait_id>.yaml
```

Available traits: `project_manager`, `sw_dev`, `solutions_architect`, `forensic_analyst`.

When a stage lists multiple traits, the orchestration layer merges their `stage_policies` in order:
- `priority_order`, `must_address`, `risk_focus` → ordered union, first appearance wins
- `question_policy`, `evidence_threshold` → strictest wins

### 3. Model Adaptation Profile (`model_profile`)

A **model profile** is resolved once at orchestrator startup and injected as a `steering_policy`
into every stage invocation. Three profiles are defined:

| Profile | For | Instruction density | Schema reminders |
|---|---|---|---|
| `compact` | Smaller/instruction-following models | `expanded` | `exhaustive` |
| `balanced` | Mid-tier models (default) | `standard` | `standard` |
| `reasoning` | Large reasoning models | `compact` | `concise` |

Resolve explicitly: `node .github/skills/uwf-model-adaptation/resolve.mjs detect --profile <name>`
or let the orchestrator auto-detect via `--model <model_name>`. Unknown inputs fall back to `balanced`.

### Discovery Stage Pilot

The `discovery` stage in both `project_manager` and `sw_dev` has been migrated to the new
architecture. Each uses `stage_type: discovery` with the appropriate trait:

```yaml
- name: discovery
  stage_type: discovery
  traits: [project_manager]   # or [sw_dev]
  ...
```

The orchestrator resolves the full `behavior_policy` and `steering_policy` at list-stages time
and injects them into the `uwf-stage-discovery` and `uwf-stage-intake` invocation context. All other stages remain
unmodified legacy `agent:` stages.

### Stage Entry Rules

A stage entry in `stages.yaml` must use **exactly one** of:
- `agent: <subagent-id>` — legacy stage (no trait resolution)
- `stage_type: <type>` + `traits: [...]` — new-style stage (full resolution)

Using both on the same stage is a hard error; `--list-stages` will exit `1`.

---

## Entry Points (`.github/prompts`)

| Prompt | Workflow triggered | Use when |
| :--- | :--- | :--- |
| `uwf-start-project-planning.prompt.md` | `uwf-core-orchestrator` with `workflow=project_manager` | Starting a new product, feature, or architectural effort from scratch. |

Additional per-workflow prompts can be added following the same pattern — reference `uwf-core-orchestrator` and pass the desired `workflow` argument.

---

## Instructions (`.github/instructions`)

Always-on rules applied automatically across the workspace.

| File | Scope | Purpose |
| :--- | :--- | :--- |
| `uwf-core.instructions.md` | `**` | Core orchestration rules, stage gates, artifact expectations, and workflow discipline. |
| `docs-writing.instructions.md` | `docs/**/*.md` | Writing conventions: skimmability, explicit assumptions, executable examples with expected output. |
| `slides.instructions.md` | `slides/**` | Slide structure and build conventions for programmatically compiled presentations. |

---

## Artifact Locations

Artifact paths use a **prefix** that is persona-scoped: `issues-` for `sw_dev`, `project-` for `project_manager`, `design-` for `solutions_architect`, `forensic-` for `forensic-analyst`.

| Artifact | Path |
| :--- | :--- |
| Output templates (read-only) | `./docs/workflow-output-templates/` |
| Intake | `tmp/workflow-artifacts/{prefix}-intake.md` |
| Discovery | `tmp/workflow-artifacts/{prefix}-discovery.md` |
| Requirements | `tmp/workflow-artifacts/{prefix}-requirements.md` |
| Risk plan | `tmp/workflow-artifacts/{prefix}-risk-plan.md` |
| Security plan | `tmp/workflow-artifacts/{prefix}-security-plan.md` |
| Test plan | `tmp/workflow-artifacts/{prefix}-test-plan.md` |
| Blueprint summary | `tmp/workflow-artifacts/{prefix}-blueprint.md` |
| Build Record | `tmp/workflow-artifacts/{prefix}-br.json` |
| Work / implementation plan | `tmp/workflow-artifacts/{prefix}-plan.md` |
| Review output | `tmp/workflow-artifacts/{prefix}-review.md` |
| Acceptance results | `tmp/workflow-artifacts/{prefix}-acceptance.md` |
| Deterministic Reconstruction Spec | `tmp/workflow-artifacts/{prefix}-drs.json` |
| Retrospective | `tmp/workflow-artifacts/{prefix}-retro.md` |
| Architecture Decision Records | `./docs/adr/ADR-####-<slug>.md` |
| Issues backlog | `tmp/workflow-artifacts/issues-backlog.md` |
| Project roadmap | `tmp/workflow-artifacts/project-roadmap.md` |
| Changelog (append-only) | `tmp/workflow-artifacts/uwf-changelog.md` |
| Workflow state | `tmp/uwf-state.json` |

---

## Brownfield Projects

When the target is one or more **existing repositories** rather than a new project, run the **forensic analyst pre-phase** before Phase 1.

### Project Type Detection

| Condition | Project Type |
| :--- | :--- |
| No existing codebase | **Greenfield** — start at Phase 1 directly |
| One or more existing repos provided as input | **Brownfield** — run the forensic pre-phase first |
| New component added to an existing system | **Hybrid** — forensic pre-phase for existing components; greenfield treatment for the new component |

### When to Run the Pre-Phase

Activate `workflow=forensic-analyst` when:
- The user supplies existing repository paths or URLs at orchestrator intake.
- No formal requirements baseline, ADR set, or design documents exist for the existing codebase.

Do **not** run it when:
- The project is greenfield (no prior code).
- A confirmed requirements pack and ADR set already exist — promote those artifacts and start at Phase 1 directly.

### Brownfield Sequence

```
orchestrator intake
  └── [existing repos?]
        YES → workflow=forensic-analyst (pre-phase)
                repo-audit → artifact-harvest → intent-inference
                → confidence-score → gap-report → [human review]
                → forensic-br.json (provisional Build Record with confidence scores)
        NO  → Phase 1 directly
  → Phase 1 — Foundation (reads forensic-br.json if present)
  → Phase 2 — Archetype-specific execution
  → Phase 3 — Closure (refinement acts as confidence promotion gate on brownfield)
```

For the full workflow diagram and per-stage handoff contract see [`docs/brownfield-path.md`](docs/brownfield-path.md).

---

## UWF Companion — VS Code Extension

The `uwf-companion/` directory contains a VS Code extension that surfaces live data from the UWF SQLite skill databases directly inside the editor. As agents write to the databases the extension reflects changes in real time — giving a single-pane view of stages, issues, requirements, ADRs, discoveries, and review findings.

See [`uwf-companion/README.md`](uwf-companion/README.md) for setup, build, and usage instructions.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full guide covering:

- Adding a new workflow persona (with the `scaffold-skill.mjs` scaffolder)
- Adding a new stage agent
- Adding a new skill or tracking backend
- Script reference for `reset-all.mjs`, `scaffold-skill.mjs`, and all skill CLIs
- Pull request guidelines

**Architecture reference:** [`docs/uwf-architecture.md`](docs/uwf-architecture.md)
