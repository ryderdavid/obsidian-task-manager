import { EditorSuggest } from 'obsidian';
import type { App, Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import type TaskManagerPlugin from '../../main';
import { isTask } from '../../utils/task-utils';
import { TimePickerPopup } from '../popups/time-picker-popup';
import { ScheduleDatePopup } from '../popups/schedule-date-popup';
import { SLASH_COMMANDS, STATUS_BAR_OPTIONS } from '../../constants';

// ============================================================================
// SLASH COMMAND SUGGEST
// ============================================================================

type SlashCommandSuggestion = (typeof SLASH_COMMANDS)[number];

export class SlashCommandSuggest extends EditorSuggest<SlashCommandSuggestion> {
  plugin: TaskManagerPlugin;
  private statusBar: HTMLDivElement;

  constructor(app: App, plugin: TaskManagerPlugin) {
    super(app);
    this.plugin = plugin;

    // Prepend horizontal status icon bar to the suggest popup
    this.statusBar = createDiv({ cls: 'slash-command-status-bar' });
    this.buildStatusBar();
    this.suggestEl.prepend(this.statusBar);
  }

  private buildStatusBar() {
    for (const option of STATUS_BAR_OPTIONS) {
      const btn = this.statusBar.createEl('button', {
        cls: 'slash-command-status-btn',
        attr: { 'aria-label': option.label, 'data-char': option.char }
      });
      const iconEl = btn.createSpan({ cls: 'slash-command-status-icon' });
      iconEl.innerHTML = option.icon;

      btn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.applyStatus(option.char);
      });
    }
  }

  private updateStatusBarHighlight(line: string) {
    const match = line.match(/^[\t]*- \[(.)\]/);
    const currentChar = match ? match[1] : null;

    this.statusBar.querySelectorAll('.slash-command-status-btn').forEach(btn => {
      const el = btn as HTMLElement;
      el.removeClass('is-active');
      if (el.dataset.char === currentChar) {
        el.addClass('is-active');
      }
    });
  }

  private applyStatus(char: string) {
    const ctx = this.context;
    if (!ctx) return;
    const { editor } = ctx;
    const lineNum = ctx.start.line;

    // Remove the "/" and any typed query
    editor.replaceRange('', ctx.start, ctx.end);

    // Apply status change
    const updatedLine = editor.getLine(lineNum);
    const newLine = updatedLine.replace(/^([\t]*- \[)[^\]](\])/, `$1${char}$2`);
    editor.setLine(lineNum, newLine);

    this.close();
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.enableSlashCommandTrigger) return null;

    // Only trigger on task lines
    const line = editor.getLine(cursor.line);
    if (!isTask(line)) return null;

    // Find the "/" character before cursor
    const lineUpToCursor = line.substring(0, cursor.ch);
    const slashIndex = lineUpToCursor.lastIndexOf('/');

    if (slashIndex === -1) return null;

    // Ensure "/" is not part of a time pattern (e.g., "15:30 - 16:00")
    const beforeSlash = lineUpToCursor.substring(0, slashIndex);
    if (/\d$/.test(beforeSlash)) return null;

    const afterSlash = lineUpToCursor.substring(slashIndex + 1);

    // Don't trigger if a space was typed after / (user wants to keep the character)
    if (afterSlash.includes(' ')) return null;

    // Update status bar to highlight the current task's status
    this.updateStatusBarHighlight(line);

    return {
      start: { line: cursor.line, ch: slashIndex },
      end: cursor,
      query: afterSlash.toLowerCase()
    };
  }

  getSuggestions(context: EditorSuggestContext): SlashCommandSuggestion[] {
    const query = context.query.toLowerCase();
    return SLASH_COMMANDS.filter(cmd =>
      cmd.label.toLowerCase().includes(query) ||
      cmd.id.includes(query)
    );
  }

  renderSuggestion(suggestion: SlashCommandSuggestion, el: HTMLElement) {
    el.addClass('slash-command-item');
    const iconSpan = el.createSpan({ cls: 'slash-command-icon' });
    iconSpan.innerHTML = suggestion.icon;
    el.createSpan({ text: suggestion.label, cls: 'slash-command-label' });
  }

  selectSuggestion(suggestion: SlashCommandSuggestion, evt: MouseEvent | KeyboardEvent) {
    const ctx = this.context;
    if (!ctx) return;
    const { editor } = ctx;
    const lineNum = ctx.start.line;

    // Remove the "/" and any typed query
    editor.replaceRange('', ctx.start, ctx.end);

    if (suggestion.action === 'schedule') {
      this.openSchedulePopup(editor, lineNum);
    } else if (suggestion.action === 'timeblock') {
      this.openTimeBlockPopup(editor, lineNum);
    }
  }

  openSchedulePopup(editor: Editor, lineNum: number) {
    const popup = new ScheduleDatePopup(this.plugin, editor, lineNum);
    popup.open();
  }

  openTimeBlockPopup(editor: Editor, lineNum: number) {
    const popup = new TimePickerPopup(this.plugin, editor, lineNum, 'start');
    popup.open();
  }
}
