/**
 * Smoke test: concurrent `adrs.mjs next-number` reservations against one ADR dir never collide.
 * Usage: node scripts/uwf-smoke/test-adr-atomic-numbering.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADRS = join(ROOT, ".github/skills/uwf-adr/adrs.mjs");
const N = 16;
const dir = mkdtempSync(join(tmpdir(), "uwf-adr-"));
let failures = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${label} ${cond ? "" : detail}`); if (!cond) failures++; };

const runOne = (i) => new Promise((res) => {
  const p = spawn(process.execPath, [ADRS, "next-number", "--title", `Decision ${i}`, "--output-path", dir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, UWF_ADR_TEST_DELAY_MS: "50" } });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => { try { res({ code, ...JSON.parse(out) }); } catch { res({ code, error: err || out }); } });
});

try {
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
  check("all reservations succeeded", results.every((r) => r.code === 0 && r.ok), JSON.stringify(results.filter((r) => r.code !== 0)));
  const nums = results.map((r) => Number(r.number)).sort((a, b) => a - b);
  check("numbers are distinct", new Set(nums).size === N, nums.join(","));
  check("numbers are consecutive from 1", nums.every((n, i) => n === i + 1), nums.join(","));
  check("each reserved path exists and is unique", new Set(results.map((r) => r.path)).size === N && results.every((r) => existsSync(r.path)));
  check("no claim files left behind", readdirSync(dir).every((f) => !f.endsWith(".claim")), readdirSync(dir).join(","));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
