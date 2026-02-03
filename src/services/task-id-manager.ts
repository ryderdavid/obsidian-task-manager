import { addId, extractId, generateId, isCalendarEvent, isTask } from '../utils/task-utils';

// ============================================================================
// TASK ID MANAGER MODULE
// ============================================================================

export function processContent(content, settings) {
  const lines = content.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip calendar events - they don't need task IDs
    if (isCalendarEvent(line)) {
      result.push(line);
      continue;
    }

    if (isTask(line)) {
      if (!extractId(line)) {
        line = addId(line, generateId(settings));
      }
    }

    result.push(line);
  }

  return result.join('\n');
}
