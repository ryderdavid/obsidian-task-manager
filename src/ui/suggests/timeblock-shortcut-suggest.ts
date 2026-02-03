import { EditorSuggest } from 'obsidian';
import type { App, Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import type TaskManagerPlugin from '../../main';
import { isTask } from '../../utils/task-utils';
import { TimePickerPopup } from '../popups/time-picker-popup';
import { TIMEBLOCK_SUGGESTIONS } from '../../constants';

// ============================================================================
// TIMEBLOCK SHORTCUT SUGGEST (^ triggers timeblock suggestions)
// ============================================================================

type TimeblockSuggestion = (typeof TIMEBLOCK_SUGGESTIONS)[number];

export class TimeblockShortcutSuggest extends EditorSuggest<TimeblockSuggestion> {
  plugin: TaskManagerPlugin;

  constructor(app: App, plugin: TaskManagerPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.enableTimeblockTrigger) return null;

    const line = editor.getLine(cursor.line);
    if (!isTask(line)) return null;

    const lineUpToCursor = line.substring(0, cursor.ch);
    const triggerIndex = lineUpToCursor.lastIndexOf('^');

    if (triggerIndex === -1) return null;
    if (triggerIndex === 0) return null;

    const beforeTrigger = lineUpToCursor.substring(0, triggerIndex);
    if (beforeTrigger.endsWith('^')) return null;

    const afterTrigger = lineUpToCursor.substring(triggerIndex + 1);

    // Don't trigger if a space was typed after ^ (user wants to keep the character)
    if (afterTrigger.includes(' ')) return null;

    return {
      start: { line: cursor.line, ch: triggerIndex },
      end: cursor,
      query: afterTrigger
    };
  }

  getSuggestions(context: EditorSuggestContext): TimeblockSuggestion[] {
    const query = context.query;
    return TIMEBLOCK_SUGGESTIONS.filter(s =>
      s.label.toLowerCase().includes(query.toLowerCase())
    );
  }

  renderSuggestion(suggestion: TimeblockSuggestion, el: HTMLElement) {
    el.addClass('slash-command-item');
    const iconSpan = el.createSpan({ cls: 'slash-command-icon' });
    iconSpan.innerHTML = suggestion.icon;
    el.createSpan({ text: suggestion.label, cls: 'slash-command-label' });
  }

  selectSuggestion(suggestion: TimeblockSuggestion, evt: MouseEvent | KeyboardEvent) {
    const ctx = this.context;
    if (!ctx) return;
    const { editor } = ctx;
    const lineNum = ctx.start.line;

    // Remove the ^ and any query text
    editor.replaceRange('', ctx.start, ctx.end);

    if (suggestion.id === 'set-time') {
      const popup = new TimePickerPopup(this.plugin, editor, lineNum, 'start');
      popup.open();
    }
  }
}
