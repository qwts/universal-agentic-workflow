# Implementation verify gate

The `sw_dev` implementation stage gate runs
`.github/skills/uwf-orchestration-engine/verify.mjs` in the target repository, so an
implementation that does not build or whose tests fail cannot pass the gate. The
`issues-plan.md` check still applies.

The commands run in the target repo's own toolchain (its Node version, native modules, and so on),
so a dependency without a prebuilt binary for the runner's Node version, such as
better-sqlite3 12.11.1 on Node 20, fails the gate until the target repo pins a compatible version.

## Where the commands come from

First match wins:

1. `UWF_VERIFY_CMDS` environment variable: newline-separated shell commands.
2. `verify` array in `.uwf.json` at the target repo root:

   ```json
   { "verify": ["npm run build", "npm test"] }
   ```

   An explicit empty list (`"verify": []`) means there is nothing to verify and the gate passes.
3. Auto-detection:
   - `package.json`: `npm run build --if-present`, then `npm test --if-present` (skipped when the
     `test` script is the npm default placeholder)
   - `Cargo.toml`: `cargo build`, `cargo test`
   - `go.mod`: `go build ./...`, `go test ./...`
   - `pyproject.toml` mentioning pytest, or a `tests/` directory: `python -m pytest -q`
   - nothing detected: prints "no verify commands detected" and passes

Configured commands run through the shell, so only operator-controlled config should set them.
Commands run in order and stop at the first failure; the gate message carries the command and the
last 40 lines of its output.

Preview the resolved commands without running them with
`node .github/skills/uwf-orchestration-engine/verify.mjs --dry-run`.
