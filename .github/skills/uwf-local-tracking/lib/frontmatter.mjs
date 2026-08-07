/**
 * Minimal YAML-subset frontmatter parser.
 * Handles the exact syntax used in UWF issue files:
 *   - scalar strings and numbers
 *   - booleans (true / false)
 *   - empty arrays: []
 *   - inline arrays: [I-001, I-002]
 * No external dependencies — Node built-ins only.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Parse frontmatter from a file on disk.
 * @param {string} filePath
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontmatter(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return parseFrontmatterString(raw);
}

/**
 * Parse frontmatter from a raw string.
 * @param {string} raw
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontmatterString(raw) {
  const lines = raw.split("\n");

  if (lines[0].trim() !== "---") {
    return { data: {}, body: raw };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { data: {}, body: raw };
  }

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const data = {};

  for (const line of fmLines) {
    // Match "key: rest" — key may contain letters, digits, hyphens, underscores
    const match = line.match(/^([\w][\w-]*):\s*(.*)$/);
    if (!match) continue;

    const [, key, raw_val] = match;
    const val = raw_val.trim();

    if (val === "[]") {
      data[key] = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      // Inline array: [I-001, I-002]
      data[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (val === "true") {
      data[key] = true;
    } else if (val === "false") {
      data[key] = false;
    } else if (val !== "" && !isNaN(Number(val))) {
      data[key] = Number(val);
    } else {
      data[key] = val;
    }
  }

  return { data, body };
}

/**
 * Serialize data + body back to a frontmatter markdown string.
 * @param {Record<string, any>} data
 * @param {string} body
 * @returns {string}
 */
export function serializeFrontmatter(data, body) {
  const lines = ["---"];

  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(", ")}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }

  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

/**
 * Read, mutate, and write back an issue file's frontmatter.
 * The mutator receives the parsed `data` object; mutations are applied in-place.
 * @param {string} filePath
 * @param {(data: Record<string, any>) => void} mutator
 */
export function mutateFrontmatter(filePath, mutator) {
  const { data, body } = parseFrontmatter(filePath);
  mutator(data);
  writeFileSync(filePath, serializeFrontmatter(data, body), "utf8");
}
