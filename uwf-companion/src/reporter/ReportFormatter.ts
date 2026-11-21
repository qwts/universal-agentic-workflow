import * as fs from "node:fs";
import * as path from "node:path";

export function formatJsonReport(snapshot: object): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Neutralize spreadsheet formula triggers (`=`, `+`, `-`, `@`, `\t`, `\r`, `\n`, or whitespace-prefixed formulas)
 * and escape quotes per RFC 4180.
 */
function neutralizeFormula(text: string): string {
  if (/^[\t\r\n ]*[=+\-@]|^[\t\r\n]/.test(text)) {
    return `'${text}`;
  }
  return text;
}

export function formatCsvReport(snapshot: Record<string, Array<Record<string, unknown>>>): string {
  const sections: string[] = [];

  const csvCell = (val: unknown) => {
    const raw = val !== null && typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
    const safe = neutralizeFormula(raw);
    return `"${safe.replace(/"/g, '""')}"`;
  };

  for (const [key, rows] of Object.entries(snapshot)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const keySet = new Set<string>();
    for (const row of rows) {
      for (const col of Object.keys(row)) keySet.add(col);
    }
    const keys = [...keySet];
    const headers = keys.map((h) => csvCell(h));
    const csvRows = rows.map((row) => keys.map((h) => csvCell(row[h])).join(","));
    sections.push(`## ${key}\n${headers.join(",")}\n${csvRows.join("\n")}`);
  }

  return sections.join("\n\n");
}

function assertNonSymlinkDirectory(dirPath: string): void {
  let lst: fs.Stats | null = null;
  try {
    lst = fs.lstatSync(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (!lst) {
    fs.mkdirSync(dirPath);
    const createdSt = fs.lstatSync(dirPath);
    if (createdSt.isSymbolicLink() || !createdSt.isDirectory()) {
      throw new Error(`Expected regular directory at ${dirPath}`);
    }
    return;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`Refusing symlink directory in report export path: ${dirPath}`);
  }
  if (!lst.isDirectory()) {
    throw new Error(`Expected directory at ${dirPath}`);
  }
}

/**
 * Safely create `<workspaceRoot>/tmp/reports/<filename>` without following symlinks
 * and failing closed with `flag: "wx"` if the target already exists.
 */
export function writeReportFileSafe(
  workspaceRoot: string,
  filename: string,
  content: string,
): string {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new Error(`Invalid report filename: ${filename}`);
  }

  const realWs = fs.realpathSync(workspaceRoot);
  const tmpDir = path.join(realWs, "tmp");
  assertNonSymlinkDirectory(tmpDir);
  const reportsDir = path.join(tmpDir, "reports");
  assertNonSymlinkDirectory(reportsDir);

  const realOutDir = fs.realpathSync(reportsDir);
  const rel = path.relative(realWs, realOutDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Report output directory escaped workspace root: ${realOutDir}`);
  }

  const outPath = path.join(realOutDir, filename);
  fs.writeFileSync(outPath, content, { encoding: "utf8", flag: "wx" });
  return outPath;
}
