import * as vscode from 'vscode';
import { SyncManager } from './syncManager';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'markdownLiveRender.editor';

  private syncManagers = new Map<string, SyncManager>();
  private lastSentContent = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Set up webview options
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    // Create sync manager for this document
    const syncManager = new SyncManager(document, webviewPanel);
    this.syncManagers.set(document.uri.toString(), syncManager);

    // Set up the webview HTML
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Send initial content to webview
    this.updateWebview(webviewPanel.webview, document);

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      (message) => this.handleWebviewMessage(message, document),
      undefined,
      this.context.subscriptions
    );

    // Handle document changes (from other sources like AI)
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          const manager = this.syncManagers.get(document.uri.toString());
          if (manager && !manager.isInternalChange) {
            this.updateWebview(webviewPanel.webview, document);
          }
        }
      }
    );

    // Clean up when editor is closed
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      const uri = document.uri.toString();
      const manager = this.syncManagers.get(uri);
      if (manager) {
        manager.dispose();
        this.syncManagers.delete(uri);
      }
      this.lastSentContent.delete(uri);
    });
  }

  private updateWebview(webview: vscode.Webview, document: vscode.TextDocument) {
    const content = document.getText();
    const uri = document.uri.toString();
    
    // Skip if content hasn't changed (avoid redundant updates)
    if (this.lastSentContent.get(uri) === content) {
      return;
    }
    
    this.lastSentContent.set(uri, content);
    
    webview.postMessage({
      type: 'update',
      content,
      version: document.version,
    });
  }

  private async handleWebviewMessage(
    message: { type: string; content?: string; cursorPosition?: number },
    document: vscode.TextDocument
  ) {
    switch (message.type) {
      case 'edit':
        if (message.content !== undefined) {
          const manager = this.syncManagers.get(document.uri.toString());
          if (manager) {
            manager.isInternalChange = true;
          }

          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            message.content
          );
          await vscode.workspace.applyEdit(edit);

          if (manager) {
            manager.isInternalChange = false;
          }
        }
        break;

      case 'ready':
        // Webview is ready, send initial content
        break;
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'editor.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'editor.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>Markdown Live Render</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-bold" title="Bold (Cmd+B)"><b>B</b></button>
    <button id="btn-italic" title="Italic (Cmd+I)"><i>I</i></button>
    <button id="btn-strikethrough" title="Strikethrough (Cmd+Shift+S)"><s>S</s></button>
    <button id="btn-code" title="Inline Code (Cmd+\`)"><code>&lt;/&gt;</code></button>
    <span class="toolbar-separator"></span>
    <button id="btn-h1" title="Heading 1 (Cmd+1)">H1</button>
    <button id="btn-h2" title="Heading 2 (Cmd+2)">H2</button>
    <button id="btn-h3" title="Heading 3 (Cmd+3)">H3</button>
    <span class="toolbar-separator"></span>
    <button id="btn-bullet-list" title="Bullet List">• List</button>
    <button id="btn-ordered-list" title="Numbered List">1. List</button>
    <button id="btn-task-list" title="Task List (Cmd+Shift+L)">☐</button>
    <span class="toolbar-separator"></span>
    <button id="btn-blockquote" title="Blockquote (Cmd+Shift+.)">❝</button>
    <button id="btn-codeblock" title="Code Block (Cmd+Shift+\`)">{ }</button>
    <button id="btn-link" title="Link (Cmd+K)">🔗</button>
    <button id="btn-hr" title="Horizontal Rule">—</button>
    <span class="toolbar-separator"></span>
    <div class="toolbar-dropdown" id="table-dropdown">
      <button id="btn-table" title="Insert Table (Cmd+Shift+T)">⊞</button>
      <div class="dropdown-content" id="table-grid-picker">
        <div class="grid-picker" id="grid-picker"></div>
        <div class="grid-label" id="grid-label">Select size</div>
      </div>
    </div>
  </div>
  <!-- Table context menu for row operations -->
  <div id="table-context-menu" class="context-menu" style="display: none;">
    <button id="ctx-select-row">Select row</button>
    <button id="ctx-select-col">Select column</button>
    <button id="ctx-select-table">Select table</button>
    <div class="context-menu-separator"></div>
    <button id="ctx-add-row-above">Add row above</button>
    <button id="ctx-add-row-below">Add row below</button>
    <button id="ctx-delete-row">Delete row</button>
    <div class="context-menu-separator"></div>
    <button id="ctx-move-row-up">Move row up</button>
    <button id="ctx-move-row-down">Move row down</button>
    <div class="context-menu-separator"></div>
    <button id="ctx-delete-table" class="danger">Delete table</button>
  </div>
  <!-- Slash command menu -->
  <div id="slash-menu" class="slash-menu" style="display: none;">
    <div class="slash-menu-header">
      <span class="slash-menu-filter"></span>
    </div>
    <div class="slash-menu-items">
      <button data-command="h1" data-keywords="heading header title">
        <span class="slash-icon">H1</span>
        <span class="slash-label">Heading 1</span>
        <span class="slash-hint">Large heading</span>
      </button>
      <button data-command="h2" data-keywords="heading header title">
        <span class="slash-icon">H2</span>
        <span class="slash-label">Heading 2</span>
        <span class="slash-hint">Medium heading</span>
      </button>
      <button data-command="h3" data-keywords="heading header title">
        <span class="slash-icon">H3</span>
        <span class="slash-label">Heading 3</span>
        <span class="slash-hint">Small heading</span>
      </button>
      <div class="slash-menu-separator"></div>
      <button data-command="bullet" data-keywords="ul unordered list bullet points">
        <span class="slash-icon">•</span>
        <span class="slash-label">Bullet List</span>
        <span class="slash-hint">Unordered list</span>
      </button>
      <button data-command="number" data-keywords="ol ordered list numbered">
        <span class="slash-icon">1.</span>
        <span class="slash-label">Numbered List</span>
        <span class="slash-hint">Ordered list</span>
      </button>
      <button data-command="todo" data-keywords="task checkbox check list">
        <span class="slash-icon">☐</span>
        <span class="slash-label">Task List</span>
        <span class="slash-hint">Checklist</span>
      </button>
      <div class="slash-menu-separator"></div>
      <button data-command="quote" data-keywords="blockquote citation">
        <span class="slash-icon">❝</span>
        <span class="slash-label">Blockquote</span>
        <span class="slash-hint">Quote block</span>
      </button>
      <button data-command="code" data-keywords="codeblock pre syntax">
        <span class="slash-icon">{ }</span>
        <span class="slash-label">Code Block</span>
        <span class="slash-hint">Code snippet</span>
      </button>
      <button data-command="table" data-keywords="grid columns rows">
        <span class="slash-icon">⊞</span>
        <span class="slash-label">Table</span>
        <span class="slash-hint">Insert table</span>
      </button>
      <div class="slash-menu-separator"></div>
      <button data-command="link" data-keywords="url href anchor">
        <span class="slash-icon">🔗</span>
        <span class="slash-label">Link</span>
        <span class="slash-hint">Insert link</span>
      </button>
      <button data-command="hr" data-keywords="divider separator horizontal rule line">
        <span class="slash-icon">—</span>
        <span class="slash-label">Divider</span>
        <span class="slash-hint">Horizontal rule</span>
      </button>
    </div>
  </div>
  <div id="editor-container">
    <div id="editor"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
