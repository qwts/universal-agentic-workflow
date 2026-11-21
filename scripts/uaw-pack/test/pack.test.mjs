/**
 * pack.test.mjs — Verification tests for unified `@qwts/uaw` CLI entrypoints,
 * `uaw-mcp` stdio binary, cross-client Agent Plugin packager (`pack-plugin.mjs`),
 * Dockerfile, and composite GitHub Action (`action.yml`).
 *
 * Usage:
 *   node scripts/uaw-pack/test/pack.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const UAW_BIN = join(REPO_ROOT, "bin", "uaw.mjs");
const UAW_MCP_BIN = join(REPO_ROOT, "bin", "uaw-mcp.mjs");
const PACK_SCRIPT = join(REPO_ROOT, "scripts", "pack-plugin.mjs");
const ROOT_PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

function runNode(scriptPath, args = [], { cwd = REPO_ROOT, input = "", env, nodeArgs = [] } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [...nodeArgs, scriptPath, ...args], {
      cwd,
      input,
      env: env ?? process.env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function withStdioMcp(scriptPath, args, { cwd = REPO_ROOT, env } = {}, fn) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter.resolve(msg);
    }
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(
          new Error(
            `Timed out waiting for MCP response to ${method}; stderr=${Buffer.concat(stderrChunks).toString("utf8")}`,
          ),
        );
      }, 15_000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolvePromise(msg);
        },
        reject: rejectPromise,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pack-test", version: "1.0.0" },
    });
    assert.ok(init.result?.serverInfo, "initialize must return serverInfo");
    notify("notifications/initialized", {});
    return await fn({ request, notify, getStderr: () => Buffer.concat(stderrChunks).toString("utf8") });
  } finally {
    rl.close();
    child.stdin.end();
    await new Promise((resolveClose) => child.once("close", resolveClose));
  }
}

function walkTree(dir) {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const st = lstatSync(fullPath);
    entries.push({ path: fullPath, name: entry.name, st });
    if (st.isDirectory()) {
      entries.push(...walkTree(fullPath));
    }
  }
  return entries;
}

test("bin/uaw.mjs CLI entrypoints and hook policy", () => {
  const ver = runNode(UAW_BIN, ["--version"]);
  assert.equal(ver.code, 0);
  assert.equal(ver.stdout.trim(), ROOT_PKG.version);

  const help = runNode(UAW_BIN, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /uaw run --workflow/);
  assert.match(help.stdout, /uaw mcp/);
  assert.match(help.stdout, /uaw hook pre-tool-use/);

  const unknown = runNode(UAW_BIN, ["definitely-not-a-command"]);
  assert.equal(unknown.code, 2);

  const gates = runNode(UAW_BIN, ["gates", "--workflow", "sw_dev"]);
  assert.equal(gates.code, 0, gates.stderr);
  assert.match(gates.stdout, /\bintake\b/);
  assert.match(gates.stdout, /\breview\b/);

  const dry = runNode(
    UAW_BIN,
    [
      "run",
      "--workflow",
      "sw_dev",
      "--goal",
      "Pack CLI smoke test",
      "--adapter",
      "fake",
      "--dry-run",
    ],
    {
      env: {
        ...process.env,
        UWF_FAKE_FIXTURE_DIR: join(REPO_ROOT, "scripts", "uwf-runner", "test", "fixtures", "sw_dev"),
      },
    },
  );
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /workflow: sw_dev/);

  // Hook: allow benign
  const allow = runNode(UAW_BIN, ["hook", "pre-tool-use"], {
    input: JSON.stringify({ tool_name: "runInTerminal", tool_input: { command: "echo ok" } }),
  });
  assert.equal(allow.code, 0);
  assert.equal(JSON.parse(allow.stdout).hookSpecificOutput.permissionDecision, "allow");

  // Hook: deny destructive (Copilot & Claude tool names)
  for (const toolName of ["runInTerminal", "Bash"]) {
    const deny = runNode(UAW_BIN, ["hook", "pre-tool-use"], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { command: "rm -rf /tmp/test" } }),
    });
    assert.equal(deny.code, 0);
    assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  }

  // Hook: ask sensitive edits (Copilot & Claude tool names)
  for (const toolName of ["editFiles", "Edit"]) {
    const ask = runNode(UAW_BIN, ["hook", "pre-tool-use"], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: "/repo/.github/workflows/ci.yml" } }),
    });
    assert.equal(ask.code, 0);
    assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, "ask");
  }

  // Hook: malformed JSON degrades safely with continue: true
  const badJson = runNode(UAW_BIN, ["hook", "pre-tool-use"], { input: "{not-json" });
  assert.equal(badJson.code, 0);
  assert.equal(JSON.parse(badJson.stdout).continue, true);
});

test("bin/uaw-mcp.mjs stdio server lists uaw-mcp/v1 tools", async () => {
  const neutralDir = realpathSync(mkdtempSync(join(tmpdir(), "uaw-mcp-bin-")));
  try {
    await withStdioMcp(UAW_MCP_BIN, ["--transport", "stdio"], { cwd: neutralDir }, async ({ request }) => {
      const listed = await request("tools/list", {});
      const names = (listed.result?.tools ?? []).map((t) => t.name);
      for (const expected of [
        "uaw_run",
        "uaw_resume",
        "uaw_gates",
        "uaw_cost",
        "uaw_stage_transition",
        "uaw_question_resolve",
        "uaw_read_state",
        "uaw_read_stages",
        "uaw_read_requirements",
        "uaw_read_adrs",
        "uaw_read_discoveries",
        "uaw_read_issues",
        "uaw_read_reviews",
        "uaw_read_questions",
        "uaw_read_transcript",
      ]) {
        assert.ok(names.includes(expected), `missing tool ${expected} in ${JSON.stringify(names)}`);
      }
    });
  } finally {
    rmSync(neutralDir, { recursive: true, force: true });
  }
});

test("scripts/pack-plugin.mjs emits compliant standalone bundle and read-only --check works", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "uaw-pack-test-")));
  const bundleDir = join(scratch, "uaw-plugin");
  const marketplaceDir = join(scratch, "marketplace");
  const neutralCwd = join(scratch, "neutral-workspace");
  mkdirSync(neutralCwd, { recursive: true });

  try {
    const srcCheck = runNode(PACK_SCRIPT, ["--check"]);
    assert.equal(srcCheck.code, 0, srcCheck.stderr);

    const packed = runNode(PACK_SCRIPT, [
      "--out",
      bundleDir,
      "--marketplace-out",
      marketplaceDir,
    ]);
    assert.equal(packed.code, 0, packed.stderr);
    const summary = JSON.parse(packed.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.version, ROOT_PKG.version);

    // Closed-schema check on Agent Plugins 1.0 plugin.json and mcp.json
    const pluginJson = JSON.parse(readFileSync(join(bundleDir, "plugin.json"), "utf8"));
    assert.equal(pluginJson.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.equal(pluginJson.name, "uaw");
    const allowedPluginKeys = new Set([
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ]);
    for (const k of Object.keys(pluginJson)) {
      assert.ok(allowedPluginKeys.has(k), `unexpected plugin.json key: ${k}`);
    }

    const mcpJson = JSON.parse(readFileSync(join(bundleDir, "mcp.json"), "utf8"));
    assert.equal(mcpJson.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    assert.equal(mcpJson.mcpServers.uaw.type, "stdio");

    // Claude Code dual manifest & Copilot namespace & marketplace.json
    const claudePlugin = JSON.parse(readFileSync(join(bundleDir, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(claudePlugin.$schema, "https://json.schemastore.org/claude-plugin.json");
    assert.equal(claudePlugin.name, "uaw");
    assert.ok(existsSync(join(bundleDir, ".mcp.json")));
    assert.ok(existsSync(join(bundleDir, "hooks", "hooks.json")));
    assert.ok(existsSync(join(bundleDir, "com.github.copilot", "hooks", "hooks.json")));
    assert.ok(readdirSync(join(bundleDir, "com.github.copilot", "prompts")).length > 0);
    assert.ok(readdirSync(join(bundleDir, "com.github.copilot", "instructions")).length > 0);

    const marketplace = JSON.parse(readFileSync(join(marketplaceDir, "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "qwts-uaw");
    assert.equal(marketplace.plugins[0].name, "uaw");
    assert.equal(resolve(marketplaceDir, marketplace.plugins[0].source), bundleDir);

    // Verify all uwf-* skills and all agents copied
    const sourceSkills = readdirSync(join(REPO_ROOT, ".github", "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("uwf-"))
      .map((d) => d.name)
      .sort();
    assert.ok(sourceSkills.length > 0);
    assert.equal(summary.skills, sourceSkills.length);
    for (const s of sourceSkills) {
      assert.ok(existsSync(join(bundleDir, "skills", s, "SKILL.md")), `missing skills/${s}/SKILL.md`);
    }
    const sourceAgents = readdirSync(join(REPO_ROOT, ".github", "agents"))
      .filter((f) => f.endsWith(".agent.md"))
      .sort();
    for (const a of sourceAgents) {
      assert.ok(existsSync(join(bundleDir, "com.github.copilot", "agents", a)));
      assert.ok(existsSync(join(bundleDir, "agents", a.replace(/\.agent\.md$/, ".md"))));
    }

    // Tree hygiene check: zero symlinks, DBs, .node binaries, better-sqlite3, or test/ dirs
    const walked = walkTree(bundleDir);
    for (const item of walked) {
      assert.equal(item.st.isSymbolicLink(), false, `symlink forbidden: ${item.path}`);
      assert.equal(item.name === "better-sqlite3", false, `better-sqlite3 forbidden: ${item.path}`);
      assert.equal(item.name.endsWith(".node"), false, `.node addon forbidden: ${item.path}`);
      assert.equal(
        /\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/.test(item.name),
        false,
        `DB file forbidden: ${item.path}`,
      );
      if (item.st.isDirectory()) {
        assert.notEqual(item.name, "test", `test/ dir forbidden: ${item.path}`);
      }
    }

    // Standalone portability test: resolve ${PLUGIN_ROOT} in mcp.json and run uaw_gates from neutral dir
    const cleanEnv = { ...process.env };
    delete cleanEnv.UWF_SKILLS_ROOT;
    delete cleanEnv.UWF_DATA_DIR;
    delete cleanEnv.UAW_STATE_DIR;

    const swDevStages = yaml.load(
      readFileSync(join(REPO_ROOT, ".github", "skills", "uwf-sw_dev", "stages.yaml"), "utf8"),
    ).stages;

    const resolvedArgs = mcpJson.mcpServers.uaw.args.map((a) => a.replaceAll("${PLUGIN_ROOT}", bundleDir));
    const mcpEntry = resolvedArgs[0];
    const mcpFlags = resolvedArgs.slice(1);
    assert.ok(existsSync(mcpEntry), `packed MCP entrypoint must exist: ${mcpEntry}`);

    await withStdioMcp(mcpEntry, mcpFlags, { cwd: neutralCwd, env: cleanEnv }, async ({ request }) => {
      const resp = await request("tools/call", {
        name: "uaw_gates",
        arguments: {
          workflow: "sw_dev",
          mode: "list",
          repo_root: neutralCwd,
        },
      });
      assert.equal(resp.result?.isError, false, JSON.stringify(resp));
      const payload = resp.result.structuredContent ?? JSON.parse(resp.result.content[0].text);
      assert.equal(payload.exit_code, 0, JSON.stringify(payload));
      assert.ok(Array.isArray(payload.stages) && payload.stages.length === swDevStages.length);
    });

    // Standalone skill script test from neutral cwd (verifies bundle root node_modules/ for M5)
    const skillDataDir = join(scratch, "skill-data");
    const stateInit = runNode(
      join(bundleDir, "skills", "uwf-state-manager", "state.mjs"),
      ["init", "--mode", "issue", "--data-dir", skillDataDir],
      { cwd: neutralCwd, env: cleanEnv },
    );
    assert.equal(stateInit.code, 0, stateInit.stderr || stateInit.stdout);
    assert.equal(JSON.parse(stateInit.stdout).ok, true);

    // Standalone Claude hook test from neutral cwd
    const claudeHooks = JSON.parse(readFileSync(join(bundleDir, "hooks", "hooks.json"), "utf8"));
    const rawCmd = claudeHooks.hooks.PreToolUse[0].hooks[0].command;
    const uawEntry = rawCmd
      .match(/"([^"]+)"/)?.[1]
      ?.replaceAll("${CLAUDE_PLUGIN_ROOT}", bundleDir);
    assert.ok(uawEntry && existsSync(uawEntry), `packed uaw hook binary must exist: ${uawEntry}`);
    const hookOut = runNode(uawEntry, ["hook", "pre-tool-use"], {
      cwd: neutralCwd,
      env: cleanEnv,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/evil" } }),
    });
    assert.equal(hookOut.code, 0, hookOut.stderr);
    assert.equal(JSON.parse(hookOut.stdout).hookSpecificOutput.permissionDecision, "deny");

    // Read-only --check purity test (with --out and --marketplace-out, and --marketplace-out alone)
    const mtimesBefore = new Map(
      walkTree(bundleDir)
        .filter((e) => e.st.isFile())
        .map((e) => [e.path, statSync(e.path).mtimeMs]),
    );
    const checkOk = runNode(PACK_SCRIPT, ["--check", "--out", bundleDir, "--marketplace-out", marketplaceDir]);
    assert.equal(checkOk.code, 0, checkOk.stderr);
    const checkMarketplaceOnly = runNode(PACK_SCRIPT, ["--check", "--marketplace-out", marketplaceDir]);
    assert.equal(checkMarketplaceOnly.code, 0, checkMarketplaceOnly.stderr);
    for (const [filePath, mtime] of mtimesBefore.entries()) {
      assert.equal(statSync(filePath).mtimeMs, mtime, `--check must not touch ${filePath}`);
    }

    // Re-packing onto existing UAW bundle succeeds cleanly (backup-aside swap)
    const repacked = runNode(PACK_SCRIPT, ["--out", bundleDir, "--marketplace-out", marketplaceDir]);
    assert.equal(repacked.code, 0, repacked.stderr);

    // H1 safety guards: refuse repo paths outside dist/<name> and non-empty unrelated dirs
    for (const unsafeArgs of [
      ["--out", "scripts"],
      ["--out", "dist"],
      ["--out", bundleDir, "--marketplace-out", "scripts"],
    ]) {
      const res = runNode(PACK_SCRIPT, unsafeArgs);
      assert.equal(res.code, 2, `Expected usage error exit 2 for ${unsafeArgs.join(" ")}: ${res.stderr}`);
    }
    const unrelatedDir = join(scratch, "unrelated-nonempty");
    mkdirSync(unrelatedDir, { recursive: true });
    writeFileSync(join(unrelatedDir, "keep.txt"), "do not delete\n", "utf8");
    const unrelatedRes = runNode(PACK_SCRIPT, ["--out", unrelatedDir]);
    assert.equal(unrelatedRes.code, 2, unrelatedRes.stderr);
    assert.equal(readFileSync(join(unrelatedDir, "keep.txt"), "utf8"), "do not delete\n");

    // Tamper plugin.json with unknown top-level key and assert --check fails
    writeFileSync(
      join(bundleDir, "plugin.json"),
      JSON.stringify({ ...pluginJson, unexpected_key: true }, null, 2),
      "utf8",
    );
    const checkTampered = runNode(PACK_SCRIPT, ["--check", "--out", bundleDir]);
    assert.equal(checkTampered.code, 1);
    assert.match(checkTampered.stderr, /disallowed top-level key/);

    // Published npm tarball includes scripts/pack-plugin.mjs and runs from a hoisted install
    assert.ok(ROOT_PKG.files.includes("scripts/pack-plugin.mjs"));
    assert.ok(ROOT_PKG.files.includes("schemas/"));
    const packDryJson = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO_ROOT, encoding: "utf8" }),
    );
    const packMeta = Array.isArray(packDryJson)
      ? packDryJson[0]
      : (packDryJson?.[ROOT_PKG.name] ?? Object.values(packDryJson ?? {})[0]);
    const tarballPaths = (packMeta?.files ?? []).map((f) => f.path);
    assert.ok(tarballPaths.includes("scripts/pack-plugin.mjs"), "npm pack tarball must include scripts/pack-plugin.mjs");
    for (const relPath of tarballPaths) {
      assert.equal(
        /\.(?:db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/.test(relPath),
        false,
        `DB file forbidden in npm tarball: ${relPath}`,
      );
      assert.equal(relPath.endsWith(".node"), false, `.node binary forbidden in npm tarball: ${relPath}`);
      assert.equal(
        /(?:^|\/)better-sqlite3(?:\/|$)/.test(relPath),
        false,
        `better-sqlite3 forbidden in npm tarball: ${relPath}`,
      );
      assert.equal(/\/test\//.test(relPath), false, `test/ dir forbidden in npm tarball: ${relPath}`);
    }

    const installedRoot = join(scratch, "installed");
    const installedPkgDir = join(installedRoot, "node_modules", ...ROOT_PKG.name.split("/"));
    for (const relPath of tarballPaths) {
      const destFile = join(installedPkgDir, relPath);
      mkdirSync(dirname(destFile), { recursive: true });
      copyFileSync(join(REPO_ROOT, relPath), destFile);
    }
    const copiedDeps = new Set();
    const depQueue = Object.keys(ROOT_PKG.dependencies ?? {});
    while (depQueue.length > 0) {
      const dep = depQueue.shift();
      if (copiedDeps.has(dep)) continue;
      copiedDeps.add(dep);
      const srcDep = join(REPO_ROOT, "node_modules", ...dep.split("/"));
      cpSync(srcDep, join(installedRoot, "node_modules", ...dep.split("/")), { recursive: true });
      const depPkgPath = join(srcDep, "package.json");
      if (existsSync(depPkgPath)) {
        const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
        depQueue.push(...Object.keys(depPkg.dependencies ?? {}));
      }
    }
    const installedBundleDir = join(scratch, "installed-bundle");
    const installedPack = runNode(
      join(installedPkgDir, "scripts", "pack-plugin.mjs"),
      ["--out", installedBundleDir],
      { cwd: neutralCwd, env: cleanEnv },
    );
    assert.equal(installedPack.code, 0, installedPack.stderr || installedPack.stdout);
    assert.equal(JSON.parse(installedPack.stdout).ok, true);

    // Security: non-node_modules checkout must refuse ancestor node_modules
    const checkoutDir = join(scratch, "checkout");
    const checkoutRepo = join(checkoutDir, "repo");
    cpSync(installedPkgDir, checkoutRepo, { recursive: true });
    cpSync(join(installedRoot, "node_modules"), join(checkoutDir, "node_modules"), {
      recursive: true,
    });
    const ancestorRefused = runNode(join(checkoutRepo, "scripts", "pack-plugin.mjs"), ["--check"], {
      cwd: neutralCwd,
      env: cleanEnv,
    });
    assert.equal(ancestorRefused.code, 1);
    assert.match(ancestorRefused.stderr, /Root node_modules not found/);

    // Security: symlinked node_modules fails closed
    symlinkSync(join(installedRoot, "node_modules"), join(installedPkgDir, "node_modules"));
    const symlinkRefused = runNode(join(installedPkgDir, "scripts", "pack-plugin.mjs"), ["--check"], {
      cwd: neutralCwd,
      env: cleanEnv,
    });
    assert.equal(symlinkRefused.code, 1);
    assert.match(symlinkRefused.stderr, /Symlink/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Dockerfile and action.yml satisfy security and runtime invariants", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22-slim/m);
  assert.match(dockerfile, /^ENV UWF_SKILLS_ROOT=\/opt\/uaw$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["uaw"\]$/m);
  assert.match(dockerfile, /--ignore-scripts/);
  assert.match(dockerfile, /safe\.directory/);
  assert.match(dockerfile, /\.db\*/);

  const dockerignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
  for (const pattern of ["**/node_modules", "**/*.db", "**/.env", "**/tmp", "scripts/**/test"]) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore missing recursive pattern ${pattern}`);
  }

  const actionYml = readFileSync(join(REPO_ROOT, "action.yml"), "utf8");
  assert.match(actionYml, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(actionYml, /--ignore-scripts/);
  assert.match(actionYml, /--repo-root/);

  const actionYaml = yaml.load(actionYml);
  assert.equal(actionYaml.inputs?.data_dir?.default, "");

  const lines = actionYml.split(/\r?\n/);
  const runLines = [];
  let inRunBlock = false;
  let runIndent = -1;
  for (const line of lines) {
    const runMatch = line.match(/^(\s*)run:\s*\|/);
    if (runMatch) {
      inRunBlock = true;
      runIndent = runMatch[1].length;
      continue;
    }
    if (inRunBlock) {
      if (line.trim() === "") {
        runLines.push(line);
        continue;
      }
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent <= runIndent) {
        inRunBlock = false;
      } else {
        runLines.push(line);
      }
    }
  }
  assert.ok(runLines.length > 0, "expected run: | blocks in action.yml");
  assert.equal(
    /\$\{\{\s*inputs\./.test(runLines.join("\n")),
    false,
    "action.yml must pass inputs via env vars, never interpolated in run: blocks",
  );

  // Execute the action.yml invocation step with inapplicable command=resume + dry_run=true
  const uawStep = (actionYaml.runs?.steps ?? []).find(
    (s) => typeof s.run === "string" && s.run.includes("uaw.mjs"),
  );
  assert.ok(uawStep, "expected uaw.mjs invocation step in action.yml");

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "uaw-action-test-")));
  const neutralDir = join(scratch, "workspace");
  const ghOutput = join(scratch, "github_output.txt");
  mkdirSync(neutralDir, { recursive: true });
  writeFileSync(ghOutput, "", "utf8");

  try {
    const runActionStep = (overrides = {}) => {
      writeFileSync(ghOutput, "", "utf8");
      const stepEnv = {
        ...process.env,
        GITHUB_ACTION_PATH: REPO_ROOT,
        GITHUB_WORKSPACE: neutralDir,
        GITHUB_OUTPUT: ghOutput,
        RUNNER_TEMP: scratch,
      };
      for (const [k, rawVal] of Object.entries(uawStep.env ?? {})) {
        stepEnv[k] = String(rawVal)
          .replace(/\$\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g, (_, name) =>
            overrides[name] ?? String(actionYaml.inputs?.[name]?.default ?? ""),
          )
          .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, REPO_ROOT)
          .replace(/\$\{\{\s*github\.workspace\s*\}\}/g, neutralDir)
          .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, scratch);
      }
      try {
        const stdout = execFileSync("bash", ["-euo", "pipefail", "-c", uawStep.run], {
          cwd: neutralDir,
          env: stepEnv,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "", outText: readFileSync(ghOutput, "utf8") };
      } catch (err) {
        return {
          code: err.status ?? 1,
          stdout: err.stdout?.toString() ?? "",
          stderr: err.stderr?.toString() ?? "",
          outText: readFileSync(ghOutput, "utf8"),
        };
      }
    };

    const resumeDry = runActionStep({ command: "resume", dry_run: "true" });
    assert.equal(resumeDry.code, 2);
    assert.match(resumeDry.outText, /^exit_code=2$/m);

    const gatesWithOutputPath = runActionStep({ command: "gates", output_path: "custom-artifacts" });
    assert.equal(gatesWithOutputPath.code, 2);
    assert.match(gatesWithOutputPath.outText, /^exit_code=2$/m);

    // command=cost accepts output_path and forwards --output-path to reconstruct stage prompt sizes
    const costDataDir = join(scratch, "cost-data");
    mkdirSync(join(costDataDir, "transcripts"), { recursive: true });
    writeFileSync(
      join(costDataDir, "transcripts", "0001-discovery.json"),
      JSON.stringify({
        stage: "discovery",
        stdout: JSON.stringify({
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
          },
        }),
      }),
      "utf8",
    );
    const customOutDir = join(neutralDir, "custom-artifacts");
    mkdirSync(customOutDir, { recursive: true });
    writeFileSync(
      join(customOutDir, "issues-intake.md"),
      Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ${"x".repeat(160)}`).join("\n") + "\n",
      "utf8",
    );

    const costDefault = runActionStep({ command: "cost", workflow: "sw_dev", data_dir: costDataDir });
    assert.equal(costDefault.code, 0, costDefault.stderr || costDefault.stdout);
    assert.match(costDefault.outText, /^exit_code=0$/m);

    const costWithOutputPath = runActionStep({
      command: "cost",
      workflow: "sw_dev",
      data_dir: costDataDir,
      output_path: "custom-artifacts",
    });
    assert.equal(costWithOutputPath.code, 0, costWithOutputPath.stderr || costWithOutputPath.stdout);
    assert.match(costWithOutputPath.outText, /^exit_code=0$/m);

    const matchDefault = costDefault.stdout.match(/^discovery\b.*?\s(\d+)\/~\d+\b/m);
    const matchCustom = costWithOutputPath.stdout.match(/^discovery\b.*?\s(\d+)\/~\d+\b/m);
    assert.ok(matchDefault, `Expected discovery prompt column in default cost output:\n${costDefault.stdout}`);
    assert.ok(matchCustom, `Expected discovery prompt column in custom output_path cost output:\n${costWithOutputPath.stdout}`);
    assert.ok(
      Number(matchCustom[1]) > Number(matchDefault[1]) + 1000,
      `Expected custom output_path prompt chars (${matchCustom[1]}) > default (${matchDefault[1]}) + 1000`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bin/uaw.mjs and bin/uaw-mcp.mjs enforce Node >= 22.13.0 with exit code 2", () => {
  const preload =
    'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.12.0",configurable:true})';
  for (const binPath of [UAW_BIN, UAW_MCP_BIN]) {
    const res = runNode(binPath, ["--help"], { nodeArgs: ["--import", preload] });
    assert.equal(res.code, 2, `${binPath} expected exit 2, got ${res.code}: ${res.stderr}`);
    assert.match(res.stderr, /22\.13\.0/);
  }
});
