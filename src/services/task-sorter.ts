import {
  extractId,
  extractParentId,
  getTaskSortKey,
  isCalendarEvent,
  isCompleted,
  isParentTask,
  isSubtask
} from '../utils/task-utils';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK SORTER MODULE
// ============================================================================

type TaskSortKey = ReturnType<typeof getTaskSortKey>;
type TaskGroup = { parent: string; subtasks: string[]; sortKey: TaskSortKey };
type Chunk = { type: 'task'; group: TaskGroup } | { type: 'text'; line: string };
type Section = { header: string | null; bodyLines: string[] };

/**
 * Parse a list of lines into an ordered sequence of chunks.
 * Task groups (parent + immediately following subtasks) become task chunks;
 * everything else becomes text chunks (preserved in place).
 */
function parseTaskChunks(bodyLines: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;

  while (i < bodyLines.length) {
    const line = bodyLines[i];

    if (isParentTask(line)) {
      const id = extractId(line);
      const subtasks: string[] = [];
      let j = i + 1;

      while (j < bodyLines.length && isSubtask(bodyLines[j])) {
        const subtaskParentId = extractParentId(bodyLines[j]);
        if (!subtaskParentId || subtaskParentId === id) {
          subtasks.push(bodyLines[j]);
        } else {
          break;
        }
        j++;
      }

      chunks.push({
        type: 'task',
        group: { parent: line, subtasks, sortKey: getTaskSortKey(line) }
      });
      i = j;
    } else if (isSubtask(line)) {
      // Orphan subtask (no parent before it) — preserve as text
      chunks.push({ type: 'text', line });
      i++;
    } else {
      chunks.push({ type: 'text', line });
      i++;
    }
  }

  return chunks;
}

/** Split document content into sections delimited by markdown headers. */
function splitSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    if (/^#/.test(line)) {
      sections.push({ header: currentHeader, bodyLines: currentBody });
      currentHeader = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  sections.push({ header: currentHeader, bodyLines: currentBody });

  return sections;
}

/** Standard chronological sort comparator for task groups. */
function chronologicalSort(a: TaskGroup, b: TaskGroup): number {
  if (a.sortKey.hasTime && !b.sortKey.hasTime) return -1;
  if (!a.sortKey.hasTime && b.sortKey.hasTime) return 1;
  if (a.sortKey.start !== b.sortKey.start) return a.sortKey.start - b.sortKey.start;
  return a.sortKey.end - b.sortKey.end;
}

/** Emit a task group's lines into a result array. */
function emitTaskGroup(group: TaskGroup, result: string[]): void {
  result.push(group.parent);
  for (const subtask of group.subtasks) {
    result.push(subtask);
  }
}

/**
 * Sort tasks chronologically within each header section, preserving all
 * non-task content in place. Completed tasks are collected and moved to
 * a "## Completed" section at the end.
 */
export function sortContent(content: string, settings: TaskManagerSettings): string {
  const lines = content.split('\n');
  const result: string[] = [];
  const sections = splitSections(lines);

  // Find and separate the Completed section
  const completedSectionIndex = sections.findIndex(s =>
    s.header !== null && /^##\s*Completed\s*$/i.test(s.header)
  );

  const allCompleted: TaskGroup[] = [];

  if (completedSectionIndex >= 0) {
    const completedSection = sections.splice(completedSectionIndex, 1)[0];
    for (const chunk of parseTaskChunks(completedSection.bodyLines)) {
      if (chunk.type === 'task') {
        allCompleted.push(chunk.group);
      }
    }
  }

  // Process each remaining section: sort incomplete tasks in-place,
  // collect completed tasks for the Completed section.
  for (const section of sections) {
    if (section.header !== null) {
      result.push(section.header);
    }

    const chunks = parseTaskChunks(section.bodyLines);

    // Separate incomplete and completed task groups
    const incompleteGroups: TaskGroup[] = [];
    for (const chunk of chunks) {
      if (chunk.type === 'task') {
        if (isCompleted(chunk.group.parent)) {
          allCompleted.push(chunk.group);
        } else {
          incompleteGroups.push(chunk.group);
        }
      }
    }

    // Sort incomplete groups chronologically
    incompleteGroups.sort(chronologicalSort);

    // Reconstruct: text lines stay in place, task slots get sorted tasks
    let taskIndex = 0;
    for (const chunk of chunks) {
      if (chunk.type === 'text') {
        result.push(chunk.line);
      } else {
        // Task slot — emit next sorted incomplete task if available
        if (taskIndex < incompleteGroups.length) {
          emitTaskGroup(incompleteGroups[taskIndex], result);
          taskIndex++;
        }
        // Completed tasks were removed; their slot is consumed silently
      }
    }

    // Emit any remaining tasks (if completed tasks reduced the slot count)
    while (taskIndex < incompleteGroups.length) {
      emitTaskGroup(incompleteGroups[taskIndex], result);
      taskIndex++;
    }
  }

  // Add Completed section at the end
  if (allCompleted.length > 0) {
    while (result.length > 0 && result[result.length - 1].trim() === '') {
      result.pop();
    }

    result.push('');
    result.push('## Completed');

    allCompleted.sort(chronologicalSort);

    for (const group of allCompleted) {
      emitTaskGroup(group, result);
    }
  }

  return result.join('\n');
}

/**
 * Sort all items (tasks and events) by time block within each header section,
 * with unscheduled items after scheduled ones. Preserves all non-task content
 * in place.
 */
export function sortByTimeBlock(content: string, settings: TaskManagerSettings): string {
  const lines = content.split('\n');

  const TIME_PATTERN = /^[\t]*- \[.\]\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
  const ARCHIVE_CALLOUT_START = /^> \[!archived\]-?\s*Archived\s*$/;
  const ARCHIVE_LINE = /^> /;

  type TimeSortedItem = {
    line: string;
    subtasks: string[];
    startMinutes: number;
    endMinutes: number;
    hasTime: boolean;
  };
  type ItemChunk = { type: 'item'; item: TimeSortedItem } | { type: 'text'; line: string };

  // Extract archived callout section before splitting into header sections
  const preArchiveLines: string[] = [];
  const archivedSection: string[] = [];
  let inArchiveSection = false;

  for (const line of lines) {
    if (ARCHIVE_CALLOUT_START.test(line)) {
      inArchiveSection = true;
      archivedSection.push(line);
    } else if (inArchiveSection) {
      if (ARCHIVE_LINE.test(line) || line.trim() === '') {
        archivedSection.push(line);
      } else {
        inArchiveSection = false;
        preArchiveLines.push(line);
      }
    } else {
      preArchiveLines.push(line);
    }
  }

  const sections = splitSections(preArchiveLines);
  const result: string[] = [];

  for (const section of sections) {
    if (section.header !== null) {
      result.push(section.header);
    }

    // Parse body into item chunks and text chunks
    const chunks: ItemChunk[] = [];
    let i = 0;

    while (i < section.bodyLines.length) {
      const line = section.bodyLines[i];
      const isParent = isParentTask(line);
      const isEvent = isCalendarEvent(line);

      if (isParent || isEvent) {
        const subtasks: string[] = [];

        if (isParent) {
          const parentId = extractId(line);
          let j = i + 1;
          while (j < section.bodyLines.length && isSubtask(section.bodyLines[j])) {
            const subtaskParentId = extractParentId(section.bodyLines[j]);
            if (!subtaskParentId || subtaskParentId === parentId) {
              subtasks.push(section.bodyLines[j]);
            } else {
              break;
            }
            j++;
          }
          i = j;
        } else {
          i++;
        }

        const timeMatch = line.match(TIME_PATTERN);
        chunks.push({
          type: 'item',
          item: {
            line,
            subtasks,
            hasTime: !!timeMatch,
            startMinutes: timeMatch ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : Infinity,
            endMinutes: timeMatch ? parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]) : Infinity
          }
        });
      } else if (isSubtask(line)) {
        // Orphan subtask — preserve as text
        chunks.push({ type: 'text', line });
        i++;
      } else {
        chunks.push({ type: 'text', line });
        i++;
      }
    }

    // Collect and sort items: scheduled first by time, then unscheduled
    const items: TimeSortedItem[] = [];
    for (const chunk of chunks) {
      if (chunk.type === 'item') {
        items.push(chunk.item);
      }
    }

    items.sort((a, b) => {
      if (a.hasTime && !b.hasTime) return -1;
      if (!a.hasTime && b.hasTime) return 1;
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
      return a.endMinutes - b.endMinutes;
    });

    // Reconstruct: text stays in place, item slots get sorted items
    let itemIndex = 0;
    for (const chunk of chunks) {
      if (chunk.type === 'text') {
        result.push(chunk.line);
      } else {
        if (itemIndex < items.length) {
          result.push(items[itemIndex].line);
          for (const subtask of items[itemIndex].subtasks) {
            result.push(subtask);
          }
          itemIndex++;
        }
      }
    }

    while (itemIndex < items.length) {
      result.push(items[itemIndex].line);
      for (const subtask of items[itemIndex].subtasks) {
        result.push(subtask);
      }
      itemIndex++;
    }
  }

  // Add archived section at the end
  if (archivedSection.length > 0) {
    result.push('');
    for (const line of archivedSection) {
      result.push(line);
    }
  }

  return result.join('\n');
}
