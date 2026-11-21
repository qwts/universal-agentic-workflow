---
name: uwf-core-project-tracking
description: "Read issues-backlog.md and seed the SQLite issues DB via issues.mjs."
tools: ["execute", "read"]
user-invocable: false
---
# Issue State Population Stage

Read `.github/skills/uwf-local-tracking/SKILL.md`. All commands and output shapes are defined there.

## Task

Parse `{inputs[0]}` (`issues-backlog.md`) and register every issue in the SQLite issues database via `issues.mjs`. The gate for this stage verifies SQLite has open records — there is no filesystem check.

## Procedure

### 1 — Parse the backlog

Read `issues-backlog.md`. Extract every milestone (`M*`), sprint (`S*`), and issue (`I-*`) in order. Record: milestone id, sprint id, issue id, title, depends-on (comma-separated ids), security-sensitive, acceptance-criteria, notes.

### 2 — Create issues in SQLite

For every issue, call `issues.mjs create`. Skip if `issues.mjs list` already shows the id (idempotent):

```sh
node .github/skills/uwf-local-tracking/issues.mjs create \
  --id <I-NNN> --title "<title>" \
  --milestone <M-id> --sprint <S-id> \
  [--description "<brief>"] \
  [--depends-on "<I-001,I-002>"] \
  [--risk "<note>"]
```

### 3 — Verify

```sh
node .github/skills/uwf-local-tracking/issues.mjs list --status open
```

Confirm `count > 0`. If count is 0, re-run failed steps before returning.

## Hard constraints

- Do NOT implement any issue. This stage only seeds tracking data.
- IDs must match the backlog exactly.
- Every issue in the backlog must have a corresponding SQLite row before returning.
