import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import { deleteRow as prosemirrorDeleteRow } from '@milkdown/prose/tables';
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
import { callCommand, replaceAll } from '@milkdown/utils';
import { nord } from '@milkdown/theme-nord';
import yaml from 'js-yaml';
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
let currentFrontmatter: string | null = null;
let currentFrontmatterRawBlock: string | null = null;
let frontmatterToggleInitialized = false;

const FRONTMATTER_REGEX = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n)?/;

type FrontmatterExtractionResult = {
  frontmatter: string | null;
  rawBlock: string | null;
  content: string;
};

// Outgoing edit debounce (batch rapid keystrokes into one message)
let pendingOutgoingEdit: string | null = null;
let outgoingEditTimer: ReturnType<typeof setTimeout> | null = null;
const OUTGOING_EDIT_DEBOUNCE_MS = 16; // ~1 frame at 60fps

// Cache last known markdown to avoid expensive getMarkdown() calls
let lastKnownMarkdown: string = '';

// Slash command state
let slashMenuVisible = false;
let slashMenuSelectedIndex = 0;
let slashTriggerPos: number | null = null;

interface SlashCommand {
  id: string;
  title: string;
  description: string;
  icon: string;
  keywords: string[];
  action: () => void;
}

const slashCommands: SlashCommand[] = [
  { id: 'h1', title: 'Heading 1', description: 'Large section heading', icon: 'H1', keywords: ['h1', 'heading', 'title'], action: () => setHeading(1) },
  { id: 'h2', title: 'Heading 2', description: 'Medium section heading', icon: 'H2', keywords: ['h2', 'heading'], action: () => setHeading(2) },
  { id: 'h3', title: 'Heading 3', description: 'Small section heading', icon: 'H3', keywords: ['h3', 'heading'], action: () => setHeading(3) },
  { id: 'bullet', title: 'Bullet List', description: 'Create a simple bullet list', icon: '•', keywords: ['bullet', 'list', 'ul'], action: toggleBulletList },
  { id: 'numbered', title: 'Numbered List', description: 'Create a numbered list', icon: '1.', keywords: ['numbered', 'list', 'ol', 'ordered'], action: toggleOrderedList },
  { id: 'quote', title: 'Blockquote', description: 'Capture a quote', icon: '❝', keywords: ['quote', 'blockquote'], action: toggleBlockquote },
  { id: 'code', title: 'Code Block', description: 'Add a code snippet', icon: '{ }', keywords: ['code', 'codeblock', 'snippet'], action: insertCodeBlock },
  { id: 'table', title: 'Table', description: 'Insert a 3×3 table', icon: '⊞', keywords: ['table', 'grid'], action: () => insertTable(3, 3) },
  { id: 'hr', title: 'Divider', description: 'Horizontal line separator', icon: '—', keywords: ['hr', 'divider', 'line', 'separator'], action: insertHorizontalRule },
  { id: 'link', title: 'Link', description: 'Add a hyperlink', icon: '🔗', keywords: ['link', 'url', 'href'], action: insertLink },
  { id: 'bold', title: 'Bold', description: 'Bold text', icon: 'B', keywords: ['bold', 'strong'], action: toggleBold },
  { id: 'italic', title: 'Italic', description: 'Italic text', icon: 'I', keywords: ['italic', 'emphasis', 'em'], action: toggleItalic },
  { id: 'strike', title: 'Strikethrough', description: 'Strike through text', icon: 'S', keywords: ['strike', 'strikethrough', 'del'], action: toggleStrikethrough },
  { id: 'inline-code', title: 'Inline Code', description: 'Inline code snippet', icon: '<>', keywords: ['inline', 'code', 'monospace'], action: toggleInlineCode },
];

function normalizeMarkdownForCompare(markdown: string): string {
  // Normalize line endings to reduce false mismatches between VS Code and Milkdown outputs.
  return markdown.replace(/\r\n/g, '\n');
}

function extractFrontmatter(markdown: string): FrontmatterExtractionResult {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: null, rawBlock: null, content: markdown };
  }

  const frontmatterText = match[1];
  try {
    const parsed = yaml.load(frontmatterText);
    if (!parsed || typeof parsed !== 'object') {
      return { frontmatter: null, rawBlock: null, content: markdown };
    }
  } catch {
    return { frontmatter: null, rawBlock: null, content: markdown };
  }

  return {
    frontmatter: frontmatterText,
    rawBlock: match[0],
    content: markdown.slice(match[0].length),
  };
}

function combineFrontmatter(rawBlock: string | null, content: string): string {
  if (!rawBlock) {
    return content;
  }
  return `${rawBlock}${content}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function getScalarTypeClass(value: unknown): string {
  if (value === null) return 'is-null';
  if (value instanceof Date) return 'is-date';
  switch (typeof value) {
    case 'boolean':
      return 'is-boolean';
    case 'number':
      return 'is-number';
    case 'string':
      return 'is-string';
    default:
      return 'is-unknown';
  }
}

function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
    return iso.replace(/\.\d{3}Z$/, 'Z');
  }
  if (typeof value === 'string') return value;
  return String(value);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TAG_LIKE_KEYS = new Set(['tags', 'aliases']);

function isTagLikeArray(key: string, value: unknown): value is string[] {
  if (!TAG_LIKE_KEYS.has(key) || !Array.isArray(value)) return false;
  return value.every((item) => typeof item === 'string');
}

function renderFrontmatterScalar(value: unknown): string {
  const typeClass = getScalarTypeClass(value);
  const displayValue = escapeHtml(formatScalar(value));
  return `<span class="frontmatter-value frontmatter-scalar ${typeClass}" title="${displayValue}">${displayValue}</span>`;
}

function renderFrontmatterChips(values: string[]): string {
  if (values.length === 0) {
    return '<div class="frontmatter-chips frontmatter-chips-empty"></div>';
  }
  const chips = values
    .map((v) => escapeHtml(v))
    .map((v) => `<span class="frontmatter-chip">${v}</span>`)
    .join('');
  return `<div class="frontmatter-chips">${chips}</div>`;
}

function renderFrontmatterArray(values: unknown[], depth: number, _key?: string): string {
  if (values.length === 0) {
    return '<div class="frontmatter-empty frontmatter-empty-array">[]</div>';
  }

  const indentClass = `depth-${Math.min(depth, 6)}`;
  return values
    .map((item) => {
      const nested = isObjectRecord(item) || Array.isArray(item);
      const itemValue = nested ? renderFrontmatterNode(item, depth + 1) : renderFrontmatterScalar(item);
      return `<div class="frontmatter-array-item ${indentClass}">
        <span class="frontmatter-bullet">-</span>
        <div class="frontmatter-array-value">${itemValue}</div>
      </div>`;
    })
    .join('');
}

function renderFrontmatterObject(obj: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return '<div class="frontmatter-empty frontmatter-empty-object">{}</div>';
  }

  const indentClass = `depth-${Math.min(depth, 6)}`;
  return entries
    .map(([key, value]) => {
      const nested = isObjectRecord(value) || Array.isArray(value);
      const keyHtml = `<span class="frontmatter-key">${escapeHtml(key)}</span><span class="frontmatter-separator">:</span>`;

      if (isTagLikeArray(key, value)) {
        return `<div class="frontmatter-property ${indentClass}">
          <div class="frontmatter-row">
            <div class="frontmatter-key-group">${keyHtml}</div>
            <div class="frontmatter-value-group">${renderFrontmatterChips(value)}</div>
          </div>
        </div>`;
      }

      if (nested) {
        return `<div class="frontmatter-property ${indentClass}">
          <div class="frontmatter-row">
            <div class="frontmatter-key-group">${keyHtml}</div>
            <div class="frontmatter-value-group">
              <div class="frontmatter-children">${renderFrontmatterNode(value, depth + 1)}</div>
            </div>
          </div>
        </div>`;
      }

      return `<div class="frontmatter-property ${indentClass}">
        <div class="frontmatter-row">
          <div class="frontmatter-key-group">${keyHtml}</div>
          <div class="frontmatter-value-group">${renderFrontmatterScalar(value)}</div>
        </div>
      </div>`;
    })
    .join('');
}

function renderFrontmatterNode(value: unknown, depth: number): string {
  if (Array.isArray(value)) {
    return renderFrontmatterArray(value, depth);
  }
  if (isObjectRecord(value)) {
    return renderFrontmatterObject(value, depth);
  }
  return renderFrontmatterScalar(value);
}

function renderFrontmatter(frontmatter: string | null) {
  const container = document.getElementById('frontmatter-container');
  const contentEl = document.getElementById('frontmatter-content');
  const labelEl = document.querySelector('#frontmatter-toggle .frontmatter-label');
  if (!container || !contentEl) return;

  currentFrontmatter = frontmatter;
  if (!frontmatter) {
    container.style.display = 'none';
    container.classList.remove('is-expanded', 'is-collapsed');
    contentEl.innerHTML = '';
    const chevron = document.querySelector('#frontmatter-toggle .frontmatter-chevron');
    if (chevron) chevron.textContent = '▶';
    return;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatter);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object') {
    container.style.display = 'none';
    container.classList.remove('is-expanded', 'is-collapsed');
    contentEl.innerHTML = '';
    const chevron = document.querySelector('#frontmatter-toggle .frontmatter-chevron');
    if (chevron) chevron.textContent = '▶';
    return;
  }

  container.style.display = 'block';
  const obj = parsed as Record<string, unknown>;
  const titleValue = typeof obj.title === 'string' ? obj.title.trim() : '';
  const nameValue = typeof obj.name === 'string' ? obj.name.trim() : '';
  const panelTitle =
    titleValue ||
    nameValue ||
    'no title here, just a reminder to say thank you to someone today';
  if (labelEl) labelEl.textContent = panelTitle;
  const rest = { ...obj };
  delete rest.title;
  delete rest.name;
  contentEl.innerHTML = `<div class="frontmatter-tree">${renderFrontmatterNode(rest, 0)}</div>`;
  contentEl.style.display = 'block';
  container.classList.remove('is-collapsed');
  container.classList.add('is-expanded');
  const chevron = document.querySelector('#frontmatter-toggle .frontmatter-chevron');
  if (chevron) chevron.textContent = '▼';
}

function setupFrontmatterToggle() {
  if (frontmatterToggleInitialized) return;

  const toggle = document.getElementById('frontmatter-toggle');
  const content = document.getElementById('frontmatter-content');
  const chevron = toggle?.querySelector('.frontmatter-chevron');
  const container = document.getElementById('frontmatter-container');

  toggle?.addEventListener('click', () => {
    if (!content || !chevron || !container) return;
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    chevron.textContent = isHidden ? '▼' : '▶';
    container.classList.toggle('is-expanded', isHidden);
    container.classList.toggle('is-collapsed', !isHidden);
  });

  frontmatterToggleInitialized = true;
}

function ensureNoFrontmatterInEditorContent(content: string, source: string): string {
  if (!content.startsWith('---')) {
    return content;
  }

  const extracted = extractFrontmatter(content);
  if (extracted.rawBlock) {
    console.warn(`Stripped leaked frontmatter before applying editor update from ${source}.`);
    return extracted.content;
  }
  return content;
}

function sanitizeOutgoingMarkdown(markdown: string): string {
  const extracted = extractFrontmatter(markdown);
  if (!extracted.rawBlock) {
    return markdown;
  }

  console.warn('Detected frontmatter-like block in editor output; stripping before recombine.');
  return extracted.content;
}

function applyFrontmatterStateFromContent(markdown: string): string {
  const extracted = extractFrontmatter(markdown);
  currentFrontmatterRawBlock = extracted.rawBlock;
  currentFrontmatter = extracted.frontmatter;
  renderFrontmatter(currentFrontmatter);
  return extracted.content;
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
  // Use ProseMirror's native deleteRow which operates on the row at current cursor position
  const view = editor?.ctx.get(editorViewCtx);
  if (view) {
    const result = prosemirrorDeleteRow(view.state, view.dispatch);
    console.log('deleteRow result:', result);
  }
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

function getFilteredCommands(query: string): SlashCommand[] {
  if (!query) return slashCommands;
  const lowerQuery = query.toLowerCase();
  return slashCommands.filter(cmd =>
    cmd.title.toLowerCase().includes(lowerQuery) ||
    cmd.keywords.some(kw => kw.includes(lowerQuery))
  );
}

function renderSlashMenu(commands: SlashCommand[]) {
  const list = document.getElementById('slash-menu-list');
  if (!list) return;

  if (commands.length === 0) {
    list.innerHTML = '<div class="slash-menu-empty">No commands found</div>';
    return;
  }

  list.innerHTML = commands.map((cmd, i) => `
    <div class="slash-menu-item${i === slashMenuSelectedIndex ? ' selected' : ''}" data-index="${i}">
      <div class="slash-menu-icon">${cmd.icon}</div>
      <div class="slash-menu-content">
        <div class="slash-menu-title">${cmd.title}</div>
        <div class="slash-menu-description">${cmd.description}</div>
      </div>
    </div>
  `).join('');

  // Add click handlers
  list.querySelectorAll('.slash-menu-item').forEach((item, index) => {
    item.addEventListener('click', () => executeSlashCommand(commands[index]));
    item.addEventListener('mouseenter', () => {
      slashMenuSelectedIndex = index;
      updateSlashMenuSelection(commands);
    });
  });
}

function updateSlashMenuSelection(commands: SlashCommand[]) {
  const items = document.querySelectorAll('.slash-menu-item');
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === slashMenuSelectedIndex);
  });
  // Scroll selected item into view
  const selected = items[slashMenuSelectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest' });
  }
}

function showSlashMenu(x: number, y: number, query: string = '') {
  const menu = document.getElementById('slash-menu');
  if (!menu) return;

  slashMenuVisible = true;
  slashMenuSelectedIndex = 0;

  const commands = getFilteredCommands(query);
  renderSlashMenu(commands);

  // Position menu at cursor
  menu.style.display = 'block';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Adjust if menu goes off-screen
  const rect = menu.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  if (rect.bottom > viewportHeight) {
    menu.style.top = `${y - rect.height - 24}px`;
  }
  if (rect.right > viewportWidth) {
    menu.style.left = `${viewportWidth - rect.width - 16}px`;
  }
}

function hideSlashMenu() {
  const menu = document.getElementById('slash-menu');
  if (menu) {
    menu.style.display = 'none';
  }
  slashMenuVisible = false;
  slashTriggerPos = null;
}

function executeSlashCommand(command: SlashCommand) {
  if (!editor) return;

  // Delete the slash and any typed query from the document
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from } = state.selection;

    if (slashTriggerPos !== null && slashTriggerPos <= from) {
      // Delete from slash position to current cursor
      const tr = state.tr.delete(slashTriggerPos, from);
      view.dispatch(tr);
    }
  });

  hideSlashMenu();

  // Execute the command after a small delay to ensure cleanup happened
  setTimeout(() => {
    command.action();
  }, 10);
}

function handleSlashMenuKeydown(e: KeyboardEvent, commands: SlashCommand[]): boolean {
  if (!slashMenuVisible) return false;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      slashMenuSelectedIndex = (slashMenuSelectedIndex + 1) % commands.length;
      updateSlashMenuSelection(commands);
      return true;

    case 'ArrowUp':
      e.preventDefault();
      slashMenuSelectedIndex = (slashMenuSelectedIndex - 1 + commands.length) % commands.length;
      updateSlashMenuSelection(commands);
      return true;

    case 'Enter':
    case 'Tab':
      e.preventDefault();
      if (commands[slashMenuSelectedIndex]) {
        executeSlashCommand(commands[slashMenuSelectedIndex]);
      }
      return true;

    case 'Escape':
      e.preventDefault();
      hideSlashMenu();
      return true;
  }

  return false;
}

function getSlashQuery(): string {
  if (!editor || slashTriggerPos === null) return '';

  let query = '';
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from } = state.selection;

    // +1 to skip the "/"
    if (slashTriggerPos + 1 <= from) {
      query = state.doc.textBetween(slashTriggerPos + 1, from);
    }
  });
  return query;
}

function getCursorCoords(): { x: number; y: number } | null {
  if (!editor) return null;

  let coords: { x: number; y: number } | null = null;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const cursorCoords = view.coordsAtPos(state.selection.from);
    if (cursorCoords) {
      coords = { x: cursorCoords.left, y: cursorCoords.bottom + 4 };
    }
  });
  return coords;
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
    // Check if we're inside a table cell
    const tableCell = target.closest('td, th');
    if (tableCell) {
      e.preventDefault();
      
      // Position cursor at the click coordinates so delete/row operations work correctly
      const view = editor?.ctx.get(editorViewCtx);
      if (view) {
        // Use click coordinates to find the exact position in the document
        const posAtCoords = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (posAtCoords) {
          try {
            const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, posAtCoords.pos));
            view.dispatch(tr);
          } catch (err) {
            console.log('Selection error, trying near:', err);
            // Fallback: use TextSelection.near for tricky positions
            try {
              const $pos = view.state.doc.resolve(posAtCoords.pos);
              const tr = view.state.tr.setSelection(TextSelection.near($pos));
              view.dispatch(tr);
            } catch (err2) {
              console.log('Near selection also failed:', err2);
            }
          }
        }
      }
      
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

    // Handle slash menu navigation
    if (slashMenuVisible) {
      const query = getSlashQuery();
      const commands = getFilteredCommands(query);
      if (handleSlashMenuKeydown(e, commands)) {
        return;
      }
      // Hide menu if user presses space (they're done filtering)
      if (e.key === ' ') {
        hideSlashMenu();
      }
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

  setupFrontmatterToggle();
  const editorContent = applyFrontmatterStateFromContent(content);
  const safeEditorContent = ensureNoFrontmatterInEditorContent(editorContent, 'initializeEditor');
  lastKnownMarkdown = content;

  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorContainer);
      ctx.set(defaultValueCtx, safeEditorContent);
      ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
        if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
          lastLocalEditAt = Date.now();
          const safeMarkdown = sanitizeOutgoingMarkdown(markdown);
          const fullMarkdown = combineFrontmatter(currentFrontmatterRawBlock, safeMarkdown);
          lastKnownMarkdown = fullMarkdown;
          sendOutgoingEdit(fullMarkdown);
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
  setupSlashCommands();
}

function setupSlashCommands() {
  if (!editor) return;

  // Use ProseMirror's transaction handler for reliable input detection
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    
    // Create a plugin-like handler via direct DOM event on the editor
    const editorDOM = view.dom;
    
    // Listen for input events (most typing)
    editorDOM.addEventListener('input', () => {
      setTimeout(() => {
        checkForSlashTrigger();
      }, 0);
    });
    
    // Also listen for keyup on "/" to catch trigger input immediately
    editorDOM.addEventListener('keyup', (e) => {
      if (e.key === '/') {
        setTimeout(() => {
          checkForSlashTrigger();
        }, 0);
      }
    });
  });

  // Hide menu when clicking outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('slash-menu');
    if (menu && slashMenuVisible && !menu.contains(e.target as Node)) {
      hideSlashMenu();
    }
  });
}

function checkForSlashTrigger() {
  if (!editor) return;

  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from } = state.selection;

    // Need at least 1 character for "/"
    if (from < 1) {
      if (slashMenuVisible) hideSlashMenu();
      return;
    }

    // Get the text content of the current block/paragraph
    const $from = state.selection.$from;
    const startOfBlock = $from.start();
    const textInBlock = state.doc.textBetween(startOfBlock, from);

    // Trigger on "/" at start of block or after whitespace
    // Match: / followed by optional alphanumeric query
    const slashMatch = textInBlock.match(/(?:^|\s)(\/[a-zA-Z0-9]*)$/);

    if (slashMatch) {
      const fullMatch = slashMatch[1]; // e.g., "/h1"
      const matchStart = from - fullMatch.length;
      const query = fullMatch.slice(1); // Remove the "/"

      if (slashTriggerPos === null) {
        slashTriggerPos = matchStart;
      }

      const coords = getCursorCoords();
      if (coords) {
        showSlashMenu(coords.x, coords.y, query);
      }
    } else if (slashMenuVisible) {
      // No longer in a slash command context
      hideSlashMenu();
    }
  });
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

  const fullContent = pendingUpdate;
  pendingUpdate = null;
  
  // Fast-path: use cached markdown for comparison (avoids expensive getMarkdown() call)
  const normalizedContent = normalizeMarkdownForCompare(fullContent);
  const normalizedCached = normalizeMarkdownForCompare(lastKnownMarkdown);
  
  // Quick length check before full string compare
  if (normalizedContent.length === normalizedCached.length && normalizedContent === normalizedCached) {
    return;
  }
  
  isUpdatingFromExtension = true;
  const editorContent = applyFrontmatterStateFromContent(fullContent);
  const safeEditorContent = ensureNoFrontmatterInEditorContent(editorContent, 'applyPendingUpdate');
  
  // Batch all operations into a single editor.action() for better performance
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      
      // Save cursor position
      const { anchor } = view.state.selection;
      
      // Apply content update via replaceAll
      replaceAll(safeEditorContent)(ctx);
      
      // Update cache
      lastKnownMarkdown = fullContent;
      
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
    reinitializeEditor(fullContent);
  }
  
  isUpdatingFromExtension = false;
}

async function reinitializeEditor(content: string) {
  const editorContainer = document.getElementById('editor');
  if (editorContainer) {
    editorContainer.innerHTML = '';
    setupFrontmatterToggle();
    const editorContent = applyFrontmatterStateFromContent(content);
    const safeEditorContent = ensureNoFrontmatterInEditorContent(editorContent, 'reinitializeEditor');
    lastKnownMarkdown = content;
    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, editorContainer);
        ctx.set(defaultValueCtx, safeEditorContent);
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
          if (!isUpdatingFromExtension && markdown !== prevMarkdown) {
            lastLocalEditAt = Date.now();
            const safeMarkdown = sanitizeOutgoingMarkdown(markdown);
            const fullMarkdown = combineFrontmatter(currentFrontmatterRawBlock, safeMarkdown);
            lastKnownMarkdown = fullMarkdown;
            sendOutgoingEdit(fullMarkdown);
          }
        });
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .create();
    
    // Re-setup event handlers after reinitialization
    setupToolbar();
    setupKeyboardShortcuts();
    setupSlashCommands();
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
