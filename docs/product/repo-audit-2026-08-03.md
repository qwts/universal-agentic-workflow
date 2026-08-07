# Repo Audit — State of the Skills Split

Date: 2026-08-03
Status: Findings recorded; remediation tracked in [roadmap-v1.md](roadmap-v1.md) M0
Assumption: local external repos live at `../skills-uwf-<slug>` relative to the
repo root and mirror `github.com/qwts/skills-uwf-<slug>`.

This audit captures why the repo currently cannot run a workflow past the
discovery stage, and exactly what M0 must fix.

---

## Timeline of the breakage

1. **`2151b74` — "move skills to their own repo" (2026-03-16).** Deleted all 20
   skill directories from `.github/skills/` (88 files, ~13,400 lines), intending a
   multi-repo extraction.
2. **Only 3 skills were actually extracted** — `skills-uwf-local-tracking`,
   `skills-uwf-orchestration-engine`, `skills-uwf-state-manager` — each a single
   "Initial commit" under `qwts`.
3. **`9b4b460` — PR #29 (2026-04-19, current HEAD).** Branched before the move;
   during conflict resolution re-added **7 skill directories** to
   `.github/skills/` (orchestration-engine, state-manager, model-adaptation,
   traits, and the three persona skills) with newer content (canonical `intake`
   stage contract, `uwf-stage-*` agent renames). The traits directory was only
   partially restored: its registry plus the `solutions_architect` and
   `forensic_analyst` trait files remained missing.

Net effect: three partially overlapping sources of truth, none complete.

---

## Skill inventory

| Skill | In repo | External (`qwts/skills-uwf-*`) | Status |
| :--- | :---: | :---: | :--- |
| uwf-orchestration-engine | ✅ | ✅ stale | In-repo is canonical (has `intake.yaml`, post-#29 agent names). External predates #29. |
| uwf-state-manager | ✅ | ✅ stale | In-repo is canonical. External references the legacy discovery-agent name removed by PR #29. |
| uwf-local-tracking | ❌ | ✅ | **Missing in-repo.** External copy verified byte-identical to `2151b74^` (2026-08-04) — restore from git history with the rest. |
| uwf-model-adaptation | ✅ | — | OK |
| uwf-traits | ⚠️ partial | — | Newer `project_manager` and `sw_dev` traits are present; restore the missing registry, `solutions_architect`, and `forensic_analyst` files from history. |
| uwf-project_manager | ✅ | — | OK |
| uwf-sw_dev | ✅ | — | OK |
| uwf-solutions_architect | ✅ | — | OK |
| uwf-adr | ❌ | — | **Deleted, nowhere locally.** Restore from `2151b74^`. |
| uwf-cbs | ❌ | — | Deleted, nowhere. Restore. |
| uwf-discovery | ❌ | — | Deleted, nowhere. Restore. |
| uwf-forensic-analyst | ❌ | — | Deleted, nowhere — the persona is entirely broken. Restore. |
| uwf-question-protocol | ❌ | — | Deleted, nowhere. Restore. |
| uwf-refinement | ❌ | — | Deleted, nowhere. Restore. |
| uwf-requirements | ❌ | — | Deleted, nowhere. Restore. |
| uwf-review | ❌ | — | Deleted, nowhere. Restore. |
| uwf-reviewer | ❌ | — | Deleted, nowhere. Restore. |
| uwf-risk-planner | ❌ | — | Deleted, nowhere. Restore. |
| uwf-snapshot | ❌ | — | Deleted, nowhere. Restore. |
| uwf-threat-model | ❌ | — | Deleted, nowhere. Restore. |
| reset-all.mjs (skills root) | ❌ | — | Deleted with the move. Restore. |

---

## Dangling references (verified 2026-08-03)

Command run from repo root:

```bash
grep -h 'skills/uwf-' .github/agents/*.agent.md .github/copilot-instructions.md \
  | grep -oE '\.github/skills/uwf-[a-z_-]+' | sort -u \
  | while read p; do [ -d "$p" ] && echo "OK      $p" || echo "MISSING $p"; done
```

Result: **13 MISSING** (adr, cbs, discovery, forensic-analyst, local-tracking,
question-protocol, refinement, requirements, review, reviewer, risk-planner,
snapshot, threat-model). Success signal after M0: zero `MISSING` lines. This check
becomes the reference-integrity smoke test in CI.

Additional inconsistencies:

- `README.md` documents all 20 skills as present at `.github/skills/` paths.
- The UWF Companion extension reads databases owned by skills that no longer exist
  in-repo (issues, ADRs, discoveries, reviews).
- No mechanism (submodule, installer, docs) references the external repos, so a
  fresh clone has no path to a working state.

---

## Remediation (tracked as M0 in the roadmap)

1. Restore all 13 missing skills + `reset-all.mjs` from `2151b74^`, and complete
   the partial `uwf-traits` restore with its missing registry and two declared
   trait files
   (`git checkout 2151b74^ -- .github/skills/<name>` per skill; drop any `*.db*`
   files; respect current `.gitignore`). Git history is the single authoritative
   restore source, including for `uwf-local-tracking` — verified 2026-08-04:
   `diff -rq` between the `2151b74^` copy and the external repo (excluding
   `node_modules`, `*.db*`, `.git`) reports no differences.
2. Keep the 7 in-repo skills as-is — they are the newest versions.
3. Archive `qwts/skills-uwf-{local-tracking,orchestration-engine,state-manager}`
   with a README note: *"Superseded 2026-08 — canonical source is the
   universal-agentic-workflow monorepo."* Decision:
   [ADR-0004](../adr/ADR-0004-skills-live-in-the-monorepo.md).
4. Add the reference-integrity check to `scripts/uwf-smoke/` and wire the suite
   into CI.
