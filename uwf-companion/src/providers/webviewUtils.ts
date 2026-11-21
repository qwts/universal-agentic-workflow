import * as crypto from "node:crypto";

/** Generate a cryptographically random nonce for CSP script-src directives. */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

/** Escape HTML special characters to prevent injection in webview content. */
export function escHtml(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format scalar or structured MCP JSON field values without "[object Object]". */
export function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/** Derive ordered column names from dynamic MCP row objects. */
export function deriveColumns(
  rows: Array<Record<string, unknown>>,
  preferredOrder: string[] = [],
): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];

  for (const col of preferredOrder) {
    if (!seen.has(col) && rows.some((r) => Object.prototype.hasOwnProperty.call(r, col))) {
      seen.add(col);
      cols.push(col);
    }
  }
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

export function badge(
  text: string,
  color: "green" | "yellow" | "red" | "blue" | "grey",
): string {
  const colors: Record<string, string> = {
    green: "#2ea44f",
    yellow: "#d29922",
    red: "#da3633",
    blue: "#0969da",
    grey: "#8b949e",
  };
  return `<span style="background:${colors[color]};color:#fff;padding:1px 6px;border-radius:10px;font-size:11px;">${escHtml(text)}</span>`;
}

export function statusBadge(status: string): string {
  const map: Record<string, "green" | "yellow" | "red" | "blue" | "grey"> = {
    open: "blue",
    active: "yellow",
    closed: "green",
    skipped: "grey",
    passed: "green",
    completed: "green",
    complete: "green",
    failed: "red",
    pending: "yellow",
    answered: "green",
  };
  return badge(status, map[status] ?? "grey");
}

/**
 * Render a dynamic HTML table from MCP record objects.
 * Values pass through formatCellValue + escHtml unless overridden by a badge renderer.
 */
export function renderDynamicTable(
  columns: string[],
  rows: unknown[],
  renderers: Record<string, (val: unknown, row: Record<string, unknown>) => string> = {},
): string {
  if (!rows.length) return `<p class="empty">No records found.</p>`;
  const headers = columns.map((c) => `<th>${escHtml(c)}</th>`).join("");
  const bodyRows = (rows as Record<string, unknown>[])
    .map((row) => {
      const cells = columns
        .map((c) => {
          const val = row[c];
          const rendered = renderers[c] ? renderers[c](val, row) : escHtml(formatCellValue(val));
          return `<td>${rendered}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${headers}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

export function pageShell(
  title: string,
  body: string,
  nonce?: string,
  scriptContent?: string,
): string {
  const scriptPolicy = nonce ? ` script-src 'nonce-${nonce}';` : "";
  const scriptTag =
    nonce && scriptContent ? `<script nonce="${nonce}">${scriptContent}</script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';${scriptPolicy}">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h2 { margin: 0 0 12px; font-size: 15px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); vertical-align: top; }
  th { font-weight: 600; }
  .empty { opacity: .6; font-style: italic; }
  .btn { display:inline-block; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:0; border-radius:4px; padding:4px 8px; cursor:pointer; text-decoration:none; font-size:12px; }
</style>
<title>${escHtml(title)}</title>
</head>
<body>
${body}
${scriptTag}
</body>
</html>`;
}

export function sectionHeader(title: string, openCommand?: string): string {
  const action = openCommand
    ? `<a style="font-size:12px;opacity:.8;" href="command:${openCommand}">Open interactive view</a>`
    : "";
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><h2 style="margin:0;">${escHtml(title)}</h2>${action}</div>`;
}
