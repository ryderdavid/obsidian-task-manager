import { CALENDAR_EVENT_PATTERN, SUBTASK_PATTERN } from '../utils/task-utils';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK ARCHIVER MODULE
// ============================================================================

// Checkbox states that should be archived
const ARCHIVE_STATES = /^[\t]*- \[[xX>\-]\]/;
// States to keep active
const ACTIVE_STATES = /^[\t]*- \[[ \/c]\]/;
// Callout pattern for existing archive section
const ARCHIVE_CALLOUT_START = /^> \[!archived\]-?\s*Archived\s*$/;
const ARCHIVE_LINE = /^> /;

/**
 * Archive completed and scheduled tasks to a collapsed callout section
 */
export function archiveContent(content: string, settings: TaskManagerSettings): string {
  const lines = content.split('\n');
  const calendarEvents: string[] = [];
  const activeTasks: string[] = [];
  const archivedTasks: string[] = [];
  const existingArchiveContent: string[] = [];
  let inArchiveSection = false;
  let i = 0;

  // First pass: categorize all lines
  while (i < lines.length) {
    const line = lines[i];

    // Check if entering existing archive section
    if (ARCHIVE_CALLOUT_START.test(line)) {
      inArchiveSection = true;
      i++;
      continue;
    }

    // If in archive section, collect existing archived content
    if (inArchiveSection) {
      if (ARCHIVE_LINE.test(line)) {
        // Strip the "> " prefix and store
        existingArchiveContent.push(line.substring(2));
        i++;
        continue;
      } else {
        // End of archive section
        inArchiveSection = false;
      }
    }

    // Calendar events stay at top
    if (CALENDAR_EVENT_PATTERN.test(line)) {
      calendarEvents.push(line);
      i++;
      continue;
    }

    // Check if this is a task that should be archived
    if (ARCHIVE_STATES.test(line)) {
      const taskGroup = [line];
      i++;
      // Collect subtasks
      while (i < lines.length && SUBTASK_PATTERN.test(lines[i])) {
        taskGroup.push(lines[i]);
        i++;
      }
      archivedTasks.push(...taskGroup);
      continue;
    }

    // Check if this is an active task
    if (ACTIVE_STATES.test(line)) {
      const taskGroup = [line];
      i++;
      // Collect subtasks
      while (i < lines.length && SUBTASK_PATTERN.test(lines[i])) {
        taskGroup.push(lines[i]);
        i++;
      }
      activeTasks.push(...taskGroup);
      continue;
    }

    // Other lines (blank lines, headers, etc.) go with active content
    if (line.trim() !== '' || activeTasks.length > 0) {
      activeTasks.push(line);
    }
    i++;
  }

  // Combine archived tasks with any existing archive content
  const allArchived = [...archivedTasks, ...existingArchiveContent];

  // Build result
  const result: string[] = [];

  // Calendar events first
  for (const event of calendarEvents) {
    result.push(event);
  }

  // Active tasks
  for (const task of activeTasks) {
    result.push(task);
  }

  // Archive section (only if there are archived tasks)
  if (allArchived.length > 0) {
    // Add 7 blank lines as separator before archive section
    if (result.length > 0) {
      // Remove any trailing blank lines first
      while (result.length > 0 && result[result.length - 1] === '') {
        result.pop();
      }
      // Add exactly 7 blank lines
      for (let j = 0; j < 7; j++) {
        result.push('');
      }
    }

    // Collapsible callout header
    result.push('> [!archived]- Archived');

    // Add archived tasks with callout prefix
    for (const line of allArchived) {
      result.push('> ' + line);
    }
  }

  return result.join('\n');
}
