import { WidgetType } from '@codemirror/view';

// ============================================================================
// UI COMPONENTS
// ============================================================================

// Gutter "more" widget - shows a light gray "more" text in the left gutter area
// on hover of a task line. Clicking opens the task info modal.
export class GutterMoreWidget extends WidgetType {
  constructor(options, plugin) {
    super();
    this.options = options; // { taskText, taskId, parentId, uid, isCalendarEvent, calendarSource }
    this.plugin = plugin;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'task-gutter-more';
    el.textContent = 'more';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.showTaskInfo(this.options.taskId, this.options.parentId, this.options.taskText, null, null, this.options.uid, this.options.isCalendarEvent, this.options.calendarSource);
    });
    return el;
  }

  eq(other) {
    return (
      other.options.taskId === this.options.taskId &&
      other.options.parentId === this.options.parentId &&
      other.options.uid === this.options.uid &&
      other.options.taskText === this.options.taskText
    );
  }

  ignoreEvent() {
    return false;
  }
}
