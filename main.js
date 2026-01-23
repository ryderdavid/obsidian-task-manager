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
  taskNotesFolder: 'Task Notes'
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
  METADATA_PATTERN: /\s*\[(?:id|parent)::[^\]]+\]/g,
  COMPLETED_PATTERN: /^[\t]*- \[[xX]\]/,
  TIMEBLOCK_PATTERN: /^- \[.\]\s*(\d{2}):(\d{2}) - (\d{2}):(\d{2})/,

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

  removeParentId(line) {
    return line.replace(/\s*\[parent::[^\]]+\]/, '');
  },

  isTask(line) {
    return this.TASK_PATTERN.test(line);
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
// TASK ID MANAGER MODULE
// ============================================================================

const TaskIdManager = {
  processContent(content, settings) {
    const lines = content.split('\n');
    const result = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

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

  async openOrCreateTaskNote(app, settings, taskText, sourceFilePath) {
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

    let file = app.vault.getAbstractFileByPath(filePath);
    const isNewFile = !file;

    if (!file) {
      const subtasksContent = subtasksFromSource.length > 0
        ? subtasksFromSource.map(st => `- [${st.completed ? 'x' : ' '}] ${st.text}`).join('\n')
        : '- [ ] ';

      const sourceLink = sourceFilePath ? `[[${sourceFilePath.replace(/\.md$/, '')}]]` : '';

      const content = `---
task: "${taskText.replace(/"/g, '\\"')}"
created: ${new Date().toISOString().split('T')[0]}
sourceFile: "${sourceFilePath || ''}"
---

# ${taskText}

**Source:** ${sourceLink}

---

## Notes


## Subtasks

${subtasksContent}

## References

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

  // Schedule a task to a target date
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

    const currentDate = this.getCurrentDate();
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

    // Create the task copy for the target date
    const taskCopy = this.createScheduledTaskCopy(line, currentDate);

    // First, mark the original task as scheduled (update in place)
    const updatedLine = this.markTaskAsScheduled(line, targetDate);
    editor.setLine(lineNum, updatedLine);

    // Then append the copy to the target daily note
    const targetContent = await app.vault.read(targetFile);
    const newTargetContent = targetContent.trimEnd() + '\n' + taskCopy;
    await app.vault.modify(targetFile, newTargetContent);

    new obsidian.Notice(`Task scheduled to ${targetDate}`);
    return true;
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
// SLASH COMMAND SUGGEST
// ============================================================================

// SVG icons (Font Awesome style)
const SLASH_COMMAND_ICONS = {
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"/></svg>',
  halfCircle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M448 256c0-106-86-192-192-192V448c106 0 192-86 192-192zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  ban: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  anglesRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M470.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L402.7 256 265.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160zm-352 160l160-160c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L210.7 256 73.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0z"/></svg>'
};

const SLASH_COMMANDS = [
  { id: 'complete', label: 'Mark Complete', icon: SLASH_COMMAND_ICONS.check, marker: 'x' },
  { id: 'in-progress', label: 'Mark In Progress', icon: SLASH_COMMAND_ICONS.halfCircle, marker: '/' },
  { id: 'cancelled', label: 'Mark Cancelled', icon: SLASH_COMMAND_ICONS.ban, marker: '-' },
  { id: 'schedule', label: 'Schedule Task', icon: SLASH_COMMAND_ICONS.anglesRight, action: 'schedule' }
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
    }
  }

  openSchedulePopup(editor, lineNum) {
    const popup = new ScheduleDatePopup(this.plugin, editor, lineNum);
    popup.open();
  }
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
// UI COMPONENTS
// ============================================================================

// Widget for the task note button
class TaskNoteButtonWidget extends WidgetType {
  constructor(taskText, plugin) {
    super();
    this.taskText = taskText;
    this.plugin = plugin;
  }

  toDOM() {
    const btn = document.createElement('span');
    btn.className = 'task-note-button';
    btn.textContent = '📝 notes';
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
        sourceFilePath
      );
    });
    return btn;
  }

  eq(other) {
    return other.taskText === this.taskText;
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
  constructor(app, taskId, parentId, taskText, parentText, onUnlink) {
    super(app);
    this.taskId = taskId;
    this.parentId = parentId;
    this.taskText = taskText;
    this.parentText = parentText;
    this.onUnlink = onUnlink;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-info-modal');

    contentEl.createEl('h3', { text: 'Task Information' });

    const infoContainer = contentEl.createDiv({ cls: 'task-info-content' });

    if (this.taskId) {
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

    // Debounce timer
    this.debounceTimer = null;
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
          const metadataPattern = /\s*\[(?:id|parent)::\s*[^\]]+\]/g;
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

                // Handle schedule-to tags [> YYYY-MM-DD]
                let scheduleToMatch;
                scheduleToPattern.lastIndex = 0;
                while ((scheduleToMatch = scheduleToPattern.exec(lineText)) !== null) {
                  const start = line.from + scheduleToMatch.index;
                  const end = start + scheduleToMatch[0].length;
                  const date = scheduleToMatch[1];
                  // Hide the raw tag
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                  // Add pill widget at end of line
                  decorations.push({
                    from: line.to,
                    to: line.to,
                    value: Decoration.widget({
                      widget: new ScheduledToPillWidget(date, plugin),
                      side: 0
                    })
                  });
                }

                // Handle schedule-from tags [< YYYY-MM-DD]
                let scheduleFromMatch;
                scheduleFromPattern.lastIndex = 0;
                while ((scheduleFromMatch = scheduleFromPattern.exec(lineText)) !== null) {
                  const start = line.from + scheduleFromMatch.index;
                  const end = start + scheduleFromMatch[0].length;
                  const date = scheduleFromMatch[1];
                  // Hide the raw tag
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                  // Add pill widget at end of line
                  decorations.push({
                    from: line.to,
                    to: line.to,
                    value: Decoration.widget({
                      widget: new ScheduledFromPillWidget(date, plugin),
                      side: 0
                    })
                  });
                }

                // Handle legacy schedule-to tags [sch_to::DATE]
                let legacyToMatch;
                legacyScheduleToPattern.lastIndex = 0;
                while ((legacyToMatch = legacyScheduleToPattern.exec(lineText)) !== null) {
                  const start = line.from + legacyToMatch.index;
                  const end = start + legacyToMatch[0].length;
                  const date = legacyToMatch[1];
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                  decorations.push({
                    from: line.to,
                    to: line.to,
                    value: Decoration.widget({
                      widget: new ScheduledToPillWidget(date, plugin),
                      side: 0
                    })
                  });
                }

                // Handle legacy schedule-from tags [sch_from::DATE]
                let legacyFromMatch;
                legacyScheduleFromPattern.lastIndex = 0;
                while ((legacyFromMatch = legacyScheduleFromPattern.exec(lineText)) !== null) {
                  const start = line.from + legacyFromMatch.index;
                  const end = start + legacyFromMatch[0].length;
                  const date = legacyFromMatch[1];
                  decorations.push({
                    from: start,
                    to: end,
                    value: Decoration.replace({})
                  });
                  decorations.push({
                    from: line.to,
                    to: line.to,
                    value: Decoration.widget({
                      widget: new ScheduledFromPillWidget(date, plugin),
                      side: 0
                    })
                  });
                }

                // Add task note button for parent tasks (not in task notes folder)
                if (plugin.settings.enableTaskNotes && isParentTask && !inTaskNotesFolder) {
                  const taskText = TaskNoteManager.extractTaskTextFromLine(lineText);
                  if (taskText && taskText.trim() !== '') {
                    decorations.push({
                      from: line.to,
                      to: line.to,
                      value: Decoration.widget({
                        widget: new TaskNoteButtonWidget(taskText, plugin),
                        side: 1
                      })
                    });
                  }
                }

                // Add info button if enabled and there's metadata
                if (plugin.settings.showInfoButton && (taskId || parentId)) {
                  // Extract clean task text for display in modal
                  const infoTaskText = TaskNoteManager.extractTaskTextFromLine(lineText);
                  decorations.push({
                    from: line.to,
                    to: line.to,
                    value: Decoration.widget({
                      widget: new InfoButtonWidget(taskId, parentId, infoTaskText, plugin),
                      side: 2
                    })
                  });
                }
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
              } finally {
                setTimeout(() => { this.taskNoteSyncing = false; }, 100);
              }
            }, 500));
          }
          return;
        }

        // Handle regular task processing with 5-second debounce (safety net)
        if (!TaskUtils.shouldProcessFile(file, this.settings)) return;

        // Clear existing timer - resets on every keystroke
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        // 5-second debounce: only fires when user stops typing for 5 seconds
        this.debounceTimer = setTimeout(() => {
          this.processFile(file);
        }, 5000);
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

    // Add settings tab
    this.addSettingTab(new TaskManagerSettingTab(this.app, this));
  }

  onunload() {
    console.log('Task Manager: unloaded');
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
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
    } finally {
      // Reset flag after a short delay
      setTimeout(() => {
        this.isProcessing = false;
      }, 100);
    }
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

    // Only process task lines
    if (!TaskUtils.isTask(line)) return;

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

    if (modified) {
      this.isProcessing = true;
      editor.setLine(lineNum, newLine);
      setTimeout(() => { this.isProcessing = false; }, 50);
    }
  }

  showTaskInfo(taskId, parentId, taskText, editor, lineNum) {
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
    });
    modal.open();
  }
}

module.exports = TaskManagerPlugin;
