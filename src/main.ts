import { Plugin, Notice, TFile, EditorSuggest, MarkdownView } from 'obsidian';
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { DEFAULT_SETTINGS } from './constants';
import * as TaskUtils from './utils/task-utils';
import * as TaskIdManager from './services/task-id-manager';
import * as ParentChildLinker from './services/parent-child-linker';
import * as TaskSorter from './services/task-sorter';
import * as TaskArchiver from './services/task-archiver';
import * as IcsEventSync from './services/ics-event-sync';
import * as TaskNoteManager from './services/task-note-manager';
import * as EventNoteManager from './services/event-note-manager';
import * as TaskScheduler from './services/task-scheduler';
import * as BulkScheduler from './services/bulk-scheduler';
import { GutterMoreWidget } from './ui/widgets/gutter-more-widget';
import { TaskInfoModal } from './ui/modals/task-info-modal';
import { TimePickerPopup } from './ui/popups/time-picker-popup';
import { ScheduleDatePopup } from './ui/popups/schedule-date-popup';
import { ScheduleDatePopupFromWidget } from './ui/popups/schedule-date-popup-from-widget';
import { TimePickerPopupFromWidget } from './ui/popups/time-picker-popup-from-widget';
import { TimeblockShortcutSuggest } from './ui/suggests/timeblock-shortcut-suggest';
import { SlashCommandSuggest } from './ui/suggests/slash-command-suggest';
import { ScheduleShortcutSuggest } from './ui/suggests/schedule-shortcut-suggest';
import { TaskManagerSettingTab } from './settings/settings-tab';

// ============================================================================
// MAIN PLUGIN
// ============================================================================

class TaskManagerPlugin extends Plugin {
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
          if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view, plugin);
          }
        }

        buildDecorations(view, plugin) {
          const decorations = [];
          const isSourceMode = !view.dom.closest('.is-live-preview');
          // Get cursor line to skip Decoration.replace on it (prevents backwards typing bug)
          const cursorHead = view.state.selection.main.head;
          const cursorLine = cursorHead != null
            ? view.state.doc.lineAt(cursorHead).number
            : -1;
          const taskPattern = TaskUtils.TASK_PATTERN;
          const parentTaskPattern = TaskUtils.PARENT_TASK_PATTERN;
          // Build metadata pattern from configured field names
          const fieldNames = plugin.settings.hiddenMetadataFieldNames
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
          const metadataPattern = fieldNames.length > 0
            ? new RegExp(`\\s*\\[(?:${fieldNames.join('|')})::\\s*[^\\]]+\\]`, 'g')
            : null;
          // Time block pattern: HH:MM - HH:MM at start of task text
          const timeblockPattern = /^([\t]*- \[.\]\s*)(\d{2}:\d{2}\s*-\s*\d{2}:\d{2})/;
          // Schedule tags (>[[DATE]], <[[DATE]]) are now visible text — no hiding needed

          for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos < to;) {
              const line = view.state.doc.lineAt(pos);
              const lineText = line.text;

              if (taskPattern.test(lineText)) {
                const taskId = TaskUtils.extractId(lineText);
                const parentId = TaskUtils.extractParentId(lineText);
                const isParentTask = parentTaskPattern.test(lineText);

                // Detect priority markers (!, !!, !!!) at start of task text
                const priorityMatch = lineText.match(/^[\t]*- \[.\]\s*(?:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s+)?(!!!|!!|!)\s/);
                if (priorityMatch) {
                  const level = priorityMatch[1].length; // 1, 2, or 3
                  decorations.push({
                    from: line.from,
                    to: line.from,
                    value: Decoration.line({
                      attributes: { 'data-priority': String(level) }
                    })
                  });
                }

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

                // Hide metadata fields if enabled (only in Live Preview, not Source Mode)
                // Uses Decoration.mark instead of Decoration.replace to avoid
                // cursor corruption that inserts spaces into field values (#30)
                if (plugin.settings.hideMetadataFields && !isSourceMode && metadataPattern) {
                  let match;
                  let hasMutedMetadata = false;
                  let hasHiddenMetadata = false;
                  metadataPattern.lastIndex = 0;
                  while ((match = metadataPattern.exec(lineText)) !== null) {
                    const start = line.from + match.index;
                    const end = start + match[0].length;
                    if (line.number === cursorLine) {
                      // On cursor line: style subtly instead of hiding
                      hasMutedMetadata = true;
                      decorations.push({
                        from: start,
                        to: end,
                        value: Decoration.mark({ class: 'task-metadata-muted' })
                      });
                    } else {
                      hasHiddenMetadata = true;
                      decorations.push({
                        from: start,
                        to: end,
                        value: Decoration.mark({ class: 'task-metadata-hidden' })
                      });
                    }
                  }
                  // Add line class so CSS can target Dataview's sibling spans too
                  if (hasMutedMetadata) {
                    decorations.push({
                      from: line.from,
                      to: line.from,
                      value: Decoration.line({ attributes: { class: 'has-muted-metadata' } })
                    });
                  }
                  if (hasHiddenMetadata) {
                    decorations.push({
                      from: line.from,
                      to: line.from,
                      value: Decoration.line({ attributes: { class: 'has-hidden-metadata' } })
                    });
                  }
                }

                // Schedule tags (>[[DATE]], <[[DATE]]) are visible text — no hiding needed
                // Legacy schedule tags ([> DATE], [scheduled_to::], [sch_to::]) are still
                // readable by the scheduling system but no longer hidden/decorated

                // Determine what to show in the unified container
                const isCalendarEvent = TaskUtils.isCalendarEvent(lineText);
                const uid = isCalendarEvent ? IcsEventSync.extractUid(lineText) : null;
                const calendarSource = isCalendarEvent ? IcsEventSync.extractCalendar(lineText) : null;

                // For calendar events, extract event title; for tasks, extract task text
                const taskText = isCalendarEvent
                  ? EventNoteManager.extractEventTitle(lineText)
                  : TaskNoteManager.extractTaskTextFromLine(lineText);
                const showInfoButton = plugin.settings.showInfoButton && (taskId || parentId || uid);

                // Add gutter "more" widget at line start (shown on hover)
                if (showInfoButton) {
                  decorations.push({
                    from: line.from,
                    to: line.from,
                    value: Decoration.widget({
                      widget: new GutterMoreWidget({
                        taskText: taskText,
                        taskId: taskId,
                        parentId: parentId,
                        uid: uid,
                        isCalendarEvent: isCalendarEvent,
                        calendarSource: calendarSource
                      }, plugin),
                      side: -1
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

    // Inline tasks: click to edit, Cmd+click to follow link (#21)
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      // If Cmd (Mac) or Ctrl (Windows/Linux) is held, allow normal link behavior
      if (evt.metaKey || evt.ctrlKey) return;

      const target = evt.target as HTMLElement;
      // Check if the click target is a link (or inside a link) within a task list item
      const link = target.closest('a.internal-link, a.external-link, a.cm-underline');
      if (!link) return;
      const taskItem = link.closest('li.task-list-item, li[data-task]');
      if (!taskItem) return;

      // Prevent the link from being followed
      evt.preventDefault();
      evt.stopPropagation();

      // Place cursor at the link's position in the editor for editing
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.editor) return;

      // Switch to editing mode if in reading/preview mode
      const viewState = view.leaf.getViewState();
      if (viewState.state?.mode === 'preview') {
        viewState.state.mode = 'source';
        view.leaf.setViewState(viewState);
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
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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
          new Notice('Task unlinked from parent');
        } else {
          new Notice('This task has no parent link');
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
          new Notice('No task metadata on this line');
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
          new Notice('This command only works in task notes');
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
          new Notice('This command only works in task notes');
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
          new Notice('This command only works in task notes');
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
          new Notice('This command only works in task notes');
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
        // Must be scheduled (has [>] marker or >[[DATE]] tag or legacy formats)
        const hasScheduledMarker = /^[\t]*- \[>\]/.test(line);
        const hasScheduledTag = />\[\[\d{4}-\d{2}-\d{2}\]\]/.test(line) || /\[scheduled_to::\s*\[\[\d{4}-\d{2}-\d{2}\]\]\]/.test(line) || /\[>\s*\d{4}-\d{2}-\d{2}\]/.test(line);
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

    this.addCommand({
      id: 'create-task-note',
      name: 'Create task note and link',
      editorCheckCallback: (checking, editor, view) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !TaskUtils.shouldProcessFile(activeFile, this.settings)) return false;
        if (!this.settings.enableTaskNotes) return false;

        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        if (!TaskUtils.isTask(line)) return false;
        if (TaskUtils.isCalendarEvent(line)) return false;
        if (!TaskUtils.isParentTask(line)) return false;
        if (TaskUtils.hasWikiLink(line)) return false;

        const textAfterCheckbox = line.replace(/^[\t]*- \[.\]\s*/, '').trim();
        if (!textAfterCheckbox) return false;

        if (checking) return true;

        // Ensure task has an ID
        let currentLine = line;
        if (this.settings.enableTaskIds && !TaskUtils.extractId(currentLine)) {
          currentLine = TaskUtils.addId(currentLine, TaskUtils.generateId(this.settings));
          this.isProcessing = true;
          editor.setLine(cursor.line, currentLine);
          setTimeout(() => { this.isProcessing = false; }, 50);
        }

        const taskText = TaskNoteManager.extractTaskTextFromLine(currentLine);
        if (!taskText || !taskText.trim()) {
          new Notice('Could not extract task text');
          return;
        }

        const taskId = TaskUtils.extractId(currentLine);
        const sourceFilePath = activeFile.path;

        (async () => {
          try {
            const file = await TaskNoteManager.ensureTaskNoteExists(
              this.app, this.settings, taskText, sourceFilePath, taskId, currentLine
            );
            if (!file) {
              new Notice('Failed to create task note');
              return;
            }

            const lineNow = editor.getLine(cursor.line);
            if (!lineNow || TaskUtils.hasWikiLink(lineNow)) {
              new Notice('Task note created');
              return;
            }

            const wrapped = TaskUtils.wrapTaskTextWithLink(lineNow);
            if (wrapped && wrapped !== lineNow) {
              this.isProcessing = true;
              editor.setLine(cursor.line, wrapped);
              setTimeout(() => { this.isProcessing = false; }, 50);
            }

            new Notice('Task note created and linked');
          } catch (err) {
            console.error('Task Manager: create task note failed', err);
            new Notice('Error creating task note');
          }
        })();
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
          new Notice('This command only works in target folders');
          return;
        }

        const content = editor.getValue();
        const archived = TaskArchiver.archiveContent(content, this.settings);

        if (archived !== content) {
          editor.setValue(archived);
          new Notice('Tasks archived');
        } else {
          new Notice('No tasks to archive');
        }
      }
    });

    // Hide configured metadata fields in Reading View
    this.registerMarkdownPostProcessor((element, context) => {
      if (!this.settings.hideMetadataFields) return;
      const fieldNames = this.settings.hiddenMetadataFieldNames
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      for (const name of fieldNames) {
        const els = element.querySelectorAll(
          `.dataview.inline-field[data-dv-key="${name}"], ` +
          `.dataview.inline-field-standalone[data-dv-key="${name}"]`
        );
        for (const el of els) {
          el.style.display = 'none';
        }
      }
    });

    // Add settings tab
    this.addSettingTab(new TaskManagerSettingTab(this.app, this));

    // Add status bar item showing version and git branch
    const version = this.manifest.version;
    const branch = typeof __GIT_BRANCH__ !== 'undefined' ? __GIT_BRANCH__ : 'unknown';
    const statusBarEl = this.addStatusBarItem();
    statusBarEl.setText(`Task Manager: v${version} | ${branch}`);
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
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
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
      new Notice(`Status already set to ${newStatus}`);
      return;
    }

    // Update frontmatter status
    let updated = TaskNoteManager.updateFrontmatterField(content, 'status', newStatus);

    // Update button highlighting to match new status
    updated = this.updateButtonHighlighting(updated, newStatus);

    if (updated !== content) {
      await this.app.vault.modify(file, updated);
      new Notice(`Status changed to ${newStatus}`);
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
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !TaskUtils.shouldProcessFile(activeFile, this.settings)) return;

    const editor = activeView.editor;
    const line = editor.getLine(lineNum);
    if (!line) return;

    // Only process task lines (but NOT calendar events)
    if (!TaskUtils.isTask(line)) return;
    if (TaskUtils.isCalendarEvent(line)) return;

    // Skip empty tasks (checkbox only, no text content)
    const textAfterCheckbox = line.replace(/^[\t]*- \[.\]\s*/, '').trim();
    if (!textAfterCheckbox) return;

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

    // Sync priority field with marker (!, !!, !!!)
    const markerLevel = TaskUtils.detectPriorityMarker(newLine);
    const existingPriority = TaskUtils.extractPriority(newLine);
    if (markerLevel && existingPriority !== markerLevel) {
      newLine = TaskUtils.addPriority(newLine, markerLevel);
      modified = true;
    } else if (!markerLevel && existingPriority !== null) {
      newLine = TaskUtils.removePriority(newLine);
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
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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
        new Notice('Task unlinked from parent');
      }
    }, uid, isCalendarEvent, calendarSource);
    modal.open();
  }

  // Show schedule popup positioned relative to a widget element
  showSchedulePopupFromWidget(anchorEl, lineNum) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return;

    const editor = view.editor;
    const popup = new ScheduleDatePopupFromWidget(this, editor, lineNum, anchorEl);
    popup.open();
  }

  // Show timeblock picker positioned relative to a widget element
  showTimeblockPickerFromWidget(anchorEl, lineNum) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return;

    const editor = view.editor;
    const popup = new TimePickerPopupFromWidget(this, editor, lineNum, 'start', null, null, anchorEl);
    popup.open();
  }
}

export default TaskManagerPlugin;
