/**
 * cost.mjs — `runner.mjs cost --data-dir <d> [--workflow <w> [--repo-root <r>]]`.
 *
 * Reads <d>/transcripts/*.json (written by the claude-code adapter) and prints, per stage:
 * turns, context per turn (uncached input + cache_read + cache_creation, divided by turns), cache read/write,
 * output and thinking tokens, the reported cost, and flags. With --workflow it also prints the
 * static prompt size (chars and ~tokens at 4 chars/token) from materializePrompt, plus the size of the
 * SKILL/reference files the stage's agent file tells it to read.
 *
 * Flags: "!50K" = average context per turn above 50K; "!100K" = the final turn (the largest) is
 * likely above 100K, the pricing tier boundary; "!MISS" = cache_write exceeds both cache_read and 50K (the cache
 * missed and the conversation was re-written at cache-write price, typical of a resumed retry).
 *
 * Also used by the runner: attemptUsage() (one transcript) and listTranscripts() (all transcripts in a data dir).
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { materializePrompt } from "./prompt.mjs";

export const AVG_LIMIT = 50_000;
export const TURN_LIMIT = 100_000;
const CHARS_PER_TOKEN = 4;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const OPEN_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const k = (n) => (n / 1000).toFixed(1) + "K";
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Parse one transcript file into a row (null when it is not a claude-code JSON result). */
export function transcriptRow(file, t) {
  let r;
  try { r = JSON.parse(t.stdout); } catch { return null; }
  const u = r?.usage;
  if (!u || !Number.isFinite(r.num_turns) || r.num_turns <= 0) return null;
  const m = String(t.prompt ?? "").match(/^Run the (\S+) stage for the/m);
  const input = num(u.input_tokens), read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens);
  const models = Object.values(r.modelUsage ?? {});
  const thinking = u.output_tokens_details?.thinking_tokens ?? (models.length ? models.reduce((a, x) => a + num(x.thinkingTokens), 0) : undefined);
  const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : null;
  const lastCtx = last ? num(last.input_tokens) + num(last.cache_read_input_tokens) + num(last.cache_creation_input_tokens) : 0;
  const perTurn = (input + read + write) / r.num_turns;
  return {
    file, stage: m ? m[1] : "?", turns: r.num_turns, perTurn, lastCtx, input, read, write,
    output: num(u.output_tokens), thinking, cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
    flags: [perTurn > AVG_LIMIT ? "!50K" : null, lastCtx > TURN_LIMIT || perTurn > TURN_LIMIT ? "!100K" : null, write > read && write > AVG_LIMIT ? "!MISS" : null].filter(Boolean),
  };
}

function readRegularUtf8Bounded(fullPath, expectedRealDir = null, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let lst;
  try {
    lst = lstatSync(fullPath);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > maxBytes) return null;
  if (expectedRealDir !== null) {
    let realFull;
    try {
      realFull = realpathSync(fullPath);
    } catch {
      return null;
    }
    const prefix = expectedRealDir.endsWith(sep) ? expectedRealDir : expectedRealDir + sep;
    if (!realFull.startsWith(prefix)) return null;
  }
  let fd;
  try {
    fd = openSync(fullPath, OPEN_NOFOLLOW_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const chunks = [];
    let total = 0;
    const chunkBuf = Buffer.allocUnsafe(65536);
    while (true) {
      const n = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(chunkBuf.subarray(0, n)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readTranscriptJsonSafe(fullPath, expectedRealDir = null) {
  const raw = readRegularUtf8Bounded(fullPath, expectedRealDir, MAX_TRANSCRIPT_BYTES);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** { ctx, cost } for one transcript file: context of the last turn (falls back to the per-turn average) and reported cost (0 when unknown). */
export function attemptUsage(path) {
  try {
    const parsed = readTranscriptJsonSafe(path);
    if (!parsed) return { ctx: 0, cost: 0 };
    const row = transcriptRow(path, parsed);
    return row ? { ctx: row.lastCtx || row.perTurn, cost: row.cost ?? 0 } : { ctx: 0, cost: 0 };
  } catch { return { ctx: 0, cost: 0 }; }
}

/** Absolute paths of every regular, non-symlink transcript file in <dataDir>/transcripts. */
export function listTranscripts(dataDir) {
  const dir = join(dataDir, "transcripts");
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return [];
  }
  const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const lst = lstatSync(full);
      if (lst.isSymbolicLink() || !lst.isFile() || lst.size > MAX_TRANSCRIPT_BYTES) continue;
      if (!realpathSync(full).startsWith(prefix)) continue;
      out.push(full);
    } catch { /* unreadable transcript */ }
  }
  return out;
}

/** Context size of the last turn of the newest transcript whose prompt names this stage (0 when none). */
export function lastStageContext(dataDir, stage) {
  let realDir = null;
  try {
    const dir = join(dataDir, "transcripts");
    const dirStat = lstatSync(dir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      realDir = realpathSync(dir);
    }
  } catch {
    return 0;
  }
  if (!realDir) return 0;
  for (const f of listTranscripts(dataDir).sort().reverse()) {
    try {
      const parsed = readTranscriptJsonSafe(f, realDir);
      if (!parsed) continue;
      const row = transcriptRow(f, parsed);
      if (row?.stage === stage) return row.lastCtx || row.perTurn;
    } catch { /* unreadable transcript */ }
  }
  return 0;
}

/** Files the agent body tells the stage to read (`.github/...` paths in backticks), with their sizes. */
function referencedChars(skillsRoot, systemPrompt) {
  let realRoot;
  try {
    realRoot = realpathSync(skillsRoot);
  } catch {
    return 0;
  }
  let total = 0;
  // Relative refs resolve against skillsRoot; refs the prompt already made absolute resolve to themselves.
  for (const ref of new Set([...String(systemPrompt).matchAll(/`([^`\s]*\.github\/[^`\s]+)`/g)].map((x) => x[1]))) {
    if (!ref.endsWith("/")) {
      const text = readRegularUtf8Bounded(resolve(skillsRoot, ref), realRoot, MAX_TRANSCRIPT_BYTES);
      if (text !== null) total += text.length;
    }
  }
  return total;
}

export async function costReport({ dataDir, workflow, repoRoot, skillsRoot, outputPath }) {
  const dir = join(dataDir, "transcripts");
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    throw new Error(`No transcripts directory at ${dir}`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Invalid transcripts directory at ${dir}`);
  }
  const realDir = realpathSync(dir);
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const t = readTranscriptJsonSafe(join(dir, f), realDir);
    if (!t) continue;
    const row = transcriptRow(f, t);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new Error(`No claude-code transcripts with usage data in ${dir}`);

  const statics = {};
  if (workflow) {
    for (const st of new Set(rows.map((r) => r.stage))) {
      try {
        const mp = await materializePrompt({ workflow, stage: st, repoRoot, skillsRoot, outputPath, dataDir });
        statics[st] = { prompt: mp.prompt.length, system: mp.systemPrompt.length, refs: referencedChars(skillsRoot ?? repoRoot, mp.systemPrompt) };
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
  const total = ["TOTAL", String(sum("turns")), k((sum("input") + sum("read") + sum("write")) / sum("turns")), "-", String(sum("read")), String(sum("write")),
    String(sum("output")), String(sum("thinking")), "$" + sum("cost").toFixed(3), "-"];
  if (workflow) total.push("", "");
  const all = [head, ...body, total];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 || i === r.length - 1 || (workflow && i >= r.length - 2) ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd();
  const out = [line(head), ...body.map(line), line(total)];
  out.push("", `ctx/turn = (uncached input + cache_read + cache_write) / turns. Flags: !50K = average above ${AVG_LIMIT / 1000}K per turn; !100K = final turn likely above ${TURN_LIMIT / 1000}K (pricing tier); !MISS = cache_write above both cache_read and ${AVG_LIMIT / 1000}K (a real re-bill, not just the first write; cache miss: the context was re-billed at cache-write price).`);
  return out.join("\n") + "\n";
}
