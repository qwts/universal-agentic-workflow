# Universal Agentic Workflow agent context

This is the canonical, vendor-neutral agent context for this repository, per
[ENG-0006](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).
Vendor-specific instruction files point here and contain only genuinely
vendor-specific integration details.

## What this repository is

Universal Agentic Workflow (UWF) is the source monorepo for a composable,
gate-enforced delivery workflow and its VS Code companion. Start with the
[README](README.md) for current status and use, the
[product definition](docs/product/product-definition.md) for scope, and the
[v1 roadmap](docs/product/roadmap-v1.md) for sequencing.

Follow the
[org-wide agent conventions](https://github.com/qwts/agent-sop/blob/main/docs/reference/agent-conventions.md)
for the shared working agreement. Keep only UWF-specific context here.

## Repository map

- [`.github/agents/`](.github/agents/) contains orchestration and stage-agent
  definitions.
- [`.github/skills/`](.github/skills/) contains UWF behavior modules. The
  [orchestration-engine skill](.github/skills/uwf-orchestration-engine/SKILL.md)
  is the detailed execution and gate contract.
- [`.github/instructions/`](.github/instructions/) and
  [`.github/prompts/`](.github/prompts/) contain scoped rules and workflow entry
  points.
- [`docs/`](docs/) contains architecture, product, ADR, and artifact
  documentation. Start with the
  [architecture overview](docs/uwf-architecture.md).
- [`scripts/uwf-smoke/`](scripts/uwf-smoke/) contains the cheap repository smoke
  tests.
- [`uwf-companion/`](uwf-companion/) contains the VS Code extension; its setup
  and checks are documented in its
  [README](uwf-companion/README.md).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) documents dependency setup and how to add
  personas, agents, skills, and tracking backends.

## Validation

Install the affected skill dependencies as described in
[`CONTRIBUTING.md`](CONTRIBUTING.md#development-setup), then run the complete
smoke suite:

```sh
for test_file in scripts/uwf-smoke/*.mjs; do
  node "$test_file" || exit 1
done
```

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/agent-sop/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/agent-sop/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
This repository is governed by
[agent-sop](https://github.com/qwts/agent-sop) — its
[shared SOPs](https://github.com/qwts/agent-sop/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/agent-sop/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->
