# Claude Instructions

## After Merging a PR

Always rebuild the extension after merging so the user can reinstall:

```bash
git checkout main && git pull && npm run build && npx vsce package --no-dependencies
```

Then remind the user to install with:
```bash
code --install-extension markdown-live-render-0.1.0.vsix
```

## Project Structure

- `src/extension.ts` - VS Code extension entry point
- `src/markdownEditorProvider.ts` - Custom editor provider, contains toolbar HTML
- `src/webview/editor.ts` - Milkdown editor, toolbar handlers, slash commands
- `src/webview/styles.css` - Editor styling
- `media/` - Extension icons/logos
- `package.json` - Extension manifest, commands, keybindings

## Key Technologies

- **Milkdown** - WYSIWYG markdown editor built on ProseMirror
- **@milkdown/preset-commonmark** - Standard markdown support
- **@milkdown/preset-gfm** - GitHub Flavored Markdown (tables, strikethrough)

## Common Tasks

### Adding a toolbar button
1. Add HTML in `markdownEditorProvider.ts` (getHtmlForWebview)
2. Add click handler in `editor.ts` (setupToolbar)
3. Add keyboard shortcut in `editor.ts` (setupKeyboardShortcuts)

### Adding a slash command
1. Add entry to `slashCommands` array in `editor.ts`
2. Create or reference the action function

## Build Commands

- `npm run build` - Build extension
- `npm run watch` - Build with watch mode
- `npx vsce package --no-dependencies` - Package .vsix
