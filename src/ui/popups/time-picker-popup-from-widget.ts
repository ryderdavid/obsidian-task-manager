import { TimePickerPopup } from './time-picker-popup';
import type { Editor } from 'obsidian';
import type TaskManagerPlugin from '../../main';

// Time picker popup that positions itself relative to an anchor element (for widget clicks)
export class TimePickerPopupFromWidget extends TimePickerPopup {
  anchorEl: HTMLElement;

  constructor(
    plugin: TaskManagerPlugin,
    editor: Editor,
    lineNum: number,
    mode: 'start' | 'end',
    existingStart: { hour: number; minute: number } | null,
    onComplete: ((hour: number, minute: number) => void) | null,
    anchorEl: HTMLElement
  ) {
    super(plugin, editor, lineNum, mode, existingStart, onComplete);
    this.anchorEl = anchorEl;
  }

  positionPopup() {
    if (!this.anchorEl || !this.container) return;

    const rect = this.anchorEl.getBoundingClientRect();
    const container = this.container;
    if (!container) return;
    container.style.position = 'absolute';
    container.style.left = `${rect.left}px`;
    container.style.top = `${rect.bottom + 5}px`;
    container.style.zIndex = '1000';

    // Ensure popup stays within viewport
    requestAnimationFrame(() => {
      const popupRect = container.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        container.style.left = `${window.innerWidth - popupRect.width - 10}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        container.style.top = `${rect.top - popupRect.height - 5}px`;
      }
    });
  }

  selectTime(hour: number, minute: number) {
    this.selectedHour = hour;
    this.close();

    if (this.mode === 'start') {
      // Open end time picker - also use widget-anchored version
      const endPopup = new TimePickerPopupFromWidget(
        this.plugin,
        this.editor,
        this.lineNum,
        'end',
        { hour: hour, minute: minute },
        (endHour: number, endMinute: number) => {
          this.applyTimeblock(hour, minute, endHour, endMinute);
        },
        this.anchorEl
      );
      endPopup.open();
    } else if (this.mode === 'end' && this.onComplete) {
      this.onComplete(hour, minute);
    }
  }
}
