---
name: uwf-adr
description: "Create and manage Architecture Decision Records using a 300-point checklist (security/ops/compliance/testability included). ADRs are persisted in SQLite with CRUD support."
---
# UWF ADR Skill

## Overview

ADR metadata is stored in a SQLite database:

```
.github/skills/uwf-adr/uwf-adrs.db
```

The database schema is defined by `adr-schema.yaml` in the same directory. Markdown files are scaffolded from `templates/adr.template.md` and written to `docs/adr/` by default.

> **Note:** `uwf-adrs.db` is in `.gitignore` and should not be committed. The markdown files in `docs/adr/` are committed.

## When to use
Use when a decision materially impacts security, cost, reliability, maintainability, or long-term architecture.

**All ADR operations MUST be performed by running the deterministic script:**
```
node .github/skills/uwf-adr/adrs.mjs <command> [options]
```
Agents must never write to the database directly. Call the script via terminal and parse the JSON output.

---

## Script reference

| Command | Purpose |
|---|---|
| `create --title <text> --decision <text> [--impact low\|medium\|high] [--stage <s>] [--output-path <path>]` | Register a new ADR; scaffolds `docs/adr/ADR-####-<slug>.md`; returns the assigned `number` and `id` |
| `update --id <n> [field flags…]` | Update fields on an existing ADR |
| `get --id <n>` | Get a single ADR record |
| `list [--status <s>] [--impact <s>]` | List ADRs with optional filters |
| `supersede --id <n> --by <n>` | Mark ADR as superseded by another (by DB `id`) |
| `deprecate --id <n>` | Mark an ADR as deprecated |

**Update field flags:** `--title`, `--status`, `--impact`, `--stage`, `--decision`, `--file-path`, `--superseded-by`

All output is JSON. Exit code `0` = success, `1` = operational error, `2` = usage error.

### Example invocations

```sh
# Create a new ADR — scaffolds docs/adr/ADR-0001-use-sqlite-for-state.md
node .github/skills/uwf-adr/adrs.mjs create \
  --title "Use SQLite for state management" \
  --decision "Store all workflow and issue state in SQLite via better-sqlite3" \
  --impact high \
  --stage planning

# List all accepted ADRs
node .github/skills/uwf-adr/adrs.mjs list --status accepted

# Accept an ADR
node .github/skills/uwf-adr/adrs.mjs update --id 1 --status accepted

# Supersede ADR 1 with ADR 2
node .github/skills/uwf-adr/adrs.mjs supersede --id 1 --by 2

# Deprecate an ADR
node .github/skills/uwf-adr/adrs.mjs deprecate --id 3
```

---

## ADR procedure

1. **Create the ADR** via `adrs.mjs create` — captures metadata in the DB and scaffolds the markdown file.
2. **Fill in the template** — edit `docs/adr/ADR-####-<slug>.md`:
   - Context, Decision, Alternatives, Consequences, Verification
   - Appendix A — ADR-300 checklist (see below)
3. **Update status** via `adrs.mjs update --id <n> --status accepted` once reviewed.
4. **Supersede/deprecate** stale ADRs as architecture evolves.

## Template
See: `templates/adr.template.md`

The template includes:
- Context, Decision, Alternatives considered, Consequences
- Security / Privacy / Compliance notes
- Verification
- **Appendix A — ADR-300 Checklist** (up to ~300 considerations grouped by domain)

### Checklist domains
Product/UX · Data · APIs · AuthN/AuthZ · Secrets · Dependencies/Supply chain ·
Observability · Performance · Reliability · Cost · Compliance/Privacy · Operations ·
Testing · Migration/Rollback · Incident response · Maintenance

- Use checkboxes (`[ ]`).
- Mark non-applicable items explicitly as `N/A`.
- Deep-dive where impact is `high`; keep checklist items brief for `low`/`medium`.

---

## Schema reference

### adrs

Defined by `adr-schema.yaml`.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment row ID |
| `number` | TEXT | Zero-padded ADR number (e.g. `0003`) |
| `slug` | TEXT | Kebab-case title slug |
| `title` | TEXT | Full decision title |
| `status` | TEXT | `proposed` \| `accepted` \| `deprecated` \| `superseded` |
| `impact` | TEXT | `low` \| `medium` \| `high` |
| `stage` | TEXT | Workflow stage this decision belongs to (optional) |
| `decision` | TEXT | One-line decision summary |
| `file_path` | TEXT | Relative path to the markdown file |
| `superseded_by` | TEXT | ADR number of the superseding decision |
| `created_at` | TEXT | ISO-8601 timestamp |
| `updated_at` | TEXT | ISO-8601 timestamp |

### Status lifecycle

```
proposed → accepted
proposed → deprecated
accepted → superseded (by a newer ADR)
accepted → deprecated
```

---

## Error conditions

| Condition | Response |
|---|---|
| DB missing | Auto-created on first run via `adr-schema.yaml` |
| `--impact` not in allowed set | Reject with validation error |
| ADR `id` not found | Return not-found error |
| Superseding ADR `id` not found | Return not-found error |
| No update fields provided | Return usage error |
