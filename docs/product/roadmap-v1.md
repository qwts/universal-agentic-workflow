# UWF Roadmap to v1

Date: 2026-08-03
Status: Agreed (project owner + tech writer session)
Depends on: [product-definition.md](product-definition.md)

Five milestones, each with a single exit criterion. A milestone is done when its
exit criterion is demonstrably true, not when its tasks are merely merged.

**V1 release criterion (the whole game):** someone we have never spoken to ships a
gated change with UWF, without opening the architecture doc.

---

## M0 — Truth

*The repo is internally consistent and provably stays that way.*

Tracked on GitHub: [milestone "M0 — Truth"](https://github.com/qwts/universal-agentic-workflow/milestone/1)
(issues [#39](https://github.com/qwts/universal-agentic-workflow/issues/39)–[#44](https://github.com/qwts/universal-agentic-workflow/issues/44)).

- [x] Migrate repository ownership to the `qwts` account so the main repo and all
      project repos conform to one namespace standard (external skill repos are
      already `qwts/skills-uwf-*`; history references `qwtm`/`qwtj`).
      *(Done 2026-08-03.)*
- [x] Set repository private for the cleanup period
      ([ADR-0006](../adr/ADR-0006-repo-visibility.md)). *(Done 2026-08-03.)*
- [ ] Conform to `qwts` org governance (`../playbook-engineering`):
  - [ ] Enroll in `governance/repos.json` (regenerate with
        `node tools/repos/repos.mjs --write`; `repos.mjs check` must pass).
  - [ ] Add a root `AGENTS.md` per ENG-0006; make
        `.github/copilot-instructions.md` a thin adapter onto it (no restated
        facts).
  - [ ] Adopt the shared SOP baseline: PR-first, trunk-based branches,
        agent-authored PRs under the bot identity (ENG-0016), one approving
        human review.
  - [ ] Run `markdownlint` (playbook config) over `docs/` as a cheap local gate;
        enroll in docs-gov when governed.
- [ ] Restore the 13 skills deleted by commit `2151b74` ("move skills to their own
      repo") that were never re-added; adopt the in-repo copies as canonical for the
      two that drifted ([ADR-0004](../adr/ADR-0004-skills-live-in-the-monorepo.md)).
- [ ] Copy `uwf-local-tracking` back in from `qwts/skills-uwf-local-tracking`
      (exists only externally today).
- [ ] Archive the three `skills-uwf-*` repos with a "superseded — see monorepo"
      note.
- [ ] Add a reference-integrity smoke test: every `.github/skills/uwf-*` path
      referenced by any agent, skill, or instruction file must exist on disk.
- [ ] Wire the full `scripts/uwf-smoke/` suite into CI on every PR.

**Exit:** CI is green, and the reference-integrity test would fail on the current
main branch's dangling references (proving it catches the class of breakage that
got us here). Current findings: [repo-audit-2026-08-03.md](repo-audit-2026-08-03.md).

---

## M1 — Proof

*The flagship path demonstrably works.*

- [ ] Run `workflow=sw_dev` end to end on a toy repository.
- [ ] Fix whatever breaks until the workflow closes (acceptance + snapshot + retro).
- [ ] Commit the resulting artifact chain as a **golden run** — it is both the
      regression fixture and the demo.

**Exit:** a fresh checkout can replay the golden path; the committed artifact chain
shows every stage's output.

---

## M2 — Door

*A stranger goes zero-to-first-gate in under 15 minutes.*

- [ ] Installer: one command scaffolds `.github/` into a target repo.
- [ ] `doctor` command: verifies Node version, VS Code Copilot custom-subagents
      setting, and directory layout; prescribes fixes.
- [ ] Rewrite `README.md` around the day-1 story (sell the loaf, not the oven).
- [ ] Wiki publish pipeline: CI job pushes `docs/guide/` to the GitHub wiki on merge
      ([ADR-0005](../adr/ADR-0005-documentation-strategy.md)).
- [ ] First wiki guide: quickstart at a 5th-grade reading level.
- [ ] Re-evaluate going public; announce nothing yet.

**Exit:** timed test — a person unfamiliar with the repo reaches their first passed
gate in under 15 minutes using only the quickstart.

---

## M3 — Trust

*A stranger completes the full flagship run unassisted.*

- [ ] Gate failures are prescriptive (what is missing, what happens next, retry
      count) — audit every gate in `uwf-sw_dev/stages.yaml`.
- [ ] Resume flow: one command reports current phase/stage and how to continue.
- [ ] Companion dashboard polish for the flagship path.
- [ ] Audit every human touchpoint against the no-PhD invariants in
      [product-definition.md](product-definition.md).

**Exit:** an unassisted stranger run of the full `sw_dev` workflow, observed,
completing without intervention.

---

## M4 — Release

*v1 ships.*

- [ ] Quickstart + exactly one customization guide (tweaking gates in YAML).
- [ ] 2–3 stranger tests as release acceptance.
- [ ] Repository public; tag `v1.0.0`; announce.

**Exit:** the v1 release criterion at the top of this document.

---

## Deferred (not v1)

See Non-goals in [product-definition.md](product-definition.md): runtime adapters
beyond Copilot, non-software personas, the eval tier, skill
extraction/marketplace, forensic-analyst polish.
