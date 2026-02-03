import {
  extractId,
  extractParentId,
  getTaskSortKey,
  isCalendarEvent,
  isCompleted,
  isParentTask,
  isSubtask
} from '../utils/task-utils';

// ============================================================================
// TASK SORTER MODULE
// ============================================================================

export function sortContent(content, settings) {
  const lines = content.split('\n');
  const result = [];
  let completedTasks = [];
  let inCompletedSection = false;

  const allParentTasks = [];
  const allSubtasks = [];
  const otherLines = [];

  let inTaskArea = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^##\s*Completed\s*$/i.test(line)) {
      inCompletedSection = true;
      continue;
    }

    const isParent = isParentTask(line);
    const isChild = isSubtask(line);

    if (inCompletedSection) {
      if (isParent) {
        completedTasks.push({ id: extractId(line), parent: line, subtasks: [] });
      } else if (isChild && completedTasks.length > 0) {
        const parentId = extractParentId(line);
        if (parentId) {
          const parentTask = completedTasks.find(t => t.id === parentId);
          if (parentTask) {
            parentTask.subtasks.push(line);
          } else {
            completedTasks[completedTasks.length - 1].subtasks.push(line);
          }
        } else {
          completedTasks[completedTasks.length - 1].subtasks.push(line);
        }
      } else if (/^#/.test(line)) {
        inCompletedSection = false;
        otherLines.push({ line, index: i, isTaskArea: false });
      }
      continue;
    }

    if (isParent) {
      if (!inTaskArea) {
        inTaskArea = true;
      }
      allParentTasks.push({ id: extractId(line), line, index: i });
    } else if (isChild) {
      allSubtasks.push({ parentId: extractParentId(line), line, index: i });
    } else {
      if (inTaskArea && /^#/.test(line)) {
        inTaskArea = false;
      }
      otherLines.push({ line, index: i, isTaskArea: inTaskArea });
    }
  }

  // Build task groups using parent IDs
  const taskGroups = [];

  for (const parentTask of allParentTasks) {
    const group = {
      parent: parentTask.line,
      subtasks: [],
      sortKey: getTaskSortKey(parentTask.line)
    };

    if (parentTask.id) {
      for (const subtask of allSubtasks) {
        if (subtask.parentId === parentTask.id) {
          group.subtasks.push(subtask.line);
        }
      }
    }

    // Legacy support: include subtasks without parent ID that immediately followed this task
    const parentIndex = parentTask.index;
    for (const subtask of allSubtasks) {
      if (!subtask.parentId) {
        let isDirectChild = true;
        for (const otherParent of allParentTasks) {
          if (otherParent.index > parentIndex && otherParent.index < subtask.index) {
            isDirectChild = false;
            break;
          }
        }
        const closestParent = allParentTasks
          .filter(p => p.index < subtask.index)
          .sort((a, b) => b.index - a.index)[0];

        if (closestParent && closestParent.index === parentIndex && isDirectChild) {
          if (!group.subtasks.includes(subtask.line)) {
            group.subtasks.push(subtask.line);
          }
        }
      }
    }

    taskGroups.push(group);
  }

  // Separate incomplete and completed
  const incompleteGroups = taskGroups.filter(g => !isCompleted(g.parent));
  const completedGroups = taskGroups.filter(g => isCompleted(g.parent));

  // Sort incomplete groups chronologically
  incompleteGroups.sort((a, b) => {
    if (a.sortKey.hasTime && !b.sortKey.hasTime) return -1;
    if (!a.sortKey.hasTime && b.sortKey.hasTime) return 1;
    if (a.sortKey.start !== b.sortKey.start) return a.sortKey.start - b.sortKey.start;
    return a.sortKey.end - b.sortKey.end;
  });

  // Sort completed groups chronologically
  completedGroups.sort((a, b) => {
    if (a.sortKey.hasTime && !b.sortKey.hasTime) return -1;
    if (!a.sortKey.hasTime && b.sortKey.hasTime) return 1;
    if (a.sortKey.start !== b.sortKey.start) return a.sortKey.start - b.sortKey.start;
    return a.sortKey.end - b.sortKey.end;
  });

  // Rebuild the content
  const firstTaskIndex = allParentTasks.length > 0 ? allParentTasks[0].index : 0;
  const lastTaskIndex = allParentTasks.length > 0
    ? Math.max(...allParentTasks.map(t => t.index), ...allSubtasks.map(s => s.index))
    : 0;

  // Add lines before tasks
  for (const item of otherLines) {
    if (item.index < firstTaskIndex) {
      result.push(item.line);
    }
  }

  // Add sorted incomplete tasks
  for (const group of incompleteGroups) {
    result.push(group.parent);
    for (const subtask of group.subtasks) {
      result.push(subtask);
    }
  }

  // Add lines after tasks (but before Completed section)
  for (const item of otherLines) {
    if (item.index > lastTaskIndex) {
      result.push(item.line);
    }
  }

  // Add Completed section
  const allCompleted = [...completedGroups, ...completedTasks];
  if (allCompleted.length > 0) {
    while (result.length > 0 && result[result.length - 1].trim() === '') {
      result.pop();
    }

    result.push('');
    result.push('## Completed');

    allCompleted.sort((a, b) => {
      const keyA = getTaskSortKey(a.parent);
      const keyB = getTaskSortKey(b.parent);
      if (keyA.hasTime && !keyB.hasTime) return -1;
      if (!keyA.hasTime && keyB.hasTime) return 1;
      if (keyA.start !== keyB.start) return keyA.start - keyB.start;
      return keyA.end - keyB.end;
    });

    for (const group of allCompleted) {
      result.push(group.parent);
      for (const subtask of group.subtasks) {
        result.push(subtask);
      }
    }
  }

  return result.join('\n');
}

// Sort all items (tasks and events) by time block, with unscheduled at bottom
export function sortByTimeBlock(content, settings) {
  const lines = content.split('\n');

  // Pattern to extract time from any line (tasks or events)
  const TIME_PATTERN = /^[\t]*- \[.\]\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
  // Pattern to detect archived callout section
  const ARCHIVE_CALLOUT_START = /^> \[!archived\]-?\s*Archived\s*$/;
  const ARCHIVE_LINE = /^> /;

  // Collect all items
  const scheduledItems = [];  // Items with time blocks (tasks + events)
  const unscheduledItems = []; // Items without time blocks
  const archivedSection = [];  // Archived callout and its content

  let i = 0;
  let inArchiveSection = false;

  while (i < lines.length) {
    const line = lines[i];

    // Check for archived callout section
    if (ARCHIVE_CALLOUT_START.test(line)) {
      inArchiveSection = true;
      archivedSection.push(line);
      i++;
      continue;
    }

    // If in archive section, collect lines until we exit
    if (inArchiveSection) {
      if (ARCHIVE_LINE.test(line) || line.trim() === '') {
        archivedSection.push(line);
        i++;
        continue;
      } else {
        // Exited archive section
        inArchiveSection = false;
      }
    }

    const isParent = isParentTask(line);
    const isEvent = isCalendarEvent(line);

    if (isParent || isEvent) {
      // Extract time block
      const timeMatch = line.match(TIME_PATTERN);

      // Collect subtasks for parent tasks
      const subtasks = [];
      if (isParent) {
        const parentId = extractId(line);
        let j = i + 1;
        while (j < lines.length && isSubtask(lines[j])) {
          // Check if subtask belongs to this parent (by parent ID or by position)
          const subtaskParentId = extractParentId(lines[j]);
          if (!subtaskParentId || subtaskParentId === parentId) {
            subtasks.push(lines[j]);
          }
          j++;
        }
        i = j; // Skip past subtasks
      } else {
        i++;
      }

      const item = {
        line,
        subtasks,
        isEvent: isEvent
      };

      if (timeMatch) {
        item.startMinutes = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
        item.endMinutes = parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]);
        scheduledItems.push(item);
      } else {
        unscheduledItems.push(item);
      }
    } else if (isSubtask(line)) {
      // Orphan subtask - skip (should be collected with parent)
      i++;
    } else {
      // Skip other lines (empty lines, etc.) - they'll be rebuilt in output
      i++;
    }
  }

  // Sort scheduled items by start time, then end time
  scheduledItems.sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) {
      return a.startMinutes - b.startMinutes;
    }
    return a.endMinutes - b.endMinutes;
  });

  // Build result
  const result = [];

  // Add scheduled items
  for (const item of scheduledItems) {
    result.push(item.line);
    for (const subtask of item.subtasks) {
      result.push(subtask);
    }
  }

  // Add blank line separator before unscheduled if there are any
  if (unscheduledItems.length > 0 && scheduledItems.length > 0) {
    result.push('');
  }

  // Add unscheduled items
  for (const item of unscheduledItems) {
    result.push(item.line);
    for (const subtask of item.subtasks) {
      result.push(subtask);
    }
  }

  // Add archived section at the end if it exists
  if (archivedSection.length > 0) {
    result.push('');
    for (const line of archivedSection) {
      result.push(line);
    }
  }

  return result.join('\n');
}
