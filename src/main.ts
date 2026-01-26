'use strict';

const obsidian = require('obsidian');
const { EditorView, Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_SETTINGS = {
  // Scope
  targetFolders: ['00 - Daily/'],

  // Task IDs
  enableTaskIds: true,
  idPrefix: 't-',
  idLength: 8,

  // Parent-Child Linking
  enableParentChildLinking: true,
  preserveExistingParentLinks: true,

  // Sorting
  enableAutoSort: false,
  sortDebounceMs: 500,
  tasksWithoutTimePosition: 'end',

  // UI
  showInfoButton: true,
  hideMetadataFields: true,

  // Task Notes
  enableTaskNotes: true,
  taskNotesFolder: 'Task Notes',

  // Event Notes (for calendar events)
  enableEventNotes: true,
  eventNotesFolder: 'Event Notes',

  // ICS Calendar Sync
  enableIcsSync: true,

  // Auto-Archive
  enableAutoArchive: true,

  // Task Status Sync
  enableTaskStatusSync: true,
  statusMappings: {
    ' ': 'incomplete',
    'x': 'complete',
    'X': 'complete',
    '/': 'in-progress',
    '-': 'cancelled',
    '>': 'scheduled'
  }
};

// ============================================================================
// SHARED UTILITIES
// ============================================================================

const TaskUtils = {
  // Regex patterns
  TASK_PATTERN: /^[\t]*- \[.\]/,
  PARENT_TASK_PATTERN: /^- \[.\]/,
  SUBTASK_PATTERN: /^\t+- \[.\]/,
  ID_PATTERN: /\[id::([^\]]+)\]/,
  PARENT_ID_PATTERN: /\[parent::([^\]]+)\]/,
  METADATA_PATTERN: /\s*\[(?:id|parent|uid)::[^\]]+\]/g,
  COMPLETED_PATTERN: /^[\t]*- \[[xX\->]\]/,
  TIMEBLOCK_PATTERN: /^- \[.\]\s*(\d{2}):(\d{2}) - (\d{2}):(\d{2})/,
  CALENDAR_EVENT_PATTERN: /^[\t]*- \[c\]/,

  extractId(line) {
    const match = line.match(this.ID_PATTERN);
    return match ? match[1].trim() : null;
  },

  extractParentId(line) {
    const match = line.match(this.PARENT_ID_PATTERN);
    return match ? match[1].trim() : null;
  },

  generateId(settings) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = settings.idPrefix;
    for (let i = 0; i < settings.idLength; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  },

  addId(line, id) {
    if (this.extractId(line)) {
      return line;
    }
    return line.trimEnd() + ` [id::${id}]`;
  },

  addParentId(line, parentId) {
    const existingParent = this.extractParentId(line);
    if (existingParent) {
      if (existingParent !== parentId) {
        return line.replace(this.PARENT_ID_PATTERN, `[parent::${parentId}]`);
      }
      return line;
    }
    return line.trimEnd() + ` [parent::${parentId}]`;
  },

  /**
   * Normalize metadata field ordering on a task line.
   * Ensures all dataview fields and schedule tags are at the end in consistent order:
   * Task text #tags [id::xxx] [parent::xxx] [< DATE] [> DATE]
   */
  normalizeMetadataOrder(line) {
    if (!this.isTask(line)) return line;

    // Extract the checkbox prefix (including indentation)
    const prefixMatch = line.match(/^([\t]*- \[.\]\s*)/);
    if (!prefixMatch) return line;
    const prefix = prefixMatch[1];
    let content = line.slice(prefix.length);

    // Extract all metadata fields
    const idMatch = content.match(/\[id::([^\]]+)\]/);
    const parentMatch = content.match(/\[parent::([^\]]+)\]/);
    const uidMatch = content.match(/\[uid::([^\]]+)\]/);
    const scheduleToMatch = content.match(/\[>\s*(\d{4}-\d{2}-\d{2})\]/);
    const scheduleFromMatch = content.match(/\[<\s*(\d{4}-\d{2}-\d{2})\]/);

    // Remove all metadata fields from content
    content = content
      .replace(/\s*\[id::[^\]]+\]/g, '')
      .replace(/\s*\[parent::[^\]]+\]/g, '')
      .replace(/\s*\[uid::[^\]]+\]/g, '')
      .replace(/\s*\[>\s*\d{4}-\d{2}-\d{2}\]/g, '')
      .replace(/\s*\[<\s*\d{4}-\d{2}-\d{2}\]/g, '')
      .trimEnd();

    // Rebuild with metadata at the end in consistent order
    const parts = [prefix + content];
    if (idMatch) parts.push(`[id::${idMatch[1]}]`);
    if (parentMatch) parts.push(`[parent::${parentMatch[1]}]`);
    if (uidMatch) parts.push(`[uid::${uidMatch[1]}]`);
    if (scheduleFromMatch) parts.push(`[< ${scheduleFromMatch[1]}]`);
    if (scheduleToMatch) parts.push(`[> ${scheduleToMatch[1]}]`);

    return parts.join(' ');
  },

  removeParentId(line) {
    return line.replace(/\s*\[parent::[^\]]+\]/, '');
  },

  isTask(line) {
    return this.TASK_PATTERN.test(line);
  },

  isCalendarEvent(line) {
    return this.CALENDAR_EVENT_PATTERN.test(line);
  },

  isParentTask(line) {
    return this.PARENT_TASK_PATTERN.test(line);
  },

  isSubtask(line) {
    return this.SUBTASK_PATTERN.test(line);
  },

  isCompleted(line) {
    return this.COMPLETED_PATTERN.test(line);
  },

  getTaskSortKey(taskLine) {
    const match = taskLine.match(this.TIMEBLOCK_PATTERN);
    if (match) {
      const startMinutes = parseInt(match[1]) * 60 + parseInt(match[2]);
      const endMinutes = parseInt(match[3]) * 60 + parseInt(match[4]);
      return { hasTime: true, start: startMinutes, end: endMinutes };
    }
    return { hasTime: false, start: Infinity, end: Infinity };
  },

  shouldProcessFile(file, settings) {
    if (file.extension !== 'md') return false;
    return settings.targetFolders.some(folder => file.path.includes(folder));
  }
};

// ============================================================================
// ICS CALENDAR EVENT SYNC MODULE
// ============================================================================

const IcsEventSync = {
  // Pattern to extract UID from calendar event line
  UID_PATTERN: /\[uid::([^\]]+)\]/,
  // Pattern to extract calendar source from calendar event line
  CALENDAR_PATTERN: /\[calendar::([^\]]+)\]/,

  // Extract UID from a calendar event line
  extractUid(line) {
    const match = line.match(this.UID_PATTERN);
    return match ? match[1].trim() : null;
  },

  // Extract calendar source name from a calendar event line
  extractCalendar(line) {
    const match = line.match(this.CALENDAR_PATTERN);
    return match ? match[1].trim() : null;
  },

  // Parse a calendar event line into components
  parseEventLine(line) {
    // Match: - [c] HH:MM - HH:MM Event text [uid::xxx]
    const match = line.match(/^- \[c\]\s*(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s+(.+?)(?:\s*\[uid::[^\]]+\])?\s*$/);
    if (!match) return null;
    return {
      startHour: parseInt(match[1]),
      startMinute: parseInt(match[2]),
      endHour: parseInt(match[3]),
      endMinute: parseInt(match[4]),
      text: match[5].trim(),
      uid: this.extractUid(line)
    };
  },

  // Format time as HH:MM
  formatTime(hour, minute) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  },

  // Build a calendar event line from ICS event data
  // ICS plugin returns: { uid, time, endTime, summary, location, callUrl, utime, icsName, ... }
  buildEventLine(event, settings) {
    // ICS plugin already formats times as strings like "10:00"
    const startTime = event.time || '00:00';
    const endTime = event.endTime || startTime;

    // Build event text - include location and URL if present
    let text = event.summary || 'Untitled Event';
    if (event.location) {
      text += ` ${event.location}`;
    }
    // Add video call URL if present
    if (event.callUrl) {
      text += ` ${event.callUrl}`;
    }

    // Use the real UID from the ICS file (from our forked plugin)
    const uid = event.uid || `fallback-${event.utime}`;

    // Get calendar source name from ICS plugin
    const calendarName = event.icsName || '';

    // Build the line with UID and calendar source
    let line = `- [c] ${startTime} - ${endTime} ${text} [uid::${uid}]`;
    if (calendarName) {
      line += ` [calendar::${calendarName}]`;
    }
    return line;
  },

  // Check if a file is a daily note for a specific date
  getDailyNoteDate(file, settings) {
    // Check if file is in target folders
    if (!TaskUtils.shouldProcessFile(file, settings)) return null;

    // Try to parse date from filename (YYYY-MM-DD.md)
    const match = file.basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  },

  // Get events from ICS plugin for a specific date
  async getIcsEvents(app, date) {
    try {
      const icsPlugin = app.plugins.getPlugin('ics');
      if (!icsPlugin || !icsPlugin.getEvents) {
        return null; // ICS plugin not available
      }

      // ICS plugin expects a moment object
      const moment = window.moment;
      if (!moment) return null;

      const events = await icsPlugin.getEvents(moment(date));
      return events;
    } catch (e) {
      console.error('Task Manager: Error fetching ICS events', e);
      return null;
    }
  },

  // Sync ICS events into a daily note
  async syncEventsToNote(app, file, settings) {
    const noteDate = this.getDailyNoteDate(file, settings);
    if (!noteDate) return false;

    // Get ICS events for this date
    const icsEvents = await this.getIcsEvents(app, noteDate);
    if (!icsEvents || icsEvents.length === 0) {
      // No events to sync - but we should still remove stale events
      // For now, return false if no ICS events
      return false;
    }

    // Read current file content
    const content = await app.vault.read(file);
    const lines = content.split('\n');

    // Separate calendar events from other content
    const calendarLines = [];
    const otherLines = [];

    for (const line of lines) {
      if (TaskUtils.isCalendarEvent(line)) {
        calendarLines.push(line);
      } else {
        otherLines.push(line);
      }
    }

    // Build a map of existing events by UID
    const existingByUid = new Map();
    for (const line of calendarLines) {
      const uid = this.extractUid(line);
      if (uid) {
        existingByUid.set(uid, line);
      }
    }

    // Build new calendar events list
    const newCalendarLines = [];

    for (const event of icsEvents) {
      // Always use fresh data from ICS (overwrite)
      const newLine = this.buildEventLine(event, settings);
      newCalendarLines.push({
        line: newLine,
        utime: event.utime || 0  // Use utime for sorting
      });
    }

    // Sort calendar events by start time (using utime from ICS plugin)
    newCalendarLines.sort((a, b) => a.utime - b.utime);

    // Find where to insert calendar events (at the top of the file, before tasks)
    // Strategy: calendar events go at the very top
    const sortedEventLines = newCalendarLines.map(e => e.line);

    // Rebuild file: calendar events first, then everything else
    const newContent = [...sortedEventLines, ...otherLines].join('\n');

    // Only write if content changed
    if (newContent !== content) {
      await app.vault.modify(file, newContent);
      return true;
    }

    return false;
  }
};

// ============================================================================
// TASK ID MANAGER MODULE
// ============================================================================

const TaskIdManager = {
  processContent(content, settings) {
    const lines = content.split('\n');
    const result = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Skip calendar events - they don't need task IDs
      if (TaskUtils.isCalendarEvent(line)) {
        result.push(line);
        continue;
      }

      if (TaskUtils.isTask(line)) {
        if (!TaskUtils.extractId(line)) {
          line = TaskUtils.addId(line, TaskUtils.generateId(settings));
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }
};

// ============================================================================
// PARENT-CHILD LINKER MODULE
// ============================================================================

const ParentChildLinker = {
  linkContent(content, settings) {
    const lines = content.split('\n');
    const result = [];

    let currentParentId = null;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      const isParentTask = TaskUtils.isParentTask(line);
      const isSubtask = TaskUtils.isSubtask(line);

      if (isParentTask) {
        currentParentId = TaskUtils.extractId(line);

        // Remove any parent field from top-level tasks
        if (TaskUtils.extractParentId(line)) {
          line = TaskUtils.removeParentId(line);
        }

        result.push(line);

      } else if (isSubtask) {
        const existingParentId = TaskUtils.extractParentId(line);

        // Only add parent link if subtask doesn't have one and parent has an ID
        if (!existingParentId && currentParentId) {
          line = TaskUtils.addParentId(line, currentParentId);
        }

        result.push(line);

      } else {
        // Reset parent tracking on headers
        if (/^#/.test(line)) {
          currentParentId = null;
        }
        result.push(line);
      }
    }

    return result.join('\n');
  }
};

// ============================================================================
// TASK SORTER MODULE
// ============================================================================

const TaskSorter = {
  sortContent(content, settings) {
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

      const isParentTask = TaskUtils.isParentTask(line);
      const isSubtask = TaskUtils.isSubtask(line);

      if (inCompletedSection) {
        if (isParentTask) {
          completedTasks.push({ id: TaskUtils.extractId(line), parent: line, subtasks: [] });
        } else if (isSubtask && completedTasks.length > 0) {
          const parentId = TaskUtils.extractParentId(line);
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

      if (isParentTask) {
        if (!inTaskArea) {
          inTaskArea = true;
        }
        allParentTasks.push({ id: TaskUtils.extractId(line), line, index: i });
      } else if (isSubtask) {
        allSubtasks.push({ parentId: TaskUtils.extractParentId(line), line, index: i });
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
        sortKey: TaskUtils.getTaskSortKey(parentTask.line)
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
    const incompleteGroups = taskGroups.filter(g => !TaskUtils.isCompleted(g.parent));
    const completedGroups = taskGroups.filter(g => TaskUtils.isCompleted(g.parent));

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
        const keyA = TaskUtils.getTaskSortKey(a.parent);
        const keyB = TaskUtils.getTaskSortKey(b.parent);
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
  },

  // Sort all items (tasks and events) by time block, with unscheduled at bottom
  sortByTimeBlock(content, settings) {
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

      const isParentTask = TaskUtils.isParentTask(line);
      const isCalendarEvent = TaskUtils.isCalendarEvent(line);

      if (isParentTask || isCalendarEvent) {
        // Extract time block
        const timeMatch = line.match(TIME_PATTERN);

        // Collect subtasks for parent tasks
        const subtasks = [];
        if (isParentTask) {
          const parentId = TaskUtils.extractId(line);
          let j = i + 1;
          while (j < lines.length && TaskUtils.isSubtask(lines[j])) {
            // Check if subtask belongs to this parent (by parent ID or by position)
            const subtaskParentId = TaskUtils.extractParentId(lines[j]);
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
          isEvent: isCalendarEvent
        };

        if (timeMatch) {
          item.startMinutes = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
          item.endMinutes = parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]);
          scheduledItems.push(item);
        } else {
          unscheduledItems.push(item);
        }
      } else if (TaskUtils.isSubtask(line)) {
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
};

// ============================================================================
// TASK ARCHIVER MODULE
// ============================================================================

const TaskArchiver = {
  // Checkbox states that should be archived
  ARCHIVE_STATES: /^[\t]*- \[[xX>\-]\]/,
  // States to keep active
  ACTIVE_STATES: /^[\t]*- \[[ \/c]\]/,
  // Callout pattern for existing archive section
  ARCHIVE_CALLOUT_START: /^> \[!archived\]-?\s*Archived\s*$/,
  ARCHIVE_LINE: /^> /,

  /**
   * Archive completed and scheduled tasks to a collapsed callout section
   */
  archiveContent(content, settings) {
    const lines = content.split('\n');
    const calendarEvents = [];
    const activeTasks = [];
    const archivedTasks = [];
    const existingArchiveContent = [];
    let inArchiveSection = false;
    let i = 0;

    // First pass: categorize all lines
    while (i < lines.length) {
      const line = lines[i];

      // Check if entering existing archive section
      if (this.ARCHIVE_CALLOUT_START.test(line)) {
        inArchiveSection = true;
        i++;
        continue;
      }

      // If in archive section, collect existing archived content
      if (inArchiveSection) {
        if (this.ARCHIVE_LINE.test(line)) {
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
      if (TaskUtils.CALENDAR_EVENT_PATTERN.test(line)) {
        calendarEvents.push(line);
        i++;
        continue;
      }

      // Check if this is a task that should be archived
      if (this.ARCHIVE_STATES.test(line)) {
        const taskGroup = [line];
        i++;
        // Collect subtasks
        while (i < lines.length && TaskUtils.SUBTASK_PATTERN.test(lines[i])) {
          taskGroup.push(lines[i]);
          i++;
        }
        archivedTasks.push(...taskGroup);
        continue;
      }

      // Check if this is an active task
      if (this.ACTIVE_STATES.test(line)) {
        const taskGroup = [line];
        i++;
        // Collect subtasks
        while (i < lines.length && TaskUtils.SUBTASK_PATTERN.test(lines[i])) {
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
    const result = [];

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
};

// ============================================================================
// TASK NOTE MANAGER MODULE
// ============================================================================

const TaskNoteManager = {
  cleanTaskText(text) {
    // Remove time ranges like "15:30 - 15:45"
    text = text.replace(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*/g, '');
    // Remove dates in various formats
    text = text.replace(/📅\s*\[\[[^\]]+\]\]/g, '');
    text = text.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '');
    // Remove tags
    text = text.replace(/#\w+/g, '');
    // Remove task note chain link
    text = text.replace(/🔗\[\[[^\]]+\]\]/g, '');
    // Remove wiki links but keep display text
    text = text.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m, link, display) => display || link);
    // Remove task metadata emojis
    text = text.replace(/[📅🗓️⏳🛫✅❌➕🔺⏫🔼🔽⏬🆔⛔🔁][^\s]*/g, '');
    // Remove button icons
    text = text.replace(/📝/g, '');
    text = text.replace(/🔗/g, '');
    // Remove inline fields (dataview style)
    text = text.replace(/\s*\[[^\]]+::[^\]]*\]/g, '');
    // Remove schedule tags [> DATE] and [< DATE]
    text = text.replace(/\s*\[[<>]\s*\d{4}-\d{2}-\d{2}\]/g, '');
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  },

  sanitizeFilename(text) {
    return text
      .replace(/[\\/:*?"<>|#\[\]]/g, '-')
      .replace(/-+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
  },

  extractTaskTextFromLine(line) {
    // Match any task marker (space, x, >, /, -, etc.)
    const taskMatch = line.match(/^- \[.\]\s*(.+)$/);
    if (!taskMatch) return null;
    return this.cleanTaskText(taskMatch[1]);
  },

  extractCheckboxMarker(line) {
    // Extract the character inside the checkbox brackets
    const match = line.match(/^[\t]*- \[(.)\]/);
    return match ? match[1] : null;
  },

  checkboxToStatus(marker, settings) {
    return settings.statusMappings[marker] || 'incomplete';
  },

  statusToCheckbox(status, settings) {
    // Reverse lookup: find marker for status name
    for (const [marker, name] of Object.entries(settings.statusMappings)) {
      if (name === status) return marker;
    }
    return ' ';
  },

  extractFrontmatterField(content, fieldName) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;
    const frontmatter = frontmatterMatch[1];
    const fieldMatch = frontmatter.match(new RegExp(`^${fieldName}:\\s*"?([^"\\n]*)"?`, 'm'));
    return fieldMatch ? fieldMatch[1] : null;
  },

  updateFrontmatterField(content, fieldName, newValue) {
    const frontmatterMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (!frontmatterMatch) return content;

    const [fullMatch, start, frontmatter, end] = frontmatterMatch;
    const fieldRegex = new RegExp(`^(${fieldName}:\\s*)"?[^"\\n]*"?`, 'm');

    let updatedFrontmatter;
    if (fieldRegex.test(frontmatter)) {
      // Update existing field
      updatedFrontmatter = frontmatter.replace(fieldRegex, `$1"${newValue}"`);
    } else {
      // Add new field at the end of frontmatter
      updatedFrontmatter = frontmatter + `\n${fieldName}: "${newValue}"`;
    }

    return content.replace(fullMatch, start + updatedFrontmatter + end);
  },

  updateTaskCheckbox(content, taskId, newMarker) {
    const lines = content.split('\n');
    const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);

    for (let i = 0; i < lines.length; i++) {
      if (idPattern.test(lines[i])) {
        // Found the task line, update the checkbox marker
        lines[i] = lines[i].replace(/^([\t]*- \[).(])/, `$1${newMarker}$2`);
        break;
      }
    }

    return lines.join('\n');
  },

  async findTaskNoteByTaskId(app, taskId, settings) {
    const folder = settings.taskNotesFolder;
    const files = app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));

    for (const file of files) {
      const content = await app.vault.read(file);
      const noteTaskId = this.extractFrontmatterField(content, 'taskId');
      if (noteTaskId === taskId) {
        return file;
      }
    }
    return null;
  },

  // ============================================================================
  // BIDIRECTIONAL STATUS SYNC
  // ============================================================================

  /**
   * Sync status from task note frontmatter back to daily note checkbox
   * Called when task note is modified
   */
  async syncStatusToSource(app, taskNote, settings) {
    if (!settings.enableTaskStatusSync) return;

    const content = await app.vault.read(taskNote);
    const taskId = this.extractFrontmatterField(content, 'taskId');
    const status = this.extractFrontmatterField(content, 'status');
    const sourceFile = this.extractFrontmatterField(content, 'sourceFile');

    if (!taskId || !status || !sourceFile) return;

    const source = app.vault.getAbstractFileByPath(sourceFile);
    if (!source || !(source instanceof obsidian.TFile)) return;

    const targetMarker = this.statusToCheckbox(status, settings);
    const sourceContent = await app.vault.read(source);

    // Find the current marker for this task
    const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
    const lines = sourceContent.split('\n');
    for (const line of lines) {
      if (idPattern.test(line)) {
        const currentMarker = this.extractCheckboxMarker(line);
        if (currentMarker === targetMarker) {
          // No change needed
          return;
        }
        break;
      }
    }

    // Update the checkbox in the source file
    const updated = this.updateTaskCheckbox(sourceContent, taskId, targetMarker);
    if (updated !== sourceContent) {
      await app.vault.modify(source, updated);
    }
  },

  /**
   * Sync status from daily note checkbox to task note frontmatter
   * Called when daily note is modified
   */
  async syncStatusToTaskNote(app, taskId, newMarker, settings) {
    if (!settings.enableTaskStatusSync) return;

    const taskNote = await this.findTaskNoteByTaskId(app, taskId, settings);
    if (!taskNote) return;

    const newStatus = this.checkboxToStatus(newMarker, settings);
    const content = await app.vault.read(taskNote);
    const currentStatus = this.extractFrontmatterField(content, 'status');

    if (currentStatus === newStatus) {
      // No change needed
      return;
    }

    const updated = this.updateFrontmatterField(content, 'status', newStatus);
    if (updated !== content) {
      await app.vault.modify(taskNote, updated);
    }
  },

  /**
   * Extract all tasks with IDs from a daily note and sync their status to task notes
   * Called when daily note is modified (debounced)
   */
  async syncAllStatusesToTaskNotes(app, file, settings) {
    if (!settings.enableTaskStatusSync) return;

    const content = await app.vault.read(file);
    const lines = content.split('\n');

    for (const line of lines) {
      const taskId = TaskUtils.extractId(line);
      if (!taskId) continue;

      // Skip calendar events
      if (TaskUtils.CALENDAR_EVENT_PATTERN.test(line)) continue;

      const marker = this.extractCheckboxMarker(line);
      if (marker) {
        await this.syncStatusToTaskNote(app, taskId, marker, settings);
      }
    }
  },

  async getSubtasksFromSource(app, sourceFilePath, parentTaskText) {
    if (!sourceFilePath) return [];
    const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
    if (!sourceFile || !(sourceFile instanceof obsidian.TFile)) return [];

    const content = await app.vault.read(sourceFile);
    const lines = content.split('\n');
    const subtasks = [];

    let parentLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = line.match(/^(\s*)- \[[ x]\]\s*(.+)$/);
      if (taskMatch) {
        const cleanedText = this.cleanTaskText(taskMatch[2]);
        if (cleanedText === parentTaskText) {
          parentLineIndex = i;
          break;
        }
      }
    }

    if (parentLineIndex === -1) return [];

    const parentIndent = lines[parentLineIndex].match(/^(\s*)/)[1].length;

    for (let i = parentLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = line.match(/^(\s*)- \[([ x])\]\s*(.+)$/);

      if (!taskMatch) {
        const indentMatch = line.match(/^(\s*)/);
        if (indentMatch && indentMatch[1].length <= parentIndent && line.trim() !== '') {
          break;
        }
        continue;
      }

      const currentIndent = taskMatch[1].length;
      if (currentIndent > parentIndent) {
        const isCompleted = taskMatch[2] === 'x';
        const taskText = this.cleanTaskText(taskMatch[3]);
        if (taskText) {
          subtasks.push({ text: taskText, completed: isCompleted, originalLine: line });
        }
      } else {
        break;
      }
    }

    return subtasks;
  },

  async syncSubtasksToTaskNote(app, taskNoteFile, sourceSubtasks, sourceFilePath) {
    const content = await app.vault.read(taskNoteFile);

    const currentSourceMatch = content.match(/sourceFile:\s*"([^"]+)"/);
    const currentSourceFile = currentSourceMatch ? currentSourceMatch[1] : null;
    const sourceFileChanged = sourceFilePath && currentSourceFile && currentSourceFile !== sourceFilePath;

    const subtasksMatch = content.match(/## Subtasks\n\n([\s\S]*?)(?=\n## |$)/);
    if (!subtasksMatch) return;

    const existingSubtasksSection = subtasksMatch[1];
    const existingSubtasks = [];
    const lines = existingSubtasksSection.split('\n');

    for (const line of lines) {
      const match = line.match(/^- \[([ x])\]\s*(.*)$/);
      if (match && match[2].trim()) {
        existingSubtasks.push({ text: match[2].trim(), completed: match[1] === 'x' });
      }
    }

    const mergedSubtasks = [...existingSubtasks];
    for (const srcTask of sourceSubtasks) {
      const exists = existingSubtasks.some(et => et.text.toLowerCase() === srcTask.text.toLowerCase());
      if (!exists) {
        mergedSubtasks.push(srcTask);
      }
    }

    const hasNewSubtasks = mergedSubtasks.length > existingSubtasks.length;
    const needsSourceFileUpdate = sourceFilePath && (!currentSourceFile || sourceFileChanged);

    if (hasNewSubtasks || needsSourceFileUpdate) {
      let finalContent = content;

      if (hasNewSubtasks) {
        const newSubtasksContent = mergedSubtasks
          .map(st => `- [${st.completed ? 'x' : ' '}] ${st.text}`)
          .join('\n');
        finalContent = finalContent.replace(
          /## Subtasks\n\n[\s\S]*?(?=\n## |$)/,
          `## Subtasks\n\n${newSubtasksContent}\n`
        );
      }

      if (needsSourceFileUpdate) {
        if (currentSourceFile) {
          finalContent = finalContent.replace(
            /sourceFile:\s*"[^"]*"/,
            `sourceFile: "${sourceFilePath}"`
          );
        } else {
          finalContent = finalContent.replace(
            /^---\n([\s\S]*?)---/,
            `---\n$1sourceFile: "${sourceFilePath}"\n---`
          );
        }
      }

      await app.vault.modify(taskNoteFile, finalContent);
      if (hasNewSubtasks) {
        new obsidian.Notice(`Synced ${sourceSubtasks.length} subtask(s) from source`);
      }
    }
  },

  async syncSubtasksBackToSource(app, taskNoteFile, isSyncing) {
    if (isSyncing) return false;

    const content = await app.vault.read(taskNoteFile);

    const sourceMatch = content.match(/sourceFile:\s*"([^"]+)"/);
    if (!sourceMatch || !sourceMatch[1]) return false;

    const sourceFilePath = sourceMatch[1];
    const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
    if (!sourceFile || !(sourceFile instanceof obsidian.TFile)) return false;

    const taskMatch = content.match(/task:\s*"?([^"\n]+)"?/);
    if (!taskMatch) return false;
    const parentTaskText = taskMatch[1].replace(/\\"/g, '"');

    const subtasksMatch = content.match(/## Subtasks\n\n([\s\S]*?)(?=\n## |$)/);
    if (!subtasksMatch) return false;

    const taskNoteSubtasks = [];
    const subtaskLines = subtasksMatch[1].split('\n');
    for (const line of subtaskLines) {
      const match = line.match(/^- \[([ x])\]\s*(.+)$/);
      if (match && match[2].trim()) {
        taskNoteSubtasks.push({ text: match[2].trim(), completed: match[1] === 'x' });
      }
    }

    if (taskNoteSubtasks.length === 0) return false;

    const sourceContent = await app.vault.read(sourceFile);
    const sourceLines = sourceContent.split('\n');

    let parentLineIndex = -1;
    let parentIndent = 0;
    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      const taskMatchLine = line.match(/^(\s*)- \[[ x]\]\s*(.+)$/);
      if (taskMatchLine) {
        const cleanedText = this.cleanTaskText(taskMatchLine[2]);
        if (cleanedText === parentTaskText) {
          parentLineIndex = i;
          parentIndent = taskMatchLine[1].length;
          break;
        }
      }
    }

    if (parentLineIndex === -1) return false;

    let subtaskEndIndex = parentLineIndex;
    for (let i = parentLineIndex + 1; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      const indentMatch = line.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1].length : 0;

      if (line.trim() === '') continue;

      if (currentIndent > parentIndent) {
        subtaskEndIndex = i;
      } else {
        break;
      }
    }

    const subtaskIndent = '\t';
    const newSubtaskLines = taskNoteSubtasks.map(st =>
      `${subtaskIndent}- [${st.completed ? 'x' : ' '}] ${st.text}`
    );

    const beforeParent = sourceLines.slice(0, parentLineIndex + 1);
    const afterSubtasks = sourceLines.slice(subtaskEndIndex + 1);

    const newSourceContent = [...beforeParent, ...newSubtaskLines, ...afterSubtasks].join('\n');

    if (newSourceContent !== sourceContent) {
      await app.vault.modify(sourceFile, newSourceContent);
      return true;
    }
    return false;
  },

  /**
   * Opens an existing task note or creates a new one.
   *
   * Task notes store expanded information about a task including:
   * - taskId: The unique identifier linking this note to the task in daily notes
   * - sourceFile: The daily note where the task currently lives (updated on schedule)
   * - Subtasks synced from the source file
   *
   * @param {App} app - Obsidian app instance
   * @param {Object} settings - Plugin settings
   * @param {string} taskText - The cleaned task text (used as filename)
   * @param {string} sourceFilePath - Path to the daily note containing this task
   * @param {string} taskId - Optional task ID (e.g., "t-abc123") for linking
   */
  async openOrCreateTaskNote(app, settings, taskText, sourceFilePath, taskId = null) {
    const sanitizedName = this.sanitizeFilename(taskText);
    if (!sanitizedName) {
      new obsidian.Notice('Could not extract task name');
      return null;
    }

    const folderPath = settings.taskNotesFolder;
    const filePath = `${folderPath}/${sanitizedName}.md`;

    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await app.vault.createFolder(folderPath);
    }

    const subtasksFromSource = await this.getSubtasksFromSource(app, sourceFilePath, taskText);

    // Look up the checkbox marker from the source file for status sync
    let checkboxMarker = ' ';
    if (sourceFilePath && taskId) {
      const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
      if (sourceFile instanceof obsidian.TFile) {
        const sourceContent = await app.vault.read(sourceFile);
        const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
        const lines = sourceContent.split('\n');
        for (const line of lines) {
          if (idPattern.test(line)) {
            const marker = this.extractCheckboxMarker(line);
            if (marker) checkboxMarker = marker;
            break;
          }
        }
      }
    }
    const status = this.checkboxToStatus(checkboxMarker, settings);

    let file = app.vault.getAbstractFileByPath(filePath);
    const isNewFile = !file;

    if (!file) {
      const subtasksContent = subtasksFromSource.length > 0
        ? subtasksFromSource.map(st => `- [${st.completed ? 'x' : ' '}] ${st.text}`).join('\n')
        : '- [ ] ';

      const sourceLink = sourceFilePath ? `[[${sourceFilePath.replace(/\.md$/, '')}]]` : '';

      // Task note frontmatter includes taskId for future reference/lookup
      // Even if we update sourceFile on schedule, taskId provides a fallback
      // to find the task across the vault if needed
      const content = `---
task: "${taskText.replace(/"/g, '\\"')}"
taskId: "${taskId || ''}"
status: "${status}"
created: ${new Date().toISOString().split('T')[0]}
sourceFile: "${sourceFilePath || ''}"
---

# ${taskText}

**Source:** ${sourceLink}

---

## Status
\`BUTTON[btn-incomplete, btn-progress, btn-cancelled, btn-complete]\`

## Notes


## Subtasks

${subtasksContent}

## References


---
> [!meta]- Button Definitions
> \`\`\`meta-bind-button
> label: "○ Incomplete"
> style: primary
> id: btn-incomplete
> hidden: true
> action:
>   type: command
>   command: task-manager:set-status-incomplete
> \`\`\`
>
> \`\`\`meta-bind-button
> label: "◐ In Progress"
> style: default
> id: btn-progress
> hidden: true
> action:
>   type: command
>   command: task-manager:set-status-in-progress
> \`\`\`
>
> \`\`\`meta-bind-button
> label: "✕ Cancelled"
> style: default
> id: btn-cancelled
> hidden: true
> action:
>   type: command
>   command: task-manager:set-status-cancelled
> \`\`\`
>
> \`\`\`meta-bind-button
> label: "✓ Complete"
> style: default
> id: btn-complete
> hidden: true
> action:
>   type: command
>   command: task-manager:set-status-complete
> \`\`\`
`;
      file = await app.vault.create(filePath, content);
      new obsidian.Notice(`Created: ${sanitizedName}`);
    } else if (file instanceof obsidian.TFile) {
      await this.syncSubtasksToTaskNote(app, file, subtasksFromSource, sourceFilePath);
    }

    if (file instanceof obsidian.TFile) {
      await app.workspace.getLeaf().openFile(file);
    }

    return file;
  },

  // ============================================================================
  // TASK NOTE SOURCE SYNCHRONIZATION
  // ============================================================================
  //
  // WHY THIS EXISTS:
  // ----------------
  // When a task is scheduled from one day to another (e.g., from 2026-01-22 to
  // 2026-01-24), the task physically moves to a new daily note file. However,
  // if that task has a Task Note (a dedicated note file for expanded task info),
  // the Task Note's "sourceFile" metadata would still point to the OLD date.
  //
  // This creates a broken link: clicking "Source" in the Task Note would take
  // you to the wrong day.
  //
  // THE SOLUTION:
  // -------------
  // When scheduling a task, we also update its Task Note (if one exists) to
  // point to the NEW daily note. This keeps the Task Note's sourceFile in sync
  // with where the task actually lives.
  //
  // HOW IT WORKS:
  // 1. User schedules task from today (2026-01-22) to future (2026-01-24)
  // 2. TaskScheduler copies task to 2026-01-24 with [< 2026-01-22] tag
  // 3. TaskScheduler marks original with [>] and [> 2026-01-24] tag
  // 4. TaskScheduler calls updateTaskNoteSourceFile()
  // 5. We find the Task Note by the task's text (filename match)
  // 6. We update both YAML frontmatter and the **Source:** link in the body
  //
  // FALLBACK:
  // ---------
  // The Task Note also stores "taskId" in frontmatter. If sourceFile ever gets
  // out of sync (manual moves, etc.), a future enhancement could search by
  // taskId to find the task's current location.
  // ============================================================================

  /**
   * Updates a Task Note when a task is scheduled to a new date.
   * Called by TaskScheduler.scheduleTask() after moving a task.
   *
   * Updates three things in the Task Note:
   * - sourceFile: The daily note path where the active task copy lives
   * - scheduled: The date (YYYY-MM-DD) the task is currently scheduled for
   * - **Source:** link in the body
   *
   * @param {App} app - Obsidian app instance
   * @param {Object} settings - Plugin settings (needs taskNotesFolder)
   * @param {string} taskText - The task text (used to find the Task Note)
   * @param {string} newSourcePath - Full path like "00 - Daily/2026-01-24.md"
   * @param {string} scheduledDate - The target date in YYYY-MM-DD format
   * @returns {Promise<boolean>} True if Task Note was found and updated
   */
  async updateTaskNoteSourceFile(app, settings, taskText, newSourcePath, scheduledDate) {
    // Find the Task Note by sanitized task name
    const sanitizedName = this.sanitizeFilename(taskText);
    if (!sanitizedName) return false;

    const filePath = `${settings.taskNotesFolder}/${sanitizedName}.md`;
    const file = app.vault.getAbstractFileByPath(filePath);

    // No Task Note exists for this task - that's fine, not all tasks have notes
    if (!file || !(file instanceof obsidian.TFile)) {
      return false;
    }

    let content = await app.vault.read(file);
    let modified = false;

    // Update YAML frontmatter: sourceFile: "old/path.md" → sourceFile: "new/path.md"
    // Note: We use replace() directly instead of test() + replace() to avoid
    // regex lastIndex issues. Replace returns the original string if no match.
    const sourceFileRegex = /^(sourceFile:\s*")([^"]*)(")$/m;
    const newFrontmatterContent = content.replace(sourceFileRegex, `$1${newSourcePath}$3`);
    if (newFrontmatterContent !== content) {
      content = newFrontmatterContent;
      modified = true;
    }

    // Update or add scheduled field in frontmatter
    // This tracks which date the task is currently scheduled for
    const scheduledRegex = /^(scheduled:\s*)(\S+)$/m;
    if (scheduledRegex.test(content)) {
      // Update existing scheduled field
      const newScheduledContent = content.replace(scheduledRegex, `$1${scheduledDate}`);
      if (newScheduledContent !== content) {
        content = newScheduledContent;
        modified = true;
      }
    } else {
      // Add scheduled field after sourceFile (or at end of frontmatter if sourceFile missing)
      const insertAfterSourceFile = content.replace(
        /^(sourceFile:\s*"[^"]*")$/m,
        `$1\nscheduled: ${scheduledDate}`
      );
      if (insertAfterSourceFile !== content) {
        content = insertAfterSourceFile;
        modified = true;
      } else {
        // sourceFile not found, insert before closing ---
        content = content.replace(/^(---)$/m, `scheduled: ${scheduledDate}\n$1`);
        modified = true;
      }
    }

    // Update body link: **Source:** [[old/path]] → **Source:** [[new/path]]
    const newLink = `[[${newSourcePath.replace(/\.md$/, '')}]]`;
    const sourceLinkRegex = /^(\*\*Source:\*\*\s*)\[\[[^\]]+\]\]/m;
    const newBodyContent = content.replace(sourceLinkRegex, `$1${newLink}`);
    if (newBodyContent !== content) {
      content = newBodyContent;
      modified = true;
    }

    if (modified) {
      await app.vault.modify(file, content);
      return true;
    }

    return false;
  }
};

// ============================================================================
// EVENT NOTE MANAGER MODULE
// ============================================================================
// Creates and manages notes for calendar events, similar to Task Notes.
// When clicking a calendar event's "notes" button, creates a note with
// the event's UID in frontmatter for tracking/linking purposes.
// ============================================================================

const EventNoteManager = {
  /**
   * Sanitize event title for use as filename
   */
  sanitizeFilename(text) {
    if (!text) return null;
    // Remove time range at start (e.g., "10:00 - 15:00")
    let cleaned = text.replace(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '');
    // Remove URLs
    cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
    // Remove special characters that are problematic in filenames
    cleaned = cleaned.replace(/[<>:"/\\|?*]/g, '');
    // Trim whitespace and limit length
    cleaned = cleaned.trim().substring(0, 100);
    return cleaned || null;
  },

  /**
   * Extract event title from a calendar event line
   * e.g., "- [c] 10:00 - 15:00 Meeting Name https://... [uid::xxx]"
   * Returns: "Meeting Name"
   */
  extractEventTitle(line) {
    // Remove the checkbox prefix
    let text = line.replace(/^[\t]*- \[c\]\s*/, '');
    // Remove time range
    text = text.replace(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '');
    // Remove uid metadata
    text = text.replace(/\s*\[uid::[^\]]+\]/g, '');
    // Remove calendar metadata
    text = text.replace(/\s*\[calendar::[^\]]+\]/g, '');
    // Remove URLs but keep text before them
    text = text.replace(/\s*https?:\/\/[^\s]+/g, '');
    return text.trim();
  },

  /**
   * Extract time range from calendar event line
   * Returns object { start: "HH:MM", end: "HH:MM" } or null
   */
  extractTimeRange(line) {
    const match = line.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    if (match) {
      return { start: match[1], end: match[2] };
    }
    return null;
  },

  /**
   * Open or create an event note for a calendar event
   * @param {App} app - Obsidian app instance
   * @param {Object} settings - Plugin settings
   * @param {string} eventTitle - The event title (used as filename)
   * @param {string} uid - The calendar event UID
   * @param {string} sourceFilePath - Path to the daily note containing this event
   * @param {string} timeRange - Optional time range string
   * @param {string} calendarSource - Optional calendar source name (e.g., "Work", "Fastmail")
   */
  async openOrCreateEventNote(app, settings, eventTitle, uid, sourceFilePath, timeRange = null, calendarSource = null) {
    const sanitizedName = this.sanitizeFilename(eventTitle);
    if (!sanitizedName) {
      new obsidian.Notice('Could not extract event name');
      return null;
    }

    const folderPath = settings.eventNotesFolder;
    const filePath = `${folderPath}/${sanitizedName}.md`;

    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await app.vault.createFolder(folderPath);
    }

    let file = app.vault.getAbstractFileByPath(filePath);

    if (!file) {
      const sourceLink = sourceFilePath ? `[[${sourceFilePath.replace(/\.md$/, '')}]]` : '';
      const timeInfo = timeRange ? `${timeRange.start} - ${timeRange.end}` : '';
      const dateFromSource = sourceFilePath ? sourceFilePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1] : new Date().toISOString().split('T')[0];

      // Event note frontmatter includes eventUID for tracking
      const content = `---
event: "${eventTitle.replace(/"/g, '\\"')}"
eventUID: "${uid || ''}"
calendar: "${calendarSource || ''}"
date: ${dateFromSource}
time: "${timeInfo}"
created: ${new Date().toISOString().split('T')[0]}
sourceFile: "${sourceFilePath || ''}"
---

# ${eventTitle}

**Date:** ${dateFromSource}${timeInfo ? `  |  **Time:** ${timeInfo}` : ''}
**Source:** ${sourceLink}

---

## Agenda


## Notes


## Action Items

- [ ]

## Follow-ups


`;
      file = await app.vault.create(filePath, content);
      new obsidian.Notice(`Created: ${sanitizedName}`);
    }

    if (file instanceof obsidian.TFile) {
      await app.workspace.getLeaf().openFile(file);
    }

    return file;
  }
};

// ============================================================================
// TASK SCHEDULER MODULE
// ============================================================================

const TaskScheduler = {
  // Remove existing scheduling tags from a line
  removeSchedulingTags(line) {
    return line
      .replace(/\s*\[<\s*\d{4}-\d{2}-\d{2}\]/g, '')
      .replace(/\s*\[>\s*\d{4}-\d{2}-\d{2}\]/g, '')
      // Legacy format cleanup
      .replace(/\s*\[sch_from::[^\]]+\]/g, '')
      .replace(/\s*\[sch_to::[^\]]+\]/g, '')
      .replace(/\s*📅\s*\[\[[^\]]+\]\]/g, '')
      .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '');
  },

  // Get current date in YYYY-MM-DD format
  getCurrentDate() {
    return new Date().toISOString().split('T')[0];
  },

  // Get the daily note path for a given date
  getDailyNotePath(date, settings) {
    // Use the first target folder as the daily notes folder
    const dailyFolder = settings.targetFolders[0] || '00 - Daily/';
    const folder = dailyFolder.replace(/\/$/, '');
    return `${folder}/${date}.md`;
  },

  // Create the scheduled copy of a task (for the target date)
  createScheduledTaskCopy(line, fromDate) {
    // Remove the [>] marker and restore to [ ] for the copy
    let taskCopy = line.replace(/^([\t]*- \[)[^\]](\])/, '$1 $2');
    // Remove any existing scheduling tags and calendar icons
    taskCopy = this.removeSchedulingTags(taskCopy);
    // Keep the task ID (same task, different date)
    // Remove parent tags (will be re-linked if needed)
    taskCopy = taskCopy.replace(/\s*\[parent::\s*[^\]]+\]/g, '');
    // Add sch_from tag: [< YYYY-MM-DD]
    taskCopy = taskCopy.trimEnd() + ` [< ${fromDate}]`;
    return taskCopy;
  },

  // Mark the original task as scheduled
  markTaskAsScheduled(line, toDate) {
    // Change marker to [>]
    let newLine = line.replace(/^([\t]*- \[)[^\]](\])/, '$1>$2');
    // Remove time block (e.g., "13:45 - 15:15 " at start of task text)
    newLine = newLine.replace(/^([\t]*- \[.\]\s*)\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*/, '$1');
    // Remove any existing scheduling tags
    newLine = this.removeSchedulingTags(newLine);
    // Add sch_to tag: [> YYYY-MM-DD]
    newLine = newLine.trimEnd() + ` [> ${toDate}]`;
    return newLine;
  },

  // Extract target date from [> YYYY-MM-DD] tag
  extractScheduledToDate(line) {
    const match = line.match(/\[>\s*(\d{4}-\d{2}-\d{2})\]/);
    return match ? match[1] : null;
  },

  // Check if a task is scheduled away (has [>] checkbox)
  isScheduledAway(line) {
    return /^[\t]*- \[>\]/.test(line);
  },

  // Reset a scheduled task back to actionable state
  // Changes [>] to [ ] and removes scheduling tags
  resetScheduledTask(line) {
    // Change [>] marker back to [ ]
    let newLine = line.replace(/^([\t]*- \[)>(\])/, '$1 $2');
    // Remove all scheduling tags
    newLine = this.removeSchedulingTags(newLine);
    return newLine;
  },

  // ============================================================================
  // SCHEDULE TASK TO TARGET DATE
  // ============================================================================
  //
  // This is the main scheduling function. When a user schedules a task:
  //
  // 1. ORIGINAL TASK (current daily note):
  //    - Marker changes from [ ] to [>] (indicating "scheduled away")
  //    - Time block is removed (task no longer occupies time today)
  //    - Tag [> YYYY-MM-DD] is added showing where it went
  //
  // 2. TASK AT TARGET (target daily note):
  //    - If task (by ID) already exists there: UPDATE its [< DATE] tag
  //    - If task doesn't exist there: APPEND new copy with [< DATE] tag
  //    - The [< DATE] tag always shows the MOST RECENT source (where it came from)
  //
  // 3. TASK NOTE (if exists):
  //    - sourceFile updated to point to the TARGET daily note
  //    - Because the "active" copy of the task now lives there
  //
  // EDGE CASE: Scheduling back to a previous date
  // ----------------------------------------------
  // If you schedule a task 1/23 → 1/24 → 1/30 → 1/23, the task on 1/23 should:
  // - NOT create a duplicate (same task ID already exists)
  // - UPDATE the existing task's [< DATE] tag to show 1/30 (most recent source)
  // - The old [>] marker on 1/23 gets updated to the new destination
  //
  // ============================================================================

  async scheduleTask(app, settings, editor, lineNum, targetDate) {
    // Re-read the line fresh (it may have changed since modal opened)
    const line = editor.getLine(lineNum);
    if (!TaskUtils.isTask(line)) {
      new obsidian.Notice('Not a task line');
      return false;
    }

    // Check if already scheduled to this date
    if (line.includes(`[> ${targetDate}]`)) {
      new obsidian.Notice('Task already scheduled to this date');
      return false;
    }

    // Get the current file's date as the "from" date
    // This is the date we're scheduling FROM, not necessarily today's calendar date
    const activeFile = app.workspace.getActiveFile();
    const fromDate = activeFile ? activeFile.basename : this.getCurrentDate();

    const targetPath = this.getDailyNotePath(targetDate, settings);

    // Get or create the target daily note
    let targetFile = app.vault.getAbstractFileByPath(targetPath);

    if (!targetFile) {
      // Create the daily note if it doesn't exist
      const folder = targetPath.substring(0, targetPath.lastIndexOf('/'));
      const folderExists = app.vault.getAbstractFileByPath(folder);
      if (!folderExists) {
        await app.vault.createFolder(folder);
      }
      // Create empty daily note
      targetFile = await app.vault.create(targetPath, '');
      new obsidian.Notice(`Created daily note: ${targetDate}`);
    }

    if (!(targetFile instanceof obsidian.TFile)) {
      new obsidian.Notice('Target is not a file');
      return false;
    }

    // Extract task ID to check for existing copy in target
    const taskId = TaskUtils.extractId(line);

    // Read target file content
    let targetContent = await app.vault.read(targetFile);

    // Check if this task (by ID) already exists in the target file
    let taskExistsInTarget = false;
    if (taskId) {
      const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
      taskExistsInTarget = idPattern.test(targetContent);
    }

    if (taskExistsInTarget) {
      // -----------------------------------------------------------------------
      // TASK ALREADY EXISTS IN TARGET - Update its [< DATE] tag
      // -----------------------------------------------------------------------
      // This handles the case where a task bounces back to a previous date.
      // We update the existing task's "scheduled from" tag to show the most
      // recent source, and reset its marker from [>] to [ ] if needed.
      // -----------------------------------------------------------------------
      const lines = targetContent.split('\n');
      const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);

      for (let i = 0; i < lines.length; i++) {
        if (idPattern.test(lines[i])) {
          let updatedLine = lines[i];
          // Reset marker to [ ] (it's now the active copy)
          updatedLine = updatedLine.replace(/^([\t]*- \[)[^\]](\])/, '$1 $2');
          // Remove old scheduling tags
          updatedLine = this.removeSchedulingTags(updatedLine);
          // Add new [< fromDate] tag
          updatedLine = updatedLine.trimEnd() + ` [< ${fromDate}]`;
          lines[i] = updatedLine;
          break;
        }
      }
      targetContent = lines.join('\n');
    } else {
      // -----------------------------------------------------------------------
      // TASK DOESN'T EXIST IN TARGET - Append new copy
      // -----------------------------------------------------------------------
      const taskCopy = this.createScheduledTaskCopy(line, fromDate);
      targetContent = targetContent.trimEnd() + '\n' + taskCopy;
    }

    // Write updated target file
    await app.vault.modify(targetFile, targetContent);

    // Mark the original task as scheduled (update in place)
    const updatedLine = this.markTaskAsScheduled(line, targetDate);
    editor.setLine(lineNum, updatedLine);

    // -----------------------------------------------------------------------
    // MARK SUBTASKS AS SCHEDULED TOO
    // -----------------------------------------------------------------------
    // When a parent task is scheduled away, its subtasks should also show [>]
    // so they don't appear as orphaned incomplete tasks
    // -----------------------------------------------------------------------
    const totalLines = editor.lineCount();
    for (let i = lineNum + 1; i < totalLines; i++) {
      const subtaskLine = editor.getLine(i);
      if (TaskUtils.isSubtask(subtaskLine)) {
        // Mark subtask as scheduled (change [ ] to [>])
        const updatedSubtask = subtaskLine.replace(/^([\t]*- \[)[^\]](\])/, '$1>$2');
        if (updatedSubtask !== subtaskLine) {
          editor.setLine(i, updatedSubtask);
        }
      } else {
        // Stop at first non-subtask line
        break;
      }
    }

    // -----------------------------------------------------------------------
    // UPDATE TASK NOTE (if one exists for this task)
    // -----------------------------------------------------------------------
    const taskText = TaskNoteManager.extractTaskTextFromLine(line);
    if (taskText) {
      await TaskNoteManager.updateTaskNoteSourceFile(
        app,
        settings,
        taskText,
        targetPath,
        targetDate  // Pass the scheduled date for the scheduled field
      );
    }

    new obsidian.Notice(`Task scheduled to ${targetDate}`);
    return true;
  },

  // ============================================================================
  // UNSCHEDULE TASK - Reverse a scheduling operation
  // ============================================================================
  //
  // When user runs "Unschedule task" on a scheduled task (has [>] checkbox):
  //
  // 1. CURRENT TASK:
  //    - Marker changes from [>] back to [ ]
  //    - Remove [> TARGET_DATE] and [< FROM_DATE] tags
  //    - Subtasks also reset from [>] to [ ]
  //
  // 2. TARGET FILE:
  //    - Find and delete the task (by ID) and its subtasks from target file
  //    - If task doesn't exist in target, just clean up current task
  //
  // 3. TASK NOTE (if exists):
  //    - Update sourceFile to point to current file
  //    - Update scheduled field to current date
  //
  // ============================================================================

  async unscheduleTask(app, settings, editor, lineNum) {
    const line = editor.getLine(lineNum);

    // Validate: must be a task
    if (!TaskUtils.isTask(line)) {
      new obsidian.Notice('Not a task line');
      return false;
    }

    // Validate: must be scheduled away (has [>] marker or [> DATE] tag)
    const targetDate = this.extractScheduledToDate(line);
    const hasScheduledMarker = this.isScheduledAway(line);

    if (!targetDate && !hasScheduledMarker) {
      new obsidian.Notice('Task is not scheduled');
      return false;
    }

    const taskId = TaskUtils.extractId(line);
    const activeFile = app.workspace.getActiveFile();
    const currentFilePath = activeFile ? activeFile.path : null;
    const currentDate = activeFile ? activeFile.basename : this.getCurrentDate();

    // -----------------------------------------------------------------------
    // STEP 1: Reset the current task
    // -----------------------------------------------------------------------
    const updatedLine = this.resetScheduledTask(line);
    editor.setLine(lineNum, updatedLine);

    // -----------------------------------------------------------------------
    // STEP 2: Reset subtasks (change [>] back to [ ])
    // -----------------------------------------------------------------------
    const totalLines = editor.lineCount();
    for (let i = lineNum + 1; i < totalLines; i++) {
      const subtaskLine = editor.getLine(i);
      if (TaskUtils.isSubtask(subtaskLine)) {
        // Reset subtask marker from [>] to [ ]
        const resetSubtask = subtaskLine.replace(/^([\t]*- \[)>(\])/, '$1 $2');
        if (resetSubtask !== subtaskLine) {
          editor.setLine(i, resetSubtask);
        }
      } else {
        // Stop at first non-subtask line
        break;
      }
    }

    // -----------------------------------------------------------------------
    // STEP 3: Delete the scheduled copy from target file (if targetDate exists)
    // -----------------------------------------------------------------------
    if (targetDate && taskId) {
      const targetPath = this.getDailyNotePath(targetDate, settings);
      const targetFile = app.vault.getAbstractFileByPath(targetPath);

      if (targetFile && targetFile instanceof obsidian.TFile) {
        let targetContent = await app.vault.read(targetFile);
        const lines = targetContent.split('\n');
        const idPattern = new RegExp(`\\[id::\\s*${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);

        // Find the task line index
        let taskLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          if (idPattern.test(lines[i])) {
            taskLineIndex = i;
            break;
          }
        }

        if (taskLineIndex !== -1) {
          // Count how many lines to remove (task + its subtasks)
          let linesToRemove = 1;
          for (let i = taskLineIndex + 1; i < lines.length; i++) {
            if (TaskUtils.isSubtask(lines[i])) {
              linesToRemove++;
            } else {
              break;
            }
          }

          // Remove the task and its subtasks
          lines.splice(taskLineIndex, linesToRemove);

          // Clean up: collapse consecutive blank lines
          targetContent = lines.join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();

          await app.vault.modify(targetFile, targetContent);
        }
      }
    }

    // -----------------------------------------------------------------------
    // STEP 4: Update task note (if exists)
    // -----------------------------------------------------------------------
    const taskText = TaskNoteManager.extractTaskTextFromLine(line);
    if (taskText && currentFilePath) {
      await this.updateTaskNoteForUnschedule(
        app,
        settings,
        taskText,
        currentFilePath,
        currentDate
      );
    }

    new obsidian.Notice('Task unscheduled');
    return true;
  },

  // Update task note when unscheduling - point sourceFile back to current file
  async updateTaskNoteForUnschedule(app, settings, taskText, currentFilePath, currentDate) {
    const sanitizedName = TaskNoteManager.sanitizeFilename(taskText);
    if (!sanitizedName) return false;

    const filePath = `${settings.taskNotesFolder}/${sanitizedName}.md`;
    const file = app.vault.getAbstractFileByPath(filePath);

    if (!file || !(file instanceof obsidian.TFile)) {
      return false;
    }

    let content = await app.vault.read(file);
    let modified = false;

    // Update sourceFile to point to current file
    const sourceFileRegex = /^(sourceFile:\s*")([^"]*)(")$/m;
    const newContent = content.replace(sourceFileRegex, `$1${currentFilePath}$3`);
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }

    // Update scheduled field to current date
    const scheduledRegex = /^(scheduled:\s*)(\S+)$/m;
    if (scheduledRegex.test(content)) {
      const newScheduledContent = content.replace(scheduledRegex, `$1${currentDate}`);
      if (newScheduledContent !== content) {
        content = newScheduledContent;
        modified = true;
      }
    }

    // Update body link
    const newLink = `[[${currentFilePath.replace(/\.md$/, '')}]]`;
    const sourceLinkRegex = /^(\*\*Source:\*\*\s*)\[\[[^\]]+\]\]/m;
    const newBodyContent = content.replace(sourceLinkRegex, `$1${newLink}`);
    if (newBodyContent !== content) {
      content = newBodyContent;
      modified = true;
    }

    if (modified) {
      await app.vault.modify(file, content);
      return true;
    }

    return false;
  }
};

// ============================================================================
// BULK SCHEDULER MODULE - Schedule all overdue tasks
// ============================================================================

const BulkScheduler = {
  // Pattern for incomplete tasks (not completed, cancelled, scheduled, or in-progress)
  INCOMPLETE_TASK_PATTERN: /^[\t]*- \[ \]/,

  // Check if a task is incomplete (actionable)
  isIncompleteTask(line) {
    return this.INCOMPLETE_TASK_PATTERN.test(line);
  },

  // Parse date from daily note filename (YYYY-MM-DD.md)
  parseDateFromFilename(filename) {
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  },

  // Get all daily note files from target folders
  async getDailyNoteFiles(app, settings) {
    const files = [];
    const targetFolders = settings.targetFolders || ['00 - Daily/'];

    for (const folder of targetFolders) {
      const folderPath = folder.replace(/\/$/, '');
      const abstractFolder = app.vault.getAbstractFileByPath(folderPath);
      if (!abstractFolder) continue;

      // Get all markdown files in the folder
      const allFiles = app.vault.getMarkdownFiles();
      for (const file of allFiles) {
        if (file.path.startsWith(folderPath + '/') && file.path.endsWith('.md')) {
          const date = this.parseDateFromFilename(file.basename);
          if (date) {
            files.push({ file, date, basename: file.basename });
          }
        }
      }
    }

    return files;
  },

  // Find all overdue incomplete tasks across daily notes before targetDate
  async findOverdueTasks(app, settings, targetDate) {
    const dailyNotes = await this.getDailyNoteFiles(app, settings);
    const overdueTasks = [];

    // Filter to notes before target date
    const targetTime = targetDate.getTime();

    for (const { file, date, basename } of dailyNotes) {
      // Skip notes on or after target date
      if (date.getTime() >= targetTime) continue;

      // Read file content
      const content = await app.vault.read(file);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Find incomplete tasks ([ ]) - not completed [x], not cancelled [-], not scheduled [>], not in-progress [/]
        if (this.isIncompleteTask(line) && !TaskUtils.isCalendarEvent(line)) {
          overdueTasks.push({
            file,
            fileDate: basename,
            line,
            lineNum: i,
            taskId: TaskUtils.extractId(line)
          });
        }
      }
    }

    return overdueTasks;
  },

  // Schedule all overdue tasks to a target date
  async scheduleAllOverdueTo(app, settings, targetDate) {
    const targetDateStr = targetDate.toISOString().split('T')[0];
    const overdueTasks = await this.findOverdueTasks(app, settings, targetDate);

    if (overdueTasks.length === 0) {
      new obsidian.Notice('No overdue tasks found');
      return 0;
    }

    let scheduledCount = 0;

    // Group tasks by source file to batch file modifications
    const tasksByFile = new Map();
    for (const task of overdueTasks) {
      if (!tasksByFile.has(task.file.path)) {
        tasksByFile.set(task.file.path, []);
      }
      tasksByFile.get(task.file.path).push(task);
    }

    // Get or create the target daily note
    const targetPath = TaskScheduler.getDailyNotePath(targetDateStr, settings);
    let targetFile = app.vault.getAbstractFileByPath(targetPath);

    if (!targetFile) {
      // Create the daily note if it doesn't exist
      const folder = targetPath.substring(0, targetPath.lastIndexOf('/'));
      const folderExists = app.vault.getAbstractFileByPath(folder);
      if (!folderExists) {
        await app.vault.createFolder(folder);
      }
      targetFile = await app.vault.create(targetPath, '');
    }

    if (!(targetFile instanceof obsidian.TFile)) {
      new obsidian.Notice('Could not access target daily note');
      return 0;
    }

    // Read target file content
    let targetContent = await app.vault.read(targetFile);

    // Process each source file
    for (const [filePath, tasks] of tasksByFile) {
      const sourceFile = app.vault.getAbstractFileByPath(filePath);
      if (!sourceFile || !(sourceFile instanceof obsidian.TFile)) continue;

      let sourceContent = await app.vault.read(sourceFile);
      const sourceLines = sourceContent.split('\n');
      const fromDate = sourceFile.basename;

      // Process tasks in reverse order to maintain line numbers
      const sortedTasks = tasks.sort((a, b) => b.lineNum - a.lineNum);

      for (const task of sortedTasks) {
        const line = sourceLines[task.lineNum];
        if (!line || !this.isIncompleteTask(line)) continue;

        const taskId = TaskUtils.extractId(line);

        // Check if task already exists in target (by ID)
        let taskExistsInTarget = false;
        if (taskId) {
          const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
          taskExistsInTarget = idPattern.test(targetContent);
        }

        if (taskExistsInTarget) {
          // Update existing task in target - reset marker and update from-date
          const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
          const targetLines = targetContent.split('\n');

          for (let i = 0; i < targetLines.length; i++) {
            if (idPattern.test(targetLines[i])) {
              let updatedLine = targetLines[i];
              // Reset marker to [ ]
              updatedLine = updatedLine.replace(/^([\t]*- \[)[^\]](\])/, '$1 $2');
              // Remove old scheduling tags
              updatedLine = TaskScheduler.removeSchedulingTags(updatedLine);
              // Add new [< fromDate] tag
              updatedLine = updatedLine.trimEnd() + ` [< ${fromDate}]`;
              targetLines[i] = updatedLine;
              break;
            }
          }
          targetContent = targetLines.join('\n');
        } else {
          // Append new copy to target
          const taskCopy = TaskScheduler.createScheduledTaskCopy(line, fromDate);
          targetContent = targetContent.trimEnd() + '\n' + taskCopy;
        }

        // Mark original as scheduled
        sourceLines[task.lineNum] = TaskScheduler.markTaskAsScheduled(line, targetDateStr);
        scheduledCount++;

        // Update task note if exists
        const taskText = TaskNoteManager.extractTaskTextFromLine(line);
        if (taskText) {
          await TaskNoteManager.updateTaskNoteSourceFile(
            app,
            settings,
            taskText,
            targetPath,
            targetDateStr
          );
        }
      }

      // Write updated source file
      sourceContent = sourceLines.join('\n');
      await app.vault.modify(sourceFile, sourceContent);
    }

    // Write updated target file
    await app.vault.modify(targetFile, targetContent);

    new obsidian.Notice(`Scheduled ${scheduledCount} overdue task(s) to ${targetDateStr}`);
    return scheduledCount;
  }
};

// ============================================================================
// SCHEDULE DATE OPTIONS
// ============================================================================

const ScheduleDateUtils = {
  formatDate(date) {
    return date.toISOString().split('T')[0];
  },

  getTomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return this.formatDate(d);
  },

  getDayAfterTomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return this.formatDate(d);
  },

  getNextMonday() {
    const d = new Date();
    const dayOfWeek = d.getDay();
    // Days until next Monday: if today is Monday (1), go to next week's Monday (7 days)
    // Otherwise calculate days remaining
    const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
    d.setDate(d.getDate() + daysUntilMonday);
    return this.formatDate(d);
  },

  getOneWeekFromNow() {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return this.formatDate(d);
  },

  // Parse and normalize date input (YYYYMMDD or YYYY-MM-DD)
  parseCustomDate(input) {
    if (!input) return null;
    const cleaned = input.trim();

    // Try YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
      return cleaned;
    }

    // Try YYYYMMDD format
    if (/^\d{8}$/.test(cleaned)) {
      return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
    }

    return null;
  }
};

const SCHEDULE_DATE_OPTIONS = [
  { id: 'tomorrow', label: 'Tomorrow', getDate: () => ScheduleDateUtils.getTomorrow() },
  { id: 'day-after', label: 'Day After Tomorrow', getDate: () => ScheduleDateUtils.getDayAfterTomorrow() },
  { id: 'next-monday', label: 'Next Monday', getDate: () => ScheduleDateUtils.getNextMonday() },
  { id: 'one-week', label: 'In One Week', getDate: () => ScheduleDateUtils.getOneWeekFromNow() },
  { id: 'custom', label: 'Enter a date...', isCustom: true }
];

// ============================================================================
// SHARED ICONS (Font Awesome)
// ============================================================================

const Icons = {
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"/></svg>',
  halfCircle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M448 256c0-106-86-192-192-192V448c106 0 192-86 192-192zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  ban: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  anglesRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M470.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L402.7 256 265.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160zm-352 160l160-160c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L210.7 256 73.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0z"/></svg>',
  // file-lines (solid) - document with lines icon
  fileLines: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d="M64 0C28.7 0 0 28.7 0 64V448c0 35.3 28.7 64 64 64H320c35.3 0 64-28.7 64-64V160H256c-17.7 0-32-14.3-32-32V0H64zM256 0V128H384L256 0zM112 256H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/></svg>',
  // clock (regular) - time/clock icon
  clock: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M464 256A208 208 0 1 1 48 256a208 208 0 1 1 416 0zM0 256a256 256 0 1 0 512 0A256 256 0 1 0 0 256zM232 120V256c0 8 4 15.5 10.7 20l96 64c11 7.4 25.9 4.4 33.3-6.7s4.4-25.9-6.7-33.3L280 243.2V120c0-13.3-10.7-24-24-24s-24 10.7-24 24z"/></svg>',
  // circle-right (solid) - schedule/forward icon
  circleRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M0 256a256 256 0 1 0 512 0A256 256 0 1 0 0 256zM294.6 135.1l99.9 107.1c3.5 3.8 5.5 8.7 5.5 13.8s-2 10.1-5.5 13.8L294.6 376.9c-4.2 4.5-10.1 7.1-16.3 7.1C266 384 256 374 256 361.7l0-57.7-96 0c-17.7 0-32-14.3-32-32l0-32c0-17.7 14.3-32 32-32l96 0 0-57.7c0-12.3 10-22.3 22.3-22.3c6.2 0 12.1 2.6 16.3 7.1z"/></svg>'
};

// ============================================================================
// TIMEBLOCK UTILITIES
// ============================================================================

const TimeblockUtils = {
  // Extract existing timeblock from a task line (format: "HH:MM - HH:MM" at start)
  extractTimeblock(line) {
    const match = line.match(/^([\t]*- \[.\]\s*)(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s*/);
    if (match) {
      return {
        prefix: match[1],
        startHour: parseInt(match[2]),
        startMinute: parseInt(match[3]),
        endHour: parseInt(match[4]),
        endMinute: parseInt(match[5]),
        fullMatch: match[0]
      };
    }
    return null;
  },

  // Format time as HH:MM
  formatTime(hour, minute) {
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  },

  // Format time for display (e.g., "09 AM", "12 PM")
  formatDisplayTime(hour) {
    const pad = (n) => n.toString().padStart(2, '0');
    if (hour === 0) return '12 AM';
    if (hour === 12) return '12 PM';
    if (hour < 12) return `${pad(hour)} AM`;
    return `${pad(hour - 12)} PM`;
  },

  // Add timeblock to a task line
  addTimeblock(line, startHour, startMinute, endHour, endMinute) {
    const existing = this.extractTimeblock(line);
    const timeblock = `${this.formatTime(startHour, startMinute)} - ${this.formatTime(endHour, endMinute)} `;

    if (existing) {
      // Replace existing timeblock
      return line.replace(existing.fullMatch, existing.prefix + timeblock);
    } else {
      // Insert after the task marker "- [x] "
      return line.replace(/^([\t]*- \[.\]\s*)/, `$1${timeblock}`);
    }
  },

  // Remove timeblock from a task line
  removeTimeblock(line) {
    return line.replace(/^([\t]*- \[.\]\s*)\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '$1');
  },

  // Calculate default end time (start + 30 minutes)
  getDefaultEndTime(startHour, startMinute) {
    let endMinute = startMinute + 30;
    let endHour = startHour;
    if (endMinute >= 60) {
      endMinute -= 60;
      endHour = (endHour + 1) % 24;
    }
    return { hour: endHour, minute: endMinute };
  }
};

// ============================================================================
// TIME PICKER POPUP
// ============================================================================

class TimePickerPopup {
  constructor(plugin, editor, lineNum, mode, existingStart = null, onComplete = null) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.mode = mode; // 'start' or 'end'
    this.existingStart = existingStart; // { hour, minute } for end mode
    this.onComplete = onComplete; // Callback for chaining start->end
    this.selectedHour = null;
    this.expandedHour = null; // For mobile: tracks which hour row is expanded
    this.container = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  open() {
    this.container = document.createElement('div');
    this.container.className = 'timeblock-picker-popup';

    this.render();
    this.positionPopup();

    document.body.appendChild(this.container);

    document.addEventListener('keydown', this.handleKeyDown, true);
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
    }, 10);
  }

  close() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('click', this.handleClickOutside);
  }

  render() {
    this.container.empty();

    // Header
    const header = document.createElement('div');
    header.className = 'timeblock-picker-header';
    header.textContent = this.mode === 'start' ? 'Start' : 'End';
    this.container.appendChild(header);

    // If in end mode, show selected start time
    if (this.mode === 'end' && this.existingStart) {
      const startInfo = document.createElement('div');
      startInfo.className = 'timeblock-picker-start-info';
      startInfo.textContent = `Start: ${TimeblockUtils.formatTime(this.existingStart.hour, this.existingStart.minute)}`;
      this.container.appendChild(startInfo);
    }

    // Column container
    const columns = document.createElement('div');
    columns.className = 'timeblock-picker-columns';

    // DAY column (6 AM - 5 PM)
    const dayColumn = this.createColumn('DAY', 6, 17);
    columns.appendChild(dayColumn);

    // NIGHT column (6 PM - 5 AM)
    const nightColumn = this.createColumn('NIGHT', 18, 29); // 18-23 and 0-5
    columns.appendChild(nightColumn);

    this.container.appendChild(columns);
  }

  createColumn(title, startHour, endHour) {
    const column = document.createElement('div');
    column.className = 'timeblock-picker-column';

    const header = document.createElement('div');
    header.className = 'timeblock-picker-column-header';
    header.textContent = title;
    column.appendChild(header);

    for (let h = startHour; h <= endHour; h++) {
      const hour = h % 24;
      const row = this.createHourRow(hour);
      column.appendChild(row);
    }

    return column;
  }

  createHourRow(hour) {
    const row = document.createElement('div');
    row.className = 'timeblock-picker-row';

    // Check if this hour is expanded (for mobile click-to-expand)
    const isExpanded = this.expandedHour === hour;
    if (isExpanded) {
      row.addClass('is-expanded');
    }

    // Highlight suggested time in end mode
    let suggestedMinute = null;
    if (this.mode === 'end' && this.existingStart) {
      const defaultEnd = TimeblockUtils.getDefaultEndTime(this.existingStart.hour, this.existingStart.minute);
      if (hour === defaultEnd.hour) {
        row.addClass('is-suggested');
        suggestedMinute = defaultEnd.minute;
      }
    }

    // Hour label
    const hourLabel = document.createElement('div');
    hourLabel.className = 'timeblock-picker-hour';
    hourLabel.textContent = TimeblockUtils.formatDisplayTime(hour);

    // Click on hour label: expand on mobile or select :00 on desktop with hover
    hourLabel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleHourClick(hour);
    });

    row.appendChild(hourLabel);

    // Minute options container (shown on hover or when expanded)
    const minuteOptions = document.createElement('div');
    minuteOptions.className = 'timeblock-picker-row-minutes';

    for (const minute of [0, 15, 30, 45]) {
      const btn = document.createElement('button');
      btn.className = 'timeblock-picker-minute-btn';

      if (suggestedMinute === minute) {
        btn.addClass('is-suggested');
      }

      btn.textContent = minute.toString().padStart(2, '0');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectTime(hour, minute);
      });
      minuteOptions.appendChild(btn);
    }

    row.appendChild(minuteOptions);

    return row;
  }

  handleHourClick(hour) {
    // If already expanded for this hour, select :00
    if (this.expandedHour === hour) {
      this.selectTime(hour, 0);
      return;
    }

    // Expand this hour row (for mobile/touch)
    this.expandedHour = hour;
    this.render();
  }

  selectTime(hour, minute) {
    this.selectedHour = hour;
    this.close();

    if (this.mode === 'start') {
      // Open end time picker
      const endPopup = new TimePickerPopup(
        this.plugin,
        this.editor,
        this.lineNum,
        'end',
        { hour: hour, minute: minute },
        (endHour, endMinute) => {
          this.applyTimeblock(hour, minute, endHour, endMinute);
        }
      );
      endPopup.open();
    } else if (this.mode === 'end' && this.onComplete) {
      this.onComplete(hour, minute);
    }
  }

  applyTimeblock(startHour, startMinute, endHour, endMinute) {
    const line = this.editor.getLine(this.lineNum);
    const newLine = TimeblockUtils.addTimeblock(line, startHour, startMinute, endHour, endMinute);
    this.editor.setLine(this.lineNum, newLine);
    new obsidian.Notice(`Timeblock set: ${TimeblockUtils.formatTime(startHour, startMinute)} - ${TimeblockUtils.formatTime(endHour, endMinute)}`);
  }

  positionPopup() {
    const view = this.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) return;

    const cm = view.editor.cm;
    if (!cm) return;

    const cursor = this.editor.getCursor();
    const coords = cm.coordsAtPos(cm.state.doc.line(cursor.line + 1).from);

    if (coords) {
      this.container.style.position = 'absolute';
      this.container.style.left = `${coords.left}px`;
      this.container.style.top = `${coords.bottom + 5}px`;
      this.container.style.zIndex = '1000';
    }
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  handleClickOutside(e) {
    if (this.container && !this.container.contains(e.target)) {
      this.close();
    }
  }
}

// ============================================================================
// TIMEBLOCK SHORTCUT SUGGEST (^ triggers TimePickerPopup)
// ============================================================================

class TimeblockShortcutSuggest extends obsidian.EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    // Only trigger on task lines
    const line = editor.getLine(cursor.line);
    if (!TaskUtils.isTask(line)) return null;

    // Find the "^" character before cursor
    const lineUpToCursor = line.substring(0, cursor.ch);
    const triggerIndex = lineUpToCursor.lastIndexOf('^');

    if (triggerIndex === -1) return null;

    // Don't trigger if at start of line
    if (triggerIndex === 0) return null;

    const beforeTrigger = lineUpToCursor.substring(0, triggerIndex);
    // Don't trigger if preceded by another ^
    if (beforeTrigger.endsWith('^')) return null;

    // Remove the "^" character
    const start = { line: cursor.line, ch: triggerIndex };
    const end = cursor;
    editor.replaceRange('', start, end);

    // Check for existing timeblock to pre-populate
    const existingTimeblock = TimeblockUtils.extractTimeblock(line);

    // Open the time picker popup
    const popup = new TimePickerPopup(this.plugin, editor, cursor.line, 'start');
    popup.open();

    return null;
  }

  getSuggestions(context) {
    return [];
  }

  renderSuggestion(suggestion, el) {}

  selectSuggestion(suggestion, evt) {}
}

// ============================================================================
// SLASH COMMAND SUGGEST
// ============================================================================

const SLASH_COMMANDS = [
  { id: 'complete', label: 'Mark Complete', icon: Icons.check, marker: 'x' },
  { id: 'in-progress', label: 'Mark In Progress', icon: Icons.halfCircle, marker: '/' },
  { id: 'cancelled', label: 'Mark Cancelled', icon: Icons.ban, marker: '-' },
  { id: 'schedule', label: 'Schedule Task', icon: Icons.anglesRight, action: 'schedule' },
  { id: 'timeblock', label: 'Set Time Block', icon: Icons.clock, action: 'timeblock' }
];

class SlashCommandSuggest extends obsidian.EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    // Only trigger on task lines
    const line = editor.getLine(cursor.line);
    if (!TaskUtils.isTask(line)) return null;

    // Find the "/" character before cursor
    const lineUpToCursor = line.substring(0, cursor.ch);
    const slashIndex = lineUpToCursor.lastIndexOf('/');

    if (slashIndex === -1) return null;

    // Ensure "/" is not part of a time pattern (e.g., "15:30 - 16:00")
    const beforeSlash = lineUpToCursor.substring(0, slashIndex);
    if (/\d$/.test(beforeSlash)) return null;

    return {
      start: { line: cursor.line, ch: slashIndex },
      end: cursor,
      query: lineUpToCursor.substring(slashIndex + 1).toLowerCase()
    };
  }

  getSuggestions(context) {
    const query = context.query.toLowerCase();
    return SLASH_COMMANDS.filter(cmd =>
      cmd.label.toLowerCase().includes(query) ||
      cmd.id.includes(query)
    );
  }

  renderSuggestion(suggestion, el) {
    el.addClass('slash-command-item');
    const iconSpan = el.createSpan({ cls: 'slash-command-icon' });
    iconSpan.innerHTML = suggestion.icon;
    el.createSpan({ text: suggestion.label, cls: 'slash-command-label' });
  }

  selectSuggestion(suggestion, evt) {
    const { editor } = this.context;
    const lineNum = this.context.start.line;
    const line = editor.getLine(lineNum);

    // Remove the "/" and any typed query
    editor.replaceRange('', this.context.start, this.context.end);

    // Re-read line after removal
    const updatedLine = editor.getLine(lineNum);

    if (suggestion.marker) {
      // Change task status marker
      const newLine = updatedLine.replace(/^([\t]*- \[)[^\]](\])/, `$1${suggestion.marker}$2`);
      editor.setLine(lineNum, newLine);
    } else if (suggestion.action === 'schedule') {
      this.openSchedulePopup(editor, lineNum);
    } else if (suggestion.action === 'timeblock') {
      this.openTimeBlockPopup(editor, lineNum);
    }
  }

  openSchedulePopup(editor, lineNum) {
    const popup = new ScheduleDatePopup(this.plugin, editor, lineNum);
    popup.open();
  }

  openTimeBlockPopup(editor, lineNum) {
    const popup = new TimePickerPopup(this.plugin, editor, lineNum, 'start');
    popup.open();
  }
}

// ============================================================================
// SCHEDULE SHORTCUT SUGGEST (> triggers ScheduleDatePopup directly)
// ============================================================================

class ScheduleShortcutSuggest extends obsidian.EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    // Only trigger on task lines
    const line = editor.getLine(cursor.line);
    if (!TaskUtils.isTask(line)) return null;

    // Find the ">" character before cursor
    const lineUpToCursor = line.substring(0, cursor.ch);
    const triggerIndex = lineUpToCursor.lastIndexOf('>');

    if (triggerIndex === -1) return null;

    // Don't trigger if at start of line (would be blockquote)
    if (triggerIndex === 0) return null;

    const beforeTrigger = lineUpToCursor.substring(0, triggerIndex);
    // Don't trigger if preceded by another > (nested blockquote)
    if (beforeTrigger.endsWith('>')) return null;
    // Don't trigger if this > is part of a scheduling tag [> or [<
    // Check if preceded by "[" (scheduling tag like [> 2026-01-24])
    if (beforeTrigger.endsWith('[')) return null;

    // Immediately open the schedule popup and return null to not show suggest UI
    // Remove the ">" character first
    const start = { line: cursor.line, ch: triggerIndex };
    const end = cursor;
    editor.replaceRange('', start, end);

    // Open the same ScheduleDatePopup used by the slash command
    const popup = new ScheduleDatePopup(this.plugin, editor, cursor.line);
    popup.open();

    return null;
  }

  getSuggestions(context) {
    return [];
  }

  renderSuggestion(suggestion, el) {}

  selectSuggestion(suggestion, evt) {}
}

// ============================================================================
// SCHEDULE DATE POPUP
// ============================================================================

class ScheduleDatePopup {
  constructor(plugin, editor, lineNum) {
    this.plugin = plugin;
    this.editor = editor;
    this.lineNum = lineNum;
    this.selectedIndex = 0;
    this.isCustomMode = false;
    this.container = null;
    this.customInput = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
  }

  open() {
    // Create popup container
    this.container = document.createElement('div');
    this.container.className = 'schedule-date-popup';

    // Build the options list
    this.renderOptions();

    // Position the popup near the cursor
    this.positionPopup();

    // Add to DOM
    document.body.appendChild(this.container);

    // Add event listeners
    document.addEventListener('keydown', this.handleKeyDown, true);
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
    }, 10);
  }

  close() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('click', this.handleClickOutside);
  }

  renderOptions() {
    this.container.empty();

    SCHEDULE_DATE_OPTIONS.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'schedule-date-option';
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      }

      if (option.isCustom && this.isCustomMode) {
        // Render input field
        this.customInput = document.createElement('input');
        this.customInput.type = 'text';
        this.customInput.className = 'schedule-date-custom-input';
        this.customInput.placeholder = 'YYYY-MM-DD';
        this.customInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this.submitCustomDate();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
          }
        });
        item.appendChild(this.customInput);
        setTimeout(() => this.customInput.focus(), 0);
      } else {
        item.createSpan({ text: option.label, cls: 'schedule-date-label' });
        if (option.getDate) {
          item.createSpan({ text: option.getDate(), cls: 'schedule-date-value' });
        }
      }

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = index;
        this.selectOption(option);
      });

      this.container.appendChild(item);
    });
  }

  positionPopup() {
    // Get cursor position from CodeMirror
    const view = this.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) return;

    const cm = view.editor.cm;
    if (!cm) return;

    const cursor = this.editor.getCursor();
    const coords = cm.coordsAtPos(cm.state.doc.line(cursor.line + 1).from);

    if (coords) {
      this.container.style.position = 'absolute';
      this.container.style.left = `${coords.left}px`;
      this.container.style.top = `${coords.bottom + 5}px`;
      this.container.style.zIndex = '1000';
    }
  }

  handleKeyDown(e) {
    if (this.isCustomMode && this.customInput && document.activeElement === this.customInput) {
      // Let input handle its own keys except Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.min(this.selectedIndex + 1, SCHEDULE_DATE_OPTIONS.length - 1);
        this.renderOptions();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderOptions();
        break;

      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        this.selectOption(SCHEDULE_DATE_OPTIONS[this.selectedIndex]);
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
    }
  }

  handleClickOutside(e) {
    if (this.container && !this.container.contains(e.target)) {
      this.close();
    }
  }

  selectOption(option) {
    if (option.isCustom) {
      if (!this.isCustomMode) {
        this.isCustomMode = true;
        this.renderOptions();
      }
    } else if (option.getDate) {
      this.scheduleToDate(option.getDate());
    }
  }

  submitCustomDate() {
    if (!this.customInput) return;

    const parsed = ScheduleDateUtils.parseCustomDate(this.customInput.value);
    if (parsed) {
      this.scheduleToDate(parsed);
    } else {
      new obsidian.Notice('Invalid date format. Use YYYY-MM-DD or YYYYMMDD');
    }
  }

  async scheduleToDate(date) {
    this.close();
    await TaskScheduler.scheduleTask(
      this.plugin.app,
      this.plugin.settings,
      this.editor,
      this.lineNum,
      date
    );
  }
}

// ============================================================================
// WIDGET-ANCHORED POPUPS (positioned relative to DOM elements)
// ============================================================================

// Schedule date popup that positions itself relative to an anchor element (for widget clicks)
class ScheduleDatePopupFromWidget extends ScheduleDatePopup {
  constructor(plugin, editor, lineNum, anchorEl) {
    super(plugin, editor, lineNum);
    this.anchorEl = anchorEl;
  }

  positionPopup() {
    if (!this.anchorEl) return;

    const rect = this.anchorEl.getBoundingClientRect();
    this.container.style.position = 'absolute';
    this.container.style.left = `${rect.left}px`;
    this.container.style.top = `${rect.bottom + 5}px`;
    this.container.style.zIndex = '1000';

    // Ensure popup stays within viewport
    requestAnimationFrame(() => {
      const popupRect = this.container.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        this.container.style.left = `${window.innerWidth - popupRect.width - 10}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        this.container.style.top = `${rect.top - popupRect.height - 5}px`;
      }
    });
  }
}

// Time picker popup that positions itself relative to an anchor element (for widget clicks)
class TimePickerPopupFromWidget extends TimePickerPopup {
  constructor(plugin, editor, lineNum, mode, existingStart, onComplete, anchorEl) {
    super(plugin, editor, lineNum, mode, existingStart, onComplete);
    this.anchorEl = anchorEl;
  }

  positionPopup() {
    if (!this.anchorEl) return;

    const rect = this.anchorEl.getBoundingClientRect();
    this.container.style.position = 'absolute';
    this.container.style.left = `${rect.left}px`;
    this.container.style.top = `${rect.bottom + 5}px`;
    this.container.style.zIndex = '1000';

    // Ensure popup stays within viewport
    requestAnimationFrame(() => {
      const popupRect = this.container.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        this.container.style.left = `${window.innerWidth - popupRect.width - 10}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        this.container.style.top = `${rect.top - popupRect.height - 5}px`;
      }
    });
  }

  selectTime(hour, minute) {
    this.selectedHour = hour;
    this.close();

    if (this.mode === 'start') {
      // Open end time picker - also use widget-anchored version
      const endPopup = new TimePickerPopupFromWidget(
        this.plugin,
        this.editor,
        this.lineNum,
        'end',
        { hour: hour, minute: minute },
        (endHour, endMinute) => {
          this.applyTimeblock(hour, minute, endHour, endMinute);
        },
        this.anchorEl
      );
      endPopup.open();
    } else if (this.mode === 'end' && this.onComplete) {
      this.onComplete(hour, minute);
    }
  }
}

// ============================================================================
// UI COMPONENTS
// ============================================================================

// Container widget that holds all task decorations (notes button, pills, info button)
// so they wrap together as a single unit
class TaskDecorationsWidget extends WidgetType {
  constructor(options, plugin) {
    super();
    this.options = options; // { taskText, taskId, parentId, scheduleToDates, scheduleFromDates, showInfoButton, showNotesButton }
    this.plugin = plugin;
  }

  toDOM() {
    const container = document.createElement('span');
    container.className = 'task-decorations-container';

    // Add notes button if enabled (for both tasks and calendar events)
    if (this.options.showNotesButton && this.options.taskText) {
      const btn = document.createElement('span');
      btn.className = 'task-note-button';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'task-note-button-icon';
      iconSpan.innerHTML = Icons.fileLines;
      btn.appendChild(iconSpan);
      btn.appendChild(document.createTextNode('notes'));
      btn.setAttribute('aria-label', this.options.isCalendarEvent ? 'Open event note' : 'Open task note');
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const activeFile = this.plugin.app.workspace.getActiveFile();
        const sourceFilePath = activeFile ? activeFile.path : null;

        if (this.options.isCalendarEvent) {
          // Use EventNoteManager for calendar events
          await EventNoteManager.openOrCreateEventNote(
            this.plugin.app,
            this.plugin.settings,
            this.options.taskText,
            this.options.uid,
            sourceFilePath,
            this.options.eventTimeRange,
            this.options.calendarSource
          );
        } else {
          // Use TaskNoteManager for regular tasks
          await TaskNoteManager.openOrCreateTaskNote(
            this.plugin.app,
            this.plugin.settings,
            this.options.taskText,
            sourceFilePath,
            this.options.taskId
          );
        }
      });
      container.appendChild(btn);
    }

    // Add schedule-to pills
    if (this.options.scheduleToDates) {
      for (const date of this.options.scheduleToDates) {
        const pill = document.createElement('span');
        pill.className = 'schedule-pill schedule-pill-to';
        pill.textContent = `→ ${date}`;
        pill.setAttribute('aria-label', `Go to ${date}`);
        pill.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.navigateToDate(date);
        });
        container.appendChild(pill);
      }
    }

    // Add schedule-from pills
    if (this.options.scheduleFromDates) {
      for (const date of this.options.scheduleFromDates) {
        const pill = document.createElement('span');
        pill.className = 'schedule-pill schedule-pill-from';
        pill.textContent = `← ${date}`;
        pill.setAttribute('aria-label', `Go to ${date}`);
        pill.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.navigateToDate(date);
        });
        container.appendChild(pill);
      }
    }

    // Add info button if enabled
    if (this.options.showInfoButton && (this.options.taskId || this.options.parentId || this.options.uid)) {
      const btn = document.createElement('span');
      btn.className = 'task-info-button';
      btn.textContent = '\u24D8'; // ⓘ
      btn.title = this.options.isCalendarEvent ? 'Event info' : 'Task info';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.showTaskInfo(this.options.taskId, this.options.parentId, this.options.taskText, null, null, this.options.uid, this.options.isCalendarEvent, this.options.calendarSource);
      });
      container.appendChild(btn);
    }

    // Add schedule button (hover-only action button) - only for non-calendar events
    if (!this.options.isCalendarEvent) {
      const scheduleBtn = document.createElement('span');
      scheduleBtn.className = 'task-action-button task-schedule-button';
      const scheduleIcon = document.createElement('span');
      scheduleIcon.className = 'task-action-button-icon';
      scheduleIcon.innerHTML = Icons.circleRight;
      scheduleBtn.appendChild(scheduleIcon);
      scheduleBtn.title = 'Schedule task';
      scheduleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.showSchedulePopupFromWidget(scheduleBtn, this.options.lineNum);
      });
      container.appendChild(scheduleBtn);
    }

    // Add timeblock button (hover-only action button) - only for non-calendar events
    if (!this.options.isCalendarEvent) {
      const timeblockBtn = document.createElement('span');
      timeblockBtn.className = 'task-action-button task-timeblock-button';
      const timeblockIcon = document.createElement('span');
      timeblockIcon.className = 'task-action-button-icon';
      timeblockIcon.innerHTML = Icons.clock;
      timeblockBtn.appendChild(timeblockIcon);
      timeblockBtn.title = 'Set time block';
      timeblockBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.showTimeblockPickerFromWidget(timeblockBtn, this.options.lineNum);
      });
      container.appendChild(timeblockBtn);
    }

    return container;
  }

  async navigateToDate(date) {
    const path = TaskScheduler.getDailyNotePath(date, this.plugin.settings);
    let file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file) {
      file = await this.plugin.app.vault.create(path, '');
    }
    if (file instanceof obsidian.TFile) {
      await this.plugin.app.workspace.getLeaf().openFile(file);
    }
  }

  eq(other) {
    return (
      other.options.taskText === this.options.taskText &&
      other.options.taskId === this.options.taskId &&
      other.options.parentId === this.options.parentId &&
      other.options.uid === this.options.uid &&
      other.options.calendarSource === this.options.calendarSource &&
      other.options.isCalendarEvent === this.options.isCalendarEvent &&
      JSON.stringify(other.options.eventTimeRange) === JSON.stringify(this.options.eventTimeRange) &&
      JSON.stringify(other.options.scheduleToDates) === JSON.stringify(this.options.scheduleToDates) &&
      JSON.stringify(other.options.scheduleFromDates) === JSON.stringify(this.options.scheduleFromDates) &&
      other.options.showInfoButton === this.options.showInfoButton &&
      other.options.showNotesButton === this.options.showNotesButton &&
      other.options.lineNum === this.options.lineNum
    );
  }

  ignoreEvent() {
    return false;
  }
}

// Widget for the task note button (kept for backwards compatibility)
class TaskNoteButtonWidget extends WidgetType {
  constructor(taskText, taskId, plugin) {
    super();
    this.taskText = taskText;
    this.taskId = taskId;  // Store taskId for inclusion in new Task Notes
    this.plugin = plugin;
  }

  toDOM() {
    const btn = document.createElement('span');
    btn.className = 'task-note-button';
    // Use Font Awesome file-lines icon + text
    const iconSpan = document.createElement('span');
    iconSpan.className = 'task-note-button-icon';
    iconSpan.innerHTML = Icons.fileLines;
    btn.appendChild(iconSpan);
    btn.appendChild(document.createTextNode('notes'));
    btn.setAttribute('aria-label', 'Open task note');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const activeFile = this.plugin.app.workspace.getActiveFile();
      const sourceFilePath = activeFile ? activeFile.path : null;
      await TaskNoteManager.openOrCreateTaskNote(
        this.plugin.app,
        this.plugin.settings,
        this.taskText,
        sourceFilePath,
        this.taskId  // Pass taskId so new Task Notes include it in frontmatter
      );
    });
    return btn;
  }

  eq(other) {
    return other.taskText === this.taskText && other.taskId === this.taskId;
  }

  ignoreEvent() {
    return false;
  }
}

// Widget for scheduled-to pill [> YYYY-MM-DD]
class ScheduledToPillWidget extends WidgetType {
  constructor(date, plugin) {
    super();
    this.date = date;
    this.plugin = plugin;
  }

  toDOM() {
    const pill = document.createElement('span');
    pill.className = 'schedule-pill schedule-pill-to';
    pill.textContent = `→ ${this.date}`;
    pill.setAttribute('aria-label', `Go to ${this.date}`);
    pill.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.navigateToDate();
    });
    return pill;
  }

  async navigateToDate() {
    const path = TaskScheduler.getDailyNotePath(this.date, this.plugin.settings);
    let file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file) {
      // Create if doesn't exist
      file = await this.plugin.app.vault.create(path, '');
    }
    if (file instanceof obsidian.TFile) {
      await this.plugin.app.workspace.getLeaf().openFile(file);
    }
  }

  eq(other) {
    return other.date === this.date;
  }

  ignoreEvent() {
    return false;
  }
}

// Widget for scheduled-from pill [< YYYY-MM-DD]
class ScheduledFromPillWidget extends WidgetType {
  constructor(date, plugin) {
    super();
    this.date = date;
    this.plugin = plugin;
  }

  toDOM() {
    const pill = document.createElement('span');
    pill.className = 'schedule-pill schedule-pill-from';
    pill.textContent = `← ${this.date}`;
    pill.setAttribute('aria-label', `Go to ${this.date}`);
    pill.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.navigateToDate();
    });
    return pill;
  }

  async navigateToDate() {
    const path = TaskScheduler.getDailyNotePath(this.date, this.plugin.settings);
    let file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file) {
      // Create if doesn't exist
      file = await this.plugin.app.vault.create(path, '');
    }
    if (file instanceof obsidian.TFile) {
      await this.plugin.app.workspace.getLeaf().openFile(file);
    }
  }

  eq(other) {
    return other.date === this.date;
  }

  ignoreEvent() {
    return false;
  }
}

// Modal for displaying task metadata
class TaskInfoModal extends obsidian.Modal {
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


// Widget for the info button
class InfoButtonWidget extends WidgetType {
  constructor(taskId, parentId, taskText, plugin) {
    super();
    this.taskId = taskId;
    this.parentId = parentId;
    this.taskText = taskText;
    this.plugin = plugin;
  }

  toDOM() {
    const btn = document.createElement('span');
    btn.className = 'task-info-button';
    btn.textContent = '\u24D8'; // ⓘ
    btn.title = 'Task info';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.showTaskInfo(this.taskId, this.parentId, this.taskText);
    });
    return btn;
  }

  ignoreEvent() {
    return false;
  }
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

class TaskManagerSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Task Manager Settings' });

    // SCOPE SECTION
    containerEl.createEl('h3', { text: 'Scope' });

    new obsidian.Setting(containerEl)
      .setName('Target folders')
      .setDesc('Comma-separated list of folder paths to process (e.g., "00 - Daily/, 01 - Projects/")')
      .addText(text => text
        .setPlaceholder('00 - Daily/')
        .setValue(this.plugin.settings.targetFolders.join(', '))
        .onChange(async (value) => {
          this.plugin.settings.targetFolders = value.split(',').map(s => s.trim()).filter(s => s);
          await this.plugin.saveSettings();
        }));

    // TASK IDS SECTION
    containerEl.createEl('h3', { text: 'Task IDs' });

    new obsidian.Setting(containerEl)
      .setName('Enable task IDs')
      .setDesc('Automatically assign unique IDs to all tasks')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskIds)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskIds = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('ID prefix')
      .setDesc('Prefix for generated task IDs')
      .addText(text => text
        .setPlaceholder('t-')
        .setValue(this.plugin.settings.idPrefix)
        .onChange(async (value) => {
          this.plugin.settings.idPrefix = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('ID length')
      .setDesc('Number of random characters in task IDs')
      .addText(text => text
        .setPlaceholder('8')
        .setValue(String(this.plugin.settings.idLength))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.idLength = num;
            await this.plugin.saveSettings();
          }
        }));

    // PARENT-CHILD LINKING SECTION
    containerEl.createEl('h3', { text: 'Parent-Child Linking' });

    new obsidian.Setting(containerEl)
      .setName('Enable parent-child linking')
      .setDesc('Automatically link subtasks to their parent tasks')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableParentChildLinking)
        .onChange(async (value) => {
          this.plugin.settings.enableParentChildLinking = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Preserve existing parent links')
      .setDesc('Do not overwrite existing parent links when subtasks are moved')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.preserveExistingParentLinks)
        .onChange(async (value) => {
          this.plugin.settings.preserveExistingParentLinks = value;
          await this.plugin.saveSettings();
        }));

    // SORTING SECTION
    containerEl.createEl('h3', { text: 'Sorting' });

    new obsidian.Setting(containerEl)
      .setName('Enable auto-sort')
      .setDesc('Automatically sort tasks by time when file is modified')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAutoSort)
        .onChange(async (value) => {
          this.plugin.settings.enableAutoSort = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Sort debounce delay')
      .setDesc('Milliseconds to wait after last edit before sorting')
      .addText(text => text
        .setPlaceholder('500')
        .setValue(String(this.plugin.settings.sortDebounceMs))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 0) {
            this.plugin.settings.sortDebounceMs = num;
            await this.plugin.saveSettings();
          }
        }));

    new obsidian.Setting(containerEl)
      .setName('Tasks without time position')
      .setDesc('Where to place tasks that do not have a timeblock')
      .addDropdown(dropdown => dropdown
        .addOption('end', 'End of list')
        .addOption('start', 'Start of list')
        .setValue(this.plugin.settings.tasksWithoutTimePosition)
        .onChange(async (value) => {
          this.plugin.settings.tasksWithoutTimePosition = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Auto-archive completed tasks')
      .setDesc('Move completed, scheduled, and cancelled tasks to a collapsed section')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAutoArchive)
        .onChange(async (value) => {
          this.plugin.settings.enableAutoArchive = value;
          await this.plugin.saveSettings();
        }));

    // TASK STATUS SYNC SECTION
    containerEl.createEl('h3', { text: 'Task Status Sync' });

    new obsidian.Setting(containerEl)
      .setName('Enable status sync')
      .setDesc('Sync task status between task notes and daily notes bidirectionally')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskStatusSync)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskStatusSync = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Status mappings')
      .setDesc('Checkbox marker → status name mappings (JSON format)')
      .addTextArea(text => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 40;
        text
          .setValue(JSON.stringify(this.plugin.settings.statusMappings, null, 2))
          .onChange(async (value) => {
            try {
              const parsed = JSON.parse(value);
              this.plugin.settings.statusMappings = parsed;
              await this.plugin.saveSettings();
            } catch (e) {
              // Invalid JSON, ignore until valid
            }
          });
      });

    // DISPLAY SECTION
    containerEl.createEl('h3', { text: 'Display' });

    new obsidian.Setting(containerEl)
      .setName('Show info button')
      .setDesc('Display info button (i) on tasks to view metadata')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showInfoButton)
        .onChange(async (value) => {
          this.plugin.settings.showInfoButton = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Hide metadata fields')
      .setDesc('Hide [id::...] and [parent::...] fields in the editor')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideMetadataFields)
        .onChange(async (value) => {
          this.plugin.settings.hideMetadataFields = value;
          await this.plugin.saveSettings();
        }));

    // TASK NOTES SECTION
    containerEl.createEl('h3', { text: 'Task Notes' });

    new obsidian.Setting(containerEl)
      .setName('Enable task notes')
      .setDesc('Show "notes" button on parent tasks to create/open dedicated task notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskNotes)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskNotes = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Task notes folder')
      .setDesc('Folder where task notes will be created')
      .addText(text => text
        .setPlaceholder('Task Notes')
        .setValue(this.plugin.settings.taskNotesFolder)
        .onChange(async (value) => {
          this.plugin.settings.taskNotesFolder = value.trim() || 'Task Notes';
          await this.plugin.saveSettings();
        }));

    // EVENT NOTES SECTION
    containerEl.createEl('h3', { text: 'Event Notes' });

    new obsidian.Setting(containerEl)
      .setName('Enable event notes')
      .setDesc('Show "notes" button on calendar events to create/open dedicated event notes with eventUID in frontmatter')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableEventNotes)
        .onChange(async (value) => {
          this.plugin.settings.enableEventNotes = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Event notes folder')
      .setDesc('Folder where event notes will be created')
      .addText(text => text
        .setPlaceholder('Event Notes')
        .setValue(this.plugin.settings.eventNotesFolder)
        .onChange(async (value) => {
          this.plugin.settings.eventNotesFolder = value.trim() || 'Event Notes';
          await this.plugin.saveSettings();
        }));

    // ICS CALENDAR SYNC SECTION
    containerEl.createEl('h3', { text: 'Calendar Sync' });

    new obsidian.Setting(containerEl)
      .setName('Enable ICS calendar sync')
      .setDesc('Automatically sync calendar events from ICS plugin when opening daily notes. Events use [c] checkbox and are read-only.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableIcsSync)
        .onChange(async (value) => {
          this.plugin.settings.enableIcsSync = value;
          await this.plugin.saveSettings();
        }));
  }
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

class TaskManagerPlugin extends obsidian.Plugin {
  async onload() {
    console.log('Task Manager: loaded');

    await this.loadSettings();

    // Store reference for widgets and closures
    const plugin = this;

    this.isProcessing = false;

    // Register CodeMirror extension for info buttons and metadata hiding
    const infoButtonPlugin = ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = this.buildDecorations(view, plugin);
        }

        update(update) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = this.buildDecorations(update.view, plugin);
          }
        }

        buildDecorations(view, plugin) {
          const decorations = [];
          const taskPattern = TaskUtils.TASK_PATTERN;
          const parentTaskPattern = TaskUtils.PARENT_TASK_PATTERN;
          const metadataPattern = /\s*\[(?:id|parent|uid|calendar)::\s*[^\]]+\]/g;
          // Time block pattern: HH:MM - HH:MM at start of task text
          const timeblockPattern = /^([\t]*- \[.\]\s*)(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/;
          // Schedule tag patterns: [> YYYY-MM-DD] and [< YYYY-MM-DD]
          const scheduleToPattern = /\s*\[>\s*(\d{4}-\d{2}-\d{2})\]/g;
          const scheduleFromPattern = /\s*\[<\s*(\d{4}-\d{2}-\d{2})\]/g;
          // Legacy patterns
          const legacyScheduleToPattern = /\s*\[sch_to::([^\]]+)\]/g;
          const legacyScheduleFromPattern = /\s*\[sch_from::([^\]]+)\]/g;

          // Check if we're in the task notes folder (skip task note buttons there)
          const activeFile = plugin.app.workspace.getActiveFile();
          const inTaskNotesFolder = activeFile &&
            activeFile.path.startsWith(plugin.settings.taskNotesFolder + '/');

          for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos < to;) {
              const line = view.state.doc.lineAt(pos);
              const lineText = line.text;

              if (taskPattern.test(lineText)) {
                const taskId = TaskUtils.extractId(lineText);
                const parentId = TaskUtils.extractParentId(lineText);
                const isParentTask = parentTaskPattern.test(lineText);

                // Add clickable pill styling to time blocks
                const timeblockMatch = lineText.match(timeblockPattern);
                if (timeblockMatch) {
                  const timeblockStart = line.from + timeblockMatch[1].length;
                  const timeblockEnd = timeblockStart + timeblockMatch[2].length;
                  decorations.push({
                    from: timeblockStart,
                    to: timeblockEnd,
                    value: Decoration.mark({
                      class: 'timeblock-pill',
                      attributes: { 'data-line': String(line.number - 1) }
                    })
                  });
                }

                // Collect schedule dates for unified widget
                const scheduleToDates = [];
                const scheduleFromDates = [];

                // Hide metadata fields if enabled
                if (plugin.settings.hideMetadataFields) {
                  let match;
                  metadataPattern.lastIndex = 0;
                  while ((match = metadataPattern.exec(lineText)) !== null) {
                    const start = line.from + match.index;
                    const end = start + match[0].length;
                    decorations.push({
                      from: start,
                      to: end,
                      value: Decoration.replace({})
                    });
                  }
                }

                // Handle schedule-to tags [> YYYY-MM-DD] - hide raw tags
                let scheduleToMatch;
                scheduleToPattern.lastIndex = 0;
                while ((scheduleToMatch = scheduleToPattern.exec(lineText)) !== null) {
                  const start = line.from + scheduleToMatch.index;
                  const end = start + scheduleToMatch[0].length;
                  scheduleToDates.push(scheduleToMatch[1]);
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                }

                // Handle schedule-from tags [< YYYY-MM-DD] - hide raw tags
                let scheduleFromMatch;
                scheduleFromPattern.lastIndex = 0;
                while ((scheduleFromMatch = scheduleFromPattern.exec(lineText)) !== null) {
                  const start = line.from + scheduleFromMatch.index;
                  const end = start + scheduleFromMatch[0].length;
                  scheduleFromDates.push(scheduleFromMatch[1]);
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                }

                // Handle legacy schedule-to tags [sch_to::DATE] - hide raw tags
                let legacyToMatch;
                legacyScheduleToPattern.lastIndex = 0;
                while ((legacyToMatch = legacyScheduleToPattern.exec(lineText)) !== null) {
                  const start = line.from + legacyToMatch.index;
                  const end = start + legacyToMatch[0].length;
                  scheduleToDates.push(legacyToMatch[1]);
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                }

                // Handle legacy schedule-from tags [sch_from::DATE] - hide raw tags
                let legacyFromMatch;
                legacyScheduleFromPattern.lastIndex = 0;
                while ((legacyFromMatch = legacyScheduleFromPattern.exec(lineText)) !== null) {
                  const start = line.from + legacyFromMatch.index;
                  const end = start + legacyFromMatch[0].length;
                  scheduleFromDates.push(legacyFromMatch[1]);
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                }

                // Determine what to show in the unified container
                const isCalendarEvent = TaskUtils.isCalendarEvent(lineText);
                const uid = isCalendarEvent ? IcsEventSync.extractUid(lineText) : null;
                const calendarSource = isCalendarEvent ? IcsEventSync.extractCalendar(lineText) : null;

                // For calendar events, extract event title; for tasks, extract task text
                const taskText = isCalendarEvent
                  ? EventNoteManager.extractEventTitle(lineText)
                  : TaskNoteManager.extractTaskTextFromLine(lineText);
                const eventTimeRange = isCalendarEvent ? EventNoteManager.extractTimeRange(lineText) : null;

                // Show notes button for parent tasks OR calendar events (with their respective settings)
                const showTaskNotesButton = plugin.settings.enableTaskNotes && isParentTask && !inTaskNotesFolder && taskText && taskText.trim() !== '';
                const showEventNotesButton = plugin.settings.enableEventNotes && isCalendarEvent && uid && taskText && taskText.trim() !== '';
                const showNotesButton = showTaskNotesButton || showEventNotesButton;

                const showInfoButton = plugin.settings.showInfoButton && (taskId || parentId || uid);
                const hasSchedulePills = scheduleToDates.length > 0 || scheduleFromDates.length > 0;

                // Add unified container widget - always show for tasks (hover buttons appear on any task)
                decorations.push({
                  from: line.to,
                  to: line.to,
                  value: Decoration.widget({
                    widget: new TaskDecorationsWidget({
                      taskText: taskText,
                      taskId: taskId,
                      parentId: parentId,
                      uid: uid,
                      calendarSource: calendarSource,
                      isCalendarEvent: isCalendarEvent,
                      eventTimeRange: eventTimeRange,
                      scheduleToDates: scheduleToDates.length > 0 ? scheduleToDates : null,
                      scheduleFromDates: scheduleFromDates.length > 0 ? scheduleFromDates : null,
                      showInfoButton: showInfoButton,
                      showNotesButton: showNotesButton,
                      lineNum: line.number
                    }, plugin),
                    side: 1
                  })
                });
              }

              pos = line.to + 1;
            }
          }

          // Sort decorations by position (required by RangeSetBuilder)
          decorations.sort((a, b) => a.from - b.from || a.to - b.to);

          const builder = new RangeSetBuilder();
          for (const d of decorations) {
            builder.add(d.from, d.to, d.value);
          }

          return builder.finish();
        }
      },
      {
        decorations: (v) => v.decorations
      }
    );

    this.registerEditorExtension([infoButtonPlugin]);

    // Register slash command suggest
    this.registerEditorSuggest(new SlashCommandSuggest(this.app, this));

    // Register schedule shortcut suggest (> shortcut)
    this.registerEditorSuggest(new ScheduleShortcutSuggest(this.app, this));

    // Register timeblock shortcut suggest (^ shortcut)
    this.registerEditorSuggest(new TimeblockShortcutSuggest(this.app, this));

    // Task notes sync state
    this.taskNoteSyncing = false;
    this.taskNoteSyncTimers = new Map();

    // Track last cursor line for line-change detection
    this.lastCursorLine = -1;

    // Register cursor line change handler via CodeMirror extension
    const lineChangePlugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.plugin = plugin;
        this.lastLine = -1;
      }

      update(update) {
        if (!update.selectionSet) return;

        const currentLine = update.state.doc.lineAt(update.state.selection.main.head).number - 1;

        if (this.lastLine !== -1 && this.lastLine !== currentLine) {
          // Cursor moved to a different line - process the line we just left
          // Use setTimeout to defer processing until after the current update completes
          const lineToProcess = this.lastLine;
          setTimeout(() => this.plugin.processLineOnLeave(lineToProcess), 0);
        }

        this.lastLine = currentLine;
      }
    });

    this.registerEditorExtension([lineChangePlugin]);

    // Prevent calendar event [c] checkboxes from being toggled
    this.registerDomEvent(document, 'click', (evt) => {
      const target = evt.target;
      // Check if clicking on a calendar event checkbox
      if (target.matches('input[data-task="c"], .task-list-item-checkbox[data-task="c"]')) {
        evt.preventDefault();
        evt.stopPropagation();
        return false;
      }
      // Also check parent for Reading view
      const li = target.closest('li[data-task="c"]');
      if (li && target.matches('input[type="checkbox"]')) {
        evt.preventDefault();
        evt.stopPropagation();
        return false;
      }
    }, true); // Use capture phase to intercept before Obsidian handles it

    // Handle time block pill clicks to open TimePickerPopup
    this.registerDomEvent(document, 'click', (evt) => {
      const target = evt.target;
      const pill = target.closest('.timeblock-pill');
      if (!pill) return;

      evt.preventDefault();
      evt.stopPropagation();

      const lineNum = parseInt(pill.dataset.line, 10);
      if (isNaN(lineNum)) return;

      // Get the active editor
      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (!view || !view.editor) return;

      const editor = view.editor;
      const popup = new TimePickerPopup(this, editor, lineNum, 'start');
      popup.open();
    });

    // Register file modification event for both task note sync and debounced full-file processing
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.isProcessing) return;

        // Handle task note sync (files in task notes folder)
        if (this.settings.enableTaskNotes &&
            file.path.startsWith(this.settings.taskNotesFolder + '/')) {
          if (!this.taskNoteSyncing) {
            // Debounce per-file
            if (this.taskNoteSyncTimers.has(file.path)) {
              clearTimeout(this.taskNoteSyncTimers.get(file.path));
            }
            this.taskNoteSyncTimers.set(file.path, setTimeout(async () => {
              this.taskNoteSyncTimers.delete(file.path);
              this.taskNoteSyncing = true;
              try {
                await TaskNoteManager.syncSubtasksBackToSource(this.app, file, false);
                // Also sync status from task note to daily note
                await TaskNoteManager.syncStatusToSource(this.app, file, this.settings);
              } finally {
                setTimeout(() => { this.taskNoteSyncing = false; }, 100);
              }
            }, 500));
          }
          return;
        }

        // Task ID assignment and parent linking now handled exclusively by
        // processLineOnLeave() when cursor leaves a line - no background processing
        // while user is typing to avoid corrupting text mid-edit
      })
    );

    // Register file open event for ICS calendar sync
    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        if (!file) return;
        if (!this.settings.enableIcsSync) return;
        if (this.isProcessing) return;

        // Only sync daily notes (files in target folders with date names)
        const noteDate = IcsEventSync.getDailyNoteDate(file, this.settings);
        if (!noteDate) return;

        // Sync ICS events
        this.isProcessing = true;
        try {
          const synced = await IcsEventSync.syncEventsToNote(this.app, file, this.settings);
          if (synced) {
            console.log('Task Manager: Synced ICS events to', file.path);
          }
        } catch (e) {
          console.error('Task Manager: Error syncing ICS events', e);
        } finally {
          setTimeout(() => { this.isProcessing = false; }, 100);
        }
      })
    );

    // Register commands
    this.addCommand({
      id: 'assign-task-ids',
      name: 'Assign IDs to all tasks in current file',
      editorCallback: (editor, view) => {
        const content = editor.getValue();
        const updated = TaskIdManager.processContent(content, this.settings);
        if (content !== updated) {
          editor.setValue(updated);
        }
      }
    });

    this.addCommand({
      id: 'link-parent-child',
      name: 'Link subtasks to parent tasks in current file',
      editorCallback: (editor, view) => {
        let content = editor.getValue();
        // Ensure IDs exist first
        content = TaskIdManager.processContent(content, this.settings);
        const updated = ParentChildLinker.linkContent(content, this.settings);
        if (editor.getValue() !== updated) {
          editor.setValue(updated);
        }
      }
    });

    this.addCommand({
      id: 'unlink-from-parent',
      name: 'Unlink task from parent',
      editorCallback: (editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        if (TaskUtils.extractParentId(line)) {
          const newLine = TaskUtils.removeParentId(line);
          editor.setLine(cursor.line, newLine);
          new obsidian.Notice('Task unlinked from parent');
        } else {
          new obsidian.Notice('This task has no parent link');
        }
      }
    });

    this.addCommand({
      id: 'sort-tasks',
      name: 'Sort tasks chronologically in current file',
      editorCallback: (editor, view) => {
        const content = editor.getValue();
        const sorted = TaskSorter.sortContent(content, this.settings);
        if (content !== sorted) {
          editor.setValue(sorted);
        }
      }
    });

    this.addCommand({
      id: 'sort-by-time-block',
      name: 'Sort all items by time block',
      editorCallback: (editor, view) => {
        const content = editor.getValue();
        const sorted = TaskSorter.sortByTimeBlock(content, this.settings);
        if (content !== sorted) {
          editor.setValue(sorted);
        }
      }
    });

    this.addCommand({
      id: 'show-task-info',
      name: 'Show task info for current line',
      editorCallback: (editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const taskId = TaskUtils.extractId(line);
        const parentId = TaskUtils.extractParentId(line);
        const taskText = TaskNoteManager.extractTaskTextFromLine(line);

        if (taskId || parentId) {
          this.showTaskInfo(taskId, parentId, taskText, editor, cursor.line);
        } else {
          new obsidian.Notice('No task metadata on this line');
        }
      }
    });

    // Task-specific commands (conditionally enabled via editorCheckCallback)
    // These integrate with Slash Commander and command palette
    this.addCommand({
      id: 'mark-task-complete',
      name: 'Mark task complete',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        if (!TaskUtils.isTask(line)) return false;
        if (checking) return true;
        const newLine = line.replace(/^([\t]*- \[)[^\]](\])/, '$1x$2');
        editor.setLine(cursor.line, newLine);
      }
    });

    this.addCommand({
      id: 'mark-task-in-progress',
      name: 'Mark task in progress',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        if (!TaskUtils.isTask(line)) return false;
        if (checking) return true;
        const newLine = line.replace(/^([\t]*- \[)[^\]](\])/, '$1/$2');
        editor.setLine(cursor.line, newLine);
      }
    });

    this.addCommand({
      id: 'mark-task-cancelled',
      name: 'Mark task cancelled',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        if (!TaskUtils.isTask(line)) return false;
        if (checking) return true;
        const newLine = line.replace(/^([\t]*- \[)[^\]](\])/, '$1-$2');
        editor.setLine(cursor.line, newLine);
      }
    });

    // Task Note Status Commands (for use with Buttons plugin in task notes)
    this.addCommand({
      id: 'set-status-complete',
      name: 'Set task status: Complete',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.path.startsWith(this.settings.taskNotesFolder + '/')) {
          new obsidian.Notice('This command only works in task notes');
          return;
        }
        await this.updateTaskNoteStatus(file, 'complete');
      }
    });

    this.addCommand({
      id: 'set-status-incomplete',
      name: 'Set task status: Incomplete',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.path.startsWith(this.settings.taskNotesFolder + '/')) {
          new obsidian.Notice('This command only works in task notes');
          return;
        }
        await this.updateTaskNoteStatus(file, 'incomplete');
      }
    });

    this.addCommand({
      id: 'set-status-in-progress',
      name: 'Set task status: In Progress',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.path.startsWith(this.settings.taskNotesFolder + '/')) {
          new obsidian.Notice('This command only works in task notes');
          return;
        }
        await this.updateTaskNoteStatus(file, 'in-progress');
      }
    });

    this.addCommand({
      id: 'set-status-cancelled',
      name: 'Set task status: Cancelled',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.path.startsWith(this.settings.taskNotesFolder + '/')) {
          new obsidian.Notice('This command only works in task notes');
          return;
        }
        await this.updateTaskNoteStatus(file, 'cancelled');
      }
    });

    this.addCommand({
      id: 'schedule-task',
      name: 'Schedule task',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        if (!TaskUtils.isTask(line)) return false;
        if (checking) return true;
        const popup = new ScheduleDatePopup(this, editor, cursor.line);
        popup.open();
      }
    });

    this.addCommand({
      id: 'unschedule-task',
      name: 'Unschedule task',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        // Must be a task
        if (!TaskUtils.isTask(line)) return false;
        // Must be scheduled (has [>] marker or [> DATE] tag)
        const hasScheduledMarker = /^[\t]*- \[>\]/.test(line);
        const hasScheduledTag = /\[>\s*\d{4}-\d{2}-\d{2}\]/.test(line);
        if (!hasScheduledMarker && !hasScheduledTag) return false;
        if (checking) return true;
        TaskScheduler.unscheduleTask(
          this.app,
          this.settings,
          editor,
          cursor.line
        );
      }
    });

    this.addCommand({
      id: 'set-time-block',
      name: 'Set time block',
      editorCheckCallback: (checking, editor, view) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        if (!TaskUtils.isTask(line)) return false;
        if (checking) return true;
        const popup = new TimePickerPopup(this, editor, cursor.line, 'start');
        popup.open();
      }
    });

    // Bulk scheduling commands for overdue tasks
    this.addCommand({
      id: 'schedule-overdue-to-today',
      name: 'Schedule all overdue tasks to today',
      callback: async () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        await BulkScheduler.scheduleAllOverdueTo(this.app, this.settings, today);
      }
    });

    this.addCommand({
      id: 'schedule-overdue-to-this-note',
      name: 'Schedule all overdue tasks to this note\'s date',
      checkCallback: (checking) => {
        // Only available when viewing a daily note
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;

        // Check if this is a daily note (YYYY-MM-DD.md in target folder)
        if (!TaskUtils.shouldProcessFile(activeFile, this.settings)) return false;
        const noteDate = BulkScheduler.parseDateFromFilename(activeFile.basename);
        if (!noteDate) return false;

        if (checking) return true;

        // Execute the bulk schedule
        BulkScheduler.scheduleAllOverdueTo(this.app, this.settings, noteDate);
      }
    });

    this.addCommand({
      id: 'archive-completed-tasks',
      name: 'Archive completed/scheduled tasks now',
      editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file || !TaskUtils.shouldProcessFile(file, this.settings)) {
          new obsidian.Notice('This command only works in target folders');
          return;
        }

        const content = editor.getValue();
        const archived = TaskArchiver.archiveContent(content, this.settings);

        if (archived !== content) {
          editor.setValue(archived);
          new obsidian.Notice('Tasks archived');
        } else {
          new obsidian.Notice('No tasks to archive');
        }
      }
    });

    // Add settings tab
    this.addSettingTab(new TaskManagerSettingTab(this.app, this));
  }

  onunload() {
    console.log('Task Manager: unloaded');
    // Clean up task note sync timers
    if (this.taskNoteSyncTimers) {
      for (const timer of this.taskNoteSyncTimers.values()) {
        clearTimeout(timer);
      }
      this.taskNoteSyncTimers.clear();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async processFile(file) {
    this.isProcessing = true;

    try {
      // Check if this file is open in the active editor
      const activeView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const activeFile = this.app.workspace.getActiveFile();
      const isActiveFile = activeView && activeFile && activeFile.path === file.path;

      let content;
      let editor;

      if (isActiveFile) {
        // Use editor API to avoid race conditions with typing
        editor = activeView.editor;
        content = editor.getValue();
      } else {
        // File not actively being edited, safe to use vault API
        content = await this.app.vault.read(file);
      }

      let modified = false;

      // Step 1: Assign IDs
      if (this.settings.enableTaskIds) {
        const updated = TaskIdManager.processContent(content, this.settings);
        if (updated !== content) {
          content = updated;
          modified = true;
        }
      }

      // Step 2: Link parent-child
      if (this.settings.enableParentChildLinking) {
        const updated = ParentChildLinker.linkContent(content, this.settings);
        if (updated !== content) {
          content = updated;
          modified = true;
        }
      }

      // Step 3: Sort (if auto-sort enabled)
      if (this.settings.enableAutoSort) {
        const updated = TaskSorter.sortContent(content, this.settings);
        if (updated !== content) {
          content = updated;
          modified = true;
        }
      }

      // Step 4: Archive completed/scheduled tasks (only for non-active files to avoid cursor disruption)
      if (this.settings.enableAutoArchive && !isActiveFile) {
        const updated = TaskArchiver.archiveContent(content, this.settings);
        if (updated !== content) {
          content = updated;
          modified = true;
        }
      }

      // Write changes
      if (modified) {
        if (isActiveFile && editor) {
          // Use line-by-line replacement to avoid disrupting cursor/selection
          const cursor = editor.getCursor();
          const currentLines = editor.getValue().split('\n');
          const newLines = content.split('\n');

          // Update all lines that changed (safe because 5-second debounce ensures user stopped typing)
          for (let i = 0; i < newLines.length; i++) {
            if (i < currentLines.length && currentLines[i] !== newLines[i]) {
              // For cursor line, use replaceRange to append at end without moving cursor
              if (i === cursor.line) {
                const oldLine = currentLines[i];
                const newLine = newLines[i];
                // Append the new content (ID/parent) at the end of the line
                if (newLine.length > oldLine.length && newLine.startsWith(oldLine.trimEnd())) {
                  const addition = newLine.slice(oldLine.trimEnd().length);
                  editor.replaceRange(addition, { line: i, ch: oldLine.length });
                }
              } else {
                editor.setLine(i, newLines[i]);
              }
            }
          }
        } else {
          await this.app.vault.modify(file, content);
        }
      }

      // Step 5: Sync task statuses to task notes (if enabled)
      // This runs after all other processing is complete
      if (this.settings.enableTaskStatusSync && !this.taskNoteSyncing) {
        await TaskNoteManager.syncAllStatusesToTaskNotes(this.app, file, this.settings);
      }
    } finally {
      // Reset flag after a short delay
      setTimeout(() => {
        this.isProcessing = false;
      }, 100);
    }
  }

  // Helper method to update task note status from commands/buttons
  async updateTaskNoteStatus(file, newStatus) {
    const content = await this.app.vault.read(file);
    const currentStatus = TaskNoteManager.extractFrontmatterField(content, 'status');

    if (currentStatus === newStatus) {
      new obsidian.Notice(`Status already set to ${newStatus}`);
      return;
    }

    // Update frontmatter status
    let updated = TaskNoteManager.updateFrontmatterField(content, 'status', newStatus);

    // Update button highlighting to match new status
    updated = this.updateButtonHighlighting(updated, newStatus);

    if (updated !== content) {
      await this.app.vault.modify(file, updated);
      new obsidian.Notice(`Status changed to ${newStatus}`);
      // The file modify handler will automatically sync to the daily note
    }
  }

  // Update meta-bind button styles so only the active status has style: primary
  updateButtonHighlighting(content, activeStatus) {
    // Map status names to button IDs
    const statusToButtonId = {
      'incomplete': 'btn-incomplete',
      'in-progress': 'btn-progress',
      'cancelled': 'btn-cancelled',
      'complete': 'btn-complete'
    };

    const activeButtonId = statusToButtonId[activeStatus];
    if (!activeButtonId) return content;

    // Find all meta-bind-button blocks and update their styles
    // Pattern matches the button block including the id line
    const buttonBlockRegex = /(```meta-bind-button\n(?:> )?label: "[^"]+"\n(?:> )?style: )(primary|default)(\n(?:> )?id: (btn-[a-z-]+))/g;

    return content.replace(buttonBlockRegex, (match, prefix, currentStyle, suffix, buttonId) => {
      const newStyle = (buttonId === activeButtonId) ? 'primary' : 'default';
      return prefix + newStyle + suffix;
    });
  }

  // Process a single line when cursor leaves it (add ID, parent link)
  processLineOnLeave(lineNum) {
    const activeView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!activeView) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !TaskUtils.shouldProcessFile(activeFile, this.settings)) return;

    const editor = activeView.editor;
    const line = editor.getLine(lineNum);
    if (!line) return;

    // Only process task lines (but NOT calendar events)
    if (!TaskUtils.isTask(line)) return;
    if (TaskUtils.isCalendarEvent(line)) return;

    let newLine = line;
    let modified = false;

    // Add ID if missing
    if (this.settings.enableTaskIds && !TaskUtils.extractId(line)) {
      newLine = TaskUtils.addId(newLine, TaskUtils.generateId(this.settings));
      modified = true;
    }

    // Add parent link if this is a subtask
    if (this.settings.enableParentChildLinking && TaskUtils.isSubtask(line)) {
      // Find parent task (look backwards for a non-indented task)
      let parentId = null;
      for (let i = lineNum - 1; i >= 0; i--) {
        const prevLine = editor.getLine(i);
        if (TaskUtils.isParentTask(prevLine)) {
          parentId = TaskUtils.extractId(prevLine);
          break;
        }
      }

      if (parentId && !TaskUtils.extractParentId(newLine)) {
        newLine = TaskUtils.addParentId(newLine, parentId);
        modified = true;
      }
    }

    // Normalize metadata ordering (ensure all fields are at end of line)
    const normalized = TaskUtils.normalizeMetadataOrder(newLine);
    if (normalized !== newLine) {
      newLine = normalized;
      modified = true;
    }

    if (modified) {
      this.isProcessing = true;
      editor.setLine(lineNum, newLine);
      setTimeout(() => { this.isProcessing = false; }, 50);
    }
  }

  showTaskInfo(taskId, parentId, taskText, editor, lineNum, uid, isCalendarEvent, calendarSource) {
    // Find parent task text by ID if we have a parentId
    let parentText = null;
    if (parentId) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        // Get the current document content to search for parent
        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (view && view.editor) {
          const content = view.editor.getValue();
          const lines = content.split('\n');
          for (const line of lines) {
            const lineId = TaskUtils.extractId(line);
            if (lineId === parentId) {
              parentText = TaskNoteManager.extractTaskTextFromLine(line);
              break;
            }
          }
        }
      }
    }

    const modal = new TaskInfoModal(this.app, taskId, parentId, taskText, parentText, () => {
      if (editor && lineNum !== undefined) {
        const line = editor.getLine(lineNum);
        const newLine = TaskUtils.removeParentId(line);
        editor.setLine(lineNum, newLine);
        new obsidian.Notice('Task unlinked from parent');
      }
    }, uid, isCalendarEvent, calendarSource);
    modal.open();
  }

  // Show schedule popup positioned relative to a widget element
  showSchedulePopupFromWidget(anchorEl, lineNum) {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.editor) return;

    const editor = view.editor;
    const popup = new ScheduleDatePopupFromWidget(this, editor, lineNum, anchorEl);
    popup.open();
  }

  // Show timeblock picker positioned relative to a widget element
  showTimeblockPickerFromWidget(anchorEl, lineNum) {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.editor) return;

    const editor = view.editor;
    const popup = new TimePickerPopupFromWidget(this, editor, lineNum, 'start', null, null, anchorEl);
    popup.open();
  }
}

module.exports = TaskManagerPlugin;
