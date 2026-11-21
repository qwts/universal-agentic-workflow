#!/usr/bin/env node
/**
 * pack-plugin.mjs — Build or verify a self-contained cross-client Agent Plugin
 * bundle for Universal Agentic Workflow (Agent Plugins 1.0 + Claude Code + Copilot).
 *
 * Usage:
 *   node scripts/pack-plugin.mjs [--out <dir>] [--version <semver>] [--marketplace-out <dir>]
 *   node scripts/pack-plugin.mjs --check [--out <dir>] [--marketplace-out <dir>]
 *   node scripts/pack-plugin.mjs --help
 *
 * Exit codes:
 *   0  success
 *   1  validation / check failure
 *   2  usage error
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const CLAUDE_PLUGIN_SCHEMA = "https://json.schemastore.org/claude-plugin.json";

const CLOSED_PLUGIN_KEYS = new Set([
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

const CLOSED_MCP_KEYS = new Set(["$schema", "mcpServers"]);

const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VALID_PKG_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

const DB_SIDECAR_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite", ".sqlite3"];

class UsageError extends Error {}
class ValidationError extends Error {}

function usageText() {
  return [
    "pack-plugin.mjs — Build or verify UAW cross-client Agent Plugin bundle",
    "",
    "Usage:",
    "  node scripts/pack-plugin.mjs [--out <dir>] [--version <semver>] [--marketplace-out <dir>]",
    "  node scripts/pack-plugin.mjs --check [--out <dir>] [--marketplace-out <dir>]",
    "  node scripts/pack-plugin.mjs --help",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const flags = { check: false, help: false };
  const valueFlags = new Set(["out", "version", "marketplace-out"]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      flags.help = true;
      continue;
    }
    if (tok === "--check") {
      flags.check = true;
      continue;
    }
    if (!tok.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument "${tok}"`);
    }
    const key = tok.slice(2);
    if (!valueFlags.has(key)) {
      throw new UsageError(`Unknown flag "--${key}"`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`--${key} requires a value`);
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function isDbFileName(name) {
  return DB_SIDECAR_SUFFIXES.some((s) => name.endsWith(s));
}

function validatePluginName(name) {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 64 ||
    name.includes("--") ||
    name.includes("..") ||
    !PLUGIN_NAME_RE.test(name)
  ) {
    throw new ValidationError(`Invalid Agent Plugin name "${name}"`);
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function resolveWithAncestorRealpath(targetPath) {
  let cur = resolve(targetPath);
  const tail = [];
  while (true) {
    const st = lstatOrNull(cur);
    if (st) {
      let baseReal;
      try {
        baseReal = realpathSync(cur);
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new UsageError(`Broken symbolic link in target path: ${cur}`);
        }
        throw err;
      }
      return join(baseReal, ...tail);
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return join(cur, ...tail);
    }
    tail.unshift(basename(cur));
    cur = parent;
  }
}

function isAncestorOrSame(ancestor, descendant) {
  const rel = relative(ancestor, descendant);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafeTargetDir(
  targetDir,
  label,
  { requireDistIfInRepo = false, requireBundleOrEmpty = false } = {},
) {
  if (!targetDir || typeof targetDir !== "string") {
    throw new UsageError(`${label} must be a non-empty directory path`);
  }
  const abs = resolve(targetDir);
  const absSt = lstatOrNull(abs);
  if (absSt?.isSymbolicLink()) {
    throw new UsageError(`${label} must not be a symbolic link: ${abs}`);
  }
  if (absSt && !absSt.isDirectory()) {
    throw new UsageError(`${label} must be a directory: ${abs}`);
  }

  const canonical = resolveWithAncestorRealpath(abs);
  const homeReal = resolveWithAncestorRealpath(homedir());
  const repoReal = realpathSync(REPO_ROOT);
  const distPath = join(repoReal, "dist");
  if (lstatOrNull(distPath)?.isSymbolicLink()) {
    throw new UsageError(`Repository dist directory must not be a symbolic link: ${distPath}`);
  }

  if (
    canonical === "/" ||
    isAncestorOrSame(canonical, homeReal) ||
    isAncestorOrSame(canonical, repoReal)
  ) {
    throw new UsageError(`Refusing unsafe ${label} path: ${abs}`);
  }

  if (requireDistIfInRepo && isAncestorOrSame(repoReal, canonical)) {
    const relDist = relative(distPath, canonical);
    if (relDist === "" || relDist.startsWith("..") || isAbsolute(relDist)) {
      throw new UsageError(`Refusing ${label} inside repository outside dist/<name>: ${abs}`);
    }
  }

  if (requireBundleOrEmpty && absSt) {
    const entries = readdirSync(canonical);
    if (entries.length > 0) {
      const manifestPath = join(canonical, "plugin.json");
      let isUawBundle = false;
      if (existsSync(manifestPath)) {
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
          isUawBundle = parsed?.name === "uaw";
        } catch {
          isUawBundle = false;
        }
      }
      if (!isUawBundle) {
        throw new UsageError(
          `Refusing to overwrite non-empty directory without UAW plugin.json at ${abs}`,
        );
      }
    }
  }

  return canonical;
}

function assertNotSymlink(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new ValidationError(`Symlink is not allowed in plugin inputs or bundle: ${path}`);
  }
  return st;
}

function copyTreeSafe(srcDir, destDir, { skipNames = new Set(), skipTests = true } = {}) {
  const srcSt = assertNotSymlink(srcDir);
  if (!srcSt.isDirectory()) {
    throw new ValidationError(`Expected directory at ${srcDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const st = assertNotSymlink(srcPath);

    if (
      entry.name === ".DS_Store" ||
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".env" ||
      entry.name === "tmp" ||
      skipNames.has(entry.name)
    ) {
      continue;
    }
    if (skipTests && entry.isDirectory() && entry.name === "test") {
      continue;
    }
    if (isDbFileName(entry.name) || entry.name.endsWith(".node")) {
      if (entry.name.endsWith(".node")) {
        throw new ValidationError(`Native .node addon is not allowed in plugin bundle: ${srcPath}`);
      }
      continue;
    }

    if (st.isDirectory()) {
      copyTreeSafe(srcPath, destPath, { skipNames, skipTests });
    } else if (st.isFile()) {
      copyFileSync(srcPath, destPath);
      chmodSync(destPath, st.mode & 0o777);
    }
  }
}

function validatePackageName(dep) {
  if (typeof dep !== "string" || !VALID_PKG_NAME_RE.test(dep)) {
    throw new ValidationError(`Invalid dependency package name: "${dep}"`);
  }
  for (const seg of dep.split("/")) {
    if (seg === "." || seg === ".." || seg === "@." || seg === "@..") {
      throw new ValidationError(`Unsafe dependency package name segment in "${dep}"`);
    }
  }
}

function getAllowedNodeModulesRoots() {
  const ownNm = join(REPO_ROOT, "node_modules");
  const parentDir = dirname(REPO_ROOT);
  const parentName = basename(parentDir);

  let enclosingNm = null;
  if (parentName === "node_modules") {
    enclosingNm = parentDir;
  } else if (parentName.startsWith("@") && basename(dirname(parentDir)) === "node_modules") {
    assertNotSymlink(parentDir);
    enclosingNm = dirname(parentDir);
  }

  const roots = [];
  const ownSt = lstatOrNull(ownNm);
  if (ownSt) {
    assertNotSymlink(ownNm);
    if (!ownSt.isDirectory()) {
      throw new ValidationError(`Expected directory at ${ownNm}`);
    }
    roots.push(ownNm);
  }

  if (enclosingNm) {
    assertNotSymlink(REPO_ROOT);
    const encSt = assertNotSymlink(enclosingNm);
    if (!encSt.isDirectory()) {
      throw new ValidationError(`Expected directory at ${enclosingNm}`);
    }
    roots.push(enclosingNm);
  } else if (roots.length === 0) {
    throw new ValidationError(
      `Root node_modules not found at ${ownNm}; run "npm ci" at repository root first.`,
    );
  }

  return roots;
}

function resolveRuntimeDepDir(dep, allowedNmRoots, minRootIdx) {
  const segs = dep.split("/");
  for (let i = minRootIdx; i < allowedNmRoots.length; i += 1) {
    const nmDir = allowedNmRoots[i];
    if (segs.length === 2) {
      const scopeDir = join(nmDir, segs[0]);
      if (lstatOrNull(scopeDir)) {
        assertNotSymlink(scopeDir);
      }
    }
    const depDir = join(nmDir, ...segs);
    if (lstatOrNull(depDir)) {
      const depSt = assertNotSymlink(depDir);
      if (!depSt.isDirectory()) {
        throw new ValidationError(`Expected dependency directory at ${depDir}`);
      }
      return { depDir, rootIdx: i };
    }
  }
  const searched = allowedNmRoots.slice(minRootIdx).join(", ");
  throw new ValidationError(`Missing dependency "${dep}" in ${searched}; run "npm ci" first.`);
}

function collectRuntimeDeps(rootPkg) {
  const allowedNmRoots = getAllowedNodeModulesRoots();
  const resolved = new Map();
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((dep) => ({ dep, minRootIdx: 0 }));
  while (queue.length > 0) {
    const { dep, minRootIdx } = queue.shift();
    validatePackageName(dep);
    if (dep === "better-sqlite3") {
      throw new ValidationError(`Forbidden native dependency "${dep}" in root dependencies`);
    }
    const { depDir, rootIdx } = resolveRuntimeDepDir(dep, allowedNmRoots, minRootIdx);
    const existing = resolved.get(dep);
    if (existing !== undefined) {
      if (existing !== depDir) {
        throw new ValidationError(
          `Conflicting dependency resolutions for "${dep}": ${existing} vs ${depDir}`,
        );
      }
      continue;
    }
    const nestedNm = join(depDir, "node_modules");
    if (lstatOrNull(nestedNm)) {
      assertNotSymlink(nestedNm);
      throw new ValidationError(
        `Nested node_modules found inside "${dep}" at ${nestedNm}; hoist dependencies at root before packing.`,
      );
    }
    resolved.set(dep, depDir);
    const depPkgPath = join(depDir, "package.json");
    if (lstatOrNull(depPkgPath)) {
      assertNotSymlink(depPkgPath);
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
      for (const childDep of Object.keys(depPkg.dependencies ?? {})) {
        validatePackageName(childDep);
        queue.push({ dep: childDep, minRootIdx: rootIdx });
      }
    }
  }
  return [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readRootPkg() {
  const pkgPath = join(REPO_ROOT, "package.json");
  if (!existsSync(pkgPath)) {
    throw new ValidationError(`Missing root package.json at ${pkgPath}`);
  }
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function assertCleanDirectoryTree(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const st = assertNotSymlink(dir);
    if (!st.isDirectory()) {
      throw new ValidationError(`Expected directory: ${dir}`);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const entrySt = assertNotSymlink(fullPath);
      if (entry.name === "better-sqlite3") {
        throw new ValidationError(`Forbidden better-sqlite3 entry found: ${fullPath}`);
      }
      if (entry.name.endsWith(".node")) {
        throw new ValidationError(`Forbidden native .node binary found: ${fullPath}`);
      }
      if (isDbFileName(entry.name)) {
        throw new ValidationError(`Forbidden SQLite DB file found in bundle: ${fullPath}`);
      }
      if (entrySt.isDirectory()) {
        if (entry.name === "test") {
          throw new ValidationError(`Forbidden test/ directory found in bundle: ${fullPath}`);
        }
        stack.push(fullPath);
      }
    }
  }
}

export function validateSourceReadiness() {
  const rootPkg = readRootPkg();
  if (rootPkg.dependencies && Object.hasOwn(rootPkg.dependencies, "better-sqlite3")) {
    throw new ValidationError("Root package.json must not depend on better-sqlite3");
  }
  const requiredFiles = [
    "bin/uaw.mjs",
    "bin/uaw-mcp.mjs",
    "scripts/uwf-runner/runner.mjs",
    "scripts/uaw-mcp/server.mjs",
    "scripts/hooks/preToolUse.mjs",
    "schemas/uaw-manifest.schema.json",
  ];
  for (const rel of requiredFiles) {
    const p = join(REPO_ROOT, rel);
    if (!existsSync(p)) throw new ValidationError(`Missing required source file: ${rel}`);
    assertNotSymlink(p);
  }
  const requiredDirs = [
    ".github/skills",
    ".github/agents",
    ".github/prompts",
    ".github/instructions",
    "scripts/uwf-runner",
    "scripts/uaw-mcp",
    "scripts/hooks",
    "schemas",
  ];
  for (const rel of requiredDirs) {
    const p = join(REPO_ROOT, rel);
    if (!existsSync(p)) {
      throw new ValidationError(`Missing required source directory: ${rel}`);
    }
    const st = assertNotSymlink(p);
    if (!st.isDirectory()) {
      throw new ValidationError(`Missing required source directory: ${rel}`);
    }
  }
  collectRuntimeDeps(rootPkg);
  return { ok: true, mode: "source-check", rootVersion: rootPkg.version };
}

export function validatePackedBundle(bundleDir, { marketplaceOut } = {}) {
  if (!existsSync(bundleDir)) {
    throw new ValidationError(`Plugin bundle directory does not exist: ${bundleDir}`);
  }
  assertCleanDirectoryTree(bundleDir);

  const requiredFiles = [
    "plugin.json",
    "mcp.json",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "com.github.copilot/hooks/hooks.json",
    "node_modules/js-yaml/package.json",
    "runtime/package.json",
    "runtime/bin/uaw.mjs",
    "runtime/bin/uaw-mcp.mjs",
    "runtime/scripts/uwf-runner/runner.mjs",
    "runtime/scripts/uaw-mcp/server.mjs",
    "runtime/scripts/hooks/preToolUse.mjs",
    "runtime/schemas/uaw-manifest.schema.json",
    "runtime/node_modules/js-yaml/package.json",
  ];
  for (const rel of requiredFiles) {
    const p = join(bundleDir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) {
      throw new ValidationError(`Missing required bundle file: ${rel}`);
    }
  }

  const pluginManifest = JSON.parse(readFileSync(join(bundleDir, "plugin.json"), "utf8"));
  if (pluginManifest.$schema !== AGENT_PLUGIN_SCHEMA) {
    throw new ValidationError(`plugin.json $schema must equal ${AGENT_PLUGIN_SCHEMA}`);
  }
  for (const k of Object.keys(pluginManifest)) {
    if (!CLOSED_PLUGIN_KEYS.has(k)) {
      throw new ValidationError(`plugin.json contains disallowed top-level key "${k}"`);
    }
  }
  validatePluginName(pluginManifest.name);
  if (pluginManifest.version && !SEMVER_RE.test(pluginManifest.version)) {
    throw new ValidationError(`plugin.json version is not valid semver: ${pluginManifest.version}`);
  }

  const mcpManifest = JSON.parse(readFileSync(join(bundleDir, "mcp.json"), "utf8"));
  if (mcpManifest.$schema !== AGENT_MCP_SCHEMA) {
    throw new ValidationError(`mcp.json $schema must equal ${AGENT_MCP_SCHEMA}`);
  }
  for (const k of Object.keys(mcpManifest)) {
    if (!CLOSED_MCP_KEYS.has(k)) {
      throw new ValidationError(`mcp.json contains disallowed top-level key "${k}"`);
    }
  }
  if (!mcpManifest.mcpServers?.uaw || mcpManifest.mcpServers.uaw.type !== "stdio") {
    throw new ValidationError("mcp.json must define mcpServers.uaw with type 'stdio'");
  }

  const claudeManifest = JSON.parse(
    readFileSync(join(bundleDir, ".claude-plugin", "plugin.json"), "utf8"),
  );
  if (claudeManifest.$schema !== CLAUDE_PLUGIN_SCHEMA || claudeManifest.name !== pluginManifest.name) {
    throw new ValidationError(".claude-plugin/plugin.json manifest mismatch");
  }

  const claudeMcp = JSON.parse(readFileSync(join(bundleDir, ".mcp.json"), "utf8"));
  if (
    !claudeMcp.mcpServers?.uaw ||
    typeof claudeMcp.mcpServers.uaw.command !== "string" ||
    !Array.isArray(claudeMcp.mcpServers.uaw.args)
  ) {
    throw new ValidationError(".mcp.json must define mcpServers.uaw with command and args");
  }

  const claudeHooks = JSON.parse(readFileSync(join(bundleDir, "hooks", "hooks.json"), "utf8"));
  if (!Array.isArray(claudeHooks.hooks?.PreToolUse) || claudeHooks.hooks.PreToolUse.length === 0) {
    throw new ValidationError("hooks/hooks.json must define a non-empty hooks.PreToolUse array");
  }

  const copilotHooks = JSON.parse(
    readFileSync(join(bundleDir, "com.github.copilot", "hooks", "hooks.json"), "utf8"),
  );
  if (!Array.isArray(copilotHooks.hooks?.PreToolUse) || copilotHooks.hooks.PreToolUse.length === 0) {
    throw new ValidationError(
      "com.github.copilot/hooks/hooks.json must define a non-empty hooks.PreToolUse array",
    );
  }

  for (const subDir of ["prompts", "instructions"]) {
    const dirPath = join(bundleDir, "com.github.copilot", subDir);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory() || readdirSync(dirPath).length === 0) {
      throw new ValidationError(`com.github.copilot/${subDir} must be a non-empty directory`);
    }
  }

  const skillDirs = readdirSync(join(bundleDir, "skills"), { withFileTypes: true }).filter(
    (d) => d.isDirectory() && d.name.startsWith("uwf-"),
  );
  if (skillDirs.length === 0) {
    throw new ValidationError("skills/ contains no uwf-* skill directories");
  }
  for (const d of skillDirs) {
    if (!existsSync(join(bundleDir, "skills", d.name, "SKILL.md"))) {
      throw new ValidationError(`skills/${d.name} missing SKILL.md`);
    }
  }

  const runtimeSkillsDir = join(bundleDir, "runtime", ".github", "skills");
  if (!existsSync(runtimeSkillsDir) || !statSync(runtimeSkillsDir).isDirectory()) {
    throw new ValidationError("runtime/.github/skills directory missing");
  }
  const runtimeSkillDirs = readdirSync(runtimeSkillsDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && d.name.startsWith("uwf-"),
  );
  if (runtimeSkillDirs.length !== skillDirs.length) {
    throw new ValidationError("runtime/.github/skills out of sync with bundle skills/");
  }

  const copilotAgents = readdirSync(join(bundleDir, "com.github.copilot", "agents")).filter((f) =>
    f.endsWith(".agent.md"),
  );
  const claudeAgents = readdirSync(join(bundleDir, "agents")).filter((f) => f.endsWith(".md"));
  const runtimeAgentsDir = join(bundleDir, "runtime", ".github", "agents");
  const runtimeAgents = existsSync(runtimeAgentsDir)
    ? readdirSync(runtimeAgentsDir).filter((f) => f.endsWith(".agent.md"))
    : [];
  if (
    copilotAgents.length === 0 ||
    claudeAgents.length !== copilotAgents.length ||
    runtimeAgents.length !== copilotAgents.length
  ) {
    throw new ValidationError(
      "Agent definitions missing or out of sync across copilot, claude, and runtime",
    );
  }

  if (marketplaceOut) {
    const mpPath = join(marketplaceOut, "marketplace.json");
    if (!existsSync(mpPath)) {
      throw new ValidationError(`Missing marketplace.json at ${mpPath}`);
    }
    const mp = JSON.parse(readFileSync(mpPath, "utf8"));
    if (!mp.name || !Array.isArray(mp.plugins) || mp.plugins.length === 0) {
      throw new ValidationError(`Invalid marketplace.json structure at ${mpPath}`);
    }
    const rawSource = mp.plugins[0]?.source;
    if (typeof rawSource !== "string" || !rawSource.trim()) {
      throw new ValidationError(`Invalid plugins[0].source in ${mpPath}`);
    }
    const resolvedSource = resolve(realpathSync(marketplaceOut), rawSource);
    if (!existsSync(resolvedSource) || realpathSync(resolvedSource) !== realpathSync(bundleDir)) {
      throw new ValidationError(
        `marketplace.json plugins[0].source (${rawSource}) does not resolve to bundle ${bundleDir}`,
      );
    }
  }

  return {
    ok: true,
    mode: "bundle-check",
    outDir: bundleDir,
    skills: skillDirs.length,
    agents: claudeAgents.length,
  };
}

export function buildPluginBundle({ outDir, version, marketplaceOut } = {}) {
  const rootPkg = readRootPkg();
  const resolvedVersion = version ?? rootPkg.version ?? "0.1.0";
  if (!SEMVER_RE.test(resolvedVersion)) {
    throw new UsageError(`Invalid --version "${resolvedVersion}" (expected semver)`);
  }

  const targetOut = assertSafeTargetDir(outDir ?? join(REPO_ROOT, "dist", "uaw-plugin"), "--out", {
    requireDistIfInRepo: true,
    requireBundleOrEmpty: true,
  });
  const targetMarketplace = marketplaceOut
    ? assertSafeTargetDir(marketplaceOut, "--marketplace-out", { requireDistIfInRepo: true })
    : null;
  if (targetMarketplace && targetMarketplace === targetOut) {
    throw new UsageError("--marketplace-out must be distinct from --out");
  }

  validateSourceReadiness();
  const deps = collectRuntimeDeps(rootPkg);

  mkdirSync(dirname(targetOut), { recursive: true });
  const stagingDir = join(
    dirname(targetOut),
    `.${basename(targetOut)}.staging-${process.pid}-${Date.now()}`,
  );

  try {
    mkdirSync(stagingDir, { recursive: true });

    const commonMeta = {
      name: "uaw",
      version: resolvedVersion,
      description:
        rootPkg.description ??
        "Universal Agentic Workflow (UAW) — gate-enforced stage workflows and MCP runtime",
      author: {
        name: "qwts",
        url: "https://github.com/qwts",
      },
      homepage: "https://github.com/qwts/universal-agentic-workflow",
      repository: "https://github.com/qwts/universal-agentic-workflow.git",
      license: rootPkg.license ?? "MIT",
      keywords: ["uaw", "uwf", "workflow", "agents", "skills", "mcp"],
    };

    // 1. Agent Plugins 1.0 manifest + MCP config
    writeJson(join(stagingDir, "plugin.json"), {
      $schema: AGENT_PLUGIN_SCHEMA,
      ...commonMeta,
    });
    writeJson(join(stagingDir, "mcp.json"), {
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: {
        uaw: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/runtime/bin/uaw-mcp.mjs", "--transport", "stdio"],
        },
      },
    });

    // 2. Claude Code dual-manifest + MCP + hooks
    writeJson(join(stagingDir, ".claude-plugin", "plugin.json"), {
      $schema: CLAUDE_PLUGIN_SCHEMA,
      name: commonMeta.name,
      version: commonMeta.version,
      description: commonMeta.description,
      author: commonMeta.author,
      homepage: commonMeta.homepage,
      license: commonMeta.license,
      keywords: commonMeta.keywords,
      skills: ["./skills"],
      agents: ["./agents"],
      hooks: "./hooks/hooks.json",
      mcpServers: "./.mcp.json",
    });
    writeJson(join(stagingDir, ".mcp.json"), {
      mcpServers: {
        uaw: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/runtime/bin/uaw-mcp.mjs", "--transport", "stdio"],
        },
      },
    });
    writeJson(join(stagingDir, "hooks", "hooks.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Edit|Write|MultiEdit",
            hooks: [
              {
                type: "command",
                command: "node \"${CLAUDE_PLUGIN_ROOT}/runtime/bin/uaw.mjs\" hook pre-tool-use",
              },
            ],
          },
        ],
      },
    });

    // 3. Portable skills/ & Claude agents/
    copyTreeSafe(join(REPO_ROOT, ".github", "skills"), join(stagingDir, "skills"), {
      skipNames: new Set(["package-lock.json", "package.json"]),
    });
    const srcAgentsDir = join(REPO_ROOT, ".github", "agents");
    mkdirSync(join(stagingDir, "agents"), { recursive: true });
    for (const file of readdirSync(srcAgentsDir).sort()) {
      const srcFile = join(srcAgentsDir, file);
      const st = assertNotSymlink(srcFile);
      if (!st.isFile() || !file.endsWith(".agent.md")) continue;
      const claudeName = file.replace(/\.agent\.md$/, ".md");
      copyFileSync(srcFile, join(stagingDir, "agents", claudeName));
    }

    // 4. VS Code / Copilot reverse-domain namespace
    copyTreeSafe(srcAgentsDir, join(stagingDir, "com.github.copilot", "agents"));
    copyTreeSafe(
      join(REPO_ROOT, ".github", "prompts"),
      join(stagingDir, "com.github.copilot", "prompts"),
    );
    copyTreeSafe(
      join(REPO_ROOT, ".github", "instructions"),
      join(stagingDir, "com.github.copilot", "instructions"),
    );
    writeJson(join(stagingDir, "com.github.copilot", "hooks", "hooks.json"), {
      hooks: {
        PreToolUse: [
          {
            type: "command",
            command: "node \"${PLUGIN_ROOT}/runtime/bin/uaw.mjs\" hook pre-tool-use",
            timeout: 15,
          },
        ],
      },
    });

    // 5. Self-contained pure-JS runtime/
    const runtimeDir = join(stagingDir, "runtime");
    writeJson(join(runtimeDir, "package.json"), {
      name: rootPkg.name ?? "@qwts/uaw",
      version: resolvedVersion,
      type: "module",
      license: rootPkg.license ?? "MIT",
      engines: rootPkg.engines ?? { node: ">=22.13.0" },
      bin: {
        uaw: "./bin/uaw.mjs",
        "uaw-mcp": "./bin/uaw-mcp.mjs",
      },
      dependencies: rootPkg.dependencies ?? {},
    });
    copyTreeSafe(join(REPO_ROOT, "bin"), join(runtimeDir, "bin"));
    chmodSync(join(runtimeDir, "bin", "uaw.mjs"), 0o755);
    chmodSync(join(runtimeDir, "bin", "uaw-mcp.mjs"), 0o755);

    copyTreeSafe(join(REPO_ROOT, "scripts", "uwf-runner"), join(runtimeDir, "scripts", "uwf-runner"));
    copyTreeSafe(join(REPO_ROOT, "scripts", "uaw-mcp"), join(runtimeDir, "scripts", "uaw-mcp"));
    copyTreeSafe(join(REPO_ROOT, "scripts", "hooks"), join(runtimeDir, "scripts", "hooks"));
    copyTreeSafe(join(REPO_ROOT, "schemas"), join(runtimeDir, "schemas"));
    copyTreeSafe(
      join(REPO_ROOT, ".github", "skills"),
      join(runtimeDir, ".github", "skills"),
      { skipNames: new Set(["package-lock.json"]) },
    );
    copyTreeSafe(join(REPO_ROOT, ".github", "agents"), join(runtimeDir, ".github", "agents"));

    for (const [dep, srcDepDir] of deps) {
      const depSegments = dep.split("/");
      copyTreeSafe(srcDepDir, join(stagingDir, "node_modules", ...depSegments));
      copyTreeSafe(srcDepDir, join(runtimeDir, "node_modules", ...depSegments));
    }

    // Validate before atomic swap into targetOut
    const summary = validatePackedBundle(stagingDir);

    const backupDir = lstatOrNull(targetOut)
      ? join(dirname(targetOut), `.${basename(targetOut)}.backup-${process.pid}-${Date.now()}`)
      : null;
    if (backupDir) {
      renameSync(targetOut, backupDir);
    }
    try {
      renameSync(stagingDir, targetOut);
    } catch (swapErr) {
      if (backupDir && lstatOrNull(backupDir) && !lstatOrNull(targetOut)) {
        try {
          renameSync(backupDir, targetOut);
        } catch {
          // Best-effort restore; preserve original swap error
        }
      }
      throw swapErr;
    }
    if (backupDir) {
      rmSync(backupDir, { recursive: true, force: true });
    }

    if (targetMarketplace) {
      mkdirSync(targetMarketplace, { recursive: true });
      const relPosix = relative(targetMarketplace, targetOut).split(sep).join(posix.sep);
      const sourcePath = relPosix.startsWith(".") ? relPosix : `./${relPosix}`;
      writeJson(join(targetMarketplace, "marketplace.json"), {
        name: "qwts-uaw",
        owner: commonMeta.author,
        metadata: {
          description: commonMeta.description,
          version: resolvedVersion,
        },
        plugins: [
          {
            name: commonMeta.name,
            source: sourcePath,
            description: commonMeta.description,
            version: resolvedVersion,
          },
        ],
      });
    }

    return {
      ...summary,
      mode: "build",
      outDir: targetOut,
      marketplaceOut: targetMarketplace,
      version: resolvedVersion,
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function isDirectCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function resolveBundleFromMarketplace(marketplaceDir) {
  const absMarketplace = resolve(marketplaceDir);
  const mpPath = join(absMarketplace, "marketplace.json");
  if (!existsSync(mpPath)) {
    throw new ValidationError(`Missing marketplace.json at ${mpPath}`);
  }
  const mp = JSON.parse(readFileSync(mpPath, "utf8"));
  const rawSource = Array.isArray(mp.plugins) ? mp.plugins[0]?.source : null;
  if (typeof rawSource !== "string" || !rawSource.trim()) {
    throw new ValidationError(
      `Invalid marketplace.json structure (missing plugins[0].source) at ${mpPath}`,
    );
  }
  return resolve(absMarketplace, rawSource);
}

if (isDirectCliEntry()) {
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) {
      process.stdout.write(usageText());
      process.exit(0);
    }
    if (flags.check) {
      const marketplaceOut = flags["marketplace-out"]
        ? resolve(flags["marketplace-out"])
        : undefined;
      let result;
      if (flags.out) {
        result = validatePackedBundle(resolve(flags.out), { marketplaceOut });
      } else if (marketplaceOut) {
        result = validatePackedBundle(resolveBundleFromMarketplace(marketplaceOut), {
          marketplaceOut,
        });
      } else {
        result = validateSourceReadiness();
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    const result = buildPluginBundle({
      outDir: flags.out,
      version: flags.version,
      marketplaceOut: flags["marketplace-out"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[pack-plugin] ${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
