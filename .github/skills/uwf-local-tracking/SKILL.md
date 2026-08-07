---
name: uwf-local-tracking
description: "SQLite-backed issue management. All operations go through issues.mjs."
---
# UWF Local Tracking Skill

All issue management is backed by SQLite. No files are written to `tmp/` by this skill.

**Database:** `.github/skills/uwf-local-tracking/uwf-issues.db` (gitignored)

**Schema:** `issues-schema.yaml` in this directory

**Script:** `node .github/skills/uwf-local-tracking/issues.mjs <command> [flags]`

---

## Commands

| Command | Purpose |
|---|---|
| `create --id <id> --title <text> [fields…]` | Create a new issue |
| `update --id <id> [fields…]` | Update fields on an existing issue |
| `list [--status <s>] [--milestone <m>] [--sprint <s>]` | List issues with optional filters |
| `activate --id <id>` | Set status → `active` |
| `close --id <id>` | Set status → `closed` |
| `skip --id <id> [--reason <text>]` | Set status → `skipped` |
| `next [--milestone <m>] [--sprint <s>]` | Return next eligible open issues (respects `depends_on`) |

## Field flags (create / update)

`--status`, `--phase`, `--milestone`, `--sprint`, `--description`, `--assigned-agent`, `--risk`, `--unknowns`, `--depends-on`, `--parallel`, `--comments`

`--depends-on` accepts comma-separated issue IDs (e.g. `"I-001,I-002"`). `next` will block an issue until all deps are `closed`.

## Status values

`open` · `active` · `closed` · `skipped`

## Output shapes (all JSON, exit 0 on success)

- `create / update / activate / close / skip` → `{ ok, procedure, issue: {...} }`
- `list` → `{ ok, procedure, count, issues: [...] }`
- `next` → `{ ok, procedure, exhausted, eligible: [...], blocked: [{id, title, waiting_on}] }`

## Examples

```sh
# Create an issue
node .github/skills/uwf-local-tracking/issues.mjs create \
  --id I-001 --title "Auth module" --milestone M1 --sprint S1 \
  --risk "OAuth provider TBD" --acceptance-criteria "User can log in"

# Activate the next eligible issue
node .github/skills/uwf-local-tracking/issues.mjs activate --id I-001

# List open issues in milestone M1
node .github/skills/uwf-local-tracking/issues.mjs list --status open --milestone M1

# Find next eligible (unblocked) issue
node .github/skills/uwf-local-tracking/issues.mjs next

# Close an issue
node .github/skills/uwf-local-tracking/issues.mjs close --id I-001
```

## When `next` returns `exhausted: true`

All issues are closed or skipped. Recommend project completion summary and retrospective.
