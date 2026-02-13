import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

/**
 * Updates the workbench.editorAssociations setting based on user preference.
 * This determines whether .md files open in rendered view or raw source by default.
 */
async function updateEditorAssociation(defaultView: 'rendered' | 'source') {
  const config = vscode.workspace.getConfiguration('workbench');
  const associations = config.get<Record<string, string>>('editorAssociations') || {};
  
  const newAssociations = { ...associations };
  
  if (defaultView === 'rendered') {
    newAssociations['*.md'] = 'markdownLiveRender.editor';
  } else {
    newAssociations['*.md'] = 'default';
  }
  
  if (associations['*.md'] !== newAssociations['*.md']) {
    await config.update('editorAssociations', newAssociations, vscode.ConfigurationTarget.Global);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Get the user's preference for default view and set editor association
  const config = vscode.workspace.getConfiguration('markdownLiveRender');
  const defaultView = config.get<'rendered' | 'source'>('defaultView', 'rendered');
  updateEditorAssociation(defaultView);
  
  // Listen for configuration changes to update the association dynamically
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markdownLiveRender.defaultView')) {
        const newConfig = vscode.workspace.getConfiguration('markdownLiveRender');
        const newValue = newConfig.get<'rendered' | 'source'>('defaultView', 'rendered');
        updateEditorAssociation(newValue);
      }
    })
  );

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

  // Register toggle command (Cmd+Shift+M) to switch between rendered and raw in-place
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownLiveRender.toggle', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!activeTab) {
        vscode.window.showInformationMessage('No active editor');
        return;
      }

      let uri: vscode.Uri | undefined;
      let targetViewType: string;

      if (activeTab.input instanceof vscode.TabInputCustom) {
        uri = activeTab.input.uri;
        if (!uri.fsPath.endsWith('.md')) return;
        targetViewType = 'default';
      } else if (activeTab.input instanceof vscode.TabInputText) {
        uri = activeTab.input.uri;
        if (!uri.fsPath.endsWith('.md')) return;
        targetViewType = MarkdownEditorProvider.viewType;
      } else {
        return;
      }

      // Close current tab so the reopen takes the same tab slot (in-place toggle)
      await vscode.window.tabGroups.close(activeTab, false);
      await vscode.commands.executeCommand('vscode.openWith', uri, targetViewType);
    })
  );

  // Register command to toggle the default view setting from command palette
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownLiveRender.toggleDefaultView', async () => {
      const config = vscode.workspace.getConfiguration('markdownLiveRender');
      const currentView = config.get<'rendered' | 'source'>('defaultView', 'rendered');
      const newView = currentView === 'rendered' ? 'source' : 'rendered';
      
      await config.update('defaultView', newView, vscode.ConfigurationTarget.Global);
      
      const message = newView === 'rendered' 
        ? 'Default: Rendered view (WYSIWYG)'
        : 'Default: Raw source text';
      vscode.window.showInformationMessage(`Markdown Live Render — ${message}`);
    })
  );

  console.log('Markdown Live Render extension activated');
}

export function deactivate() {
  console.log('Markdown Live Render extension deactivated');
}
