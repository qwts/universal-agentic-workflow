#!/usr/bin/env node
/**
 * stage-bundle.mjs — Stage UAW's pure-JS Agent Plugin bundle into
 * `uwf-companion/dist/uaw-plugin` and synchronize/verify VS Code's declarative
 * AI contribution arrays (`chatAgents`, `chatSkills`, `chatPromptFiles`,
 * `chatInstructions`) in `uwf-companion/package.json`.
 *
 * Usage:
 *   node scripts/stage-bundle.mjs [--version <semver>]
 *   node scripts/stage-bundle.mjs --sync-manifest [--version <semver>]
 *   node scripts/stage-bundle.mjs --check-manifest
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(COMPANION_ROOT, "..");
const PACK_SCRIPT = join(REPO_ROOT, "scripts", "pack-plugin.mjs");
const DIST_DIR = join(COMPANION_ROOT, "dist");
const DEST_DIR = join(DIST_DIR, "uaw-plugin");
const PKG_PATH = join(COMPANION_ROOT, "package.json");

const CONTRIB_KEYS = ["chatAgents", "chatSkills", "chatPromptFiles", "chatInstructions"];

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function assertNotSymlink(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    throw new Error(`Symbolic link is not allowed: ${p}`);
  }
  return st;
}

function parseArgs(argv) {
  const flags = { checkManifest: false, syncManifest: false, version: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--check-manifest") {
      flags.checkManifest = true;
    } else if (tok === "--sync-manifest") {
      flags.syncManifest = true;
    } else if (tok === "--version") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--version requires a semver value");
      }
      flags.version = next;
      i += 1;
    } else {
      throw new Error(`Unknown flag "${tok}"`);
    }
  }
  return flags;
}

function runPacker(args) {
  execFileSync(process.execPath, [PACK_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function stageBundle({ version } = {}) {
  for (const dirPath of [COMPANION_ROOT, DIST_DIR, DEST_DIR]) {
    const st = lstatOrNull(dirPath);
    if (st?.isSymbolicLink()) {
      throw new Error(`Refusing symlinked directory: ${dirPath}`);
    }
  }

  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "uwf-companion-bundle-")));
  const tmpBundle = join(tmpRoot, "uaw-plugin");

  try {
    const packArgs = ["--out", tmpBundle];
    if (version) packArgs.push("--version", version);
    runPacker(packArgs);
    runPacker(["--check", "--out", tmpBundle]);

    mkdirSync(DIST_DIR, { recursive: true });
    assertNotSymlink(DIST_DIR);

    const siblingStaging = join(DIST_DIR, `.uaw-plugin.staging-${process.pid}-${Date.now()}`);
    const siblingBackup = lstatOrNull(DEST_DIR)
      ? join(DIST_DIR, `.uaw-plugin.backup-${process.pid}-${Date.now()}`)
      : null;

    try {
      cpSync(tmpBundle, siblingStaging, { recursive: true, dereference: false });
      if (siblingBackup) {
        renameSync(DEST_DIR, siblingBackup);
      }
      try {
        renameSync(siblingStaging, DEST_DIR);
      } catch (swapErr) {
        if (siblingBackup && lstatOrNull(siblingBackup) && !lstatOrNull(DEST_DIR)) {
          try {
            renameSync(siblingBackup, DEST_DIR);
          } catch {
            /* preserve original swap error */
          }
        }
        throw swapErr;
      }
      if (siblingBackup) {
        rmSync(siblingBackup, { recursive: true, force: true });
      }
    } finally {
      rmSync(siblingStaging, { recursive: true, force: true });
    }

    runPacker(["--check", "--out", DEST_DIR]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function toRelEntry(absPath) {
  const rel = relative(COMPANION_ROOT, absPath).split("\\").join("/");
  return { path: `./${rel}` };
}

function collectExpectedContributions(bundleDir) {
  if (!lstatOrNull(bundleDir)) {
    throw new Error(
      `Staged bundle not found at ${bundleDir}. Run "node scripts/stage-bundle.mjs" first.`,
    );
  }
  const bundleSt = assertNotSymlink(bundleDir);
  if (!bundleSt.isDirectory()) {
    throw new Error(`Expected directory at ${bundleDir}`);
  }

  const agentsDir = join(bundleDir, "com.github.copilot", "agents");
  const promptsDir = join(bundleDir, "com.github.copilot", "prompts");
  const instructionsDir = join(bundleDir, "com.github.copilot", "instructions");
  const skillsDir = join(bundleDir, "skills");

  const chatAgents = readdirSync(agentsDir)
    .filter((f) => f.endsWith(".agent.md"))
    .sort()
    .map((f) => toRelEntry(join(agentsDir, f)));

  const chatSkills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("uwf-"))
    .map((d) => d.name)
    .sort()
    .map((dirName) => {
      const skillMd = join(skillsDir, dirName, "SKILL.md");
      if (!existsSync(skillMd)) {
        throw new Error(`Missing SKILL.md inside staged skill ${dirName}`);
      }
      return toRelEntry(skillMd);
    });

  const chatPromptFiles = readdirSync(promptsDir)
    .filter((f) => f.endsWith(".prompt.md"))
    .sort()
    .map((f) => toRelEntry(join(promptsDir, f)));

  const chatInstructions = readdirSync(instructionsDir)
    .filter((f) => f.endsWith(".instructions.md"))
    .sort()
    .map((f) => toRelEntry(join(instructionsDir, f)));

  return { chatAgents, chatSkills, chatPromptFiles, chatInstructions };
}

function assertDeclaredFilesValid(entries, key) {
  const companionReal = realpathSync(COMPANION_ROOT);
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith("./")) {
      throw new Error(`contributes.${key} entry must have a "./..." string path`);
    }
    const absPath = resolve(COMPANION_ROOT, entry.path);
    const rel = relative(companionReal, absPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`contributes.${key} path escapes extension root: ${entry.path}`);
    }
    const st = lstatOrNull(absPath);
    if (!st) {
      throw new Error(`contributes.${key} path does not exist: ${entry.path}`);
    }
    assertNotSymlink(absPath);
    if (!st.isFile()) {
      throw new Error(`contributes.${key} path must be a regular file: ${entry.path}`);
    }
    // Verify parent directories contain no symlinks either
    let cur = dirname(absPath);
    while (cur !== COMPANION_ROOT && cur.length > COMPANION_ROOT.length) {
      assertNotSymlink(cur);
      cur = dirname(cur);
    }
  }
}

function syncManifest(expected) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  pkg.contributes = pkg.contributes ?? {};
  for (const key of CONTRIB_KEYS) {
    assertDeclaredFilesValid(expected[key], key);
    pkg.contributes[key] = expected[key];
  }
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function checkManifest(expected) {
  runPacker(["--check", "--out", DEST_DIR]);
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  const contributes = pkg.contributes ?? {};

  for (const key of CONTRIB_KEYS) {
    const actual = contributes[key];
    const want = expected[key];
    if (!Array.isArray(actual)) {
      throw new Error(`uwf-companion/package.json contributes.${key} must be an array`);
    }
    assertDeclaredFilesValid(actual, key);
    const actualPaths = actual.map((e) => e.path);
    const wantPaths = want.map((e) => e.path);
    if (
      actualPaths.length !== wantPaths.length ||
      actualPaths.some((val, idx) => val !== wantPaths[idx])
    ) {
      const missing = wantPaths.filter((p) => !actualPaths.includes(p));
      const extra = actualPaths.filter((p) => !wantPaths.includes(p));
      throw new Error(
        `uwf-companion/package.json contributes.${key} is out of sync with ${basename(DEST_DIR)} ` +
          `(missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}). ` +
          `Run "node scripts/stage-bundle.mjs --sync-manifest".`,
      );
    }
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.checkManifest && flags.syncManifest) {
    throw new Error("--check-manifest and --sync-manifest cannot be used together");
  }

  if (flags.checkManifest) {
    const expected = collectExpectedContributions(DEST_DIR);
    checkManifest(expected);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        mode: "check-manifest",
        bundleDir: DEST_DIR,
        counts: Object.fromEntries(CONTRIB_KEYS.map((k) => [k, expected[k].length])),
      }) + "\n",
    );
    return;
  }

  stageBundle({ version: flags.version });
  const expected = collectExpectedContributions(DEST_DIR);
  if (flags.syncManifest) {
    syncManifest(expected);
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      mode: flags.syncManifest ? "stage+sync-manifest" : "stage",
      bundleDir: DEST_DIR,
      counts: Object.fromEntries(CONTRIB_KEYS.map((k) => [k, expected[k].length])),
    }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`[stage-bundle] ${err.message}\n`);
  process.exit(1);
}
