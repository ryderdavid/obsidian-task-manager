import { TimePickerPopup } from './time-picker-popup';

// Time picker popup that positions itself relative to an anchor element (for widget clicks)
export class TimePickerPopupFromWidget extends TimePickerPopup {
  constructor(plugin, editor, lineNum, mode, existingStart, onComplete, anchorEl) {
    super(plugin, editor, lineNum, mode, existingStart, onComplete);
    this.anchorEl = anchorEl;
  }

  positionPopup() {
    if (!this.anchorEl) return;

    const rect = this.anchorEl.getBoundingClientRect();
    this.container.style.position = 'absolute';
    this.container.style.left = `${rect.left}px`;
    this.container.style.top = `${rect.bottom + 5}px`;
    this.container.style.zIndex = '1000';

    // Ensure popup stays within viewport
    requestAnimationFrame(() => {
      const popupRect = this.container.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        this.container.style.left = `${window.innerWidth - popupRect.width - 10}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        this.container.style.top = `${rect.top - popupRect.height - 5}px`;
      }
    });
  }

  selectTime(hour, minute) {
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
        (endHour, endMinute) => {
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
