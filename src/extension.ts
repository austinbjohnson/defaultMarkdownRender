import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('markdownLiveRender');

  if (!config.get('enabled', true)) {
    return;
  }

  // Track URIs that are currently in a diff view - these should use raw text
  const urisInDiffView = new Set<string>();

  // Register the custom editor provider with access to diff tracking
  const provider = new MarkdownEditorProvider(context, urisInDiffView);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Monitor tabs to track which files are in diff views and close custom editors for them
  const updateDiffTracking = async () => {
    urisInDiffView.clear();
    const customEditorsToClose: vscode.Tab[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          // Track both sides of the diff
          const originalUri = tab.input.original.toString();
          const modifiedUri = tab.input.modified.toString();
          urisInDiffView.add(originalUri);
          urisInDiffView.add(modifiedUri);
        }
      }
    }

    // Now find and close any custom editors that are showing files in diff views
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === MarkdownEditorProvider.viewType &&
          urisInDiffView.has(tab.input.uri.toString())
        ) {
          customEditorsToClose.push(tab);
        }
      }
    }

    // Close custom editors that conflict with diffs
    for (const tab of customEditorsToClose) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        // Tab may already be closed
      }
    }
  };

  // Initial scan
  updateDiffTracking();

  // Update when tabs change
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateDiffTracking();
    })
  );

  // Register command to open file with this editor (from command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownLiveRender.openWith', async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.fileName.endsWith('.md')) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          activeEditor.document.uri,
          MarkdownEditorProvider.viewType
        );
      } else {
        vscode.window.showInformationMessage('Open a markdown file first');
      }
    })
  );

  // Register command to open as raw text
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownLiveRender.openAsText', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (activeTab && activeTab.input instanceof vscode.TabInputCustom) {
        const uri = activeTab.input.uri;
        if (uri.fsPath.endsWith('.md')) {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        }
      } else {
        vscode.window.showInformationMessage('Open a markdown file first');
      }
    })
  );

  // Register toggle command (Cmd+Shift+M) to switch between rendered and raw
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownLiveRender.toggle', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!activeTab) {
        vscode.window.showInformationMessage('No active editor');
        return;
      }

      // Check if we're in the custom editor (rendered view)
      if (activeTab.input instanceof vscode.TabInputCustom) {
        const uri = activeTab.input.uri;
        if (uri.fsPath.endsWith('.md')) {
          // Switch to raw text editor
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        }
      } 
      // Check if we're in a text editor with a markdown file
      else if (activeTab.input instanceof vscode.TabInputText) {
        const uri = activeTab.input.uri;
        if (uri.fsPath.endsWith('.md')) {
          // Switch to rendered view
          await vscode.commands.executeCommand('vscode.openWith', uri, MarkdownEditorProvider.viewType);
        }
      }
    })
  );

  console.log('Markdown Live Render extension activated');
}

export function deactivate() {
  console.log('Markdown Live Render extension deactivated');
}
