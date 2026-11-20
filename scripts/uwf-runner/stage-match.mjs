/**
 * Shared stage-name resolution for runner transcripts and adapter fallbacks.
 *
 * Leaf module (zero internal imports) so `cost.mjs`, `provenance.mjs`, and
 * `adapters/grokbot.mjs` share one implementation without import cycles.
 */

export const MAX_STAGE_NAME_LENGTH = 128;
const STAGE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const CLOSE_CONTEXT_MARKER = "\n}\n\n## Reading rules\n";

/**
 * Validate and normalize an explicit or inferred stage identifier.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeStageName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "?" || trimmed.length > MAX_STAGE_NAME_LENGTH) return null;
  return STAGE_TOKEN_RE.test(trimmed) ? trimmed : null;
}

/**
 * Extract the executed stage name from a prompt when no explicit `stage` field
 * was persisted in the transcript record.
 *
 * @param {unknown} prompt
 * @param {{ allowBareStageHeader?: boolean }} [opts]
 * @returns {string | null}
 */
export function matchPromptStage(prompt, { allowBareStageHeader = false } = {}) {
  const txt = String(prompt ?? "").replace(/\r\n/g, "\n");
  if (!txt) return null;

  // 1. Direct byte-0 header (all stages after stage 1, monolith, direct fixtures).
  const direct = allowBareStageHeader
    ? /^Run the ([A-Za-z0-9_-]+) stage\b/.exec(txt)
    : /^Run the ([A-Za-z0-9_-]+) stage for the\b/.exec(txt);
  if (direct) return normalizeStageName(direct[1]);

  // 2. Canonical `materializePrompt` header following `Goal:\n<goal>\n\n`.
  //    Monotonically advance `cachedCloseIdx` and bound each slice before the next
  //    candidate header so total scanning and JSON.parse work is strictly O(N).
  const headerRe = /\n\nRun the ([A-Za-z0-9_-]+) stage for the ([A-Za-z0-9_-]+) workflow\.\n\nContext:\n\{/g;
  const headers = [...txt.matchAll(headerRe)];
  if (headers.length > 0) {
    const goalVerified = [];
    const workflowVerified = [];
    let cachedCloseIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const m = headers[i];
      const stageCand = normalizeStageName(m[1]);
      const wfCand = m[2];
      if (!stageCand) continue;
      const jsonStart = m.index + m[0].length - 1;
      const nextHeaderStart = i + 1 < headers.length ? headers[i + 1].index : txt.length;
      if (cachedCloseIdx < jsonStart) {
        cachedCloseIdx = txt.indexOf(CLOSE_CONTEXT_MARKER, jsonStart);
        if (cachedCloseIdx < 0) break;
      }
      if (cachedCloseIdx >= nextHeaderStart) continue;
      let ctx;
      try {
        ctx = JSON.parse(txt.slice(jsonStart, cachedCloseIdx + 2));
      } catch {
        continue;
      }
      if (!ctx || typeof ctx !== "object" || Array.isArray(ctx) || ctx.workflow !== wfCand) continue;
      if (typeof ctx.goal === "string" && `Goal:\n${ctx.goal.replace(/\r\n/g, "\n")}` === txt.slice(0, m.index)) {
        goalVerified.push(stageCand);
      } else {
        workflowVerified.push(stageCand);
      }
    }
    if (goalVerified.length > 0) {
      const uniqueGoal = [...new Set(goalVerified)];
      return uniqueGoal.length === 1 ? uniqueGoal[0] : null;
    }
    if (workflowVerified.length > 0) {
      const uniqueWf = [...new Set(workflowVerified)];
      return uniqueWf.length === 1 ? uniqueWf[0] : null;
    }
    // Structured Context-style header(s) existed but failed validation: fail closed rather than falling back to bare lines.
    return null;
  }

  // 3. Bare prompt fallback (short/custom prompts with no materialized Context block).
  const afterBlankRe = allowBareStageHeader
    ? /\n\nRun the ([A-Za-z0-9_-]+) stage\b/g
    : /\n\nRun the ([A-Za-z0-9_-]+) stage for the\b/g;
  const afterBlank = [...txt.matchAll(afterBlankRe)];
  if (afterBlank.length > 0) {
    return normalizeStageName(afterBlank[afterBlank.length - 1][1]);
  }
  const anyLineRe = allowBareStageHeader
    ? /^Run the ([A-Za-z0-9_-]+) stage\b/gm
    : /^Run the ([A-Za-z0-9_-]+) stage for the\b/gm;
  const anyLine = [...txt.matchAll(anyLineRe)];
  if (anyLine.length > 0) {
    return normalizeStageName(anyLine[anyLine.length - 1][1]);
  }
  return null;
}

/**
 * Resolve the stage name for a parsed transcript JSON object: validated explicit
 * `stage` field when present, else prompt-header inference.
 *
 * @param {Record<string, unknown> | null | undefined} record
 * @returns {string | null}
 */
export function inferTranscriptStage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.stage !== undefined && record.stage !== null) {
    return normalizeStageName(record.stage);
  }
  return matchPromptStage(record.prompt);
}
