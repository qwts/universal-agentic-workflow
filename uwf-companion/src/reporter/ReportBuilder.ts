import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { UawDataService } from "../services/UawDataService";
import {
  formatCsvReport,
  formatJsonReport,
  writeReportFileSafe,
} from "./ReportFormatter";

export class ReportBuilder {
  static async export(
    workspaceRoot: string,
    dataService: UawDataService,
    format: "json" | "csv",
  ): Promise<void> {
    const snap = await dataService.collectExportSnapshot();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const rand = crypto.randomBytes(4).toString("hex");
    const filename = `uwf-report-${stamp}-${rand}.${format}`;
    const content =
      format === "json"
        ? formatJsonReport(snap)
        : formatCsvReport(snap as unknown as Record<string, Array<Record<string, unknown>>>);
    const outPath = writeReportFileSafe(workspaceRoot, filename, content);

    const uri = vscode.Uri.file(outPath);
    await vscode.window.showTextDocument(uri);
  }
}
