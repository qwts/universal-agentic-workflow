/**
 * UWF Runner Harness Adapters — entry point and shared helpers.
 *
 * An adapter runs ONE stage agent through a CLI harness. It never evaluates
 * gates and never writes workflow state. Types: ./types.d.ts
 *
 * Usage:
 *   import { loadAdapter } from "./adapters/index.mjs";
 *   const adapter = await loadAdapter("claude-code");   // or "fake"
 *   const result = await adapter.invokeStage({ prompt, cwd, permissions: "edit" });
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * @typedef {"read-only"|"edit"|"edit+exec"} Permissions
 * @typedef {{ inputTokens: number, outputTokens: number }} Usage
 * @typedef {object} InvokeStageOptions
 * @property {string} [agentFile] agent .md whose body becomes part of the system prompt
 * @property {string} [systemPrompt]
 * @property {string} prompt
 * @property {string} cwd
 * @property {string[]} [inputs]
 * @property {string[]} [outputs]
 * @property {string} [model]
 * @property {string} [sessionId]
 * @property {number} [timeoutMs]
 * @property {Record<string,string|undefined>} [env]
 * @property {Permissions} [permissions]
 * @property {string} [dataDir]
 * @typedef {object} InvokeStageResult
 * @property {boolean} ok
 * @property {string|null} sessionId
 * @property {string|null} transcriptPath
 * @property {string} stdout
 * @property {number|null} exitCode
 * @property {Usage|null} usage
 * @property {number} [costUsd]
 * @property {string} [error]
 */

export const ADAPTERS = ["claude-code", "codex", "fake"];

/** @param {string} name @returns {Promise<{name:string, invokeStage:Function}>} */
export async function loadAdapter(name) {
  if (!ADAPTERS.includes(name)) {
    throw new Error(`Unknown adapter "${name}". Available: ${ADAPTERS.join(", ")}`);
  }
  return import(`./${name}.mjs`);
}

/** Resolve the data dir: explicit option, else UWF_DATA_DIR, else ./tmp/uwf. */
export function resolveDataDir(dataDir) {
  return resolve(dataDir ?? process.env.UWF_DATA_DIR ?? "./tmp/uwf");
}

/** Write a transcript JSON under <dataDir>/transcripts/<timestamp>.json; returns its path or null. */
export function writeTranscript(dataDir, record) {
  try {
    const dir = join(resolveDataDir(dataDir), "transcripts");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return path;
  } catch {
    return null;
  }
}

/** Compose the system prompt from an agent file body (frontmatter stripped) plus extra text. */
export function buildSystemPrompt(agentFile, systemPrompt) {
  const parts = [];
  if (agentFile) {
    const raw = readFileSync(agentFile, "utf8");
    parts.push(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim());
  }
  if (systemPrompt) parts.push(systemPrompt);
  return parts.filter(Boolean).join("\n\n");
}
