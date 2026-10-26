#!/usr/bin/env node
/**
 * Redact secret-shaped strings from the text files under the given paths, in place.
 *
 * Usage: node scripts/uwf-on-pr/scrub.mjs <file-or-dir>...
 *
 * Patterns come from scripts/hooks/secret-patterns.mjs; a match becomes `[redacted:<kind>]`.
 * Binary files (a NUL byte in the first 8 KiB, e.g. SQLite) and files over 64 MiB are skipped.
 * Missing paths are ignored. Prints only counts, never the matched text.
 */
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../hooks/secret-patterns.mjs";

const MAX_BYTES = 64 * 1024 * 1024;

/** Scrub `paths` recursively. Returns { files, redacted, skipped }. */
export function scrubPaths(paths) {
  const stats = { files: 0, redacted: 0, skipped: 0, failed: 0 };
  const visit = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const name of readdirSync(p)) visit(join(p, name)); return; }
    if (!st.isFile()) return;
    if (st.size > MAX_BYTES) { stats.skipped += 1; return; }
    try {
      const buf = readFileSync(p);
      if (buf.subarray(0, 8192).includes(0)) { stats.skipped += 1; return; }
      const { text, count } = redactSecrets(buf.toString("utf8"));
      stats.files += 1;
      if (count > 0) { writeFileSync(p, text); stats.redacted += count; }
    } catch { stats.failed += 1; } // keep scrubbing the rest; the caller fails so nothing is uploaded
  };
  for (const p of paths) visit(p);
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error("usage: scrub.mjs <file-or-dir>..."); process.exit(2); }
  const s = scrubPaths(paths);
  console.log(`scrub: ${s.files} text file(s) scanned, ${s.redacted} secret(s) redacted, ${s.skipped} skipped, ${s.failed} failed`);
  if (s.failed) process.exit(1);
}
