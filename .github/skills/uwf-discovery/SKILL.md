---
name: uwf-discovery
description: "Inspect the workspace, log findings to SQLite, clarify unknowns, and update intake. No implementation."
user-invokable: true
---

# UWF Discovery Skill

Findings go to a SQLite database (`.github/skills/uwf-discovery/uwf-discoveries.db`, gitignored, schema in `discovery-schema.yaml`). Agents never write to it directly; use the script and parse its JSON output:

```
node .github/skills/uwf-discovery/discoveries.mjs <command> [options]
```

| Command | Purpose |
|---|---|
| `log --role <r> --title <text> [--category <c>] [--description <text>] [--evidence <text>] [--impact low\|medium\|high] [--stage <s>]` | Log a finding; returns `discovery_id` |
| `update --id <n> [field flags]` | Update fields (`--role --stage --category --title --description --evidence --impact --status`) |
| `get --id <n>` / `list [--role --category --status --impact]` | Read records |
| `gaps [--role <r>]` | Open gaps, sorted by impact |
| `close --id <n>` | Mark `addressed` |

Categories: `workspace_structure` `dependency` `code_pattern` `gap` `unknown` `recommendation`. Statuses: `open` `addressed` `deferred` `wontfix`. Exit code 0 = ok, 1 = operational error, 2 = usage error. The database path resolves from `--db-path`, `--data-dir`, `UWF_DATA_DIR`, then the skill folder.

Example: `node .github/skills/uwf-discovery/discoveries.mjs log --role issues --category gap --title "No test suite found" --evidence "file_search **/test* returned 0 results" --impact high --stage discovery`

## Anti-hallucination rules

- Every claim must come from a tool result; every `--evidence` value cites the exact path or tool output.
- No inference, no generic findings, no boilerplate. Skip a category with nothing evidenced.
- Fewer than 5 distinct tool invocations before writing the document is a hard gate failure.

## Inspection sequence (all steps before writing)

1. **Structure**: `list_dir` the root and the directories relevant to the intake goal. Log as `workspace_structure`.
2. **Dependencies and tooling**: find and read package/build/CI/config files (`package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, `Makefile`, `Dockerfile`, `.github/workflows/*`, `tsconfig.json`). Log as `dependency`.
3. **Source and patterns**: key entry points, architectural patterns, test files. Log as `code_pattern`.
4. **Intake cross-reference**: for each goal, constraint and success metric, log what the workspace already covers (`workspace_structure`, `status=addressed`), what is missing (`gap`), and contradictions.
5. **Gaps and unknowns**: log each absent requirement as `gap` and each unresolved question as `unknown`, with `--evidence` stating what was searched and why it was inconclusive.

Greenfield workspace: still log what exists (`workspace_structure`), what the intake needs that does not exist (`gap`), and relevant scaffolding (`recommendation`).

## Procedure

1. Run the inspection sequence, logging findings as you go.
2. Write `{outputPath}/{role}-discovery.md` from the database (`list`, `gaps`).
3. Update `{outputPath}/{role}-intake.md` where discovery changed scope or constraints; mark with `<!-- updated by discovery -->`.
4. Recommend next stages only from logged findings, citing the `discovery_id`.

## Output document

Concise: under 120 lines, one line per finding, no restating of the intake. Sections:

- **Current state summary**: each item cites a path or tool result.
- **Constraints and assumptions**: evidenced constraints only; label assumptions and why each cannot be verified yet.
- **Gaps**: from `gaps --role {role}`, each with evidence.
- **Unknowns and open questions**: each with what was searched and why it was inconclusive.
- **Recommended artifacts**: each cites its `discovery_id`.
