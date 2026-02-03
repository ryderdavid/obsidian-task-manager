import { Notice, MarkdownView } from 'obsidian';
import { scheduleTask } from '../../services/task-scheduler';
import { parseCustomDate } from '../../utils/schedule-date-utils';
import { SCHEDULE_DATE_OPTIONS } from '../../constants';

// ============================================================================
// SCHEDULE DATE POPUP
// ============================================================================

export class ScheduleDatePopup {
  constructor(plugin, editor, lineNum) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.selectedIndex = 0;
    this.isCustomMode = false;
    this.container = null;
    this.customInput = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  open() {
    // Create popup container
    this.container = document.createElement('div');
    this.container.className = 'schedule-date-popup';

    // Build the options list
    this.renderOptions();

    // Position the popup near the cursor
    this.positionPopup();

    // Add to DOM
    document.body.appendChild(this.container);

    // Add event listeners
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

  renderOptions() {
    this.container.empty();

    SCHEDULE_DATE_OPTIONS.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'schedule-date-option';
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      }

      if (option.isCustom && this.isCustomMode) {
        // Render input field
        this.customInput = document.createElement('input');
        this.customInput.type = 'text';
        this.customInput.className = 'schedule-date-custom-input';
        this.customInput.placeholder = 'YYYY-MM-DD';
        this.customInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this.submitCustomDate();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
          }
        });
        item.appendChild(this.customInput);
        setTimeout(() => this.customInput.focus(), 0);
      } else {
        item.createSpan({ text: option.label, cls: 'schedule-date-label' });
        if (option.getDate) {
          item.createSpan({ text: option.getDate(), cls: 'schedule-date-value' });
        }
      }

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = index;
        this.selectOption(option);
      });

      this.container.appendChild(item);
    });
  }

  positionPopup() {
    // Get cursor position from CodeMirror
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const cm = view.editor.cm;
    if (!cm) return;

    const cursor = this.editor.getCursor();
    const coords = cm.coordsAtPos(cm.state.doc.line(cursor.line + 1).from);

    if (coords) {
      this.container.style.position = 'absolute';
      this.container.style.left = `${coords.left}px`;
      this.container.style.top = `${coords.bottom + 5}px`;
      this.container.style.zIndex = '1000';
    }
  }

  handleKeyDown(e) {
    if (this.isCustomMode && this.customInput && document.activeElement === this.customInput) {
      // Let input handle its own keys except Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.min(this.selectedIndex + 1, SCHEDULE_DATE_OPTIONS.length - 1);
        this.renderOptions();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderOptions();
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        this.selectOption(SCHEDULE_DATE_OPTIONS[this.selectedIndex]);
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
    }
  }

  handleClickOutside(e) {
    if (this.container && !this.container.contains(e.target)) {
      this.close();
    }
  }

  selectOption(option) {
    if (option.isCustom) {
      if (!this.isCustomMode) {
        this.isCustomMode = true;
        this.renderOptions();
      }
    } else if (option.getDate) {
      this.scheduleToDate(option.getDate());
    }
  }

  submitCustomDate() {
    if (!this.customInput) return;

    const parsed = parseCustomDate(this.customInput.value, this.plugin.app);
    if (parsed) {
      this.scheduleToDate(parsed);
    } else {
      new Notice('Invalid date. Try YYYY-MM-DD, YYYYMMDD, or natural language (e.g. "tomorrow", "next monday")');
    }
  }

  async scheduleToDate(date) {
    this.close();
    await scheduleTask(
      this.plugin.app,
      this.plugin.settings,
      this.editor,
      this.lineNum,
      date
    );
  }
}
