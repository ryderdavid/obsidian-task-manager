import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { extractId, extractParentId, isCalendarEvent, isSubtask } from '../utils/task-utils';
import { createScheduledTaskCopy, getDailyNotePath, markTaskAsScheduled, removeSchedulingTags } from './task-scheduler';
import { extractTaskTextFromLine, updateTaskNoteSourceFile } from './task-note-manager';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// BULK SCHEDULER MODULE - Schedule all overdue tasks
// ============================================================================

// Pattern for actionable tasks: incomplete [ ] or in-progress [/]
const INCOMPLETE_TASK_PATTERN = /^[\t]*- \[[ /]\]/;

type OverdueTask = {
  file: TFile;
  fileDate: string;
  line: string;
  lineNum: number;
  taskId: string | null;
  parentId: string | null;
};

type TaskCopy = {
  text: string;
  taskId: string | null;
  parentId: string | null;
  isSubtask: boolean;
};

// Check if a task is incomplete (actionable)
export function isIncompleteTask(line: string): boolean {
  return INCOMPLETE_TASK_PATTERN.test(line);
}

// Parse date from daily note filename (YYYY-MM-DD.md)
export function parseDateFromFilename(filename: string): Date | null {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
}

// Get all daily note files from target folders
export async function getDailyNoteFiles(app: App, settings: TaskManagerSettings): Promise<Array<{ file: TFile; date: Date; basename: string }>> {
  const files: Array<{ file: TFile; date: Date; basename: string }> = [];
  const targetFolders = settings.targetFolders;

  for (const folder of targetFolders) {
    const folderPath = folder.replace(/\/$/, '');
    const abstractFolder = app.vault.getAbstractFileByPath(folderPath);
    if (!abstractFolder) continue;

    // Get all markdown files in the folder
    const allFiles = app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      if (file.path.startsWith(folderPath + '/') && file.path.endsWith('.md')) {
        const date = parseDateFromFilename(file.basename);
        if (date) {
          files.push({ file, date, basename: file.basename });
        }
      }
    }
  }

  return files;
}

// Find all overdue incomplete tasks across daily notes before targetDate
export async function findOverdueTasks(app: App, settings: TaskManagerSettings, targetDate: Date): Promise<OverdueTask[]> {
  const dailyNotes = await getDailyNoteFiles(app, settings);
  const overdueTasks: OverdueTask[] = [];

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
      if (isIncompleteTask(line) && !isCalendarEvent(line)) {
        overdueTasks.push({
          file,
          fileDate: basename,
          line,
          lineNum: i,
          taskId: extractId(line),
          parentId: extractParentId(line)
        });
      }
    }
  }

  return overdueTasks;
}

// Schedule all overdue tasks to a target date
export async function scheduleAllOverdueTo(app: App, settings: TaskManagerSettings, targetDate: Date): Promise<number> {
  const targetDateStr = targetDate.toISOString().split('T')[0];
  const overdueTasks = await findOverdueTasks(app, settings, targetDate);

  if (overdueTasks.length === 0) {
    new Notice('No overdue tasks found');
    return 0;
  }

  let scheduledCount = 0;

  // Group tasks by source file to batch file modifications
  const tasksByFile = new Map<string, OverdueTask[]>();
  for (const task of overdueTasks) {
    if (!tasksByFile.has(task.file.path)) {
      tasksByFile.set(task.file.path, []);
    }
    const bucket = tasksByFile.get(task.file.path);
    if (bucket) {
      bucket.push(task);
    }
  }

  // Get or create the target daily note
  const targetPath = getDailyNotePath(targetDateStr, settings);
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

  if (!(targetFile instanceof TFile)) {
    new Notice('Could not access target daily note');
    return 0;
  }

  // Read target file content
  let targetContent = await app.vault.read(targetFile);

  // Collect new task copies for batch insertion (enables parent-child ordering)
  const newTaskCopies: TaskCopy[] = [];

  // Process each source file
  for (const [filePath, tasks] of tasksByFile) {
    const sourceFile = app.vault.getAbstractFileByPath(filePath);
    if (!sourceFile || !(sourceFile instanceof TFile)) continue;

    let sourceContent = await app.vault.read(sourceFile);
    const sourceLines = sourceContent.split('\n');
    const fromDate = sourceFile.basename;

    // Process tasks in reverse order to maintain line numbers
    const sortedTasks = tasks.sort((a, b) => b.lineNum - a.lineNum);

    for (const task of sortedTasks) {
      const line = sourceLines[task.lineNum];
      if (!line || !isIncompleteTask(line)) continue;

      const taskId = extractId(line);

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
            updatedLine = removeSchedulingTags(updatedLine);
            // Add schedule-from tag with wikilink date
            updatedLine = updatedLine.trimEnd() + ` <[[${fromDate}]]`;
            targetLines[i] = updatedLine;
            break;
          }
        }
        targetContent = targetLines.join('\n');
      } else {
        // Collect new copy for batch insertion (ordered by parent-child)
        const taskCopy = createScheduledTaskCopy(line, fromDate);
        newTaskCopies.push({
          text: taskCopy,
          taskId: task.taskId,
          parentId: extractParentId(line),
          isSubtask: isSubtask(line)
        });
      }

      // Mark original as scheduled
      sourceLines[task.lineNum] = markTaskAsScheduled(line, targetDateStr);
      scheduledCount++;

      // Update task note if exists
      const taskText = extractTaskTextFromLine(line);
      if (taskText) {
        await updateTaskNoteSourceFile(
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

  // Build ordered task block (parents before children) and insert under header
  const taskBlock = buildOrderedTaskBlock(newTaskCopies);
  if (taskBlock.length > 0) {
    targetContent = insertUnderHeader(targetContent, taskBlock, settings.overdueTasksTargetHeader);
  }

  // Write updated target file
  await app.vault.modify(targetFile, targetContent);

  new Notice(`Scheduled ${scheduledCount} overdue task(s) to ${targetDateStr}`);
  return scheduledCount;
}

// Build an ordered block of task lines, ensuring parents come before children
export function buildOrderedTaskBlock(taskCopies: TaskCopy[]): string[] {
  const parents: TaskCopy[] = [];
  const children: TaskCopy[] = [];

  for (const task of taskCopies) {
    if (task.parentId) {
      children.push(task);
    } else {
      parents.push(task);
    }
  }

  const result: string[] = [];
  const usedChildren = new Set<TaskCopy>();

  // Emit each parent followed by its children
  for (const parent of parents) {
    result.push(parent.text);
    if (parent.taskId) {
      for (const child of children) {
        if (child.parentId === parent.taskId) {
          // Ensure child is tab-indented
          const childText = child.text.startsWith('\t')
            ? child.text
            : '\t' + child.text;
          result.push(childText);
          usedChildren.add(child);
        }
      }
    }
  }

  // Append orphan children (parent not in this batch)
  for (const child of children) {
    if (!usedChildren.has(child)) {
      const childText = child.text.startsWith('\t')
        ? child.text
        : '\t' + child.text;
      result.push(childText);
    }
  }

  return result;
}

// Insert task lines under a specific header in the content
export function insertUnderHeader(content: string, taskLines: string[], headerSetting: string): string {
  // If no header configured, append to end (backward compat)
  if (!headerSetting) {
    return content.trimEnd() + '\n' + taskLines.join('\n');
  }

  const lines = content.split('\n');
  const headerLevel = (headerSetting.match(/^#+/) || [''])[0].length;
  const escapedHeader = headerSetting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp('^' + escapedHeader + '\\s*$');

  // Find the header line
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerPattern.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    // Header not found - fall back to append
    console.warn(`Task Manager: header "${headerSetting}" not found in target note, appending to end`);
    return content.trimEnd() + '\n' + taskLines.join('\n');
  }

  // Find insertion point: after the last task line under this header,
  // stopping at code fences, next headers, or other structural content
  let insertIndex = headerIndex + 1;
  const nextHeaderPattern = headerLevel > 0
    ? new RegExp('^#{1,' + headerLevel + '}\\s')
    : null;
  let lastTaskIndex = -1;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const ln = lines[i];
    // Stop at next header of same or higher level
    if (nextHeaderPattern && nextHeaderPattern.test(ln)) break;
    // Stop at code fences (``` blocks)
    if (ln.trim().startsWith('```')) break;
    // Track last task line (including indented subtasks)
    if (/^[\t]*- \[.\]/.test(ln)) {
      lastTaskIndex = i;
    }
  }

  if (lastTaskIndex >= 0) {
    // Insert after the last task line
    insertIndex = lastTaskIndex + 1;
  } else {
    // No tasks yet under header — insert right after the header
    insertIndex = headerIndex + 1;
    // Skip past any blank lines immediately after the header
    while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
      insertIndex++;
    }
    // But if we hit a code fence or another header, back up to right after header
    if (insertIndex > headerIndex + 1) {
      insertIndex = headerIndex + 1;
    }
  }

  // Insert task lines
  lines.splice(insertIndex, 0, ...taskLines);

  return lines.join('\n');
}
