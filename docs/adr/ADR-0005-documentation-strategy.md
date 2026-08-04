# ADR-0005: Documentation strategy — `docs/` is source of truth, wiki is a published mirror

Date: 2026-08-03
Status: Accepted

## Context
- Two audiences need docs: (a) contributors and **agents** (UWF's own runtime
  loads `.md` files from the working tree), and (b) beginner humans who need a
  5th-grade-reading-level guide, per the no-PhD invariants in
  [product-definition.md](../product/product-definition.md).
- A hand-edited GitHub wiki is a second source of truth: separate git store, no
  PR review, no CI, invisible to agents, does not version with tags. The repo's
  current README-vs-reality gap shows exactly how split truth decays here.
- A GitHub wiki is itself a git repo (`<repo>.wiki.git`) and can be pushed to
  from CI.

## Decision
- **All documentation is authored in this repo.**
  - `docs/` — build, agent, and reference documentation (technical register).
  - `docs/guide/` — human-readable pages written at a 5th-grade reading level.
- **CI publishes `docs/guide/` to the GitHub wiki** on merge to main. The wiki is
  read-only presentation; direct wiki edits are not permitted and may be
  overwritten by the next publish.
- The 5th-grade reading constraint is recorded in `docs/guide/` contributing
  notes as a hard style rule.

## Alternatives considered
1) **Hand-maintained wiki for human docs.** Rejected: recreates the split-truth
   failure mode; agents cannot read it; no gates.
2) **Everything in `docs/`, no wiki.** Simple, but loses the friendly
   browse-first surface the beginner audience deserves.
3) **Static site (GitHub Pages) instead of wiki.** Viable later; wiki is the
   cheaper v1 surface. Pages can be added on top of the same `docs/` source
   without changing this decision.

## Consequences
- Positive: guide goes through PR review and CI (commands/paths it mentions can
  be integrity-checked); docs version with tags (v1 guide ships in the v1 tag);
  agents can quote the beginner guide's own words when explaining gate failures.
- Negative: a small sync job to build and maintain; contributors must know wiki
  edits do not stick.
- Follow-ups: publish workflow (~15 lines of Actions YAML) lands in M2 with the
  first quickstart guide.

## Security / Privacy / Compliance notes
- Publish job needs only the repo-scoped token GitHub Actions already provides
  for pushing to `<repo>.wiki.git`. No external secrets.

## Verification
- CI job: merge to main → wiki page updated within one run; job fails loudly on
  push errors.
- Reference-integrity test extended to `docs/guide/` command and path mentions.
