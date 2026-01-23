# Markdown Live Render

A WYSIWYG markdown editor for VS Code with live sync for AI collaboration.

## Features

- Live rendered markdown editing (no split pane needed)
- Toolbar with formatting buttons
- Slash commands (`//`) for quick formatting
- Table insertion with grid picker
- Keyboard shortcuts for common actions
- Seamless sync with AI assistants editing the same file

## Installation

Install from the `.vsix` file:
```bash
code --install-extension markdown-live-render-0.1.0.vsix
```

## Development Workflow

### After merging a PR, rebuild the extension:

```bash
# 1. Switch to main and pull latest
git checkout main && git pull

# 2. Build and package
npm run build && npx vsce package --no-dependencies

# 3. Reinstall the extension
code --install-extension markdown-live-render-0.1.0.vsix
```

### Quick rebuild (one command):
```bash
git checkout main && git pull && npm run build && npx vsce package --no-dependencies && code --install-extension markdown-live-render-0.1.0.vsix
```

### Testing during development:
Press `F5` in VS Code to launch the Extension Development Host.

## Keyboard Shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Toggle rendered/raw view | `Cmd+Shift+M` | `Ctrl+Shift+M` |
| Bold | `Cmd+B` | `Ctrl+B` |
| Italic | `Cmd+I` | `Ctrl+I` |
| Strikethrough | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Inline code | `Cmd+\`` | `Ctrl+\`` |
| Code block | `Cmd+Shift+\`` | `Ctrl+Shift+\`` |
| Link | `Cmd+K` | `Ctrl+K` |
| Heading 1/2/3 | `Cmd+1/2/3` | `Ctrl+1/2/3` |
| Blockquote | `Cmd+Shift+.` | `Ctrl+Shift+.` |
| Insert table | `Cmd+Shift+T` | `Ctrl+Shift+T` |

## Slash Commands

Type `//` at the start of a line or after a space to open the command menu:
- `//h1`, `//h2`, `//h3` - Headings
- `//bullet`, `//numbered` - Lists
- `//quote` - Blockquote
- `//code` - Code block
- `//table` - Insert table
- `//hr` - Horizontal rule
- `//link` - Insert link
- `//bold`, `//italic`, `//strike` - Text formatting