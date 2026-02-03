import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { CALENDAR_EVENT_PATTERN, extractId } from '../utils/task-utils';
import type { TaskManagerSettings } from '../types';

// ============================================================================
// TASK NOTE MANAGER MODULE
// ============================================================================

type TaskExtraFields = {
  parent?: string;
  scheduledFrom?: string;
  scheduledTo?: string;
  tags?: string[];
};

type Subtask = { text: string; completed: boolean; originalLine?: string };

export function cleanTaskText(text: string): string {
  // Remove time ranges like "15:30 - 15:45"
  text = text.replace(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*/g, '');
  // Remove dates in various formats
  text = text.replace(/📅\s*\[\[[^\]]+\]\]/g, '');
  text = text.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '');
  // Remove tags
  text = text.replace(/#\w+/g, '');
  // Remove task note chain link
  text = text.replace(/🔗\[\[[^\]]+\]\]/g, '');
  // Remove schedule tags >[[DATE]] and <[[DATE]] (must come before wikilink handling)
  text = text.replace(/\s*[><]\[\[\d{4}-\d{2}-\d{2}\]\]/g, '');
  // Remove wiki links but keep display text
  text = text.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m: string, link: string, display: string) => display || link);
  // Remove task metadata emojis
  text = text.replace(/[📅🗓️⏳🛫✅❌➕🔺⏫🔼🔽⏬🆔⛔🔁][^\s]*/g, '');
  // Remove button icons
  text = text.replace(/📝/g, '');
  text = text.replace(/🔗/g, '');
  // Remove Dataview wikilink schedule fields (must come before generic inline field removal)
  text = text.replace(/\s*\[scheduled_(?:to|from)::\s*\[\[[^\]]*\]\]\]/g, '');
  // Remove inline fields (dataview style)
  text = text.replace(/\s*\[[^\]]+::[^\]]*\]/g, '');
  // Remove legacy schedule tags [> DATE] and [< DATE]
  text = text.replace(/\s*\[[<>]\s*\d{4}-\d{2}-\d{2}\]/g, '');
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function sanitizeFilename(text: string): string {
  return text
    .replace(/[\\/:*?"<>|#\[\]]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

export function extractTaskTextFromLine(line: string): string | null {
  // Match any task marker (space, x, >, /, -, etc.)
  // Also match tasks in callouts (prefixed with "> ") for archive support
  const taskMatch = line.match(/^(?:>\s*)?- \[.\]\s*(.+)$/);
  if (!taskMatch) return null;
  return cleanTaskText(taskMatch[1]);
}

export function extractCheckboxMarker(line: string): string | null {
  // Extract the character inside the checkbox brackets
  const match = line.match(/^[\t]*- \[(.)\]/);
  return match ? match[1] : null;
}

export function checkboxToStatus(marker: string, settings: TaskManagerSettings): string {
  return settings.statusMappings[marker] || 'incomplete';
}

export function statusToCheckbox(status: string, settings: TaskManagerSettings): string {
  // Reverse lookup: find marker for status name
  for (const [marker, name] of Object.entries(settings.statusMappings)) {
    if (name === status) return marker;
  }
  return ' ';
}

export function extractFrontmatterField(content: string, fieldName: string): string | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const frontmatter = frontmatterMatch[1];
  const fieldMatch = frontmatter.match(new RegExp(`^${fieldName}:\\s*"?([^"\\n]*)"?`, 'm'));
  return fieldMatch ? fieldMatch[1] : null;
}

export function updateFrontmatterField(content: string, fieldName: string, newValue: string): string {
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
}

export function updateTaskCheckbox(content: string, taskId: string, newMarker: string): string {
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
}

export async function findTaskNoteByTaskId(app: App, taskId: string, settings: TaskManagerSettings): Promise<TFile | null> {
  const folder = settings.taskNotesFolder;
  const files = app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));

  for (const file of files) {
    const content = await app.vault.read(file);
    const noteTaskId = extractFrontmatterField(content, 'taskId');
    if (noteTaskId === taskId) {
      return file;
    }
  }
  return null;
}

// ============================================================================
// BIDIRECTIONAL STATUS SYNC
// ============================================================================

/**
 * Sync status from task note frontmatter back to daily note checkbox
 * Called when task note is modified
 */
export async function syncStatusToSource(app: App, taskNote: TFile, settings: TaskManagerSettings): Promise<void> {
  if (!settings.enableTaskStatusSync) return;

  const content = await app.vault.read(taskNote);
  const taskId = extractFrontmatterField(content, 'taskId');
  const status = extractFrontmatterField(content, 'status');
  const sourceFile = extractFrontmatterField(content, 'sourceFile');

  if (!taskId || !status || !sourceFile) return;

  const source = app.vault.getAbstractFileByPath(sourceFile);
  if (!source || !(source instanceof TFile)) return;

  const targetMarker = statusToCheckbox(status, settings);
  const sourceContent = await app.vault.read(source);

  // Find the current marker for this task
  const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
  const lines = sourceContent.split('\n');
  for (const line of lines) {
    if (idPattern.test(line)) {
      const currentMarker = extractCheckboxMarker(line);
      if (currentMarker === targetMarker) {
        // No change needed
        return;
      }
      break;
    }
  }

  // Update the checkbox in the source file
  const updated = updateTaskCheckbox(sourceContent, taskId, targetMarker);
  if (updated !== sourceContent) {
    await app.vault.modify(source, updated);
  }
}

/**
 * Sync status from daily note checkbox to task note frontmatter
 * Called when daily note is modified
 */
export async function syncStatusToTaskNote(app: App, taskId: string, newMarker: string, settings: TaskManagerSettings): Promise<void> {
  if (!settings.enableTaskStatusSync) return;

  const taskNote = await findTaskNoteByTaskId(app, taskId, settings);
  if (!taskNote) return;

  const newStatus = checkboxToStatus(newMarker, settings);
  const content = await app.vault.read(taskNote);
  const currentStatus = extractFrontmatterField(content, 'status');

  if (currentStatus === newStatus) {
    // No change needed
    return;
  }

  const updated = updateFrontmatterField(content, 'status', newStatus);
  if (updated !== content) {
    await app.vault.modify(taskNote, updated);
  }
}

/**
 * Extract all tasks with IDs from a daily note and sync their status to task notes
 * Called when daily note is modified (debounced)
 */
export async function syncAllStatusesToTaskNotes(app: App, file: TFile, settings: TaskManagerSettings): Promise<void> {
  if (!settings.enableTaskStatusSync) return;

  const content = await app.vault.read(file);
  const lines = content.split('\n');

  for (const line of lines) {
    const taskId = extractId(line);
    if (!taskId) continue;

    // Skip calendar events
    if (CALENDAR_EVENT_PATTERN.test(line)) continue;

    const marker = extractCheckboxMarker(line);
    if (marker) {
      await syncStatusToTaskNote(app, taskId, marker, settings);
    }
  }
}

export async function getSubtasksFromSource(app: App, sourceFilePath: string | null, parentTaskText: string): Promise<Subtask[]> {
  if (!sourceFilePath) return [];
  const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
  if (!sourceFile || !(sourceFile instanceof TFile)) return [];

  const content = await app.vault.read(sourceFile);
  const lines = content.split('\n');
  const subtasks: Subtask[] = [];

  let parentLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const taskMatch = line.match(/^(\s*)- \[[ x]\]\s*(.+)$/);
    if (taskMatch) {
      const cleanedText = cleanTaskText(taskMatch[2]);
      if (cleanedText === parentTaskText) {
        parentLineIndex = i;
        break;
      }
    }
  }

  if (parentLineIndex === -1) return [];

  const parentIndentMatch = lines[parentLineIndex].match(/^(\s*)/);
  const parentIndent = parentIndentMatch ? parentIndentMatch[1].length : 0;

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
      const taskText = cleanTaskText(taskMatch[3]);
      if (taskText) {
        subtasks.push({ text: taskText, completed: isCompleted, originalLine: line });
      }
    } else {
      break;
    }
  }

  return subtasks;
}

export async function syncSubtasksToTaskNote(
  app: App,
  taskNoteFile: TFile,
  sourceSubtasks: Subtask[],
  sourceFilePath: string | null
): Promise<void> {
  const content = await app.vault.read(taskNoteFile);

  const currentSourceMatch = content.match(/sourceFile:\s*"([^"]+)"/);
  const currentSourceFile = currentSourceMatch ? currentSourceMatch[1] : null;
  const sourceFileChanged = sourceFilePath && currentSourceFile && currentSourceFile !== sourceFilePath;

  const subtasksMatch = content.match(/## Subtasks\n\n([\s\S]*?)(?=\n## |$)/);
  if (!subtasksMatch) return;

  const existingSubtasksSection = subtasksMatch[1];
  const existingSubtasks: Subtask[] = [];
  const lines = existingSubtasksSection.split('\n');

  for (const line of lines) {
    const match = line.match(/^- \[([ x])\]\s*(.*)$/);
    if (match && match[2].trim()) {
      existingSubtasks.push({ text: match[2].trim(), completed: match[1] === 'x' });
    }
  }

  const mergedSubtasks: Subtask[] = [...existingSubtasks];
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
      new Notice(`Synced ${sourceSubtasks.length} subtask(s) from source`);
    }
  }
}

export async function syncSubtasksBackToSource(app: App, taskNoteFile: TFile, isSyncing: boolean): Promise<boolean> {
  if (isSyncing) return false;

  const content = await app.vault.read(taskNoteFile);

  const sourceMatch = content.match(/sourceFile:\s*"([^"]+)"/);
  if (!sourceMatch || !sourceMatch[1]) return false;

  const sourceFilePath = sourceMatch[1];
  const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
  if (!sourceFile || !(sourceFile instanceof TFile)) return false;

  const taskMatch = content.match(/task:\s*"?([^"\n]+)"?/);
  if (!taskMatch) return false;
  const parentTaskText = taskMatch[1].replace(/\\"/g, '"');

  const subtasksMatch = content.match(/## Subtasks\n\n([\s\S]*?)(?=\n## |$)/);
  if (!subtasksMatch) return false;

  const taskNoteSubtasks: Subtask[] = [];
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
      const cleanedText = cleanTaskText(taskMatchLine[2]);
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
}

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
/**
 * Extract inline fields and tags from a task line for frontmatter sync.
 */
export function extractFieldsFromLine(line: string): TaskExtraFields {
  const fields: TaskExtraFields = {};
  const parentMatch = line.match(/\[parent::([^\]]+)\]/);
  if (parentMatch) fields.parent = parentMatch[1].trim();
  const schedFromMatch = line.match(/\[<\s*(\d{4}-\d{2}-\d{2})\]/);
  if (schedFromMatch) fields.scheduledFrom = schedFromMatch[1];
  const schedToMatch = line.match(/\[>\s*(\d{4}-\d{2}-\d{2})\]/);
  if (schedToMatch) fields.scheduledTo = schedToMatch[1];
  const tags: string[] = [];
  const tagRegex = /#(\w+)/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(line)) !== null) {
    tags.push(tagMatch[1]);
  }
  if (tags.length > 0) fields.tags = tags;
  return fields;
}

/**
 * Build frontmatter YAML string for a task note.
 */
export function buildFrontmatter(
  taskText: string,
  taskId: string | null,
  status: string,
  sourceFilePath: string | null,
  extraFields: TaskExtraFields = {}
): string {
  let yaml = `---\ntask: "${taskText.replace(/"/g, '\\"')}"\ntaskId: "${taskId || ''}"`;
  yaml += `\nstatus: "${status}"`;
  yaml += `\ncreated: ${new Date().toISOString().split('T')[0]}`;
  yaml += `\nsourceFile: "${sourceFilePath || ''}"`;
  if (extraFields.parent) yaml += `\nparent: "${extraFields.parent}"`;
  if (extraFields.scheduledFrom) yaml += `\nscheduledFrom: ${extraFields.scheduledFrom}`;
  if (extraFields.scheduledTo) yaml += `\nscheduledTo: ${extraFields.scheduledTo}`;
  if (extraFields.tags && extraFields.tags.length > 0) {
    yaml += `\ntags:\n${extraFields.tags.map((t: string) => `  - ${t}`).join('\n')}`;
  }
  yaml += `\n---`;
  return yaml;
}

/**
 * Ensures a task note exists for the given task. Creates it if not found.
 * Does NOT open the note. Returns the file (or null on failure).
 *
 * Lookup order:
 * 1. By taskId in frontmatter (handles renames)
 * 2. By sanitized filename
 * 3. Create new if neither found
 */
export async function ensureTaskNoteExists(
  app: App,
  settings: TaskManagerSettings,
  taskText: string,
  sourceFilePath: string | null,
  taskId: string | null = null,
  taskLine: string | null = null
): Promise<TFile | null> {
  const sanitizedName = sanitizeFilename(taskText);
  if (!sanitizedName) return null;

  const folderPath = settings.taskNotesFolder;
  const filePath = `${folderPath}/${sanitizedName}.md`;

  // Try to find existing note by taskId first
  let file = null;
  if (taskId) {
    file = await findTaskNoteByTaskId(app, taskId, settings);
  }
  // Fall back to filename lookup
  if (!file) {
    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      // Verify this note belongs to this task (check taskId in frontmatter)
      const content = await app.vault.read(existing);
      const noteTaskId = extractFrontmatterField(content, 'taskId');
      if (!noteTaskId || noteTaskId === taskId || !taskId) {
        file = existing;
      } else {
        // Name collision — different task. Append task ID to filename.
        const altPath = `${folderPath}/${sanitizedName} (${taskId}).md`;
        const altFile = app.vault.getAbstractFileByPath(altPath);
        if (altFile instanceof TFile) {
          file = altFile;
        }
        // If altFile doesn't exist, we'll create at altPath below
        if (!file) {
          return await _createTaskNote(app, settings, taskText, taskId, sourceFilePath, altPath, taskLine);
        }
      }
    }
  }

  if (file instanceof TFile) {
    // Existing note — sync subtasks and source file
    const subtasksFromSource = await getSubtasksFromSource(app, sourceFilePath, taskText);
    await syncSubtasksToTaskNote(app, file, subtasksFromSource, sourceFilePath);
    return file;
  }

  // Create new note
  return await _createTaskNote(app, settings, taskText, taskId, sourceFilePath, filePath, taskLine);
}

export async function _createTaskNote(
  app: App,
  settings: TaskManagerSettings,
  taskText: string,
  taskId: string | null,
  sourceFilePath: string | null,
  filePath: string,
  taskLine: string | null
): Promise<TFile> {
  const folderPath = settings.taskNotesFolder;
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  const subtasksFromSource = await getSubtasksFromSource(app, sourceFilePath, taskText);

  // Look up the checkbox marker from the source file for status sync
  let checkboxMarker = ' ';
  if (sourceFilePath && taskId) {
    const sourceFile = app.vault.getAbstractFileByPath(sourceFilePath);
    if (sourceFile instanceof TFile) {
      const sourceContent = await app.vault.read(sourceFile);
      const idPattern = new RegExp(`\\[id::\\s*${taskId}\\]`);
      const lines = sourceContent.split('\n');
      for (const line of lines) {
        if (idPattern.test(line)) {
          const marker = extractCheckboxMarker(line);
          if (marker) checkboxMarker = marker;
          break;
        }
      }
    }
  }
  const status = checkboxToStatus(checkboxMarker, settings);

  const subtasksContent = subtasksFromSource.length > 0
    ? subtasksFromSource.map(st => `- [${st.completed ? 'x' : ' '}] ${st.text}`).join('\n')
    : '- [ ] ';

  const sourceLink = sourceFilePath ? `[[${sourceFilePath.replace(/\.md$/, '')}]]` : '';

  const extraFields = taskLine ? extractFieldsFromLine(taskLine) : {};
  const frontmatter = buildFrontmatter(taskText, taskId, status, sourceFilePath, extraFields);

  const content = `${frontmatter}

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
  const file = await app.vault.create(filePath, content);
  const baseName = filePath.split('/').pop() ?? filePath;
  const name = baseName.replace(/\.md$/, '');
  new Notice(`Created: ${name}`);
  return file;
}

export async function openOrCreateTaskNote(
  app: App,
  settings: TaskManagerSettings,
  taskText: string,
  sourceFilePath: string | null,
  taskId: string | null = null
): Promise<TFile | null> {
  const file = await ensureTaskNoteExists(app, settings, taskText, sourceFilePath, taskId);
  if (!file) {
    new Notice('Could not extract task name');
    return null;
  }
  if (file instanceof TFile) {
    await app.workspace.getLeaf().openFile(file);
  }
  return file;
}

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
export async function updateTaskNoteSourceFile(
  app: App,
  settings: TaskManagerSettings,
  taskText: string,
  newSourcePath: string,
  scheduledDate: string
): Promise<boolean> {
  // Find the Task Note by sanitized task name
  const sanitizedName = sanitizeFilename(taskText);
  if (!sanitizedName) return false;

  const filePath = `${settings.taskNotesFolder}/${sanitizedName}.md`;
  const file = app.vault.getAbstractFileByPath(filePath);

  // No Task Note exists for this task - that's fine, not all tasks have notes
  if (!file || !(file instanceof TFile)) {
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
