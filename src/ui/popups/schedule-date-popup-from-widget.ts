import { ScheduleDatePopup } from './schedule-date-popup';
import type { Editor } from 'obsidian';
import type TaskManagerPlugin from '../../main';

// ============================================================================
// WIDGET-ANCHORED POPUPS (positioned relative to DOM elements)
// ============================================================================

// Schedule date popup that positions itself relative to an anchor element (for widget clicks)
export class ScheduleDatePopupFromWidget extends ScheduleDatePopup {
  anchorEl: HTMLElement;

  constructor(plugin: TaskManagerPlugin, editor: Editor, lineNum: number, anchorEl: HTMLElement) {
    super(plugin, editor, lineNum);
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
}
