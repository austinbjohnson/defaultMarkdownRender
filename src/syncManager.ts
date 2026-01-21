import * as vscode from 'vscode';

export class SyncManager {
  public isInternalChange = false;
  private lastKnownVersion: number;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly document: vscode.TextDocument,
    _webviewPanel: vscode.WebviewPanel
  ) {
    this.lastKnownVersion = document.version;
  }

  public updateVersion(version: number) {
    this.lastKnownVersion = version;
  }

  public getLastKnownVersion(): number {
    return this.lastKnownVersion;
  }

  public dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
