import { Notice, TFile } from 'obsidian';
import type { App, Editor } from 'obsidian';
import { extractId, isSubtask, isTask } from '../utils/task-utils';
import {
  extractTaskTextFromLine,
  sanitizeFilename,
  updateTaskNoteSourceFile
} from './task-note-manager';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK SCHEDULER MODULE
// ============================================================================

// Remove existing scheduling tags from a line
export function removeSchedulingTags(line: string): string {
  return line
    // Text format: >[[DATE]] and <[[DATE]]
    .replace(/\s*>\[\[\d{4}-\d{2}-\d{2}\]\]/g, '')
    .replace(/\s*<\[\[\d{4}-\d{2}-\d{2}\]\]/g, '')
    // Dataview wikilink format
    .replace(/\s*\[scheduled_from::\s*\[\[[^\]]*\]\]\]/g, '')
    .replace(/\s*\[scheduled_to::\s*\[\[[^\]]*\]\]\]/g, '')
    // Previous bracket format
    .replace(/\s*\[<\s*\d{4}-\d{2}-\d{2}\]/g, '')
    .replace(/\s*\[>\s*\d{4}-\d{2}-\d{2}\]/g, '')
    // Legacy format cleanup
    .replace(/\s*\[sch_from::[^\]]+\]/g, '')
    .replace(/\s*\[sch_to::[^\]]+\]/g, '')
    .replace(/\s*📅\s*\[\[[^\]]+\]\]/g, '')
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '');
}

// Get current date in YYYY-MM-DD format
export function getCurrentDate(): string {
  return new Date().toISOString().split('T')[0];
}

// Get the daily note path for a given date
export function getDailyNotePath(date: string, settings: TaskManagerSettings): string {
  // Use the first target folder as the daily notes folder
  const dailyFolder = settings.targetFolders[0];
  const folder = dailyFolder.replace(/\/$/, '');
  return `${folder}/${date}.md`;
}

// Create the scheduled copy of a task (for the target date)
export function createScheduledTaskCopy(line: string, fromDate: string): string {
  // Remove the [>] marker and restore to [ ] for the copy
  let taskCopy = line.replace(/^([\t]*- \[)[^\]](\])/, '$1 $2');
  // Remove any existing scheduling tags and calendar icons
  taskCopy = removeSchedulingTags(taskCopy);
  // Keep the task ID (same task, different date)
  // Keep parent tags to preserve parent-child relationships
  // Add schedule-from tag with wikilink date
  taskCopy = taskCopy.trimEnd() + ` <[[${fromDate}]]`;
  return taskCopy;
}

// Mark the original task as scheduled
export function markTaskAsScheduled(line: string, toDate: string): string {
  // Change marker to [>]
  let newLine = line.replace(/^([\t]*- \[)[^\]](\])/, '$1>$2');
  // Remove time block (e.g., "13:45 - 15:15 " at start of task text)
  newLine = newLine.replace(/^([\t]*- \[.\]\s*)\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*/, '$1');
  // Remove any existing scheduling tags
  newLine = removeSchedulingTags(newLine);
  // Add schedule-to tag with wikilink date
  newLine = newLine.trimEnd() + ` >[[${toDate}]]`;
  return newLine;
}

// Extract target date from >[[YYYY-MM-DD]] or legacy formats
export function extractScheduledToDate(line: string): string | null {
  // Text format: >[[YYYY-MM-DD]]
  let match = line.match(/>\[\[(\d{4}-\d{2}-\d{2})\]\]/);
  if (match) return match[1];
  // Dataview wikilink format
  match = line.match(/\[scheduled_to::\s*\[\[(\d{4}-\d{2}-\d{2})\]\]\]/);
  if (match) return match[1];
  // Legacy bracket format
  match = line.match(/\[>\s*(\d{4}-\d{2}-\d{2})\]/);
  return match ? match[1] : null;
}

// Check if a task is scheduled away (has [>] checkbox)
export function isScheduledAway(line: string): boolean {
  return /^[\t]*- \[>\]/.test(line);
}

// Reset a scheduled task back to actionable state
// Changes [>] to [ ] and removes scheduling tags
export function resetScheduledTask(line: string): string {
  // Change [>] marker back to [ ]
  let newLine = line.replace(/^([\t]*- \[)>(\])/, '$1 $2');
  // Remove all scheduling tags
  newLine = removeSchedulingTags(newLine);
  return newLine;
}

// ============================================================================
// SCHEDULE TASK TO TARGET DATE
// ============================================================================
//
// This is the main scheduling function. When a user schedules a task:
//
// 1. ORIGINAL TASK (current daily note):
//    - Marker changes from [ ] to [>] (indicating "scheduled away")
//    - Time block is removed (task no longer occupies time today)
//    - Field [scheduled_to:: [[YYYY-MM-DD]]] is added showing where it went
//
// 2. TASK AT TARGET (target daily note):
//    - If task (by ID) already exists there: UPDATE its scheduled_from field
//    - If task doesn't exist there: APPEND new copy with scheduled_from field
//    - The scheduled_from field always shows the MOST RECENT source (where it came from)
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

export async function scheduleTask(
  app: App,
  settings: TaskManagerSettings,
  editor: Editor,
  lineNum: number,
  targetDate: string
): Promise<boolean> {
  // Re-read the line fresh (it may have changed since modal opened)
  const line = editor.getLine(lineNum);
  if (!isTask(line)) {
    new Notice('Not a task line');
    return false;
  }

  // Check if already scheduled to this date
  if (line.includes(`>[[${targetDate}]]`) || line.includes(`[scheduled_to:: [[${targetDate}]]]`) || line.includes(`[> ${targetDate}]`)) {
    new Notice('Task already scheduled to this date');
    return false;
  }

  // Get the current file's date as the "from" date
  // This is the date we're scheduling FROM, not necessarily today's calendar date
  const activeFile = app.workspace.getActiveFile();
  const fromDate = activeFile ? activeFile.basename : getCurrentDate();

  const targetPath = getDailyNotePath(targetDate, settings);

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
    new Notice(`Created daily note: ${targetDate}`);
  }

  if (!(targetFile instanceof TFile)) {
    new Notice('Target is not a file');
    return false;
  }

  // Extract task ID to check for existing copy in target
  const taskId = extractId(line);

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
        updatedLine = removeSchedulingTags(updatedLine);
        // Add schedule-from tag with wikilink date
        updatedLine = updatedLine.trimEnd() + ` <[[${fromDate}]]`;
        lines[i] = updatedLine;
        break;
      }
    }
    targetContent = lines.join('\n');
  } else {
    // -----------------------------------------------------------------------
    // TASK DOESN'T EXIST IN TARGET - Append new copy
    // -----------------------------------------------------------------------
    const taskCopy = createScheduledTaskCopy(line, fromDate);
    targetContent = targetContent.trimEnd() + '\n' + taskCopy;
  }

  // Write updated target file
  await app.vault.modify(targetFile, targetContent);

  // Mark the original task as scheduled (update in place)
  const updatedLine = markTaskAsScheduled(line, targetDate);
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
    if (isSubtask(subtaskLine)) {
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
  const taskText = extractTaskTextFromLine(line);
  if (taskText) {
    await updateTaskNoteSourceFile(
      app,
      settings,
      taskText,
      targetPath,
      targetDate  // Pass the scheduled date for the scheduled field
    );
  }

  new Notice(`Task scheduled to ${targetDate}`);
  return true;
}

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

export async function unscheduleTask(
  app: App,
  settings: TaskManagerSettings,
  editor: Editor,
  lineNum: number
): Promise<boolean> {
  const line = editor.getLine(lineNum);

  // Validate: must be a task
  if (!isTask(line)) {
    new Notice('Not a task line');
    return false;
  }

  // Validate: must be scheduled away (has [>] marker or [> DATE] tag)
  const targetDate = extractScheduledToDate(line);
  const hasScheduledMarker = isScheduledAway(line);

  if (!targetDate && !hasScheduledMarker) {
    new Notice('Task is not scheduled');
    return false;
  }

  const taskId = extractId(line);
  const activeFile = app.workspace.getActiveFile();
  const currentFilePath = activeFile ? activeFile.path : null;
  const currentDate = activeFile ? activeFile.basename : getCurrentDate();

  // -----------------------------------------------------------------------
  // STEP 1: Reset the current task
  // -----------------------------------------------------------------------
  const updatedLine = resetScheduledTask(line);
  editor.setLine(lineNum, updatedLine);

  // -----------------------------------------------------------------------
  // STEP 2: Reset subtasks (change [>] back to [ ])
  // -----------------------------------------------------------------------
  const totalLines = editor.lineCount();
  for (let i = lineNum + 1; i < totalLines; i++) {
    const subtaskLine = editor.getLine(i);
    if (isSubtask(subtaskLine)) {
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
    const targetPath = getDailyNotePath(targetDate, settings);
    const targetFile = app.vault.getAbstractFileByPath(targetPath);

    if (targetFile && targetFile instanceof TFile) {
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
          if (isSubtask(lines[i])) {
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
  const taskText = extractTaskTextFromLine(line);
  if (taskText && currentFilePath) {
    await updateTaskNoteForUnschedule(
      app,
      settings,
      taskText,
      currentFilePath,
      currentDate
    );
  }

  new Notice('Task unscheduled');
  return true;
}

// Update task note when unscheduling - point sourceFile back to current file
export async function updateTaskNoteForUnschedule(
  app: App,
  settings: TaskManagerSettings,
  taskText: string,
  currentFilePath: string,
  currentDate: string
): Promise<boolean> {
  const sanitizedName = sanitizeFilename(taskText);
  if (!sanitizedName) return false;

  const filePath = `${settings.taskNotesFolder}/${sanitizedName}.md`;
  const file = app.vault.getAbstractFileByPath(filePath);

  if (!file || !(file instanceof TFile)) {
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
