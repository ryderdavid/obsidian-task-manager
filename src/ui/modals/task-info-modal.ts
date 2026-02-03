import { Modal } from 'obsidian';

// Modal for displaying task metadata
export class TaskInfoModal extends Modal {
  constructor(app, taskId, parentId, taskText, parentText, onUnlink, uid, isCalendarEvent, calendarSource) {
    super(app);
    this.taskId = taskId;
    this.parentId = parentId;
    this.taskText = taskText;
    this.parentText = parentText;
    this.onUnlink = onUnlink;
    this.uid = uid;
    this.isCalendarEvent = isCalendarEvent;
    this.calendarSource = calendarSource;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-info-modal');

    contentEl.createEl('h3', { text: this.isCalendarEvent ? 'Event Information' : 'Task Information' });

    const infoContainer = contentEl.createDiv({ cls: 'task-info-content' });

    // Calendar event info
    if (this.isCalendarEvent && this.uid) {
      if (this.taskText) {
        const nameRow = infoContainer.createDiv({ cls: 'task-info-row' });
        nameRow.createSpan({ text: 'Event: ', cls: 'task-info-label' });
        nameRow.createSpan({ text: this.taskText, cls: 'task-info-value task-info-name' });
      }

      if (this.calendarSource) {
        const calendarRow = infoContainer.createDiv({ cls: 'task-info-row' });
        calendarRow.createSpan({ text: 'Calendar: ', cls: 'task-info-label' });
        calendarRow.createSpan({ text: this.calendarSource, cls: 'task-info-value task-info-name' });
      }

      const uidRow = infoContainer.createDiv({ cls: 'task-info-row' });
      uidRow.createSpan({ text: 'Event UID: ', cls: 'task-info-label' });
      uidRow.createSpan({ text: this.uid, cls: 'task-info-value' });

      const noteRow = infoContainer.createDiv({ cls: 'task-info-row' });
      noteRow.createSpan({ text: 'Calendar events sync from ICS and are read-only', cls: 'task-info-note' });
    }
    // Task info
    else if (this.taskId) {
      // Task name row
      if (this.taskText) {
        const nameRow = infoContainer.createDiv({ cls: 'task-info-row' });
        nameRow.createSpan({ text: 'Task: ', cls: 'task-info-label' });
        nameRow.createSpan({ text: this.taskText, cls: 'task-info-value task-info-name' });
      }

      const idRow = infoContainer.createDiv({ cls: 'task-info-row' });
      idRow.createSpan({ text: 'Task ID: ', cls: 'task-info-label' });
      idRow.createSpan({ text: this.taskId, cls: 'task-info-value' });
    }

    if (this.parentId) {
      // Parent name row
      if (this.parentText) {
        const parentNameRow = infoContainer.createDiv({ cls: 'task-info-row' });
        parentNameRow.createSpan({ text: 'Parent: ', cls: 'task-info-label' });
        parentNameRow.createSpan({ text: this.parentText, cls: 'task-info-value task-info-name' });
      }

      const parentRow = infoContainer.createDiv({ cls: 'task-info-row' });
      parentRow.createSpan({ text: 'Parent ID: ', cls: 'task-info-label' });
      parentRow.createSpan({ text: this.parentId, cls: 'task-info-value' });

      const unlinkBtn = contentEl.createEl('button', {
        text: 'Unlink from Parent',
        cls: 'task-unlink-btn'
      });
      unlinkBtn.addEventListener('click', () => {
        this.onUnlink();
        this.close();
      });
    } else if (this.taskId) {
      const noParentRow = infoContainer.createDiv({ cls: 'task-info-row' });
      noParentRow.createSpan({ text: 'This is a parent task (no parent link)', cls: 'task-info-note' });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
