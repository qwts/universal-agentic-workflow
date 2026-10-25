# Skill: uwf-orchestration-engine

## When to use
Load this skill at orchestrator startup. It governs **how** any persona-driven orchestrator operates — stage sequencing discipline, gate enforcement, retry logic, and the fix-loop. The **what** (stage list, gate definitions, subagent roster) comes from the persona skill loaded alongside it.

---

## Invocation Contract

> ### ⚠️ CRITICAL — Two separate mechanisms; never confuse them
>
> | Mechanism | What it is | How to invoke |
> |---|---|---|
> | **`runSubagent`** | A VS Code Copilot **tool call** that runs another agent | Use the tool-call infrastructure (same as `read_file`, `run_in_terminal`, etc.) — **never a shell command** |
> | **`run.mjs`** | A Node.js script for gate checks and stage listing | `node .github/skills/uwf-{workflow}/run.mjs --list-stages` or `--check-gate <stage>` |
>
> `run.mjs` has **no** `--run-stage`, `--execute`, or `--invoke` flag. Attempting to run a subagent via terminal is a hard violation. If you find yourself typing `node ... --run-stage`, stop — use the `runSubagent` tool call.

Every `runSubagent` call **must** embed the following context block inside the `prompt` string so subagents know their operating environment.

> **CRITICAL — tool call structure:** The `runSubagent` tool takes three separate parameters:
> - `agentName` (string) — the subagent to invoke, e.g. `"uwf-stage-intake"`
> - `description` (string) — a short 3-5 word task label, e.g. `"Run sw_dev intake stage"`
> - `prompt` (string) — **always a plain string**; the JSON context block below must be embedded *inside* this string
>
> ❌ **Wrong** — passing raw JSON as the entire prompt:
> ```
> prompt: '{"role":"project"}'
> ```
> This gives the subagent no instructions; it will fall back to listing stages instead of executing them.
>
> ✅ **Correct** — embedding the context block inside a descriptive prompt string:
> ```
> agentName: "uwf-stage-intake"
> description: "Run sw_dev intake stage"
> prompt: |
>   Run the intake stage for the sw_dev workflow.
>
>   Context:
>   {
>     "workflow":   "sw_dev",
>     "role":       "issues",
>     "phase":      "intake",
>     "outputPath": "./tmp/workflow-artifacts",
>     "statePath":  "./tmp/uwf-state.json"
>   }
>
>   <goal / issue description goes here>
> ```

The context fields the prompt string must always include:

```jsonc
{
  "workflow":   "<persona_name>",      // e.g. "project_manager", "sw_dev", "book_writer"
  "role":       "<role>",              // from the persona skill, e.g. "project" or "issues"
  "phase":      "<current_phase>",     // from uwf-state.json
  "outputPath": "./tmp/workflow-artifacts",
  "statePath":  "./tmp/uwf-state.json"
}
```

The `workflow` and `role` values are provided by the persona skill. The `phase` value is read from `uwf-state.json` via `node .github/skills/uwf-state-manager/state.mjs read` before every stage transition.

---

## Non-negotiable Principles

1. The orchestrator does **not** produce, edit, or delete any artifact file. Every artifact is produced by a subagent.
2. After **every** stage transition, call `node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-start --workflow <w> --stage <stageName>` to advance the phase and record the hand-off in the stage DB.
3. After **every** subagent completes, run the **Gate Check** for that stage (defined in the persona skill). If the gate fails, re-invoke the same subagent with the failure details — up to **2 retries**. If still failing after retries, halt and report the blocked gate to the user.
4. Do **not** skip stages. Conditional stages (ADR, Security, etc.) may be marked `PASS — not required` in the gate log but must be explicitly evaluated.
5. All user questions flow through the orchestrator via `vscode/askQuestions`. Subagents must return structured requests upward; the orchestrator relays them and passes responses back down.
6. **DO NOT yield back to the user between stages.** After a subagent returns and its gate passes, immediately invoke the next stage subagent. The orchestrator must run the full stage sequence to completion in a single turn. The only permitted user-visible output between stages is a one-line trace (e.g. `[Stage N] <stageName> → starting`). Never pause, ask for permission, summarize completed work, or wait for acknowledgement between stage transitions. Only stop when: a gate fails permanently after retries, a `vscode/askQuestions` call is needed, or the workflow is fully complete.

---

## FORBIDDEN Behaviors — Orchestrator

The following are **hard violations**. If you are about to do any of these, stop and correct course:

- ❌ **Narrating or simulating stage execution in text** without calling `runSubagent`. Writing "I invoked uwf-X" or a bullet list of what each stage did is not the same as calling the tool. If the tool was not called, the stage did not run.
- ❌ **Invoking subagents via terminal commands.** `runSubagent` is a tool call, not a shell command. Never use `node run.mjs --run-stage` or any terminal variant to attempt to run a subagent.
- ❌ **Inventing subagent names.** Only use agent names present in the persona skill's Subagent Roster and listed in the orchestrator's `agents:` frontmatter. Never fabricate names like `uwf-project_manager-initiate`.
- ❌ **Producing a completion summary** without having called `runSubagent` for every stage in the sequence.
- ❌ **Emitting `Current Stage/Phase:` / `Recommended Next Stage/Phase:` blocks.** Those are for subagents only. The orchestrator never emits them.
- ❌ **Using stage names not in the persona SKILL.md Stage Sequence table.** Read the table first; use only those exact stage names and subagent names.

---

## Startup Procedure

When the orchestrator is invoked:

1. Read and internalize **this skill** (`uwf-orchestration-engine`) to load engine behavior.
2. Read and internalize the **persona skill** at `.github/skills/uwf-{workflow}/SKILL.md` to load:
   - The `role` value for the invocation contract
   - The subagent roster
   - Persona-specific operating rules
3. **Resolve the model profile** (once; persisted for all stages):
   ```sh
   node .github/skills/uwf-model-adaptation/resolve.mjs detect [--profile <profile>] [--model <model_name>]
   ```
   Capture the JSON output (`profile`, `model_name`, `steering_policy`). Store to workflow state:
   ```sh
   node .github/skills/uwf-state-manager/state.mjs set-model-profile \
     --profile <profile> [--model <model_name>]
   ```
   Pass `--profile <profile>` to every subsequent `--list-stages` call via `--model-profile <profile>`.
4. **Run the stage-list script to obtain the authoritative stage sequence:**
   ```sh
   node .github/skills/uwf-{workflow}/run.mjs --list-stages [--model-profile <profile>]
   ```
   Parse the JSON output and record every stage name in order. **This script output is your sole authoritative stage list.** The SKILL.md Stage Sequence table is human-readable documentation only — it may be incomplete or stale. You MUST execute every stage returned by the script in order. Skipping, reordering, or substituting stages based on memory, summarization, or reading the table is a **hard violation**. Conditional stages (ADR, security, test-plan, etc.) are **never skipped** — their gate script auto-passes when not applicable, but you must still invoke the subagent for every stage the script returns.
5. Initialize state: `node .github/skills/uwf-state-manager/state.mjs init --workflow <workflow>`. Read the current phase to determine the resume point.
6. Begin executing every stage from the script-supplied list in order, starting from the current phase.

### New-style stage context injection

For any stage in the list that has `stage_type` set (new-style stage), embed the additional fields
in the `runSubagent` prompt context block:

```jsonc
{
  "workflow":        "<persona_name>",
  "role":            "<role>",
  "phase":           "<current_phase>",
  "outputPath":      "./tmp/workflow-artifacts",
  "statePath":       "./tmp/uwf-state.json",
  "stage_type":      "<stage_type>",
  "trait_ids":       ["<trait_id>", ...],
  "model_profile":   "<profile>",
  "behavior_policy": { /* from stage list output */ },
  "steering_policy": { /* from stage list output */ }
}
```

Legacy stages (`stage_type: null`) use the original context block without these additional fields.

---

## Per-Stage Execution Loop

This is the canonical loop the orchestrator runs for **every stage**. Read it once; apply it to all stages.

```
FOR EACH stage in the stage sequence:

  ┌─── PRE-FLIGHT ─────────────────────────────────────────────────────────┐
  │ 1. Resolve stage metadata                                               │
  │    node .github/skills/uwf-{workflow}/run.mjs --list-stages             │
  │    → record inputs[], outputs[], runAsSubagent for this stage           │
  │                                                                         │
  │ 2. Check for outstanding question dependencies                          │
  │    node .github/skills/uwf-question-protocol/questions.mjs \            │
  │         check --stage <stageName>                                       │
  │    → exit 1 (pending required questions)?                               │
  │      YES → ask user via vscode/askQuestions                             │
  │            answer each: questions.mjs answer --id <n> --answer "..."   │
  │            REPEAT from step 2 until gate passes (exit 0)               │
  │      NO  → continue                                                     │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─── INVOKE ─────────────────────────────────────────────────────────────┐
  │ IF runAsSubagent = true:                                                │
  │   3. Claim agent token                                                  │
  │      node .github/skills/uwf-state-manager/state.mjs \                 │
  │           set-agent --agent uwf-core-orchestrator                      │
  │      node .github/skills/uwf-orchestration-engine/stage-tracker.mjs \  │
  │           stage-start --workflow <w> --stage <stageName>               │
  │                                                                         │
  │   4. Emit progress trace (one line only):                               │
  │      [Stage N/Total] <stageName> → invoking <agentName>                │
  │                                                                         │
  │   5. Call runSubagent with resolved inputs/outputs in prompt:           │
  │      agentName: <agentName>                                             │
  │      prompt: "Run the <stageName> stage.\n\nContext:\n{ ... }\n\n      │
  │               inputs: [...]\noutputs: [...]"                            │
  │                                                                         │
  │ ELSE (runAsSubagent = false):                                           │
  │   4. Execute inline — do not use runSubagent                            │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─── POST-INVOKE ────────────────────────────────────────────────────────┐
  │ 6. Release agent token                                                  │
  │    node .github/skills/uwf-state-manager/state.mjs release-agent       │
  │                                                                         │
  │ 7. Did the subagent response contain QUESTIONS_NEEDED?                  │
  │    YES → log each question to SQLite and get IDs back:                  │
  │           questions.mjs log --stage <stageName> --group "..." \         │
  │                              --question "..." --required true/false     │
  │           → capture question_id for each                                │
  │           → ask user via vscode/askQuestions                            │
  │           → answer each: questions.mjs answer --id <n> --answer "..."  │
  │           → GOTO step 2 (re-check, then re-invoke with answered ctx)   │
  │    NO  → continue                                                       │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─── GATE ───────────────────────────────────────────────────────────────┐
  │ 8. Run gate check                                                       │
  │    node .github/skills/uwf-{workflow}/run.mjs --check-gate <stageName> │
  │    exit 0 → record stage-complete; advance to next stage               │
  │             stage-tracker.mjs stage-complete --workflow <w>            │
  │                               --stage <stageName>                      │
  │    exit 1 → apply Gate Failure Protocol (max 2 retries)               │
  │             stage-tracker.mjs stage-fail --workflow <w>               │
  │                               --stage <stageName>                      │
  └─────────────────────────────────────────────────────────────────────────┘
```

**The GOTO at step 7** means questions unblock the loop from the inside — the orchestrator never advances past a stage until both questions and the gate are fully satisfied. No half-answers, no partial outputs.

---

## Gate Enforcement

For every stage, after the designated subagent returns, run the persona's gate script (see **Script-Driven Gate Enforcement** below):

```sh
node .github/skills/uwf-<workflow>/run.mjs --check-gate <stageName>
```

- Exit `0` → log `GATE PASS: <stageName>` and advance to the next stage.
- Exit `1` → parse the JSON failure list from stdout and execute the Gate Failure Protocol below.

Do **not** evaluate gate conditions through reasoning or artifact inspection in the conversation loop — the script is the authoritative gate.

---

## Gate Failure Protocol

When a gate check fails:
1. Log which check(s) failed and the missing artifact path(s).
2. Re-invoke the responsible subagent with an explicit note: `"Gate failure: <artifact> missing or empty. Please produce it."`.
3. Re-check the gate after the subagent returns.
4. Allow up to **2 retries** per gate. After 2 failures, **halt** the sequence and report the blockage to the user with: gate name, missing artifacts, and the subagent's last response.

---

## Review Fix-Loop Protocol

When a reviewer subagent returns findings:
1. Parse the fix list. Group fixes by responsible subagent.
2. Re-invoke each responsible subagent with context: `"Review fix request: <fix description>"`.
3. After all fixes are applied, re-invoke the reviewer for re-review.
4. If clean → advance. If still dirty → repeat.
5. Allow a maximum of **3 total review cycles**. After 3 dirty cycles, halt and surface the remaining issues to the user.

---

## Operating Principles

- **Run the full stage sequence without stopping.** After each gate passes, immediately invoke the next subagent. Do not pause, summarize, or yield between stages.
- Emit a single-line progress trace before each `runSubagent` call (e.g. `[Stage 3/14] discovery → invoking uwf-stage-discovery`). This is the only output allowed mid-sequence.
- **Subagent hand-off blocks are internal signals, not stopping points.** When a subagent ends with `Current Stage/Phase:` / `Recommended Next Stage/Phase:`, consume that signal internally and immediately invoke the next stage. Never echo it to the user. Never treat it as a reason to pause or yield.
- The orchestrator itself **never** emits `Current Stage/Phase:` / `Recommended Next Stage/Phase:` blocks. Those blocks are for subagents only.
- Never start a dependent stage without its prerequisite artifacts confirmed present (per gate definitions).
- Do not invent facts; use `uwf-stage-discovery` to inspect the workspace when uncertain.
- On queue empty or workflow completion, summarize completion status and offer a retrospective via `uwf-core-retro` if appropriate.

---

## Script-Driven Gate Enforcement

Gate enforcement is implemented in a central, deterministic script — not in the orchestrator's reasoning loop and not duplicated per persona.

### Architecture

| File | Purpose |
|---|---|
| `.github/skills/uwf-orchestration-engine/stage-tracker.mjs` | **Central** stage tracking and gate evaluation CLI |
| `.github/skills/uwf-orchestration-engine/stage-schema.yaml` | SQLite table definitions for `stage_runs` and `stage_history` |
| `.github/skills/uwf-orchestration-engine/uwf-stages.db` | Shared SQLite DB (all workflows, one file; in `.gitignore`) |
| `.github/skills/uwf-{workflow}/stages.yaml` | **Per-persona** stage definitions (name, agent, gate conditions, retries) |
| `.github/skills/uwf-{workflow}/run.mjs` | Thin shim — translates legacy `--list-stages` / `--check-gate` flags to `stage-tracker.mjs` |

The orchestrator's call convention (`run.mjs --list-stages`, `run.mjs --check-gate <stage>`) is **unchanged**. The shims forward those calls transparently to `stage-tracker.mjs`.

### Orchestrator gate-check protocol

Before advancing past any stage, the orchestrator **must** run the gate check via terminal:

```sh
node .github/skills/uwf-<workflow>/run.mjs --check-gate <stageName> \
  --output-path ./tmp/workflow-artifacts \
  --state-path ./tmp/uwf-state.json
```

**Exit codes:**
| Code | Meaning |
|---|---|
| `0` | Gate passed — advance to next stage |
| `1` | Gate failed — stdout contains JSON `{ stage, passed, failures[] }` |
| `2` | Usage error (bad stage name / missing args) |

On exit code `1`, apply the Gate Failure Protocol (re-invoke responsible subagent with failure details, up to `maxRetries` times). Retrieve `maxRetries` and `onGateFailure` for any stage via:

```sh
node .github/skills/uwf-<workflow>/run.mjs --list-stages
```

### Stage execution tracking (optional but recommended)

The orchestrator may optionally record stage lifecycle events for observability:

```sh
# Mark stage active when subagent is invoked
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-start \
  --workflow <name> --stage <stageName>

# Mark stage passed after gate clears
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-complete \
  --workflow <name> --stage <stageName>

# Record a gate failure + increment retry count
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-fail \
  --workflow <name> --stage <stageName> [--note "<reason>"]

# Mark stage skipped
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs stage-skip \
  --workflow <name> --stage <stageName>

# Read full execution state for a workflow
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs read \
  --workflow <name>

# Reset tracking for a fresh run
node .github/skills/uwf-orchestration-engine/stage-tracker.mjs init \
  --workflow <name>
```

### Shared utilities (skill-runner.mjs)

`skill-runner.mjs` remains available for any JS that still needs direct helper functions:
- `requireNonEmptyFile(path, label)`
- `requireFileContains(path, needle, label)`
- `requireFilesWithPrefix(dir, prefix, label)`
- `requireFileMatchingPattern(baseDir, regex, label)`
- `gatePass(stageName)` / `gateFail(stageName, failures[])`
- `runCLI(stages)` — legacy CLI dispatcher (still valid for custom JS gates)

---

## Adding a New Workflow (for workflow authors)

Creating a new persona requires **only two files** in the new skill directory — no JS gate code needed:

1. **`stages.yaml`** — declares every stage with gate conditions (see format below).
2. **`run.mjs`** — a thin shim (copy from `uwf-sw_dev/run.mjs`, change the workflow name).
3. Create stage agent files: `.github/agents/uwf-{name}-{stage}.agent.md`.
4. Add all new stage agents to the `agents:` list in `uwf-core-orchestrator.agent.md`.
5. Bootstrap the orchestrator with `workflow={name}`.

### stages.yaml format

```yaml
workflow: <name>
artifact_prefix: <prefix>          # e.g. "issues" or "project"
output_path: ./tmp/workflow-artifacts

stages:
  - name: <stage-name>
    agent: <subagent-id>
    max_retries: 2                 # retries before gate failure escalates
    on_gate_failure: retry         # retry | abort | skip
    gated: true                    # false = always passes (best-effort stages)
    conditional: true              # optional; gate auto-passes if condition is false
    condition:                     # evaluated only when conditional: true
      type: file_contains          # file_contains | file_contains_any
      path: "{{output_path}}/..."
      text: "MARKER"
    gate:
      checks:                      # all checks must pass for gate to clear
        - type: require_non_empty
          path: "{{output_path}}/artifact.md"
          label: "artifact.md"
        - type: require_contains
          path: "{{output_path}}/artifact.md"
          text: "APPROVED"
          label: "artifact.md"
        - type: require_files_with_prefix
          dir: "{{cwd}}/docs/adr"
          prefix: "ADR-"
          label: "ADR-*.md"
        - type: require_file_matching_pattern
          dir: "{{cwd}}/tmp/state"
          pattern: "/open/.*\\.md$"
          label: "open issue files"
```

**Template variables** available in any `path` or `dir` value:

| Variable | Resolves to |
|---|---|
| `{{output_path}}` | `--output-path` flag value (default `./tmp/workflow-artifacts`) |
| `{{state_path}}` | `--state-path` flag value (default `./tmp/uwf-state.json`) |
| `{{cwd}}` | `process.cwd()` at runtime |

### Required sections in a persona SKILL.md

| Section | Content |
|---|---|
| `mode` | The string passed as `mode` in the invocation contract |
| `Stage Sequence` | Ordered table: `# \| Stage \| Subagent \| Purpose` — gate logic lives in `stages.yaml` |
| `Subagent Roster` | List of all subagent names this persona uses |
| `Artifact Prefix` | The filename prefix for all generated artifacts |

## Data directory

Databases resolve in this order: `--db-path <file>`, then `--data-dir <dir>`, then the `UWF_DATA_DIR` environment variable, then the skill's own folder. The data directory is created if it does not exist.
