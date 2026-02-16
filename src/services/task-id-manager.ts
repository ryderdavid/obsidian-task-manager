import { addId, extractId, generateId, isCalendarEvent, isTask } from '../utils/task-utils';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK ID MANAGER MODULE
// ============================================================================

export function processContent(content: string, settings: TaskManagerSettings): string {
  const lines = content.split('\n');
  const result: string[] = [];

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
