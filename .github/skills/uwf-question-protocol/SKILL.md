---
name: uwf-question-protocol
description: "Canonical protocol for subagents to request user input and for orchestrators to handle those requests. Questions are persisted in SQLite with a numeric ID so they can be stored as stage dependencies."
---

# Skill: uwf-question-protocol

## Purpose
This skill defines the standard protocol for subagents to request missing information from the user via the orchestrator, and for orchestrators to handle those requests using the `vscode/askQuestions` tool.

Questions are persisted in a SQLite database (`uwf-questions.db`) via `questions.mjs`. Each logged question receives a numeric ID that the orchestrator stores in workflow state as a dependency. A stage gate will not pass until all required questions for that stage are answered.

### Database and schema

```
.github/skills/uwf-question-protocol/uwf-questions.db   ← gitignored
.github/skills/uwf-question-protocol/questions-schema.yaml
```

### `questions.mjs` command reference

| Command | Purpose |
|---|---|
| `log --stage <s> --question <text> [--group <g>] [--proposed <text>] [--required true\|false]` | Log a question; returns `question_id` |
| `answer --id <n> --answer <text>` | Record user's answer; sets `status → answered` |
| `skip --id <n>` | Mark a question skipped (unblocks gate without an answer) |
| `list [--stage <s>] [--status <s>]` | List questions with optional filters |
| `check --stage <s> [--ids <n,n,…>]` | Gate check — exit `0` if all required questions are satisfied, exit `1` if any are pending |
| `clear --stage <s>` | Delete all questions for a stage (reset for re-runs) |

All output is JSON. Exit `0` = success/gate-pass, `1` = gate-fail/operational error, `2` = usage error.

---

## When Subagents Need User Input

If you cannot infer required information from available context (input prompt, existing artifacts, workspace files), you MUST NOT fill in placeholder values like `...`, `[TBD]`, or `[TODO]`. Instead, return questions to the orchestrator using this format.

### Response Format

End your response with:

```
QUESTIONS_NEEDED

[Question Group Name]
Q: <question text>
Proposed: <your best guess or inference>
Required: <true|false>

[Next Question Group Name]
Q: <question text>
Proposed: <default/inferred value>
Required: <true|false>
```

### Example

```
QUESTIONS_NEEDED

[Goal]
Q: What is the primary goal of this project?
Proposed: Build a blog platform
Required: true

[Constraints]
Q: Are there any technical constraints (language, framework, budget, timeline)?
Proposed: None specified
Required: false

[Success metrics]
Q: How will you measure success for this project?
Proposed: Ability to publish and view posts
Required: true

[Risk tolerance]
Q: What is the acceptable risk level for this project (low/medium/high)?
Proposed: medium
Required: false
```

### Rules for Subagents

1. **Infer what you can** — Extract any information clearly stated in the user's input. Only ask about what's truly missing.

2. **Propose reasonable defaults** — Use domain knowledge to suggest sensible answers. This helps users confirm quickly.

3. **Mark criticality** — Set `Required: true` for information that blocks your work, `false` for nice-to-haves.

4. **Don't ask everything** — If you can make a reasonable assumption with low risk, document it as `[assumption: reasoning]` in your output instead of asking.

5. **Group related questions** — Use descriptive group names that match your output section names when possible.

---

## Orchestrator Handling

When a subagent response contains `QUESTIONS_NEEDED`:

### 1. Parse the Question Block

Extract questions from the structured format:
- Group name (e.g., `[Goal]`, `[Constraints]`)
- Question text (line starting with `Q:`)
- Proposed answer (line starting with `Proposed:`)
- Required flag (line starting with `Required:`)

### 2. Log Each Question to the DB

For every parsed question, call `questions.mjs log` and capture the returned `question_id`:

```sh
node .github/skills/uwf-question-protocol/questions.mjs log \
  --stage intake \
  --group "Goal" \
  --question "What is the primary goal of this project?" \
  --proposed "Build a blog platform" \
  --required true
# → { "ok": true, "question_id": 7, ... }
```

Collect all returned IDs (e.g. `7,8,9`) and store them in workflow state using `uwf-state-manager`:

```sh
node .github/skills/uwf-state-manager/state.mjs note \
  --agent uwf-core-orchestrator \
  --note "pending_question_ids=7,8,9"
```

### 3. Call `vscode/askQuestions` Tool

Transform parsed questions into the tool format:

```javascript
{
  "questions": [
    {
      "header": "Goal",
      "question": "What is the primary goal of this project?",
      "options": [],
      "allowFreeformInput": true
    },
    {
      "header": "Risk",
      "question": "What is the acceptable risk level for this project?",
      "options": [
        {"label": "low", "description": "Minimize all risks"},
        {"label": "medium", "description": "Balance risk and innovation", "recommended": true},
        {"label": "high", "description": "Accept risk for speed"}
      ]
    }
  ]
}
```

**Guidelines:**
- Show proposed answers as context in the question text or as a recommended option
- Use free-text input for open-ended questions
- Use options for constrained choices (but include "Other" automatically)
- Batch all questions in a single call

### 4. Record Answers

For each answer received, call `questions.mjs answer`:

```sh
node .github/skills/uwf-question-protocol/questions.mjs answer --id 7 --answer "Create a monitoring dashboard"
node .github/skills/uwf-question-protocol/questions.mjs answer --id 8 --answer "React, deploy to Azure"
```

### 5. Gate Check Before Advancing

Before advancing to the next stage, run the gate check. This will exit `1` if any required questions are still pending:

```sh
# Check all required questions for a stage
node .github/skills/uwf-question-protocol/questions.mjs check --stage intake

# Or scope to specific IDs stored in state
node .github/skills/uwf-question-protocol/questions.mjs check --stage intake --ids 7,8,9
```

Only proceed to re-invoke the subagent once the gate passes (exit `0`).

### 6. Re-invoke the Subagent

After the gate passes, call the same subagent again with enhanced context:

```json
{
  ...originalContext,
  "answered": {
    "Goal": "Create a monitoring dashboard for server health",
    "Constraints": "Must use React, deploy to Azure, complete in 2 weeks",
    "Success metrics": "Dashboard shows real-time metrics for 100+ servers",
    "Risk tolerance": "medium"
  }
}
```

### 7. Continue Workflow

- The subagent should now produce complete output
- Run the stage gate check as normal
- If gate fails due to missing content, apply standard retry logic
- Do NOT advance to the next stage until the current stage's gate passes

---

## Subagent Re-entry Behavior

When re-invoked with an `answered` field in your context:

1. **Use provided answers** — For each section, use the value from `answered[section]` if present

2. **Fall back to proposed values** — For optional questions that weren't answered, use your proposed default

3. **Complete your work** — Produce the full artifact with all required sections populated

4. **No more questions** — Do not return `QUESTIONS_NEEDED` again for the same information. If critical data is still missing, document assumptions and note them as risks.

---

## Benefits

- **Consistency** — All workflows use the same question format
- **Traceability** — Questions are logged in conversation history
- **User control** — Users can see and approve inferences before they're baked into artifacts
- **No placeholders** — Artifacts never contain `...` or `[TBD]` values that would fail gates or confuse downstream stages

---

## Anti-patterns to Avoid

❌ **Creating empty templates** — Never output `Goal: ...` or `Constraints: [TBD]`

❌ **Guessing blindly** — Don't make up project details without user input

❌ **Asking redundant questions** — If the user said "build a blog," don't ask "what should I build?"

❌ **Blocking on minor details** — Use assumptions for low-impact details, questions for critical ones

❌ **One question at a time** — Batch all questions to avoid multi-turn back-and-forth
