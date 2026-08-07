---
name: uwf-review
description: "Shared review infrastructure: SQLite-backed findings, script commands, fix-loop gate support. Loaded as a dependency by uwf-reviewer; do not load directly in new agents."
deprecated: true
superseded_by: uwf-reviewer
---

> **Deprecated — shared infrastructure only.**
> Archetype-specific reviewer agents must load `.github/skills/uwf-reviewer/SKILL.md`
> (with `Persona: pm` or `Persona: dev`) and reference this file only for the
> shared script commands, DB schema, and fix-loop protocol documented below.
> Do not load this file as a standalone reviewer skill in new agents.

# UWF Review Skill

## Overview

Review runs and findings are stored in a SQLite database:

```
.github/skills/uwf-review/uwf-reviews.db
```

The schema is defined by `review-schema.yaml` in the same directory. Two tables:
- **`reviews`** — one record per review run (stage, verdict, notes)
- **`findings`** — one record per issue found, linked to a `review_id`

> **Note:** `uwf-reviews.db` is in `.gitignore` and must not be committed.

**All review operations MUST use the deterministic script:**
```
node .github/skills/uwf-review/reviews.mjs <command> [options]
```

---

## Script reference

| Command | Purpose |
|---|---|
| `start --role <r> --stage <s> [--notes <text>]` | Open a new review run; returns `review_id` |
| `finding --review-id <n> --description <text> [--severity critical\|major\|minor] [--file-path <path>]` | Add a finding; returns `finding_id` |
| `verdict --review-id <n> --verdict approved\|changes_requested\|rejected [--notes <text>]` | Set final verdict |
| `get --review-id <n>` | Get a review with all its findings |
| `list [--role <r>] [--stage <s>] [--verdict <v>]` | List review runs |
| `list-findings --review-id <n> [--severity <s>] [--status <s>]` | List findings; **exits `1` if any open `critical`/`major` findings exist** (gate check) |
| `close-finding --id <n>` | Mark a finding as `fixed` |
| `reopen --id <n>` | Reopen a finding (fix was incomplete) |

**Valid severities:** `critical` · `major` · `minor`

**Valid verdicts:** `approved` · `changes_requested` · `rejected` · `pending`

**Valid finding statuses:** `open` · `fixed` · `wontfix`

All output is JSON. Exit code `0` = success/gate-pass, `1` = error/gate-fail, `2` = usage error.

### Example invocations

```sh
# Open a review
node .github/skills/uwf-review/reviews.mjs start \
  --role issues --stage review

# Log findings
node .github/skills/uwf-review/reviews.mjs finding \
  --review-id 1 \
  --severity critical \
  --file-path src/auth.ts \
  --description "JWT secret read from env without fallback — crashes if unset"

node .github/skills/uwf-review/reviews.mjs finding \
  --review-id 1 --severity minor \
  --description "Missing JSDoc on public API methods"

# Gate check — exits 1 if open critical/major findings remain
node .github/skills/uwf-review/reviews.mjs list-findings \
  --review-id 1 --status open

# After fixes are applied
node .github/skills/uwf-review/reviews.mjs close-finding --id 1

# Set verdict
node .github/skills/uwf-review/reviews.mjs verdict \
  --review-id 1 --verdict approved
```

---

## Review procedure

### Reviewer role (read-only)
The reviewer agent is **read-only**. It MUST NOT use `edit` or `execute` tools. It reads artifacts and logs findings — it never writes fixes or prescribes implementation details.

1. **Open a review run** via `reviews.mjs start --role {role} --stage {stage}`.
2. **Read artifacts** in `{outputPath}/` and cross-reference against expected outputs for the stage (from `stages.yaml`).
3. For each artifact, evaluate:
   - Completeness and internal consistency
   - Satisfaction of acceptance criteria
   - Security, compliance, or quality gaps
4. **Log every finding** via `reviews.mjs finding` — one record per issue. Use `--file-path` where applicable.
5. **Set verdict** via `reviews.mjs verdict`:
   - `approved` — no open `critical` or `major` findings → recommend Acceptance stage
   - `changes_requested` — one or more `critical`/`major` findings → return to implementer with finding IDs only (no fix instructions)
   - `rejected` — fundamental scope/approach problem → escalate to orchestrator
6. **Write the output file** (e.g. `{outputPath}/{prefix}-review.md`) with a summary rendered from the DB. The file MUST contain the line:
   ```
   verdict: approved
   ```
   (or `verdict: changes_requested` / `verdict: rejected` as applicable). This is the stage gate artifact.

### Severity guide

| Severity | When to use |
|---|---|
| `critical` | Correctness bug, security vulnerability, data loss risk, missing required artifact |
| `major` | Significant gap that blocks acceptance (missing section, broken logic, untested path) |
| `minor` | Polish, style, or non-blocking improvement |

### Fix loop
When verdict is `changes_requested`:
1. Orchestrator returns to the implementer stage with the finding list (`list-findings --review-id <n> --status open`).
2. Implementer addresses findings and calls `close-finding` for each fix applied.
3. Orchestrator re-invokes the reviewer for the same `review_id` (or starts a new run).
4. Gate check: `list-findings --review-id <n> --status open` — exits `0` only when no open `critical`/`major` findings remain.

### Gate check
The stage gate checks for `verdict: approved` in the output markdown file (e.g. `{prefix}-review.md`). The reviewer MUST write this line. The orchestrator does NOT call `list-findings` as the primary gate — the file check is authoritative.

---

## Hard constraints — never violate

- **Do NOT use `edit` or `execute` tools.** Read files only.
- **Do NOT prescribe implementation details.** Never write sentences like "create X with Y" or "add section A to file B." Report the gap only.
- **Do NOT invent content** for missing files. Only report that a file is absent and why it is expected.
- Scope is limited to the stage named in the review run. Do not review artifacts from other stages unless they are declared `inputs` for this stage in `stages.yaml`.

---

## Schema reference

### reviews

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment review run ID |
| `role` | TEXT | Workflow role (e.g. `issues`, `project`) |
| `stage` | TEXT | Stage being reviewed |
| `verdict` | TEXT | `pending` · `approved` · `changes_requested` · `rejected` |
| `notes` | TEXT | Overall review summary notes |
| `created_at` | TEXT | ISO-8601 timestamp |
| `updated_at` | TEXT | ISO-8601 timestamp |

### findings

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment finding ID |
| `review_id` | INTEGER | FK → `reviews.id` |
| `severity` | TEXT | `critical` · `major` · `minor` |
| `status` | TEXT | `open` · `fixed` · `wontfix` |
| `file_path` | TEXT | Affected file path (optional) |
| `description` | TEXT | Observation — what is wrong, not how to fix it |
| `created_at` | TEXT | ISO-8601 timestamp |
| `updated_at` | TEXT | ISO-8601 timestamp |

---

## Error conditions

| Condition | Response |
|---|---|
| DB missing | Auto-created on first run via `review-schema.yaml` |
| `--severity` not in allowed set | Reject with validation error |
| `--verdict` not in allowed set | Reject with validation error |
| Review `id` not found | Return not-found error |
| Finding `id` not found | Return not-found error |
