# ADR-0006: Repository visibility and ownership — private for cleanup, `qwts` namespace, public at launch

Date: 2026-08-03
Status: Accepted

## Context
- The repo's history spans several GitHub identities (`qwtm`, `qwtj`, `qwts`);
  the extracted skill repos already live under `qwts`. One namespace should own
  everything.
- The repo is entering a cleanup phase (M0 in
  [roadmap-v1.md](../product/roadmap-v1.md)): dangling references, half-finished
  extraction, README describing components that do not exist. First impressions
  matter for a dev tool whose adoption depends on trust.
- Long term, open source is the distribution channel: the v1 release criterion
  ("a stranger ships a gated change") requires public access.

## Decision
- **Migrate the repository to the `qwts` account** so all project repos conform
  to one namespace standard.
- **Set the repository private for the cleanup period** (M0 onward).
- **Return to public at launch readiness** — target M4, with re-evaluation at M2
  once the installer, quickstart, and golden demo exist. Public ≠ announced;
  announcement is a separate, later act.

## Alternatives considered
1) **Stay public throughout ("build in public").** Public timestamps have
   provenance value, but a visitor today finds a broken system; the owner prefers
   a controlled first impression.
2) **Private forever / source-available at v1.** Conflicts with the distribution
   model and the stranger-test release criterion.
3) **Leave ownership split across `qwtm`/`qwtj`/`qwts`.** Confusing provenance,
   inconsistent with the namespace standard; rejected.

## Consequences
- Positive: house-cleaning happens without an audience; consistent `qwts`
  namespace; launch moment is controlled.
- Negative: no public timestamps during the private window; existing clones and
  any inbound links break on migration (GitHub redirects transfers, but remotes
  should be updated).
- Follow-ups: transfer repo to `qwts`; flip to private; update local remotes and
  any hardcoded `qwtm`/`qwtj` URLs in docs and CI; enroll in the
  `playbook-engineering` governance manifest (`governance/repos.json`) and adopt
  its ENG-0006 conventions (root `AGENTS.md`, shared SOPs); re-evaluate
  visibility at M2; flip public + tag at M4.

## Security / Privacy / Compliance notes
- Before returning to public: re-scan history for secrets and stray local paths;
  confirm `.gitignore` covers all `*.db*` artifacts (PR #29 already removed
  accidentally committed `db-shm`/`db-wal` files once).
- Owner to confirm personal employment-agreement considerations independently;
  not a repo-level control.

## Verification
- `git remote -v` on all working copies shows `qwts/universal-agentic-workflow`.
- Repo visibility private during M0–M3 window; public visibility + `v1.0.0` tag
  verified at M4.
