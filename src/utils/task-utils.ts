import type { TFile } from 'obsidian';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// SHARED UTILITIES
// ============================================================================

// Regex patterns
export const TASK_PATTERN = /^[\t]*- \[.\]/;
export const PARENT_TASK_PATTERN = /^- \[.\]/;
export const SUBTASK_PATTERN = /^\t+- \[.\]/;
export const ID_PATTERN = /\[id::([^\]]+)\]/;
export const PARENT_ID_PATTERN = /\[parent::([^\]]+)\]/;
export const METADATA_PATTERN = /\s*\[(?:id|parent|uid)::[^\]]+\]/g;
export const COMPLETED_PATTERN = /^[\t]*- \[[xX\->]\]/;
export const TIMEBLOCK_PATTERN = /^- \[.\]\s*(\d{2}):(\d{2}) - (\d{2}):(\d{2})/;
export const CALENDAR_EVENT_PATTERN = /^[\t]*- \[c\]/;

export function extractId(line: string): string | null {
  const match = line.match(ID_PATTERN);
  return match ? match[1].trim() : null;
}

export function extractParentId(line: string): string | null {
  const match = line.match(PARENT_ID_PATTERN);
  return match ? match[1].trim() : null;
}

export function generateId(settings: TaskManagerSettings): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = settings.idPrefix;
  for (let i = 0; i < settings.idLength; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export function addId(line: string, id: string): string {
  if (extractId(line)) {
    return line;
  }
  return line.trimEnd() + ` [id::${id}]`;
}

export function addParentId(line: string, parentId: string): string {
  const existingParent = extractParentId(line);
  if (existingParent) {
    if (existingParent !== parentId) {
      return line.replace(PARENT_ID_PATTERN, `[parent::${parentId}]`);
    }
    return line;
  }
  return line.trimEnd() + ` [parent::${parentId}]`;
}


export function removeParentId(line: string): string {
  return line.replace(/\s*\[parent::[^\]]+\]/, '');
}

export function extractPriority(line: string): number | null {
  const match = line.match(/\[priority::\s*(\d+)\]/);
  return match ? parseInt(match[1]) : null;
}

export function detectPriorityMarker(line: string): number | null {
  const match = line.match(/^[\t]*- \[.\]\s*(?:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)?(!!!|!!|!)\s/);
  return match ? match[1].length : null;
}

export function addPriority(line: string, level: number): string {
  const existing = extractPriority(line);
  if (existing === level) return line;
  if (existing !== null) {
    return line.replace(/\[priority::\s*\d+\]/, `[priority::${level}]`);
  }
  return line.trimEnd() + ` [priority::${level}]`;
}

export function removePriority(line: string): string {
  return line.replace(/\s*\[priority::\s*\d+\]/, '');
}


export function isTask(line: string): boolean {
  return TASK_PATTERN.test(line);
}

export function isCalendarEvent(line: string): boolean {
  return CALENDAR_EVENT_PATTERN.test(line);
}

export function isParentTask(line: string): boolean {
  return PARENT_TASK_PATTERN.test(line);
}

export function isSubtask(line: string): boolean {
  return SUBTASK_PATTERN.test(line);
}

export function isCompleted(line: string): boolean {
  return COMPLETED_PATTERN.test(line);
}

export function getTaskSortKey(taskLine: string): { hasTime: boolean; start: number; end: number } {
  const match = taskLine.match(TIMEBLOCK_PATTERN);
  if (match) {
    const startMinutes = parseInt(match[1]) * 60 + parseInt(match[2]);
    const endMinutes = parseInt(match[3]) * 60 + parseInt(match[4]);
    return { hasTime: true, start: startMinutes, end: endMinutes };
  }
  return { hasTime: false, start: Infinity, end: Infinity };
}

export function shouldProcessFile(file: TFile, settings: TaskManagerSettings): boolean {
  if (file.extension !== 'md') return false;
  return settings.targetFolders.some(folder => file.path.includes(folder));
}

/**
 * Check if the task description text is already wrapped in a wiki link.
 */
export function hasWikiLink(line: string): boolean {
  // Check if line contains [[...]] in the task text portion
  return /^[\t]*- \[.\].*\[\[/.test(line);
}

/**
 * Wrap the task description text (not time blocks, tags, or metadata) in a [[wiki link]].
 * Input:  "- [ ] 13:00 - 15:30 Self evaluation #sei [id::t-xxx]"
 * Output: "- [ ] 13:00 - 15:30 [[Self evaluation]] #sei [id::t-xxx]"
 *
 * Returns null if already linked or no description text found.
 */
export function wrapTaskTextWithLink(line: string): string | null {
  if (!isTask(line)) return null;
  if (hasWikiLink(line)) return null;

  // Match: prefix (checkbox + optional timeblock) | description | suffix (tags + metadata)
  const match = line.match(
    /^([\t]*- \[.\]\s*(?:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)?)(.*?)(\s*(?:#\w+|\[(?:id|parent|uid|calendar)::[^\]]+\]|\[[<>]\s*\d{4}-\d{2}-\d{2}\]).*)$/
  );

  if (match) {
    const [, prefix, description, suffix] = match;
    const trimmedDesc = description.trim();
    if (!trimmedDesc) return null;
    return `${prefix}[[${trimmedDesc}]]${suffix}`;
  }

  // No tags or metadata — try simpler match
  const simpleMatch = line.match(/^([\t]*- \[.\]\s*(?:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)?)(.+)$/);
  if (simpleMatch) {
    const [, prefix, description] = simpleMatch;
    const trimmedDesc = description.trim();
    if (!trimmedDesc) return null;
    return `${prefix}[[${trimmedDesc}]]`;
  }

  return null;
}
