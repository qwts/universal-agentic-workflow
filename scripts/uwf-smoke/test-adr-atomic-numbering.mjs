/**
 * Smoke test: concurrent `adrs.mjs next-number` reservations against one ADR dir never collide.
 * Usage: node scripts/uwf-smoke/test-adr-atomic-numbering.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADRS = join(ROOT, ".github/skills/uwf-adr/adrs.mjs");
const N = 16;
const dir = mkdtempSync(join(tmpdir(), "uwf-adr-"));
let failures = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${label} ${cond ? "" : detail}`); if (!cond) failures++; };

const runOne = (i, extraEnv = {}) => new Promise((res) => {
  const env = { ...process.env, UWF_ADR_TEST_DELAY_MS: "50", ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === "") delete env[k];
  const p = spawn(process.execPath, [ADRS, "next-number", "--title", `Decision ${i}`, "--output-path", dir], { stdio: ["ignore", "pipe", "pipe"], env });
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

  // A claim that is not ours, whatever its age or owner, is never reclaimed: the number is skipped
  // (a gap), the claim stays, and reservation continues with the next free number.
  const aged = (Date.now() - 120_000) / 1000;
  const held = String(N + 1).padStart(4, "0");
  const heldClaim = join(dir, `.adr-${held}.claim`);
  writeFileSync(heldClaim, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  utimesSync(heldClaim, aged, aged);
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  const orphan = String(N + 2).padStart(4, "0");
  const orphanClaim = join(dir, `.adr-${orphan}.claim`);
  writeFileSync(orphanClaim, JSON.stringify({ pid: dead.pid ?? 2147483646, token: "crashed" }));
  utimesSync(orphanClaim, aged, aged);
  const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => runOne(`race-${i}`)));
  const rnums = racers.map((r) => Number(r.number)).sort((a, b) => a - b);
  check("foreign claims: all reservations still succeed", racers.every((r) => r.code === 0 && r.ok), JSON.stringify(racers.filter((r) => r.code !== 0)));
  check("foreign claims: both claimed numbers are skipped, the rest consecutive", new Set(rnums).size === 8 && rnums.every((n, i) => n === N + 3 + i), rnums.join(","));
  check("foreign claims: neither claim was removed and nothing was published for them", existsSync(heldClaim) && existsSync(orphanClaim) && !readdirSync(dir).some((f) => f.startsWith(`ADR-${held}-`) || f.startsWith(`ADR-${orphan}-`)), readdirSync(dir).join(","));
  check("no own claim files left behind", readdirSync(dir).filter((f) => f.endsWith(".claim")).length === 2, readdirSync(dir).join(","));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
