import {
  extractId,
  extractParentId,
  extractPriority,
  detectPriorityMarker,
  getTaskSortKey,
  isCalendarEvent,
  isChildLine,
  isCompleted,
  isParentTask
} from '../utils/task-utils';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK SORTER MODULE
// ============================================================================

type TaskSortKey = ReturnType<typeof getTaskSortKey>;
type TaskGroup = { parent: string; children: string[]; sortKey: TaskSortKey };
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
      const children: string[] = [];
      let j = i + 1;

      while (j < bodyLines.length && isChildLine(bodyLines[j])) {
        const childParentId = extractParentId(bodyLines[j]);
        if (!childParentId || childParentId === id) {
          children.push(bodyLines[j]);
        } else {
          break;
        }
        j++;
      }

      chunks.push({
        type: 'task',
        group: { parent: line, children, sortKey: getTaskSortKey(line) }
      });
      i = j;
    } else if (isChildLine(line)) {
      // Orphan child (no parent before it) — preserve as text
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
  for (const child of group.children) {
    result.push(child);
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
    children: string[];
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
        const children: string[] = [];

        if (isParent) {
          const parentId = extractId(line);
          let j = i + 1;
          while (j < section.bodyLines.length && isChildLine(section.bodyLines[j])) {
            const childParentId = extractParentId(section.bodyLines[j]);
            if (!childParentId || childParentId === parentId) {
              children.push(section.bodyLines[j]);
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
            children,
            hasTime: !!timeMatch,
            startMinutes: timeMatch ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : Infinity,
            endMinutes: timeMatch ? parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]) : Infinity
          }
        });
      } else if (isChildLine(line)) {
        // Orphan child — preserve as text
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
          for (const child of items[itemIndex].children) {
            result.push(child);
          }
          itemIndex++;
        }
      }
    }

    while (itemIndex < items.length) {
      result.push(items[itemIndex].line);
      for (const child of items[itemIndex].children) {
        result.push(child);
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

// ============================================================================
// SMART SORT
// ============================================================================

const STATUS_MARKER_PATTERN = /^[\t]*- \[(.)\]/;

/** Extract the checkbox status character from a task line. */
function extractStatus(line: string): string {
  const m = line.match(STATUS_MARKER_PATTERN);
  return m ? m[1] : ' ';
}

/**
 * Map a status character to a sort rank.
 * Lower rank = higher in the list.
 */
function getStatusRank(status: string): number {
  switch (status) {
    case 'c': return 0; // calendar events — fixed, always top
    case ' ': return 1; // unstarted
    case '/': return 2; // in progress
    case '>': return 3; // scheduled
    case '-': return 4; // cancelled
    case 'x':
    case 'X': return 5; // done
    default:  return 3; // unknown statuses sort with scheduled
  }
}

/** Get the effective priority for a task line (higher = more urgent). */
function getEffectivePriority(line: string): number {
  return extractPriority(line) ?? detectPriorityMarker(line) ?? 0;
}

/**
 * Smart sort: sorts tasks within each header section by status, then
 * priority (highest first), then time block (earliest first).
 * Preserves all non-task content in place.
 *
 * Status order: calendar → unstarted → in-progress → scheduled → cancelled → done
 */
export function smartSort(content: string, settings: TaskManagerSettings): string {
  const lines = content.split('\n');
  const sections = splitSections(lines);
  const result: string[] = [];

  for (const section of sections) {
    if (section.header !== null) {
      result.push(section.header);
    }

    const chunks = parseTaskChunks(section.bodyLines);

    // Collect all task groups from this section
    const taskGroups: TaskGroup[] = [];
    for (const chunk of chunks) {
      if (chunk.type === 'task') {
        taskGroups.push(chunk.group);
      }
    }

    // Sort by status rank → priority (desc) → time block (asc)
    taskGroups.sort((a, b) => {
      const statusA = getStatusRank(extractStatus(a.parent));
      const statusB = getStatusRank(extractStatus(b.parent));
      if (statusA !== statusB) return statusA - statusB;

      const prioA = getEffectivePriority(a.parent);
      const prioB = getEffectivePriority(b.parent);
      if (prioA !== prioB) return prioB - prioA; // higher priority first

      return chronologicalSort(a, b);
    });

    // Reconstruct: text stays in place, task slots get sorted tasks
    let taskIndex = 0;
    for (const chunk of chunks) {
      if (chunk.type === 'text') {
        result.push(chunk.line);
      } else {
        if (taskIndex < taskGroups.length) {
          emitTaskGroup(taskGroups[taskIndex], result);
          taskIndex++;
        }
      }
    }

    while (taskIndex < taskGroups.length) {
      emitTaskGroup(taskGroups[taskIndex], result);
      taskIndex++;
    }
  }

  return result.join('\n');
}
