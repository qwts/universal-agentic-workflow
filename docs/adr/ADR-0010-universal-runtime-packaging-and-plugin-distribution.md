# ADR-0010: Universal pure-JS runtime packaging and multi-host plugin distribution

Date: 2026-11-20
Status: Accepted
Extends: [ADR-0008](./ADR-0008-multi-surface-mcp-plugin-runtime-contract.md)

## Context
- [ADR-0007](./ADR-0007-runtime-owns-the-loop.md) and
  [ADR-0008](./ADR-0008-multi-surface-mcp-plugin-runtime-contract.md) decoupled
  UWF's stage loop, deterministic gate checks, and `uaw-mcp/v1` protocol from
  VS Code Copilot chat prompts.
- However, consuming UWF in external repositories, CI/CD pipelines, or
  third-party agent plugin hosts still carried high packaging friction:
  1. Eight SQLite-backed skill CLIs, [`scripts/uaw-mcp/store.mjs`](../../scripts/uaw-mcp/store.mjs),
     and [`scripts/uwf-bench/sqlite.mjs`](../../scripts/uwf-bench/sqlite.mjs)
     depended on native `better-sqlite3` C++ bindings installed separately across
     nine `.github/skills/uwf-*/` subdirectories. Every new environment or Node
     ABI required running a 9-folder `npm ci` loop and native toolchain builds.
  2. The repository lacked a root `package.json` (`bin` entrypoints), an OCI
     container image, a thin composite GitHub Action, or a cross-client plugin
     packager emitting Agent Plugins 1.0 and Claude Code bundles.
  3. [`uwf-companion/`](../../uwf-companion/README.md) already adopted
     Node 22.13+'s built-in `node:sqlite` for read-only dashboard views, leaving
     the core runtime and companion on different minimum Node baselines.

## Decision
- **Eliminate native SQLite addons in favor of built-in `node:sqlite` (Node >= 22.13.0).**
  - A shared compatibility wrapper
    [`.github/skills/uwf-state-manager/sqlite.mjs`](../../.github/skills/uwf-state-manager/sqlite.mjs)
    provides `openDatabase(dbPath, opts)` over `DatabaseSync`, preserving
    `better-sqlite3` semantics UWF relies on: `busy_timeout = 5000`, strict
    `fileMustExist` + `PRAGMA query_only = ON` read-only opens without creating
    WAL sidecars, plain-object row spreading (`{ ...row }`), numeric
    `changes`/`lastInsertRowid`, and savepoint-aware `transaction(fn)`.
  - All eight skill CLIs, `scripts/uaw-mcp/store.mjs`, and
    `scripts/uwf-bench/sqlite.mjs` migrate to this shared pure-JS wrapper;
    `better-sqlite3` is removed from all skill `package.json` and lockfiles.
- **Unify the runtime as a single pure-JS root package (`@qwts/uaw`).**
  - Root [`package.json`](../../package.json) hoists `js-yaml` once and exposes
    universal CLI binaries:
    - `uaw` ([`bin/uaw.mjs`](../../bin/uaw.mjs)): `run`, `resume`, `gates`,
      `cost`, `mcp`, `hook pre-tool-use`, `--version`, `--help`.
    - `uaw-mcp` ([`bin/uaw-mcp.mjs`](../../bin/uaw-mcp.mjs)): standalone
      `uaw-mcp/v1` server (`--transport stdio|http`).
  - Both CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) and
    PR automation ([`.github/workflows/uwf-on-pr.yml`](../../.github/workflows/uwf-on-pr.yml))
    replace the 9-folder `npm ci` fan-out with one root install on Node `22.13.1`.
  - `cmdGates` in [`scripts/uaw-mcp/commands.mjs`](../../scripts/uaw-mcp/commands.mjs)
    falls back to the target repo's `.github/skills/uwf-<workflow>/stages.yaml`
    when present and otherwise to the packaged runtime root so standalone plugin
    bundles evaluate gates cleanly against bare target workspaces.
- **Ship thin distribution adapters from the single monorepo core:**
  - **OCI container ([`Dockerfile`](../../Dockerfile)):** non-root `node:22-slim`
    image setting `UWF_SKILLS_ROOT=/opt/uaw` and `ENTRYPOINT ["uaw"]` for any
    CI/CD runner (GitHub Actions, GitLab CI, Buildkite, Kubernetes, local Docker).
  - **Composite GitHub Action ([`action.yml`](../../action.yml)):** typed,
    env-passed wrapper around `bin/uaw.mjs` with zero direct `${{ inputs.* }}`
    shell interpolation.
  - **Cross-client Agent Plugin packager ([`scripts/pack-plugin.mjs`](../../scripts/pack-plugin.mjs)):**
    builds a self-contained, symlink-free, zero-`npm-install` bundle containing:
    - Agent Plugins 1.0 closed-schema `plugin.json` and `mcp.json` (`${PLUGIN_ROOT}`)
    - Claude Code `.claude-plugin/plugin.json`, `.mcp.json` (`${CLAUDE_PLUGIN_ROOT}`),
      `agents/*.md`, and `hooks/hooks.json`
    - Portable `skills/` and VS Code / Copilot namespace `com.github.copilot/`
    - Pure-JS `runtime/` (`bin/`, `scripts/`, `.github/`, `node_modules/js-yaml`)
    - Optional `marketplace.json` catalog and read-only `--check` verification.

## Alternatives considered
1. **Publish per-OS/arch prebuilt `better-sqlite3` tarballs or keep 9-folder `npm ci`.**
   Adds native build matrices, Electron/Node ABI mismatches, and slow installs in
   every CI job and plugin host.
2. **Fork separate repositories for VS Code, Claude Code, and CI CLI packaging.**
   Violates [ADR-0004](./ADR-0004-skills-live-in-the-monorepo.md) and guarantees
   drift between stage gates, hooks, and MCP schemas.

## Consequences
- **Positive:** Single-command `npm ci` with two pure-JS packages (`js-yaml`,
  `argparse`), zero native compilation, portable across npm/npx, OCI containers,
  composite GitHub Actions, Claude Code plugins, Agent Plugins 1.0 hosts, and
  standalone MCP clients.
- **Negative:** Minimum supported Node.js runtime increases from `20` to `22.13+`
  (matching `uwf-companion/`).
- **Follow-up (Phase 2 implemented in `uwf-companion/`):** Rewired `uwf-companion/` from direct `.github/skills/**/*.db` file readers onto the `uaw-mcp/v1` runtime contract (`McpServerConfig`, `UawMcpClient`, `UawDataService`), replaced the stale vendored `.github/` copy with build-time staging via `uwf-companion/scripts/stage-bundle.mjs`, and registered formal VS Code AI/MCP contribution points (`mcpServerDefinitionProviders`, `chatAgents`, `chatSkills`, `chatPromptFiles`, `chatInstructions`).

## Security / Privacy / Compliance notes
- [`scripts/pack-plugin.mjs`](../../scripts/pack-plugin.mjs) rejects symlinks,
  native `.node` addons, `better-sqlite3`, `*.db*` state files, `.env`, and
  `test/` directories during bundling and `--check` verification, stages into a
  sibling directory before swapping `--out`, and refuses unsafe target paths (`/`,
  home directory, repository root).
- [`action.yml`](../../action.yml) passes every user input strictly via `INPUT_*`
  environment variables, validates `command` and `workflow` allowlists, rejects
  leading-dash option smuggling, and pins `actions/setup-node` to a full commit SHA.
- [`Dockerfile`](../../Dockerfile) runs as non-root `USER node` and excludes
  test fixtures, databases, and `.git` history via [`.dockerignore`](../../.dockerignore).

## Verification
- `scripts/uaw-pack/test/pack.test.mjs` verifies `bin/uaw.mjs`, `bin/uaw-mcp.mjs`,
  `scripts/pack-plugin.mjs` manifest schemas, tree hygiene (zero symlinks/DBs/native
  binaries), standalone neutral-cwd `uaw_gates` execution via `mcp.json`,
  standalone `PreToolUse` hook execution via `hooks/hooks.json`, read-only
  `--check` purity, and static `Dockerfile`/`action.yml` security invariants.
- Full existing suites (`scripts/uwf-smoke/*.mjs`, `scripts/uwf-runner/test/*.test.mjs`,
  `scripts/uaw-mcp/test/*.test.mjs`, `scripts/uwf-bench/test/*.test.mjs`,
  `scripts/runner-host/test/runner-host.test.sh`, and `uwf-companion`) pass on
  Node >= 22.13.0 with zero `.github/skills/uwf-*/node_modules/` directories on disk.
