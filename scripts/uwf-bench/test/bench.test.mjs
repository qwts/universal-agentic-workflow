/**
 * uwf-bench tests (fake adapter, offline).
 * Usage: node scripts/uwf-bench/test/bench.test.mjs
 *
 * Acceptance: a 2x2 mini-matrix (2 cells x 2 runs, one fixture) completes unattended and exports.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractUsage, buildOutcomes } from "../bench.mjs";
import { parseYamlSubset, planRuns, loadMatrix } from "../matrix.mjs";
import { openSqlite } from "../sqlite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const BENCH = join(ROOT, "scripts", "uwf-bench", "bench.mjs");
const RUNNER_FIXTURES = join(ROOT, "scripts", "uwf-runner", "test", "fixtures", "sw_dev");

let failures = 0;
const bases = [];
process.on("exit", () => { for (const d of bases) rmSync(d, { recursive: true, force: true }); });
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
}
const bench = (args) => {
  const r = spawnSync(process.execPath, [BENCH, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const query = (dbPath, sql) => {
  const db = openSqlite(dbPath, { readOnly: true });
  try { return db.prepare(sql).all().map((r) => ({ ...r })); } finally { db.close(); }
};

// 1. Pure functions ------------------------------------------------------------
{
  console.log("# matrix parsing and usage extraction");
  const doc = parseYamlSubset(`# c\nruns_per_cell: 2\nseed: null\nblock_randomize: true\nfixtures:\n  - name: f\n    repo: "./r"  # x\n    goal: 'it''s'\ncells:\n  - name: a\n    adapter: fake\n    state_location: cli\n  - name: b\n    adapter: fake\n    state_location: nocli\n`);
  check("subset parser", doc.runs_per_cell === 2 && doc.seed === null && doc.block_randomize === true && doc.fixtures[0].repo === "./r" && doc.fixtures[0].goal === "it's" && doc.cells.length === 2, JSON.stringify(doc));
  const m = loadMatrix(`fixtures:\n  - name: f\n    repo: r\n    goal: g\ncells:\n  - name: a\n    adapter: fake\n    state_location: cli\n  - name: b\n    adapter: fake\n    state_location: cli\nruns_per_cell: 3\nseed: 7\nblock_randomize: true\n`);
  const p1 = planRuns(m).map((e) => `${e.cell.name}${e.run_index}`).join();
  check("block randomization is deterministic and blocked", p1 === planRuns(m).map((e) => `${e.cell.name}${e.run_index}`).join() && planRuns(m).slice(0, 2).every((e) => e.block === 1));
  let msg = "";
  try { loadMatrix("cells:\n  - name: a\n    adapter: fake\n    state_location: maybe\n"); } catch (e) { msg = e.message; }
  check("validation rejects bad matrix", /fixtures: at least one/.test(msg) && /state_location/.test(msg), msg);
  let dots = "";
  try { loadMatrix("fixtures:\n  - name: ..\n    repo: r\n    goal: g\ncells:\n  - name: .\n    adapter: fake\n    state_location: cli\n"); } catch (e) { dots = e.message; }
  check("validation rejects . and .. as names", /fixture name must be/.test(dots) && /cell name must be/.test(dots), dots);
  const u = extractUsage({ stdout: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, total_cost_usd: 0.25, modelUsage: { "claude-x": {} } }) });
  check("claude transcript usage incl. cache and cost", u.tokens_input === 10 && u.tokens_output === 5 && u.tokens_cache_read === 7 && u.tokens_cache_write === 3 && u.cost_usd === 0.25 && u.model === "claude-x", JSON.stringify(u));
  check("fake transcript usage is all null", Object.values(extractUsage({ stdout: "intake: done" })).every((v) => v === null));
  const o = buildOutcomes([{ stage: "s", status: "passed", notes: null }],
    [{ stage: "s", prompt: "p", usage: {}, sessionId: "a" }, { stage: "s", prompt: "x did not pass.\n- add file\n\nWhat happens next: y", usage: {}, sessionId: "a" }], null);
  check("attempt outcomes: retry then pass", o.length === 2 && o[0].passed === false && o[0].gate_failure_reason === "add file" && o[1].passed && !o[1].first_try_pass);
}

// 2. 2x2 mini-matrix -----------------------------------------------------------
{
  console.log("# 2x2 mini-matrix (fake adapter, unattended)");
  const base = mkdtempSync(join(tmpdir(), "uwf-bench-test-"));
  bases.push(base);
  // Bare fixture repo: just a README (the runner's .github dirs are added by the harness).
  mkdirSync(join(base, "fixture-repo"));
  writeFileSync(join(base, "fixture-repo", "README.md"), "# fixture\n");
  cpSync(RUNNER_FIXTURES, join(base, "fx-pass"), { recursive: true });
  cpSync(RUNNER_FIXTURES, join(base, "fx-fail"), { recursive: true });
  const fxPath = join(base, "fx-fail", "review.json");
  const fx = JSON.parse(readFileSync(fxPath, "utf8"));
  delete fx.files["tmp/workflow-artifacts/issues-review.md"];
  writeFileSync(fxPath, JSON.stringify(fx));
  writeFileSync(join(base, "matrix.yaml"), `workflow: sw_dev
runs_per_cell: 2
output_path: ./out
timeout_ms: 60000
seed: 1
block_randomize: true
fixtures:
  - name: bare
    repo: ./fixture-repo
    goal: "Add a widget"
    acceptance_cmd: node -e "process.exit(0)"
cells:
  - name: good
    adapter: fake
    model: fake-model
    state_location: cli
    fake_fixture_dir: ./fx-pass
  - name: bad
    adapter: fake
    state_location: cli
    fake_fixture_dir: ./fx-fail
`);
  const db = join(base, "out", "results.db");
  const r = bench(["run", "--matrix", join(base, "matrix.yaml")]);
  check("bench run exits 0", r.code === 0, r.err.slice(-800));
  const runs = query(db, "SELECT * FROM runs ORDER BY cell, run_index");
  check("4 runs recorded", runs.length === 4, JSON.stringify(runs.map((x) => x.cell)));
  const good = runs.filter((x) => x.cell === "good");
  const bad = runs.filter((x) => x.cell === "bad");
  check("passing cell: complete / none", good.every((x) => x.terminal_state === "complete" && x.failure_class === "none" && x.exit_code === 0), JSON.stringify(good[0]));
  check("failing cell: gate_blocked / model_failure", bad.every((x) => x.terminal_state === "gate_blocked" && x.failure_class === "model_failure" && x.exit_code === 1 && /review/.test(x.stderr_tail)));
  check("usage fields NULL and usage_incomplete=1 for fake", runs.every((x) => x.tokens_input === null && x.tokens_cache_read === null && x.cost_usd === null && x.usage_incomplete === 1));
  check("seed NULL, versions and shas recorded", runs.every((x) => x.seed === null && x.claude_cli_version === "fake" && /^[0-9a-f]{64}$/.test(x.stages_yaml_sha) && x.block === x.run_index));
  check("acceptance_pass recorded from acceptance_cmd", runs.every((x) => x.acceptance_pass === 1));
  check("good run: first_try_pass_rate 1, retries 0", good.every((x) => x.first_try_pass_rate === 1 && x.retries_total === 0), JSON.stringify(good[0]));
  check("bad run: retries recorded", bad.every((x) => x.retries_total === 3 && x.first_try_pass_rate < 1), JSON.stringify(bad[0]));
  check("model id recorded", good.every((x) => x.model === "fake-model") && bad.every((x) => x.model === null));
  check("separate data dirs with transcripts", existsSync(join(base, "out", "work", "good", "bare", "1", "data", "transcripts")) && existsSync(join(base, "out", "work", "bad", "bare", "2", "data", "uwf-stages.db")));
  const so = query(db, `SELECT * FROM stage_outcomes WHERE run_id = ${bad[0].run_id} AND stage = 'review' ORDER BY attempt`);
  check("review: 4 attempts, last never passed with reason", so.length === 4 && so[3].never_passed === 1 && so[0].passed === 0 && /issues-review/.test(so[3].gate_failure_reason ?? "") && /issues-review/.test(so[0].gate_failure_reason ?? ""), JSON.stringify(so));
  const adr = query(db, `SELECT * FROM stage_outcomes WHERE run_id = ${good[0].run_id} AND stage = 'adr'`);
  check("conditional stage recorded as skipped", adr.length === 1 && adr[0].skipped === 1);
  check("good run: all stage outcomes passed or skipped", query(db, `SELECT COUNT(*) n FROM stage_outcomes WHERE run_id = ${good[0].run_id} AND passed = 0 AND skipped = 0`)[0].n === 0);
  check("later stages of failed run absent", query(db, `SELECT COUNT(*) n FROM stage_outcomes WHERE run_id = ${bad[0].run_id} AND stage = 'technical-writing'`)[0].n === 0);

  // resume skips everything already in the db
  const r2 = bench(["run", "--matrix", join(base, "matrix.yaml"), "--resume"]);
  check("--resume skips all 4", r2.code === 0 && (r2.err.match(/already in db/g) ?? []).length === 4 && query(db, "SELECT COUNT(*) n FROM runs")[0].n === 4, r2.err.slice(-400));

  // rate + export
  const rt = bench(["rate", "--db", db, "--run", String(good[0].run_id), "--rater", "alice", "--dimension", "plan_completeness", "--score", "4", "--run-label", "blind-7"]);
  check("rate inserts a row", rt.code === 0 && query(db, "SELECT * FROM ratings")[0]?.run_label === "blind-7");
  check("rate rejects bad dimension", bench(["rate", "--db", db, "--run", "1", "--rater", "a", "--dimension", "nope", "--score", "1"]).code === 2);
  const out1 = join(base, "csv1");
  const out2 = join(base, "csv2");
  const e1 = bench(["export", "--db", db, "--out", out1]);
  bench(["export", "--db", db, "--out", out2]);
  check("export exits 0 and writes 3 CSVs", e1.code === 0 && ["runs", "stage_outcomes", "ratings"].every((t) => existsSync(join(out1, `${t}.csv`))), e1.err);
  const runsCsv = readFileSync(join(out1, "runs.csv"), "utf8").split("\n");
  check("runs.csv: header, rows, trailing newline", runsCsv[0].startsWith("run_id,cell,") && runsCsv.join("\n").includes("gate_blocked") && runsCsv.at(-1) === "");
  check("ratings.csv has the rating", readFileSync(join(out1, "ratings.csv"), "utf8").includes("blind-7"));
  check("export is deterministic", ["runs", "stage_outcomes", "ratings"].every((t) => readFileSync(join(out1, `${t}.csv`), "utf8") === readFileSync(join(out2, `${t}.csv`), "utf8")));
}

// 3. nocli stub, harness errors, usage -------------------------------------------
{
  console.log("# nocli stub and harness errors");
  const base = mkdtempSync(join(tmpdir(), "uwf-bench-test-"));
  bases.push(base);
  writeFileSync(join(base, "matrix.yaml"), `fixtures:
  - name: gone
    repo: ./does-not-exist
    goal: g
cells:
  - name: nc
    adapter: claude-code
    state_location: nocli
  - name: c
    adapter: fake
    state_location: cli
`);
  const r = bench(["run", "--matrix", join(base, "matrix.yaml"), "--db", join(base, "r.db")]);
  const runs = query(join(base, "r.db"), "SELECT * FROM runs ORDER BY cell");
  check("matrix survives a failing run", r.code === 0 && runs.length === 2, r.err.slice(-400));
  check("nocli recorded as not_implemented, no failure class", runs[1].terminal_state === "not_implemented" && runs[1].failure_class === null);
  check("missing fixture is harness_error", runs[0].failure_class === "harness_error" && /not found/.test(runs[0].notes));
  check("--help exits 0", bench(["--help"]).code === 0);
  check("missing --matrix exits 2", bench(["run"]).code === 2);
  check("invalid matrix exits 2", (writeFileSync(join(base, "bad.yaml"), "cells:\n"), bench(["run", "--matrix", join(base, "bad.yaml")]).code === 2));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
