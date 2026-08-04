# UWF Product Definition (v1)

Date: 2026-08-03
Status: Agreed (project owner + tech writer session)
Audience: contributors and agents working on UWF itself

This document answers the six questions that scope v1: what we are building, who it
is for, why they need it, what they can build day 1, how they use it, and how we
engineer it so no software-engineering PhD is required. Milestones derived from these
answers live in [roadmap-v1.md](roadmap-v1.md).

---

## What are we building?

**A process runtime for AI agents.**

Not an agent. Not a model. Not a prompt library. UWF is the layer that turns a
capable-but-undisciplined agent into a repeatable delivery pipeline:

- **Recipes are declarative** — stages, gates, and traits defined in YAML, not code.
- **State is deterministic** — script-fronted SQLite; resumable across sessions.
- **Output is auditable** — every run leaves a full artifact trail (intake → plan →
  review → acceptance) plus ADRs.

The agent supplies intelligence; UWF supplies discipline.

> **Baking metaphor (the original thesis):** agents bake the product by adding the
> ingredients (their skills and capabilities); the workflow decides the proportions
> and timing (traits, sequencing, retries) and defines what "finished" means for
> every state (gates), plus — eventually — a way to eval the result.

**Long-term vision vs. v1 scope:** "Universal" means any agent runtime that has
these primitives (sub-agents, skills, instructions, prompts) and any domain
(software, writing, analysis). That is the *architecture*. It is **not** the v1
pitch. V1 is a wedge — see Non-goals below.

---

## Who is it for?

**V1 beachhead:** a developer who already uses an AI coding agent (VS Code Copilot
custom agents today) and has been burned by it. They have:

- watched an agent skip planning or rewrite half a repo,
- lost context mid-task or between sessions,
- received "done" with no tests and no trail of why decisions were made.

They are technical enough to have `.github/` in their repo but will not read a
364-line architecture spec.

**Explicitly not v1 audiences:** non-software domains (book writer, business
analyst), teams on other agent runtimes, enterprise process folks. They are proof
of the architecture later.

---

## Why do they need it?

Their current options all fail a different way:

| Option | Failure mode |
| :--- | :--- |
| One-shot prompting | Unrepeatable; no memory; no review |
| Hand-rolled prompt folklore | Unenforced; drifts; not shareable |
| Heavyweight agent frameworks | You must *program* the orchestration (the PhD problem) |

Nobody occupies **declarative process enforcement, drop-in, no code**. UWF's
answer: gated stages, small reviewable increments, persistent state, and decision
records that survive the session.

---

## What can they build with it day 1?

One flagship path, made flawless:

> **"Give it a GitHub issue; get back a planned, implemented, reviewed, accepted
> change with the full decision trail."**

That is the `sw_dev` persona end to end. Day 1 = install, describe the issue,
answer a few intake questions, approve at the gates, done.

- `project_manager` and `solutions_architect` ship as "also included" — no v1
  onboarding investment.
- `forensic-analyst` (brownfield archaeology) is genuinely novel but hardest to
  make reliable — deferred to v1.x.

---

## How do they use it?

Three verbs. The machinery stays invisible.

1. **Install** — one command scaffolds `.github/` and verifies the environment
   (including detecting the "custom subagents not enabled" gotcha and saying how to
   fix it).
2. **Run** — one prompt starts the orchestrator. The human's only jobs are
   answering intake questions and approving gates.
3. **Watch** — the UWF Companion dashboard is the window into state. Nobody runs
   `state.mjs` by hand; nobody opens a SQLite file.

---

## No-PhD engineering invariants

These are design constraints, not documentation aspirations. Violations are bugs.

- [ ] **One-command everything.** `init`, `doctor`, `reset`. If setup requires
      reading prose, that is a defect.
- [ ] **Zero-config default.** YAML exists for *customizing* a workflow, never for
      *starting* one.
- [ ] **The agent is the interface.** Every human touchpoint happens in chat or the
      dashboard. Scripts and databases are internal organs.
- [ ] **Errors prescribe.** A failed gate says what is missing and what happens next
      ("retry 1 of 2"), never just "check failed."
- [ ] **Progressive disclosure.** Layer 1: run a built-in persona. Layer 2: tweak
      gates in YAML. Layer 3: author a persona with the scaffolder. Each layer is
      optional and separately documented.
- [ ] **Resumable by default.** Close the laptop mid-workflow; one command tomorrow
      says where you are. (The state manager nearly delivers this — surface it.)

---

## Non-goals for v1

Written down so we stay honest. All real, all deferred, all blocked until the
wedge lands:

- Runtime adapters beyond VS Code Copilot (Claude Code, other SDKs) — v1.x+
- Non-software personas — v2
- Eval tier beyond structural gates (rubrics, scored verdicts) — v1.x
- Skill extraction / marketplace / separate skill repos — superseded, see
  [ADR-0004](../adr/ADR-0004-skills-live-in-the-monorepo.md)
- Forensic-analyst polish — v1.x

---

## Related decisions

- [ADR-0004 — Skills live in the monorepo](../adr/ADR-0004-skills-live-in-the-monorepo.md)
- [ADR-0005 — Documentation strategy: `docs/` is source of truth; wiki is a published mirror](../adr/ADR-0005-documentation-strategy.md)
- [ADR-0006 — Repository visibility: private for cleanup, public at launch](../adr/ADR-0006-repo-visibility.md)
