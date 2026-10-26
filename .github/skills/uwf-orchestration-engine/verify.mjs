#!/usr/bin/env node
/**
 * Implementation-gate verifier: runs the target repo's build and tests (cwd = target repo).
 *
 * Command source, first match wins:
 *   1. UWF_VERIFY_CMDS env (newline-separated shell commands)
 *   2. `verify` array in <cwd>/.uwf.json (shell command strings; [] means nothing to verify)
 *   3. Auto-detection (npm, cargo, go, pytest); nothing detected -> exit 0
 *
 * Configured commands run through the shell (operator-controlled); auto-detected ones run via argv.
 *
 * Usage: node verify.mjs [--dry-run]
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const cwd = process.cwd();

function detect() {
  const out = [];
  const argv = (cmd, args) => out.push({ display: [cmd, ...args].join(" "), cmd, args });
  if (existsSync(join(cwd, "package.json"))) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {}; } catch { /* ignore */ }
    argv("npm", ["run", "build", "--if-present"]);
    const placeholder = /no test specified/.test(String(scripts.test ?? ""));
    if (!placeholder) argv("npm", ["test", "--if-present"]);
  }
  if (existsSync(join(cwd, "Cargo.toml"))) { argv("cargo", ["build"]); argv("cargo", ["test"]); }
  if (existsSync(join(cwd, "go.mod"))) { argv("go", ["build", "./..."]); argv("go", ["test", "./..."]); }
  if (looksLikePytest()) argv(pythonBin(), ["-m", "pytest", "-q"]);
  return out;
}

const has = (f) => existsSync(join(cwd, f));
const read = (f) => { try { return readFileSync(join(cwd, f), "utf8"); } catch { return ""; } };

/** Only treat the repo as Python when it shows Python/pytest signals (a bare tests/ dir is not enough). */
function looksLikePytest() {
  if (/pytest/.test(read("pyproject.toml"))) return true;
  if (has("pytest.ini")) return true;
  if (/\[tool:pytest\]/.test(read("setup.cfg"))) return true;
  if (/\[pytest\]/.test(read("tox.ini"))) return true;
  const pyProject = ["pyproject.toml", "setup.py", "setup.cfg"].some(has)
    || readdirSync(cwd).some((f) => /^requirements.*\.txt$/.test(f));
  return (has("tests") || has("test")) && pyProject;
}

/** Prefer python3 when it is the only interpreter on PATH. */
function pythonBin() {
  const ok = (b) => spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0;
  return ok("python") || !ok("python3") ? "python" : "python3";
}

function resolveCommands() {
  const env = process.env.UWF_VERIFY_CMDS;
  if (env !== undefined && env.trim() !== "") {
    return { source: "UWF_VERIFY_CMDS", cmds: env.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((c) => ({ display: c, shell: c })) };
  }
  const cfgPath = join(cwd, ".uwf.json");
  if (existsSync(cfgPath)) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); }
    catch (e) { console.log(`verify failed: cannot parse .uwf.json: ${e.message}`); process.exit(1); }
    if (cfg && typeof cfg === "object" && "verify" in cfg) {
      if (!Array.isArray(cfg.verify) || cfg.verify.some((c) => typeof c !== "string")) {
        console.log("verify failed: .uwf.json `verify` must be an array of command strings");
        process.exit(1);
      }
      return { source: ".uwf.json", cmds: cfg.verify.filter((c) => c.trim()).map((c) => ({ display: c, shell: c })) };
    }
  }
  return { source: "auto-detect", cmds: detect() };
}

const { source, cmds } = resolveCommands();
if (cmds.length === 0) {
  console.log(`no verify commands detected (source: ${source})`);
  process.exit(0);
}
console.log(`verify commands (source: ${source}):`);
for (const c of cmds) console.log(`  $ ${c.display}`);
if (dryRun) process.exit(0);

for (const c of cmds) {
  console.log(`running: ${c.display}`);
  try {
    const opts = { cwd, stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
    if (c.shell) execSync(c.shell, opts); else execFileSync(c.cmd, c.args, opts);
    console.log(`  exit 0: ${c.display}`);
  } catch (err) {
    const status = err.status ?? (err.code ? String(err.code) : "unknown");
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`.trimEnd();
    const tail = text.split(/\r?\n/).slice(-40).join("\n");
    if (tail) console.log(tail);
    console.log(`verify failed: \`${c.display}\` exited ${status}`);
    process.exit(1);
  }
}
console.log("verify passed");
