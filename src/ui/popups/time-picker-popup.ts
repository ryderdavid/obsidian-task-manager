import { Notice, MarkdownView } from 'obsidian';
import type { Editor } from 'obsidian';
import { addTimeblock, formatDisplayTime, formatTime, getDefaultEndTime } from '../../utils/timeblock-utils';
import { Icons } from '../../constants';
import type TaskManagerPlugin from '../../main';

// ============================================================================
// TIME PICKER POPUP
// ============================================================================

export class TimePickerPopup {
  // Layout mapping: column 0 = DAY (6-17), column 1 = NIGHT (18-23, 0-5)
  static DAY_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  static NIGHT_HOURS = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5];
  static MINUTES = [0, 15, 30, 45];

  plugin: TaskManagerPlugin;
  editor: Editor;
  lineNum: number;
  mode: 'start' | 'end';
  existingStart: { hour: number; minute: number } | null;
  onComplete: ((hour: number, minute: number) => void) | null;
  selectedHour: number | null;
  expandedHour: number | null;
  container: HTMLDivElement | null;
  focusedColumn: number;
  focusedRowIndex: number;
  minutePhase: boolean;
  focusedMinuteIndex: number;

  constructor(
    plugin: TaskManagerPlugin,
    editor: Editor,
    lineNum: number,
    mode: 'start' | 'end',
    existingStart: { hour: number; minute: number } | null = null,
    onComplete: ((hour: number, minute: number) => void) | null = null
  ) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.mode = mode; // 'start' or 'end'
    this.existingStart = existingStart; // { hour, minute } for end mode
    this.onComplete = onComplete; // Callback for chaining start->end
    this.selectedHour = null;
    this.expandedHour = null; // For mobile: tracks which hour row is expanded
    this.container = null;

    // Keyboard navigation state
    this.focusedColumn = 0; // 0 = DAY, 1 = NIGHT
    this.focusedRowIndex = 0; // 0-11 index within column
    this.minutePhase = false; // true = selecting minute within focused hour
    this.focusedMinuteIndex = 0; // 0-3 index into MINUTES array

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  /** Get the hours array for a column index */
  getColumnHours(col: number): number[] {
    return col === 0 ? TimePickerPopup.DAY_HOURS : TimePickerPopup.NIGHT_HOURS;
  }

  /** Get the hour value for current focused position */
  getFocusedHour(): number {
    return this.getColumnHours(this.focusedColumn)[this.focusedRowIndex];
  }

  /** Initialize keyboard focus to a sensible default hour */
  initFocus() {
    if (this.mode === 'end' && this.existingStart) {
      // Focus the suggested end hour
      const defaultEnd = getDefaultEndTime(this.existingStart.hour, this.existingStart.minute);
      this.setFocusToHour(defaultEnd.hour);
    } else {
      // Focus current hour (clamp to DAY column if before 6 AM)
      const now = new Date();
      let currentHour = now.getHours();
      if (currentHour < 6) currentHour = 9; // Default to 9 AM for very early hours
      this.setFocusToHour(currentHour);
    }
  }

  /** Set focus to a specific hour value, finding it in the layout */
  setFocusToHour(hour: number) {
    const dayIdx = TimePickerPopup.DAY_HOURS.indexOf(hour);
    if (dayIdx !== -1) {
      this.focusedColumn = 0;
      this.focusedRowIndex = dayIdx;
      return;
    }
    const nightIdx = TimePickerPopup.NIGHT_HOURS.indexOf(hour);
    if (nightIdx !== -1) {
      this.focusedColumn = 1;
      this.focusedRowIndex = nightIdx;
      return;
    }
    // Fallback
    this.focusedColumn = 0;
    this.focusedRowIndex = 3; // 9 AM
  }

  /** Scroll the focused row into view within the scroll container */
  scrollFocusedIntoView() {
    if (!this.container) return;
    const focused = this.container.querySelector('.timeblock-picker-row.is-keyboard-focused');
    if (focused) {
      focused.scrollIntoView({ block: 'nearest' });
    }
  }

  open() {
    this.container = document.createElement('div');
    this.container.className = 'timeblock-picker-popup';

    this.initFocus();
    this.render();
    this.positionPopup();

    document.body.appendChild(this.container);

    // Scroll default-focused hour into view after layout
    requestAnimationFrame(() => this.scrollFocusedIntoView());

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

    // Header
    const header = document.createElement('div');
    header.className = 'timeblock-picker-header';
    header.textContent = this.mode === 'start' ? 'Start' : 'End';
    this.container.appendChild(header);

    // If in end mode, show selected start time
    if (this.mode === 'end' && this.existingStart) {
      const startInfo = document.createElement('div');
      startInfo.className = 'timeblock-picker-start-info';
      startInfo.textContent = `Start: ${formatTime(this.existingStart.hour, this.existingStart.minute)}`;
      this.container.appendChild(startInfo);
    }

    // Column container
    const columns = document.createElement('div');
    columns.className = 'timeblock-picker-columns';

    // DAY column (6 AM - 5 PM)
    const dayColumn = this.createColumn('DAY', 6, 17);
    columns.appendChild(dayColumn);

    // NIGHT column (6 PM - 5 AM)
    const nightColumn = this.createColumn('NIGHT', 18, 29); // 18-23 and 0-5
    columns.appendChild(nightColumn);

    this.container.appendChild(columns);
  }

  createColumn(title: string, startHour: number, endHour: number): HTMLDivElement {
    const column = document.createElement('div');
    column.className = 'timeblock-picker-column';

    const header = document.createElement('div');
    header.className = 'timeblock-picker-column-header';
    header.textContent = title;
    column.appendChild(header);

    for (let h = startHour; h <= endHour; h++) {
      const hour = h % 24;
      const row = this.createHourRow(hour);
      column.appendChild(row);
    }

    return column;
  }

  createHourRow(hour: number): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'timeblock-picker-row';
    row.dataset.hour = String(hour);

    // Check if this hour is expanded (for mobile click-to-expand)
    const isExpanded = this.expandedHour === hour;
    if (isExpanded) {
      row.addClass('is-expanded');
    }

    // Keyboard focus state
    const isFocused = hour === this.getFocusedHour();
    if (isFocused) {
      row.addClass('is-keyboard-focused');
    }

    // Highlight suggested time in end mode
    let suggestedMinute = null;
    if (this.mode === 'end' && this.existingStart) {
      const defaultEnd = getDefaultEndTime(this.existingStart.hour, this.existingStart.minute);
      if (hour === defaultEnd.hour) {
        row.addClass('is-suggested');
        suggestedMinute = defaultEnd.minute;
      }
    }

    // Hour label
    const hourLabel = document.createElement('div');
    hourLabel.className = 'timeblock-picker-hour';
    hourLabel.textContent = formatDisplayTime(hour);

    // Click on hour label: expand on mobile or select :00 on desktop with hover
    hourLabel.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleHourClick(hour);
    });

    row.appendChild(hourLabel);

    // Minute options container (shown on hover, when expanded, or when keyboard-focused)
    const minuteOptions = document.createElement('div');
    minuteOptions.className = 'timeblock-picker-row-minutes';

    const minutes = TimePickerPopup.MINUTES;
    for (let i = 0; i < minutes.length; i++) {
      const minute = minutes[i];
      const btn = document.createElement('button');
      btn.className = 'timeblock-picker-minute-btn';

      if (suggestedMinute === minute) {
        btn.addClass('is-suggested');
      }

      // Keyboard focus on specific minute button
      if (isFocused && this.minutePhase && this.focusedMinuteIndex === i) {
        btn.addClass('is-keyboard-focused');
      }

      btn.textContent = minute.toString().padStart(2, '0');
      btn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectTime(hour, minute);
      });
      minuteOptions.appendChild(btn);
    }

    row.appendChild(minuteOptions);

    return row;
  }

  handleHourClick(hour: number) {
    // If already expanded for this hour, select :00
    if (this.expandedHour === hour) {
      this.selectTime(hour, 0);
      return;
    }

    // Expand this hour row (for mobile/touch)
    this.expandedHour = hour;
    this.render();
  }

  selectTime(hour: number, minute: number) {
    this.selectedHour = hour;
    this.close();

    if (this.mode === 'start') {
      // Open end time picker
      const endPopup = new TimePickerPopup(
        this.plugin,
        this.editor,
        this.lineNum,
        'end',
        { hour: hour, minute: minute },
        (endHour, endMinute) => {
          this.applyTimeblock(hour, minute, endHour, endMinute);
        }
      );
      endPopup.open();
    } else if (this.mode === 'end' && this.onComplete) {
      this.onComplete(hour, minute);
    }
  }

  applyTimeblock(startHour: number, startMinute: number, endHour: number, endMinute: number) {
    const line = this.editor.getLine(this.lineNum);
    const newLine = addTimeblock(line, startHour, startMinute, endHour, endMinute);
    this.editor.setLine(this.lineNum, newLine);
    new Notice(`Timeblock set: ${formatTime(startHour, startMinute)} - ${formatTime(endHour, endMinute)}`);
  }

  positionPopup() {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const cm = (view.editor as any).cm;
    if (!cm) return;

    const cursor = this.editor.getCursor();
    const coords = cm.coordsAtPos(cm.state.doc.line(cursor.line + 1).from);

    if (coords && this.container) {
      this.container.style.position = 'absolute';
      this.container.style.left = `${coords.left}px`;
      this.container.style.top = `${coords.bottom + 5}px`;
      this.container.style.zIndex = '1000';
    }
  }

  handleKeyDown(e: KeyboardEvent) {
    const maxRow = 11; // 12 hours per column, 0-indexed

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (!this.minutePhase) {
          this.focusedRowIndex = Math.min(this.focusedRowIndex + 1, maxRow);
          this.render();
          this.scrollFocusedIntoView();
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (!this.minutePhase) {
          this.focusedRowIndex = Math.max(this.focusedRowIndex - 1, 0);
          this.render();
          this.scrollFocusedIntoView();
        }
        break;

      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        if (this.minutePhase) {
          this.focusedMinuteIndex = Math.min(this.focusedMinuteIndex + 1, 3);
          this.render();
        } else {
          // Switch to NIGHT column (or stay if already there)
          if (this.focusedColumn === 0) {
            this.focusedColumn = 1;
            this.render();
            this.scrollFocusedIntoView();
          }
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        if (this.minutePhase) {
          this.focusedMinuteIndex = Math.max(this.focusedMinuteIndex - 1, 0);
          this.render();
        } else {
          // Switch to DAY column (or stay if already there)
          if (this.focusedColumn === 1) {
            this.focusedColumn = 0;
            this.render();
            this.scrollFocusedIntoView();
          }
        }
        break;

      case 'Enter':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (this.minutePhase) {
          // Select the focused time
          const hour = this.getFocusedHour();
          const minute = TimePickerPopup.MINUTES[this.focusedMinuteIndex];
          this.selectTime(hour, minute);
        } else {
          // Enter minute selection phase
          this.minutePhase = true;
          this.focusedMinuteIndex = 0;

          // If there's a suggested minute in end mode, default to it
          if (this.mode === 'end' && this.existingStart) {
            const defaultEnd = getDefaultEndTime(this.existingStart.hour, this.existingStart.minute);
            if (this.getFocusedHour() === defaultEnd.hour) {
              const sugIdx = TimePickerPopup.MINUTES.indexOf(defaultEnd.minute);
              if (sugIdx !== -1) this.focusedMinuteIndex = sugIdx;
            }
          }

          this.render();
        }
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (this.minutePhase) {
          // Back to hour selection
          this.minutePhase = false;
          this.render();
        } else {
          this.close();
        }
        break;
    }
  }

  handleClickOutside(e: MouseEvent) {
    if (this.container && !this.container.contains(e.target as Node)) {
      this.close();
    }
  }
}
