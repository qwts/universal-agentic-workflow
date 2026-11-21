import * as vscode from "vscode";
import { Debouncer } from "./Debouncer";

type RefreshCallback = () => void;
const DEBOUNCE_MS = 300;

export class RuntimeWatcher implements vscode.Disposable {
  private workspaceWatchers: vscode.FileSystemWatcher[] = [];
  private activeDirWatchers: vscode.FileSystemWatcher[] = [];
  private callbacks: RefreshCallback[] = [];
  private debouncer: Debouncer;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentDataDir: string | null = null;

  constructor(private readonly workspaceRoot?: string) {
    this.debouncer = new Debouncer(DEBOUNCE_MS, () => {
      for (const cb of this.callbacks) cb();
    });

    const patterns = [
      ".uaw-runs/**/*.db",
      ".uaw-runs/**/*.db-wal",
      ".uaw-runs/**/*.json",
      ".github/skills/**/*.db",
      ".github/skills/**/*.db-wal",
      ".github/skills/**/stages.yaml",
    ];
    for (const pat of patterns) {
      const glob = this.workspaceRoot
        ? new vscode.RelativePattern(this.workspaceRoot, pat)
        : pat;
      this.workspaceWatchers.push(this.bindWatcher(vscode.workspace.createFileSystemWatcher(glob)));
    }
  }

  private bindWatcher(watcher: vscode.FileSystemWatcher): vscode.FileSystemWatcher {
    const handler = () => this.debouncer.trigger();
    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    watcher.onDidDelete(handler);
    return watcher;
  }

  onRefresh(cb: RefreshCallback): void {
    this.callbacks.push(cb);
  }

  setActiveDataDir(dataDir: string | null): void {
    const normalized = dataDir?.trim() || null;
    if (normalized === this.currentDataDir) return;
    this.currentDataDir = normalized;

    for (const w of this.activeDirWatchers) w.dispose();
    this.activeDirWatchers = [];
    if (!normalized) return;

    for (const pat of [
      "uwf-*.db",
      "uwf-*.db-wal",
      "run-meta.json",
      "runner-routing.json",
      "transcripts/*.json",
    ]) {
      const rp = new vscode.RelativePattern(vscode.Uri.file(normalized), pat);
      this.activeDirWatchers.push(this.bindWatcher(vscode.workspace.createFileSystemWatcher(rp)));
    }
  }

  setPollInterval(intervalMs: number): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (Number.isFinite(intervalMs) && intervalMs >= 500) {
      this.pollTimer = setInterval(() => this.debouncer.trigger(), Math.floor(intervalMs));
    }
  }

  dispose(): void {
    for (const w of this.workspaceWatchers) w.dispose();
    for (const w of this.activeDirWatchers) w.dispose();
    this.workspaceWatchers = [];
    this.activeDirWatchers = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.debouncer.dispose();
  }
}
