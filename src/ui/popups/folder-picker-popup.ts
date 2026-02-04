import { TFolder, MarkdownView, Notice } from 'obsidian';
import type { Editor } from 'obsidian';
import type TaskManagerPlugin from '../../main';

export class FolderPickerPopup {
  plugin: TaskManagerPlugin;
  editor: Editor;
  lineNum: number;
  defaultFolder: string;
  onChoose: (folderPath: string) => void;

  container: HTMLDivElement | null;
  input: HTMLInputElement | null;
  listEl: HTMLDivElement | null;
  allFolders: string[];
  filtered: string[];
  selectedIndex: number;

  constructor(
    plugin: TaskManagerPlugin,
    editor: Editor,
    lineNum: number,
    defaultFolder: string,
    onChoose: (folderPath: string) => void
  ) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.defaultFolder = defaultFolder;
    this.onChoose = onChoose;
    this.container = null;
    this.input = null;
    this.listEl = null;
    this.selectedIndex = 0;

    this.allFolders = this.plugin.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path)
      .filter(p => p !== '/')
      .sort();

    this.filtered = this.allFolders;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  open() {
    this.container = document.createElement('div');
    this.container.className = 'folder-picker-popup';

    // Input
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'folder-picker-input';
    this.input.placeholder = 'Type to filter folders...';
    this.input.value = this.defaultFolder;
    this.input.addEventListener('input', () => this.onInputChange());
    this.container.appendChild(this.input);

    // List
    this.listEl = document.createElement('div');
    this.listEl.className = 'folder-picker-list';
    this.container.appendChild(this.listEl);

    this.filterAndRender();
    this.positionPopup();

    document.body.appendChild(this.container);
    document.addEventListener('keydown', this.handleKeyDown, true);
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
    }, 10);

    this.input.focus();
    this.input.select();
  }

  close() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('click', this.handleClickOutside);
  }

  onInputChange() {
    this.selectedIndex = 0;
    this.filterAndRender();
  }

  filterAndRender() {
    const query = (this.input?.value ?? '').toLowerCase();
    if (!query) {
      this.filtered = this.allFolders;
    } else {
      // Fuzzy-ish: split query into chars and check they appear in order
      this.filtered = this.allFolders.filter(path => {
        const lower = path.toLowerCase();
        let qi = 0;
        for (let i = 0; i < lower.length && qi < query.length; i++) {
          if (lower[i] === query[qi]) qi++;
        }
        return qi === query.length;
      });
      // Sort: exact prefix first, then contains, then fuzzy
      this.filtered.sort((a, b) => {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        const aPrefix = al.startsWith(query) ? 0 : 1;
        const bPrefix = bl.startsWith(query) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        const aContains = al.includes(query) ? 0 : 1;
        const bContains = bl.includes(query) ? 0 : 1;
        if (aContains !== bContains) return aContains - bContains;
        return al.localeCompare(bl);
      });
    }

    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }

    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.replaceChildren();

    const maxVisible = 8;
    const visible = this.filtered.slice(0, maxVisible);

    visible.forEach((path, index) => {
      const item = document.createElement('div');
      item.className = 'folder-picker-option';
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      }
      item.createSpan({ text: path, cls: 'folder-picker-path' });
      item.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectFolder(path);
      });
      this.listEl!.appendChild(item);
    });

    if (this.filtered.length > maxVisible) {
      const more = document.createElement('div');
      more.className = 'folder-picker-more';
      more.textContent = `${this.filtered.length - maxVisible} more...`;
      this.listEl.appendChild(more);
    }

    if (this.filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-picker-empty';
      empty.textContent = 'No matching folders';
      this.listEl.appendChild(empty);
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
        this.selectedIndex = Math.min(this.selectedIndex + 1, Math.min(this.filtered.length, 8) - 1);
        this.renderList();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderList();
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.filtered.length > 0) {
          this.selectFolder(this.filtered[this.selectedIndex]);
        } else {
          // Allow creating in typed path even if it doesn't exist yet
          const typed = this.input?.value?.trim();
          if (typed) {
            this.selectFolder(typed);
          }
        }
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

  selectFolder(folderPath: string) {
    const exists = this.allFolders.includes(folderPath);
    if (!exists) {
      const lastSlash = folderPath.lastIndexOf('/');
      const parentPath = lastSlash > 0 ? folderPath.substring(0, lastSlash) : '/';
      const parentExists = parentPath === '/' || this.allFolders.includes(parentPath);
      if (!parentExists) {
        new Notice(`Cannot create "${folderPath}" — parent folder doesn't exist`);
        return;
      }
    }
    this.close();
    this.onChoose(folderPath);
  }
}
