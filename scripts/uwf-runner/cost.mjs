/**
 * cost.mjs — `runner.mjs cost --data-dir <d> [--workflow <w> [--repo-root <r>]]`.
 *
 * Reads <d>/transcripts/*.json (written by the claude-code adapter) and prints, per stage:
 * turns, context per turn (cache_read + cache_creation, divided by turns), cache read/write,
 * output and thinking tokens, the reported cost, and flags. With --workflow it also prints the
 * static prompt size (chars and ~tokens at 4 chars/token) from materializePrompt, plus the size of the
 * SKILL/reference files the stage's agent file tells it to read.
 *
 * Flags: "!50K" = average context per turn above 50K; "!100K" = the final turn (the largest) is
 * likely above 100K, the pricing tier boundary.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { materializePrompt } from "./prompt.mjs";

export const AVG_LIMIT = 50_000;
export const TURN_LIMIT = 100_000;
const CHARS_PER_TOKEN = 4;

const k = (n) => (n / 1000).toFixed(1) + "K";
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Parse one transcript file into a row (null when it is not a claude-code JSON result). */
export function transcriptRow(file, t) {
  let r;
  try { r = JSON.parse(t.stdout); } catch { return null; }
  const u = r?.usage;
  if (!u || !Number.isFinite(r.num_turns) || r.num_turns <= 0) return null;
  const m = String(t.prompt ?? "").match(/^Run the (\S+) stage for the/m);
  const read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens);
  const models = Object.values(r.modelUsage ?? {});
  const thinking = u.output_tokens_details?.thinking_tokens ?? (models.length ? models.reduce((a, x) => a + num(x.thinkingTokens), 0) : undefined);
  const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : null;
  const lastCtx = last ? num(last.input_tokens) + num(last.cache_read_input_tokens) + num(last.cache_creation_input_tokens) : 0;
  const perTurn = (read + write) / r.num_turns;
  return {
    file, stage: m ? m[1] : "?", turns: r.num_turns, perTurn, lastCtx, read, write,
    output: num(u.output_tokens), thinking, cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
    flags: [perTurn > AVG_LIMIT ? "!50K" : null, lastCtx > TURN_LIMIT || perTurn > TURN_LIMIT ? "!100K" : null].filter(Boolean),
  };
}

/** Files the agent body tells the stage to read (`.github/...` paths in backticks), with their sizes. */
function referencedChars(repoRoot, systemPrompt) {
  let total = 0;
  for (const ref of new Set([...String(systemPrompt).matchAll(/`(\.github\/[^`\s]+)`/g)].map((x) => x[1]))) {
    const p = resolve(repoRoot, ref);
    if (existsSync(p) && !p.endsWith("/")) { try { total += readFileSync(p, "utf8").length; } catch { /* directory */ } }
  }
  return total;
}

export async function costReport({ dataDir, workflow, repoRoot, outputPath }) {
  const dir = join(dataDir, "transcripts");
  if (!existsSync(dir)) throw new Error(`No transcripts directory at ${dir}`);
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let t;
    try { t = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const row = transcriptRow(f, t);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new Error(`No claude-code transcripts with usage data in ${dir}`);

  const statics = {};
  if (workflow) {
    for (const st of new Set(rows.map((r) => r.stage))) {
      try {
        const mp = await materializePrompt({ workflow, stage: st, repoRoot, outputPath, dataDir });
        statics[st] = { prompt: mp.prompt.length, system: mp.systemPrompt.length, refs: referencedChars(repoRoot, mp.systemPrompt) };
      } catch { /* stage not in this workflow */ }
    }
  }

  const head = ["stage", "turns", "ctx/turn", "last-turn", "cache_read", "cache_write", "output", "thinking", "cost", "flags"];
  if (workflow) head.push("prompt(ch/~tok)", "agent+refs(ch)");
  const body = rows.map((r) => {
    const s = statics[r.stage];
    const cells = [r.stage, String(r.turns), k(r.perTurn), r.lastCtx ? k(r.lastCtx) : "-", String(r.read), String(r.write), String(r.output),
      r.thinking === undefined ? "-" : String(r.thinking), r.cost === null ? "-" : "$" + r.cost.toFixed(3), r.flags.join(" ") || "-"];
    if (workflow) cells.push(s ? `${s.prompt}/~${Math.round(s.prompt / CHARS_PER_TOKEN)}` : "-", s ? String(s.system + s.refs) : "-");
    return cells;
  });
  const sum = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
  const total = ["TOTAL", String(sum("turns")), k((sum("read") + sum("write")) / sum("turns")), "-", String(sum("read")), String(sum("write")),
    String(sum("output")), String(sum("thinking")), "$" + sum("cost").toFixed(3), "-"];
  if (workflow) total.push("", "");
  const all = [head, ...body, total];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 || i === r.length - 1 || (workflow && i >= r.length - 2) ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd();
  const out = [line(head), ...body.map(line), line(total)];
  out.push("", `ctx/turn = (cache_read + cache_write) / turns. Flags: !50K = average above ${AVG_LIMIT / 1000}K per turn; !100K = final turn likely above ${TURN_LIMIT / 1000}K (pricing tier).`);
  return out.join("\n") + "\n";
}
