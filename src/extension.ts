import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('markdownLiveRender');

  if (!config.get('enabled', true)) {
    return;
  }

  // Register the custom editor provider
  const provider = new MarkdownEditorProvider(context);

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

  // Track files currently in diff view - we should use raw markdown for these
  const filesInDiff = new Set<string>();

  // Monitor for diff tabs opening/closing
  // When a diff is shown for an .md file, close our custom editor so raw markdown is visible
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(async (event) => {
      const diffConfig = vscode.workspace.getConfiguration('markdownLiveRender');
      if (!diffConfig.get('useRawForDiffs', true)) {
        return;
      }

      // Check opened tabs for diffs involving markdown files
      for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const modifiedUri = tab.input.modified;
          if (modifiedUri.fsPath.endsWith('.md')) {
            const uriString = modifiedUri.toString();
            filesInDiff.add(uriString);
            
            // Find and close any custom editor tab for this file
            // This lets the diff view show raw markdown
            for (const group of vscode.window.tabGroups.all) {
              for (const existingTab of group.tabs) {
                if (
                  existingTab.input instanceof vscode.TabInputCustom &&
                  existingTab.input.uri.toString() === uriString &&
                  existingTab.input.viewType === MarkdownEditorProvider.viewType
                ) {
                  // Close our custom editor - the diff will show raw text
                  await vscode.window.tabGroups.close(existingTab);
                }
              }
            }
          }
        }
      }

      // Track when diff tabs are closed
      for (const tab of event.closed) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const modifiedUri = tab.input.modified;
          if (modifiedUri.fsPath.endsWith('.md')) {
            filesInDiff.delete(modifiedUri.toString());
          }
        }
      }
    })
  );

  // Register command to open file with this editor
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
