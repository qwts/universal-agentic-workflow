/**
 * Matrix file parsing and validation for uwf-bench.
 *
 * YAML subset (no dependency): `key: scalar` lines, `key:` followed by a list of maps
 * (`- name: x` then more indented `key: value` lines), `#` comments, blank lines. Scalars are
 * strings (plain, 'single' or "double" quoted), numbers, true/false, null/~. No nesting
 * beyond list-of-maps, no flow collections, no multi-line scalars.
 */

const STATE_LOCATIONS = ["cli", "nocli"];

/** @param {string} raw */
function scalar(raw) {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  let q;
  if ((q = v.match(/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/))) return q[1].replace(/\\(["\\])/g, "$1");
  if ((q = v.match(/^'((?:[^']|'')*)'\s*(#.*)?$/))) return q[1].replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** Parse the documented YAML subset into plain objects. @param {string} text */
export function parseYamlSubset(text) {
  const out = {};
  let list = null;
  let item = null;
  text.split(/\r?\n/).forEach((line, n) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const fail = (why) => { throw new Error(`matrix line ${n + 1}: ${why}`); };
    const indent = line.match(/^ */)[0].length;
    let m;
    if (indent === 0) {
      if (!(m = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/))) fail("expected `key: value`");
      item = null;
      if (m[2] === undefined || m[2].trim() === "" || /^#/.test(m[2].trim())) { list = out[m[1]] = []; } else { list = null; out[m[1]] = scalar(m[2]); }
    } else if ((m = line.match(/^\s+- ([A-Za-z_][\w-]*):(?:\s+(.*))?$/))) {
      if (!list) fail("list item outside a list");
      item = { [m[1]]: scalar(m[2] ?? "") };
      list.push(item);
    } else if ((m = line.match(/^\s+([A-Za-z_][\w-]*):(?:\s+(.*))?$/))) {
      if (!item) fail("key outside a list item");
      item[m[1]] = scalar(m[2] ?? "");
    } else fail("unsupported syntax");
  });
  return out;
}

/**
 * @typedef {{name:string, repo:string, ref?:string, goal:string, issue?:number, acceptance_cmd?:string}} Fixture
 * @typedef {{name:string, adapter:string, model?:string, state_location:"cli"|"nocli", fake_fixture_dir?:string}} Cell
 * @typedef {{workflow:string, fixtures:Fixture[], cells:Cell[], runs_per_cell:number, output_path:string,
 *   timeout_ms:number, seed:number|null, block_randomize:boolean}} Matrix
 */

/** Names become run-directory components: one plain segment, never `.`/`..`, no separators. */
export const safeName = (n) => typeof n === "string" && /^[A-Za-z0-9][\w.-]*$/.test(n) && n !== "." && n !== "..";

/** Validate a parsed matrix and apply defaults. @returns {Matrix} */
export function validateMatrix(doc) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const names = (arr) => arr.map((x) => x?.name);
  need(Array.isArray(doc.fixtures) && doc.fixtures.length > 0, "fixtures: at least one required");
  need(Array.isArray(doc.cells) && doc.cells.length > 0, "cells: at least one required");
  const fixtures = Array.isArray(doc.fixtures) ? doc.fixtures : [];
  const cells = Array.isArray(doc.cells) ? doc.cells : [];
  for (const f of fixtures) {
    need(safeName(f.name), `fixture name must be a plain path segment [A-Za-z0-9][\\w.-]*, not . or ..: ${f.name}`);
    need(typeof f.repo === "string" && f.repo, `fixture ${f.name}: repo required`);
    need(typeof f.goal === "string" && f.goal, `fixture ${f.name}: goal required`);
  }
  for (const c of cells) {
    need(safeName(c.name), `cell name must be a plain path segment [A-Za-z0-9][\\w.-]*, not . or ..: ${c.name}`);
    need(typeof c.adapter === "string" && c.adapter, `cell ${c.name}: adapter required`);
    need(STATE_LOCATIONS.includes(c.state_location), `cell ${c.name}: state_location must be ${STATE_LOCATIONS.join("|")}`);
  }
  need(new Set(names(fixtures)).size === fixtures.length, "fixture names must be unique");
  need(new Set(names(cells)).size === cells.length, "cell names must be unique");
  const runs = doc.runs_per_cell ?? 1;
  need(Number.isInteger(runs) && runs > 0, "runs_per_cell must be a positive integer");
  const timeout = doc.timeout_ms ?? 1_800_000;
  need(Number.isFinite(timeout) && timeout > 0, "timeout_ms must be a positive number");
  need(doc.seed == null || Number.isInteger(doc.seed), "seed must be an integer");
  if (errs.length) throw new Error(`Invalid matrix:\n- ${errs.join("\n- ")}`);
  return {
    workflow: doc.workflow ?? "sw_dev", fixtures, cells, runs_per_cell: runs, output_path: doc.output_path ?? "./tmp/uwf-bench",
    timeout_ms: timeout, seed: doc.seed ?? null, block_randomize: doc.block_randomize === true,
  };
}

/** Deterministic PRNG (mulberry32) so block randomization is reproducible from `seed`. */
export function prng(seed) {
  let a = (seed ?? 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Execution plan: one entry per (cell, fixture, run_index). `block` is the run_index; with
 * block_randomize the cell x fixture order is shuffled inside every block (Fisher-Yates, seeded).
 * @param {Matrix} m
 */
export function planRuns(m) {
  const rand = prng(m.seed);
  const plan = [];
  for (let i = 1; i <= m.runs_per_cell; i++) {
    const block = m.cells.flatMap((cell) => m.fixtures.map((fixture) => ({ cell, fixture, run_index: i, block: i })));
    if (m.block_randomize) {
      for (let j = block.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [block[j], block[k]] = [block[k], block[j]];
      }
    }
    plan.push(...block);
  }
  return plan;
}

/** Read, parse and validate a matrix file. @param {string} text */
export const loadMatrix = (text) => validateMatrix(parseYamlSubset(text));
