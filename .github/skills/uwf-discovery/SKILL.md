---
name: uwf-discovery
description: "Inspect the workspace, log findings to SQLite, clarify unknowns, and update intake. No implementation."
user-invokable: true
---

# UWF Discovery Skill

## Overview

Discovery findings are stored in a SQLite database:

```
.github/skills/uwf-discovery/uwf-discoveries.db
```

The schema is defined by `discovery-schema.yaml` in the same directory.

> **Note:** `uwf-discoveries.db` is in `.gitignore` and must not be committed. The discovery markdown artifact in `tmp/workflow-artifacts/` is committed.

**All discovery operations MUST use the deterministic script:**
```
node .github/skills/uwf-discovery/discoveries.mjs <command> [options]
```
Agents must never write to the database directly. Call the script via terminal and parse the JSON output.

---

## Script reference

| Command | Purpose |
|---|---|
| `log --role <r> --title <text> [--category <c>] [--description <text>] [--evidence <text>] [--impact low\|medium\|high] [--stage <s>]` | Log a new finding; returns `discovery_id` |
| `update --id <n> [field flags…]` | Update fields on an existing discovery |
| `get --id <n>` | Get a single discovery record |
| `list [--role <r>] [--category <c>] [--status <s>] [--impact <i>]` | List with optional filters |
| `gaps [--role <r>]` | Shorthand: list `category=gap, status=open`, sorted by impact |
| `close --id <n>` | Mark a discovery as `addressed` |

**Update field flags:** `--role`, `--stage`, `--category`, `--title`, `--description`, `--evidence`, `--impact`, `--status`

**Valid categories:** `workspace_structure` · `dependency` · `code_pattern` · `gap` · `unknown` · `recommendation`

**Valid statuses:** `open` · `addressed` · `deferred` · `wontfix`

All output is JSON. Exit code `0` = success, `1` = operational error, `2` = usage error.

### Example invocations

```sh
# Log a gap
node .github/skills/uwf-discovery/discoveries.mjs log \
  --role issues \
  --category gap \
  --title "No test suite found" \
  --description "Searched for **/test*, **/*spec* — zero results" \
  --evidence "file_search **/test* returned 0 results" \
  --impact high \
  --stage discovery

# Log an unknown
node .github/skills/uwf-discovery/discoveries.mjs log \
  --role issues \
  --category unknown \
  --title "Database migration strategy unclear" \
  --evidence "No migration files found; schema.sql references versioning but no tooling present"

# List all open gaps
node .github/skills/uwf-discovery/discoveries.mjs gaps --role issues

# Close a discovery
node .github/skills/uwf-discovery/discoveries.mjs close --id 3
```

---

## ⛔ Anti-Hallucination Rules — Non-negotiable

> **Every factual claim logged or written MUST be backed by a specific tool call result.**

- Use `list_dir`, `grep_search`, `read_file`, `file_search`, and/or `run_in_terminal` to inspect the workspace **before** logging any finding.
- Every `--evidence` value must cite the **exact path or tool output** that proves the claim.
- Do NOT infer, assume, or speculate about workspace contents.
- Do NOT log generic findings that could apply to any project. Every entry must reference something specific found in this workspace.
- Do NOT pad categories with boilerplate. If a category has nothing evidence-based to say, skip it.
- **Violation:** Producing a discovery document without at least 5 distinct tool invocations is a hard gate failure.

---

## Mandatory Inspection Sequence

Perform ALL steps before writing the output document or logging findings.

### Step 1 — Workspace Structure Scan
Run `list_dir` on the workspace root. Recursively inspect any directories relevant to the intake goal (`src/`, `lib/`, `docs/`, `config/`, etc.). Log findings with `category=workspace_structure`.

### Step 2 — Dependency and Tooling Inventory
Search for configuration and dependency files:
- `**/package.json`, `**/requirements.txt`, `**/Cargo.toml`, `**/go.mod`, `**/Gemfile`, `**/pom.xml`, `**/*.csproj`
- `**/.eslintrc*`, `**/tsconfig.json`, `**/Makefile`, `**/Dockerfile`, `**/docker-compose*`
- `**/.github/workflows/*`, `**/.gitlab-ci*`, `**/Jenkinsfile`
- `**/.env*`, `**/*.config.*`, `**/webpack*`, `**/vite*`, `**/rollup*`

Read each file found and log relevant details with `category=dependency`.

### Step 3 — Existing Source Code and Patterns
If source code exists:
- Count files by type
- Read key entry points
- Identify architectural patterns from actual code
- Search for test files (`**/*test*`, `**/*spec*`, `**/__tests__/*`)

Log patterns with `category=code_pattern`.

### Step 4 — Intake Cross-Reference
Read the intake artifact and for every goal, constraint, and success metric:
- Determine what the workspace already contains that addresses it (log as `category=workspace_structure`, `status=addressed`)
- Determine what is missing (log as `category=gap`)
- Note contradictions between intake requirements and workspace state

### Step 5 — Gap and Unknown Analysis
After Steps 1–4, log every gap and unresolved unknown:
- **Gap:** something required by the intake that is absent — `category=gap`
- **Unknown:** something that tool-driven inspection could not resolve — `category=unknown`
- Each entry must include `--evidence` explaining what was searched and why it was inconclusive

---

## Empty or Greenfield State

If the workspace has no application source code, this is NOT an excuse to produce generic content:
1. Log exactly what IS in the workspace (scripts, configs, templates, docs) as `category=workspace_structure`
2. Log what the intake requires that does not yet exist as `category=gap`
3. Identify any scaffolding relevant to the intake goal as `category=recommendation`

---

## Discovery procedure

1. Run the **Mandatory Inspection Sequence** (Steps 1–5 above).
2. **Log every finding** via `discoveries.mjs log` as you go — do not batch at the end.
3. **Write the output document** `{outputPath}/{role}-discovery.md` using the sections below, drawing content from the DB (`list`, `gaps`).
4. **Update the intake** `{outputPath}/{role}-intake.md` — amend any section where discovery changed scope or revealed new constraints. Mark with `<!-- updated by discovery -->`.
5. **Recommend next stages** based only on what was logged — cite the `discovery_id` for each recommendation.

---

## Output document structure

`{outputPath}/{role}-discovery.md` must contain:

- **Current state summary** — every item cites a specific path or tool result (draw from `category=workspace_structure` and `category=code_pattern`)
- **Constraints and assumptions** — only constraints evidenced by the workspace or intake; label assumptions and explain why each cannot yet be verified
- **Gaps** — drawn from `discoveries.mjs gaps --role {role}`; each entry must include evidence
- **Unknowns and open questions** — drawn from `category=unknown`; each must explain what was searched and why it was inconclusive
- **Recommended artifacts** — drawn from `category=recommendation`; each must cite the `discovery_id` that motivates it

---

## Schema reference

### discoveries

Defined by `discovery-schema.yaml`.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment row ID; used as `discovery_id` in state dependencies |
| `role` | TEXT | Workflow role artifact prefix (e.g. `issues`, `project`) |
| `stage` | TEXT | Stage this was discovered in (optional) |
| `category` | TEXT | `workspace_structure` · `dependency` · `code_pattern` · `gap` · `unknown` · `recommendation` |
| `title` | TEXT | Short title |
| `description` | TEXT | Full description |
| `evidence` | TEXT | Tool call / path that proves the claim |
| `impact` | TEXT | `low` · `medium` · `high` |
| `status` | TEXT | `open` · `addressed` · `deferred` · `wontfix` |
| `created_at` | TEXT | ISO-8601 timestamp |
| `updated_at` | TEXT | ISO-8601 timestamp |

---

## Error conditions

| Condition | Response |
|---|---|
| DB missing | Auto-created on first run via `discovery-schema.yaml` |
| `--category` not in allowed set | Reject with validation error |
| `--impact` not in allowed set | Reject with validation error |
| `--status` not in allowed set | Reject with validation error |
| Discovery `id` not found | Return not-found error |
| No update fields provided | Return usage error |
