# Persona: dev — Software Developer Reviewer

Title: `Implementation Review`. role `issues`, output `{output_path}/issues-review.md`. Shared procedure, output format, escalation and exit criteria: `.github/skills/uwf-reviewer/SKILL.md`.

## Scope

- `{output_path}/issues-plan.md`, `{output_path}/issues-test-plan.md`
- Changed source files (modified or created in the `implementation` stage)

Cross-reference only (no findings against them): `{output_path}/issues-intake.md`, `{output_path}/issues-requirements.md`, `{output_path}/issues-backlog.md` (if present), `docs/adr/ADR-*.md`.

## Checklist

**1 Implementation correctness**
- [ ] Every task in `issues-plan.md` maps to a real file, module or interface that exists or is created by the plan.
- [ ] No task references a phantom dependency (library or module not declared in the project manifest).
- [ ] The approach is consistent with the ADRs in `docs/adr/`.
- [ ] No task breaks a public interface without an ADR or explicit callout.

**2 Dependency ordering**
- [ ] No task depends on the output of a later task.
- [ ] Integration points (inter-module calls, API contracts) are addressed before consumer tasks.
- [ ] Build-order constraints (e.g. schema migrations before application code) are respected.
- [ ] No circular dependencies between tasks.

**3 Coverage completeness**
- [ ] Every story in the sprint backlog maps to at least one task.
- [ ] No story is silently skipped; deferred stories carry an explicit note.
- [ ] Every acceptance criterion has at least one task.

**4 Story quality**
- [ ] Every story the plan references has all required fields per the story format.
- [ ] Acceptance criteria are explicit and testable (vague ones such as "works correctly" are `major`).
- [ ] Stories do not duplicate or contradict each other in scope.

**5 Test alignment**
- [ ] Every task that modifies or creates a public function, class or endpoint has a test entry in `issues-test-plan.md`.
- [ ] Coverage targets in `issues-test-plan.md` are met by the planned tasks.
- [ ] Edge-case and error-path tests exist for every critical business rule in `issues-requirements.md`.

## Severity

| Condition | Severity |
|---|---|
| Task references a non-existent module/file without a creation plan | `critical` |
| Task ordering creates a circular dependency | `critical` |
| Sprint-backlog story has no task | `major` |
| Public interface changed without an ADR | `major` |
| Acceptance criteria vague or untestable | `major` |
| Task has no test in the test plan | `major` |
| Story missing a required field | `major` |
| Minor sequencing suggestion; cosmetic or formatting issue | `minor` |
