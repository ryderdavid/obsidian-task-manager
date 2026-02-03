import { ScheduleDatePopup } from './schedule-date-popup';

// ============================================================================
// WIDGET-ANCHORED POPUPS (positioned relative to DOM elements)
// ============================================================================

// Schedule date popup that positions itself relative to an anchor element (for widget clicks)
export class ScheduleDatePopupFromWidget extends ScheduleDatePopup {
  constructor(plugin, editor, lineNum, anchorEl) {
    super(plugin, editor, lineNum);
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
}
