import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import { 
  commonmark, 
  toggleStrongCommand, 
  toggleEmphasisCommand, 
  wrapInHeadingCommand, 
  wrapInBulletListCommand, 
  wrapInOrderedListCommand, 
  insertHrCommand,
  toggleInlineCodeCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  toggleLinkCommand
} from '@milkdown/preset-commonmark';
import { 
  gfm, 
  toggleStrikethroughCommand,
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  deleteSelectedCellsCommand,
  moveRowCommand,
  selectRowCommand,
  selectColCommand,
  selectTableCommand
} from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { callCommand, replaceAll, getMarkdown } from '@milkdown/utils';
import { nord } from '@milkdown/theme-nord';
// Import our VS Code theme-aware styles (NOT the Nord CSS)
import './styles.css';

// Acquire VS Code API
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

let editor: Editor | null = null;
let isUpdatingFromExtension = false;
let currentVersion = 0;
let pendingUpdate: string | null = null;
let updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const UPDATE_DEBOUNCE_MS = 30; // Debounce rapid updates (AI streaming)
const USER_IDLE_BEFORE_EXTERNAL_APPLY_MS = 150; // Buffer external updates while user is actively typing
let lastLocalEditAt = 0;

// Outgoing edit debounce (batch rapid keystrokes into one message)
let pendingOutgoingEdit: string | null = null;
let outgoingEditTimer: ReturnType<typeof setTimeout> | null = null;
const OUTGOING_EDIT_DEBOUNCE_MS = 16; // ~1 frame at 60fps

// Cache last known markdown to avoid expensive getMarkdown() calls
let lastKnownMarkdown: string = '';

function normalizeMarkdownForCompare(markdown: string): string {
  // Normalize line endings to reduce false mismatches between VS Code and Milkdown outputs.
  return markdown.replace(/\r\n/g, '\n');
}

function sendOutgoingEdit(markdown: string) {
  pendingOutgoingEdit = markdown;
  if (outgoingEditTimer) {
    clearTimeout(outgoingEditTimer);
  }
  outgoingEditTimer = setTimeout(() => {
    if (pendingOutgoingEdit !== null) {
      vscode.postMessage({
        type: 'edit',
        content: pendingOutgoingEdit,
      });
      pendingOutgoingEdit = null;
    }
  }, OUTGOING_EDIT_DEBOUNCE_MS);
}

// Toolbar action handlers
function runCommand(command: ReturnType<typeof callCommand>) {
  if (editor) {
    editor.action(command);
  }
}

function toggleBold() {
  runCommand(callCommand(toggleStrongCommand.key));
}

function toggleItalic() {
  runCommand(callCommand(toggleEmphasisCommand.key));
}

function toggleStrikethrough() {
  runCommand(callCommand(toggleStrikethroughCommand.key));
}

function setHeading(level: number) {
  runCommand(callCommand(wrapInHeadingCommand.key, level));
}

function toggleBulletList() {
  runCommand(callCommand(wrapInBulletListCommand.key));
}

function toggleOrderedList() {
  runCommand(callCommand(wrapInOrderedListCommand.key));
}

function insertHorizontalRule() {
  runCommand(callCommand(insertHrCommand.key));
}

function toggleInlineCode() {
  runCommand(callCommand(toggleInlineCodeCommand.key));
}

function toggleBlockquote() {
  runCommand(callCommand(wrapInBlockquoteCommand.key));
}

function insertCodeBlock() {
  runCommand(callCommand(createCodeBlockCommand.key));
}

function insertTaskList() {
  // Task lists don't have a dedicated command, so we create a bullet list
  // The user can type "[ ]" to convert to task list, or we insert the markdown directly
  runCommand(callCommand(wrapInBulletListCommand.key));
}

function insertLink() {
  runCommand(callCommand(toggleLinkCommand.key));
}

// Table functions
function insertTable(rows: number, cols: number) {
  // Focus editor first to ensure table inserts at cursor position
  const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
  if (editorEl) {
    editorEl.focus();
  }
  runCommand(callCommand(insertTableCommand.key, { row: rows, col: cols }));
  closeTableDropdown();
}

function addRowAbove() {
  runCommand(callCommand(addRowBeforeCommand.key));
  hideContextMenu();
}

function addRowBelow() {
  runCommand(callCommand(addRowAfterCommand.key));
  hideContextMenu();
}

function deleteRow() {
  // First select the current row, then delete selected cells
  runCommand(callCommand(selectRowCommand.key, { index: -1 }));
  // Small delay to ensure selection is applied before delete
  setTimeout(() => {
    runCommand(callCommand(deleteSelectedCellsCommand.key));
  }, 10);
  hideContextMenu();
}

function moveRowUp() {
  // Move current row up by swapping with previous row
  runCommand(callCommand(moveRowCommand.key, { from: -1, to: -2 }));
  hideContextMenu();
}

function moveRowDown() {
  // Move current row down by swapping with next row
  runCommand(callCommand(moveRowCommand.key, { from: -1, to: 0 }));
  hideContextMenu();
}

function selectRow() {
  // Select current row (index -1 means current)
  runCommand(callCommand(selectRowCommand.key, { index: -1 }));
  hideContextMenu();
}

function selectColumn() {
  // Select current column (index -1 means current)
  runCommand(callCommand(selectColCommand.key, { index: -1 }));
  hideContextMenu();
}

function selectTable() {
  runCommand(callCommand(selectTableCommand.key));
  hideContextMenu();
}

function deleteTable() {
  // Select the entire table, then delete
  runCommand(callCommand(selectTableCommand.key));
  setTimeout(() => {
    runCommand(callCommand(deleteSelectedCellsCommand.key));
  }, 10);
  hideContextMenu();
}

// Grid picker state
let gridPickerInitialized = false;

function initGridPicker() {
  if (gridPickerInitialized) return;
  
  const gridPicker = document.getElementById('grid-picker');
  if (!gridPicker) return;
  
  // Generate 6x6 grid cells
  for (let row = 1; row <= 6; row++) {
    for (let col = 1; col <= 6; col++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      gridPicker.appendChild(cell);
    }
  }
  
  // Prevent focus loss when interacting with grid
  gridPicker.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  
  // Add hover and click handlers
  gridPicker.addEventListener('mouseover', handleGridHover);
  gridPicker.addEventListener('mouseout', handleGridMouseOut);
  gridPicker.addEventListener('click', handleGridClick);
  
  gridPickerInitialized = true;
}

function handleGridHover(e: Event) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('grid-cell')) return;
  
  const row = parseInt(target.dataset.row || '0');
  const col = parseInt(target.dataset.col || '0');
  
  // Highlight all cells up to and including this one
  const cells = document.querySelectorAll('.grid-cell');
  cells.forEach(cell => {
    const cellEl = cell as HTMLElement;
    const cellRow = parseInt(cellEl.dataset.row || '0');
    const cellCol = parseInt(cellEl.dataset.col || '0');
    
    if (cellRow <= row && cellCol <= col) {
      cellEl.classList.add('highlighted');
    } else {
      cellEl.classList.remove('highlighted');
    }
  });
  
  // Update label
  const label = document.getElementById('grid-label');
  if (label) {
    label.textContent = `${row} × ${col} table`;
  }
}

function handleGridMouseOut(e: Event) {
  const relatedTarget = (e as MouseEvent).relatedTarget as HTMLElement;
  const gridPicker = document.getElementById('grid-picker');
  
  // Only clear if leaving the grid entirely
  if (gridPicker && !gridPicker.contains(relatedTarget)) {
    const cells = document.querySelectorAll('.grid-cell');
    cells.forEach(cell => cell.classList.remove('highlighted'));
    
    const label = document.getElementById('grid-label');
    if (label) {
      label.textContent = 'Select size';
    }
  }
}

function handleGridClick(e: Event) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('grid-cell')) return;
  
  const row = parseInt(target.dataset.row || '0');
  const col = parseInt(target.dataset.col || '0');
  
  if (row > 0 && col > 0) {
    insertTable(row, col);
  }
}

function toggleTableDropdown() {
  const dropdown = document.getElementById('table-dropdown');
  if (dropdown) {
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) {
      initGridPicker();
    }
  }
}

function closeTableDropdown() {
  const dropdown = document.getElementById('table-dropdown');
  if (dropdown) {
    dropdown.classList.remove('open');
  }
}

// Context menu functions
function showContextMenu(x: number, y: number) {
  const menu = document.getElementById('table-context-menu');
  if (menu) {
    menu.style.display = 'block';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }
}

function hideContextMenu() {
  const menu = document.getElementById('table-context-menu');
  if (menu) {
    menu.style.display = 'none';
  }
}

// Setup toolbar event listeners
function setupToolbar() {
  document.getElementById('btn-bold')?.addEventListener('click', toggleBold);
  document.getElementById('btn-italic')?.addEventListener('click', toggleItalic);
  document.getElementById('btn-strikethrough')?.addEventListener('click', toggleStrikethrough);
  document.getElementById('btn-code')?.addEventListener('click', toggleInlineCode);
  document.getElementById('btn-h1')?.addEventListener('click', () => setHeading(1));
  document.getElementById('btn-h2')?.addEventListener('click', () => setHeading(2));
  document.getElementById('btn-h3')?.addEventListener('click', () => setHeading(3));
  document.getElementById('btn-bullet-list')?.addEventListener('click', toggleBulletList);
  document.getElementById('btn-ordered-list')?.addEventListener('click', toggleOrderedList);
  document.getElementById('btn-task-list')?.addEventListener('click', insertTaskList);
  document.getElementById('btn-blockquote')?.addEventListener('click', toggleBlockquote);
  document.getElementById('btn-codeblock')?.addEventListener('click', insertCodeBlock);
  document.getElementById('btn-link')?.addEventListener('click', insertLink);
  document.getElementById('btn-hr')?.addEventListener('click', insertHorizontalRule);
  
  // Table dropdown - prevent focus loss from editor
  const tableBtn = document.getElementById('btn-table');
  tableBtn?.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent focus from leaving editor
  });
  tableBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTableDropdown();
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('table-dropdown');
    if (dropdown && !dropdown.contains(e.target as Node)) {
      closeTableDropdown();
    }
  });
  
  // Context menu for table operations
  document.getElementById('ctx-select-row')?.addEventListener('click', selectRow);
  document.getElementById('ctx-select-col')?.addEventListener('click', selectColumn);
  document.getElementById('ctx-select-table')?.addEventListener('click', selectTable);
  document.getElementById('ctx-add-row-above')?.addEventListener('click', addRowAbove);
  document.getElementById('ctx-add-row-below')?.addEventListener('click', addRowBelow);
  document.getElementById('ctx-delete-row')?.addEventListener('click', deleteRow);
  document.getElementById('ctx-delete-table')?.addEventListener('click', deleteTable);
  document.getElementById('ctx-move-row-up')?.addEventListener('click', moveRowUp);
  document.getElementById('ctx-move-row-down')?.addEventListener('click', moveRowDown);
  
  // Hide context menu on click outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('table-context-menu');
    if (menu && !menu.contains(e.target as Node)) {
      hideContextMenu();
    }
  });
  
  // Right-click on tables to show context menu
  document.getElementById('editor')?.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    // Check if we're inside a table
    if (target.closest('table')) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY);
    }
  });
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Track active typing to avoid applying external updates mid-keystroke.
    // This is intentionally broad (covers fast typing, backspace, enter).
    const target = e.target as HTMLElement | null;
    const isInEditor = Boolean(target && target.closest && target.closest('.ProseMirror'));
    if (
      isInEditor &&
      !isMod &&
      !e.altKey &&
      (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Delete')
    ) {
      lastLocalEditAt = Date.now();
    }

    if (isMod && e.key === 'b') {
      e.preventDefault();
      e.stopPropagation();
      toggleBold();
    } else if (isMod && e.key === 'i') {
      e.preventDefault();
      e.stopPropagation();
      toggleItalic();
    } else if (isMod && e.shiftKey && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      toggleStrikethrough();
    } else if (isMod && e.key === '1') {
      e.preventDefault();
      e.stopPropagation();
      setHeading(1);
    } else if (isMod && e.key === '2') {
      e.preventDefault();
      e.stopPropagation();
      setHeading(2);
    } else if (isMod && e.key === '3') {
      e.preventDefault();
      e.stopPropagation();
      setHeading(3);
    } else if (isMod && e.key === '`') {
      // Cmd+` for inline code, Cmd+Shift+` for code block
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        insertCodeBlock();
      } else {
        toggleInlineCode();
      }
    } else if (isMod && e.shiftKey && e.key === 'l') {
      // Cmd+Shift+L for task list
      e.preventDefault();
      e.stopPropagation();
      insertTaskList();
    } else if (isMod && e.shiftKey && e.key === '.') {
      // Cmd+Shift+. for blockquote
      e.preventDefault();
      e.stopPropagation();
      toggleBlockquote();
    } else if (isMod && e.key === 'k') {
      // Cmd+K for link
      e.preventDefault();
      e.stopPropagation();
      insertLink();
    } else if (isMod && e.shiftKey && e.key === 't') {
      // Cmd+Shift+T for table (opens picker or inserts 3x3)
      e.preventDefault();
      e.stopPropagation();
      toggleTableDropdown();
    }
  }, true);
}

async function initializeEditor(content: string) {
  const editorContainer = document.getElementById('editor');
  if (!editorContainer) return;

  lastKnownMarkdown = content;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer);
      ctx.set(defaultValueCtx, content);
      ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
        if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
          lastLocalEditAt = Date.now();
          lastKnownMarkdown = markdown;
          sendOutgoingEdit(markdown);
        }
      });
    })
    .config(nord)
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .create();

  setupToolbar();
  setupKeyboardShortcuts();
}

async function updateEditorContent(content: string) {
  if (!editor) {
    await initializeEditor(content);
    return;
  }

  // Debounce rapid updates (e.g., during AI streaming)
  pendingUpdate = content;
  
  if (updateDebounceTimer) {
    clearTimeout(updateDebounceTimer);
  }
  
  updateDebounceTimer = setTimeout(() => {
    applyPendingUpdate();
  }, UPDATE_DEBOUNCE_MS);
}

function applyPendingUpdate() {
  if (!editor || pendingUpdate === null) return;

  // Avoid applying external updates while the user is actively typing.
  // Applying replaceAll mid-typing can reset selection and cause the cursor to "jump".
  const msSinceLocalEdit = Date.now() - lastLocalEditAt;
  if (msSinceLocalEdit < USER_IDLE_BEFORE_EXTERNAL_APPLY_MS) {
    if (updateDebounceTimer) {
      clearTimeout(updateDebounceTimer);
    }
    updateDebounceTimer = setTimeout(
      applyPendingUpdate,
      USER_IDLE_BEFORE_EXTERNAL_APPLY_MS - msSinceLocalEdit
    );
    return;
  }

  const content = pendingUpdate;
  pendingUpdate = null;
  
  // Fast-path: use cached markdown for comparison (avoids expensive getMarkdown() call)
  const normalizedContent = normalizeMarkdownForCompare(content);
  const normalizedCached = normalizeMarkdownForCompare(lastKnownMarkdown);
  
  // Quick length check before full string compare
  if (normalizedContent.length === normalizedCached.length && normalizedContent === normalizedCached) {
    return;
  }
  
  isUpdatingFromExtension = true;
  
  // Batch all operations into a single editor.action() for better performance
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      
      // Save cursor position
      const { anchor } = view.state.selection;
      
      // Apply content update via replaceAll
      replaceAll(content)(ctx);
      
      // Update cache
      lastKnownMarkdown = content;
      
      // Restore cursor position (clamped to valid range)
      try {
        const newView = ctx.get(editorViewCtx);
        const docLength = newView.state.doc.content.size;
        const clampedAnchor = Math.min(Math.max(1, anchor), docLength - 1);
        const newSelection = TextSelection.create(newView.state.doc, clampedAnchor);
        newView.dispatch(newView.state.tr.setSelection(newSelection));
      } catch {
        // If selection restoration fails, that's okay
      }
    });
  } catch (e) {
    console.warn('replaceAll failed, falling back to re-initialization:', e);
    // Fallback: reinitialize if replaceAll fails
    reinitializeEditor(content);
  }
  
  isUpdatingFromExtension = false;
}

async function reinitializeEditor(content: string) {
  const editorContainer = document.getElementById('editor');
  if (editorContainer) {
    editorContainer.innerHTML = '';
    lastKnownMarkdown = content;
    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, editorContainer);
        ctx.set(defaultValueCtx, content);
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
          if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
            lastLocalEditAt = Date.now();
            lastKnownMarkdown = markdown;
            sendOutgoingEdit(markdown);
          }
        });
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .create();
  }
}

// Handle messages from the extension
window.addEventListener('message', async (event) => {
  const message = event.data;

  switch (message.type) {
    case 'update':
      currentVersion = message.version;
      await updateEditorContent(message.content);
      break;
  }
});

// Notify extension that webview is ready
vscode.postMessage({ type: 'ready' });
