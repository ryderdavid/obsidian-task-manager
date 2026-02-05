import { MarkdownView } from 'obsidian';
import type { Editor } from 'obsidian';
import * as TaskUtils from '../../utils/task-utils';
import { Icons } from '../../constants';
import type TaskManagerPlugin from '../../main';

// ============================================================================
// STATUS BAR POPUP - Menu for setting task checkbox status
// ============================================================================

const STATUS_OPTIONS = [
  { char: 'x', icon: Icons.circleCheck, label: 'Complete' },
  { char: ' ', icon: Icons.circle, label: 'Incomplete' },
  { char: '/', icon: Icons.halfCircle, label: 'In Progress' },
  { char: '-', icon: Icons.circleXmark, label: 'Cancelled' },
] as const;

export class StatusBarPopup {
  plugin: TaskManagerPlugin;
  editor: Editor;
  lineNum: number;
  container: HTMLDivElement | null;
  selectedIndex: number;

  constructor(plugin: TaskManagerPlugin, editor: Editor, lineNum: number) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.container = null;
    this.selectedIndex = 0;

    // Pre-select the current status if possible
    const line = editor.getLine(lineNum);
    const match = line.match(/^[\t]*- \[(.)\]/);
    if (match) {
      const current = match[1];
      const idx = STATUS_OPTIONS.findIndex(o => o.char === current);
      if (idx !== -1) this.selectedIndex = idx;
    }

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  open() {
    this.container = document.createElement('div');
    this.container.className = 'task-status-popup';

    this.render();
    this.positionPopup();

    document.body.appendChild(this.container);

    document.addEventListener('keydown', this.handleKeyDown, true);
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
    }, 10);
  }

  close() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('click', this.handleClickOutside);
  }

  render() {
    if (!this.container) return;
    this.container.replaceChildren();

    STATUS_OPTIONS.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'task-status-popup-item';
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      }

      const iconEl = document.createElement('span');
      iconEl.className = 'task-status-popup-icon';
      iconEl.innerHTML = option.icon;
      item.appendChild(iconEl);

      item.createSpan({ text: option.label, cls: 'task-status-popup-label' });

      item.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectStatus(option.char);
      });

      this.container!.appendChild(item);
    });
  }

  selectStatus(checkboxChar: string) {
    this.close();
    const line = this.editor.getLine(this.lineNum);
    if (TaskUtils.isTask(line)) {
      const newLine = line.replace(/^([\t]*- \[)[^\]](\])/, `$1${checkboxChar}$2`);
      this.editor.setLine(this.lineNum, newLine);
    }
  }

  positionPopup() {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const cm = (view.editor as any).cm;
    if (!cm) return;

    const cursor = this.editor.getCursor();
    const coords = cm.coordsAtPos(cm.state.doc.line(cursor.line + 1).from + cursor.ch);

    if (coords && this.container) {
      this.container.style.position = 'absolute';
      this.container.style.left = `${coords.left}px`;
      this.container.style.top = `${coords.bottom + 5}px`;
      this.container.style.zIndex = '1000';
    }
  }

  handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.min(this.selectedIndex + 1, STATUS_OPTIONS.length - 1);
        this.render();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.render();
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        this.selectStatus(STATUS_OPTIONS[this.selectedIndex].char);
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
    }
  }

  handleClickOutside(e: MouseEvent) {
    if (this.container && !this.container.contains(e.target as Node)) {
      this.close();
    }
  }
}
