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
const UPDATE_DEBOUNCE_MS = 50; // Debounce rapid updates (AI streaming)

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
  // Create a proper task list by inserting a bullet list then converting it
  // First create the bullet list, then we'll set the checked attribute
  if (!editor) return;
  
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { schema } = view.state;
    const { from } = view.state.selection;
    
    // Get the list_item node type
    const listItemType = schema.nodes.list_item;
    const bulletListType = schema.nodes.bullet_list;
    const paragraphType = schema.nodes.paragraph;
    
    if (!listItemType || !bulletListType || !paragraphType) {
      // Fallback to basic approach
      runCommand(callCommand(wrapInBulletListCommand.key));
      return;
    }
    
    // Create a task list item with checked=false
    const paragraph = paragraphType.create(null);
    const listItem = listItemType.create({ checked: false }, paragraph);
    const bulletList = bulletListType.create(null, listItem);
    
    // Insert the task list
    const tr = view.state.tr.replaceSelectionWith(bulletList);
    
    // Move cursor into the paragraph
    const newPos = from + 3; // Position inside the paragraph
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    
    view.dispatch(tr);
  });
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

// ==========================================================================
// Slash Command Menu
// ==========================================================================

let slashMenuActive = false;
let slashTriggerPos = 0;
let slashFilter = '';
let selectedSlashIndex = 0;

// Map of command IDs to their handler functions
const slashCommands: Record<string, () => void> = {
  'h1': () => setHeading(1),
  'h2': () => setHeading(2),
  'h3': () => setHeading(3),
  'bullet': toggleBulletList,
  'number': toggleOrderedList,
  'todo': insertTaskList,
  'quote': toggleBlockquote,
  'code': insertCodeBlock,
  'table': () => {
    // For table, show the grid picker
    toggleTableDropdown();
  },
  'link': insertLink,
  'hr': insertHorizontalRule,
};

function showSlashMenu() {
  const menu = document.getElementById('slash-menu');
  if (!menu || !editor) return;
  
  slashMenuActive = true;
  slashFilter = '';
  selectedSlashIndex = 0;
  
  // Get cursor position from ProseMirror
  let coords = { left: 100, top: 100 };
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const pos = view.state.selection.from;
      slashTriggerPos = pos;
      coords = view.coordsAtPos(pos);
    });
  } catch (e) {
    console.warn('Could not get cursor position');
  }
  
  // Position menu below cursor
  const menuHeight = 320;
  const viewportHeight = window.innerHeight;
  
  // Check if menu would go below viewport
  let top = coords.top + 20;
  if (top + menuHeight > viewportHeight) {
    top = coords.top - menuHeight - 10;
  }
  
  menu.style.left = `${Math.max(10, coords.left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;
  menu.style.display = 'block';
  
  // Update filter display and reset selection
  updateSlashFilter();
  updateSlashSelection();
}

function hideSlashMenu() {
  const menu = document.getElementById('slash-menu');
  if (menu) {
    menu.style.display = 'none';
  }
  slashMenuActive = false;
  slashFilter = '';
  selectedSlashIndex = 0;
}

function updateSlashFilter() {
  const filterEl = document.querySelector('.slash-menu-filter');
  if (filterEl) {
    filterEl.textContent = slashFilter;
  }
  
  // Filter the menu items
  const buttons = document.querySelectorAll('.slash-menu button[data-command]');
  let visibleCount = 0;
  const filterLower = slashFilter.toLowerCase();
  
  buttons.forEach((btn) => {
    const button = btn as HTMLElement;
    const command = button.dataset.command || '';
    const keywords = button.dataset.keywords || '';
    const label = button.querySelector('.slash-label')?.textContent || '';
    
    // Match against command, keywords, and label
    const searchText = `${command} ${keywords} ${label}`.toLowerCase();
    const matches = filterLower === '' || searchText.includes(filterLower);
    
    if (matches) {
      button.classList.remove('hidden');
      visibleCount++;
    } else {
      button.classList.add('hidden');
    }
  });
  
  // Reset selection if current selection is hidden
  if (visibleCount > 0) {
    selectedSlashIndex = Math.min(selectedSlashIndex, visibleCount - 1);
  } else {
    selectedSlashIndex = 0;
  }
  
  updateSlashSelection();
}

function updateSlashSelection() {
  const buttons = document.querySelectorAll('.slash-menu button[data-command]:not(.hidden)');
  buttons.forEach((btn, idx) => {
    if (idx === selectedSlashIndex) {
      btn.classList.add('selected');
    } else {
      btn.classList.remove('selected');
    }
  });
}

function getVisibleSlashButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.slash-menu button[data-command]:not(.hidden)')) as HTMLElement[];
}

function executeSlashCommand(command: string) {
  // First, delete the slash and filter text from the document
  if (editor) {
    editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        const currentPos = view.state.selection.from;
        // Delete from trigger position to current position (the "/" and filter text)
        const tr = view.state.tr.delete(slashTriggerPos - 1, currentPos);
        view.dispatch(tr);
      } catch (e) {
        console.warn('Could not delete slash trigger text');
      }
    });
  }
  
  hideSlashMenu();
  
  // Execute the command
  const handler = slashCommands[command];
  if (handler) {
    // Small delay to let the deletion complete
    setTimeout(() => {
      handler();
    }, 10);
  }
}

function handleSlashKeydown(e: KeyboardEvent): boolean {
  if (!slashMenuActive) return false;
  
  const visibleButtons = getVisibleSlashButtons();
  
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      selectedSlashIndex = Math.min(selectedSlashIndex + 1, visibleButtons.length - 1);
      updateSlashSelection();
      // Scroll selected item into view
      visibleButtons[selectedSlashIndex]?.scrollIntoView({ block: 'nearest' });
      return true;
      
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      selectedSlashIndex = Math.max(selectedSlashIndex - 1, 0);
      updateSlashSelection();
      visibleButtons[selectedSlashIndex]?.scrollIntoView({ block: 'nearest' });
      return true;
      
    case 'Enter':
      e.preventDefault();
      e.stopPropagation();
      const selectedBtn = visibleButtons[selectedSlashIndex];
      if (selectedBtn) {
        const command = selectedBtn.dataset.command;
        if (command) {
          executeSlashCommand(command);
        }
      }
      return true;
      
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      hideSlashMenu();
      return true;
      
    case 'Backspace':
      if (slashFilter.length > 0) {
        slashFilter = slashFilter.slice(0, -1);
        updateSlashFilter();
      } else {
        // If no filter and backspace, close menu (user deleted the /)
        hideSlashMenu();
      }
      return false; // Let the editor handle the backspace too
      
    case ' ':
      // Space closes the menu (user is typing normal content)
      hideSlashMenu();
      return false;
      
    default:
      // If it's a printable character, add to filter
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        slashFilter += e.key;
        updateSlashFilter();
        
        // If no results, close menu
        const stillVisible = getVisibleSlashButtons();
        if (stillVisible.length === 0) {
          hideSlashMenu();
        }
      }
      return false;
  }
}

function setupSlashMenu() {
  const menu = document.getElementById('slash-menu');
  if (!menu) return;
  
  // Prevent clicks on menu from stealing focus
  menu.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  
  // Handle clicks on menu items
  menu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest('button[data-command]') as HTMLElement;
    if (button) {
      const command = button.dataset.command;
      if (command) {
        executeSlashCommand(command);
      }
    }
  });
  
  // Handle hover to update selection
  menu.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest('button[data-command]') as HTMLElement;
    if (button && !button.classList.contains('hidden')) {
      const visibleButtons = getVisibleSlashButtons();
      const idx = visibleButtons.indexOf(button);
      if (idx !== -1) {
        selectedSlashIndex = idx;
        updateSlashSelection();
      }
    }
  });
  
  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (slashMenuActive && !menu.contains(e.target as Node)) {
      hideSlashMenu();
    }
  });
}

function isInCodeBlock(): boolean {
  if (!editor) return false;
  
  let inCode = false;
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { $from } = view.state.selection;
      
      // Check if we're inside a code block or code mark
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'code_block' || node.type.name === 'fence') {
          inCode = true;
          break;
        }
      }
      
      // Also check for inline code mark
      if (!inCode) {
        const marks = $from.marks();
        inCode = marks.some(m => m.type.name === 'code' || m.type.name === 'inlineCode');
      }
    });
  } catch (e) {
    // If we can't determine, assume not in code
  }
  
  return inCode;
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

  // Toggle task list items when clicking the checkbox area.
  // Milkdown renders task items as li[data-item-type="task"] with data-checked,
  // so we detect clicks in the left gutter and flip the list_item.checked attr.
  document.getElementById('editor')?.addEventListener('click', (e) => {
    const evt = e as MouseEvent;
    const target = evt.target as HTMLElement;
    const taskItem = target.closest('li[data-item-type="task"]') as HTMLElement | null;
    if (!taskItem || !editor) return;

    const rect = taskItem.getBoundingClientRect();
    const clickX = evt.clientX - rect.left;
    // Only toggle when clicking near the checkbox area (left side)
    if (clickX > 28) return;

    evt.preventDefault();
    evt.stopPropagation();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const pos = view.posAtDOM(taskItem, 0);
      const $pos = view.state.doc.resolve(pos);

      let depth = $pos.depth;
      while (depth > 0 && $pos.node(depth).type.name !== 'list_item') depth--;
      if (depth === 0) return;

      const node = $pos.node(depth);
      if (node.attrs.checked == null) return;

      const nodePos = $pos.before(depth);
      const nextChecked = !node.attrs.checked;
      const tr = view.state.tr.setNodeMarkup(nodePos, void 0, {
        ...node.attrs,
        checked: nextChecked,
      });
      view.dispatch(tr);
    });
  });
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Handle slash menu navigation first
    if (slashMenuActive) {
      if (handleSlashKeydown(e)) {
        return;
      }
    }
    
    const isMod = e.metaKey || e.ctrlKey;

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

// Setup slash command trigger detection
function setupSlashTrigger() {
  // We need to detect "/" being typed in the editor
  // This is done via the 'input' event on the ProseMirror editor
  const editorContainer = document.getElementById('editor');
  if (!editorContainer) return;
  
  // Use a MutationObserver approach or input event
  // Actually, better to listen to keydown for "/" specifically
  document.addEventListener('keydown', (e) => {
    // Only trigger if not already in slash menu and "/" is pressed
    if (e.key === '/' && !slashMenuActive && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Check if we're in a code block - don't trigger there
      if (!isInCodeBlock()) {
        // Small delay to let the "/" be inserted first
        setTimeout(() => {
          showSlashMenu();
        }, 10);
      }
    }
  });
}

async function initializeEditor(content: string) {
  const editorContainer = document.getElementById('editor');
  if (!editorContainer) return;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer);
      ctx.set(defaultValueCtx, content);
      ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
        if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
          vscode.postMessage({
            type: 'edit',
            content: markdown,
          });
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
  setupSlashMenu();
  setupSlashTrigger();
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
  
  const content = pendingUpdate;
  pendingUpdate = null;
  
  // Get current markdown from editor to check if update is needed
  let currentMarkdown = '';
  try {
    editor.action((ctx) => {
      currentMarkdown = getMarkdown()(ctx);
    });
  } catch (e) {
    // If we can't get current markdown, proceed with update
  }
  
  // Skip update if content is identical (avoids unnecessary work)
  if (currentMarkdown === content) {
    return;
  }
  
  isUpdatingFromExtension = true;
  
  // Save cursor position before update
  let savedSelection: { anchor: number; head: number } | null = null;
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { anchor, head } = view.state.selection;
      savedSelection = { anchor, head };
    });
  } catch (e) {
    // If we can't get selection, proceed without it
  }
  
  // Use replaceAll to update content without recreating editor
  // This is much faster and preserves editor state better
  try {
    editor.action(replaceAll(content));
    
    // Restore cursor position if valid
    if (savedSelection) {
      editor.action((ctx) => {
        try {
          const view = ctx.get(editorViewCtx);
          const docLength = view.state.doc.content.size;
          
          // Clamp selection to valid range (ensure within document bounds)
          const anchor = Math.min(Math.max(1, savedSelection!.anchor), docLength - 1);
          
          // Create and apply new selection
          const newSelection = TextSelection.create(view.state.doc, anchor);
          view.dispatch(view.state.tr.setSelection(newSelection));
        } catch (e) {
          // If selection restoration fails, that's okay - cursor will be at start
        }
      });
    }
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
    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, editorContainer);
        ctx.set(defaultValueCtx, content);
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
          if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
            vscode.postMessage({
              type: 'edit',
              content: markdown,
            });
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
