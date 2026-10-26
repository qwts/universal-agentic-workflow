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

  // Claim ownership: an old claim whose owner is still alive is never reclaimed (the caller times out),
  // while an old claim whose owner pid is dead is.
  const aged = (Date.now() - 120_000) / 1000;
  const next = String(N + 1).padStart(4, "0");
  const claim = join(dir, `.adr-${next}.claim`);
  writeFileSync(claim, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  utimesSync(claim, aged, aged);
  const held = await runOne("held", { UWF_ADR_RESERVE_TIMEOUT_MS: "1500", UWF_ADR_TEST_DELAY_MS: "" });
  check("old claim with a live owner: not reclaimed, reservation times out", held.code !== 0 && existsSync(claim), JSON.stringify(held));
  check("old claim with a live owner: no file published for its number", !readdirSync(dir).some((f) => f.startsWith(`ADR-${next}-`)), readdirSync(dir).join(","));
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  writeFileSync(claim, JSON.stringify({ pid: dead.pid ?? 2147483646, token: "crashed" }));
  utimesSync(claim, aged, aged);
  const taken = await runOne("after-crash", { UWF_ADR_TEST_DELAY_MS: "" });
  check("old claim with a dead owner: reclaimed and the number assigned", taken.code === 0 && taken.number === next, JSON.stringify(taken));
  check("no claim files left behind (2)", readdirSync(dir).every((f) => !f.endsWith(".claim")), readdirSync(dir).join(","));

  // Many callers race one dead-owner claim: reclamation is serialized, numbers stay distinct, nothing is left behind.
  const next2 = String(N + 2).padStart(4, "0");
  writeFileSync(join(dir, `.adr-${next2}.claim`), JSON.stringify({ pid: dead.pid ?? 2147483646, token: "crashed-2" }));
  utimesSync(join(dir, `.adr-${next2}.claim`), aged, aged);
  const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => runOne(`race-${i}`)));
  const rnums = racers.map((r) => Number(r.number)).sort((a, b) => a - b);
  check("race over a dead claim: all succeeded", racers.every((r) => r.code === 0 && r.ok), JSON.stringify(racers.filter((r) => r.code !== 0)));
  check("race over a dead claim: numbers distinct and consecutive", new Set(rnums).size === 8 && rnums.every((n, i) => n === N + 2 + i), rnums.join(","));
  check("race over a dead claim: no claim or mutex left behind", !readdirSync(dir).some((f) => f.endsWith(".claim") || f === ".adr-reclaim"), readdirSync(dir).join(","));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
