# ADR-0004: Skills live in the monorepo

Date: 2026-08-03
Status: Accepted

## Context
- Commit `2151b74` ("move skills to their own repo") deleted all 20 skills from
  `.github/skills/`, but only 3 were extracted to standalone repos
  (`qwts/skills-uwf-*`). PR #29 later re-added 7 skills in-repo with newer
  content. Result: 13 skills referenced but existing nowhere locally, 2 skills
  with diverged dual copies, 1 skill existing only externally. Full findings:
  [repo-audit-2026-08-03.md](../product/repo-audit-2026-08-03.md).
- Skill interfaces are not yet stable and there is exactly one consumer (this
  repo). No install mechanism for external skills exists.
- The v1 goal (see [product-definition.md](../product/product-definition.md))
  requires one flagship workflow to run end to end from a fresh clone.

## Decision
- All skills are authored, versioned, and tested in this monorepo under
  `.github/skills/`. The multi-repo extraction is **superseded**.
- The in-repo copies are canonical wherever dual copies exist.
- The three external `skills-uwf-*` repos are archived with a pointer back to the
  monorepo.

## Alternatives considered
1) **Finish the extraction (submodules or an installer).** Right end-state for the
   "universal / marketplace" vision, but premature: interfaces unstable, one
   consumer, and it already produced drift within weeks. Revisit post-v1.
2) **Vendor external repos via package manager.** Adds a release pipeline per
   skill before a single workflow has ever run end to end.
3) **Status quo (split truth).** The repo cannot execute past discovery; rejected
   outright.

## Consequences
- Positive: single source of truth; whole-system testable in one CI run; a clone
  is a working system; drift becomes impossible by construction.
- Negative: skills are not independently versionable or shareable yet; the
  eventual extraction (if any) is deferred work.
- Follow-ups: restore missing skills (M0), archive external repos, add
  reference-integrity smoke test to CI.

## Security / Privacy / Compliance notes
- Trust boundaries unchanged; skills remain script-fronted local SQLite.
- No credentials involved. `*.db*` files stay gitignored during restoration.

## Verification
- Reference-integrity smoke test passes: zero `MISSING` skill paths (command and
  expected output documented in the audit doc).
- `workflow=sw_dev` golden run completes from a fresh clone (M1 exit).
