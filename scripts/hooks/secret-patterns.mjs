/**
 * Secret shapes shared by the UWF hooks and the uwf-on-pr scrubber.
 * Each entry: { kind, re }. `re` is global; order matters (the first match on a span wins), so
 * the specific Anthropic shape precedes the generic `sk-` one.
 */
export const SECRET_PATTERNS = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi },
];

/** Replace every secret-shaped span in `text` with `[redacted:<kind>]`. Returns { text, count }. */
export function redactSecrets(text) {
  let count = 0;
  let out = String(text);
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => { count += 1; return `[redacted:${kind}]`; });
  }
  return { text: out, count };
}
