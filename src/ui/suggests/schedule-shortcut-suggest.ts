import { EditorSuggest } from 'obsidian';
import type { App, Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import type TaskManagerPlugin from '../../main';
import { isTask } from '../../utils/task-utils';
import { scheduleTask } from '../../services/task-scheduler';
import { ScheduleDatePopup } from '../popups/schedule-date-popup';
import { parseCustomDate } from '../../utils/schedule-date-utils';
import { Icons, SCHEDULE_SUGGESTIONS } from '../../constants';

// ============================================================================
// SCHEDULE SHORTCUT SUGGEST (> triggers schedule suggestions)
// ============================================================================

type ScheduleSuggestion = (typeof SCHEDULE_SUGGESTIONS)[number];
type DynamicScheduleSuggestion =
  | (ScheduleSuggestion & { disabled?: boolean })
  | { id: 'direct-date'; label: string; icon: string; date: string }
  | { id: 'typing-date'; label: string; icon: string; disabled: true }
  | { id: 'no-match'; label: string; icon: string; disabled: true };

export class ScheduleShortcutSuggest extends EditorSuggest<DynamicScheduleSuggestion> {
  plugin: TaskManagerPlugin;

  constructor(app: App, plugin: TaskManagerPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.enableScheduleTrigger) return null;

    const line = editor.getLine(cursor.line);
    if (!isTask(line)) return null;

    const lineUpToCursor = line.substring(0, cursor.ch);
    const triggerIndex = lineUpToCursor.lastIndexOf('>');

    if (triggerIndex === -1) return null;
    if (triggerIndex === 0) return null;

    const beforeTrigger = lineUpToCursor.substring(0, triggerIndex);
    if (beforeTrigger.endsWith('>')) return null;
    if (beforeTrigger.endsWith('[')) return null;

    const afterTrigger = lineUpToCursor.substring(triggerIndex + 1);

    return {
      start: { line: cursor.line, ch: triggerIndex },
      end: cursor,
      query: afterTrigger
    };
  }

  getSuggestions(context: EditorSuggestContext): DynamicScheduleSuggestion[] {
    const query = context.query;

    // No query — show default options
    if (!query) {
      return SCHEDULE_SUGGESTIONS;
    }

    // Try flexible date parsing (YYYY-MM-DD, YYYYMMDD, or natural language)
    const parsed = parseCustomDate(query, this.plugin.app);
    if (parsed) {
      return [{ id: 'direct-date', label: `Schedule to ${parsed}`, icon: Icons.anglesRight, date: parsed }];
    }

    // Partial numeric input — show hint
    if (/^\d+[-]?\d*[-]?\d*$/.test(query) && query.length < 10) {
      return [{ id: 'typing-date', label: `Type date: YYYY-MM-DD or YYYYMMDD`, icon: Icons.anglesRight, disabled: true }];
    }

    // Text query — try to match default options, and show nldates hint if available
    const matches = SCHEDULE_SUGGESTIONS.filter(s =>
      s.label.toLowerCase().includes(query.toLowerCase())
    );

    // If no default matches but there's text, show "no match" hint
    if (matches.length === 0 && query.length > 0) {
      return [{ id: 'no-match', label: `No date match for "${query}"`, icon: Icons.anglesRight, disabled: true }];
    }

    return matches;
  }

  renderSuggestion(suggestion: DynamicScheduleSuggestion, el: HTMLElement) {
    el.addClass('slash-command-item');
    const iconSpan = el.createSpan({ cls: 'slash-command-icon' });
    iconSpan.innerHTML = suggestion.icon;
    el.createSpan({ text: suggestion.label, cls: 'slash-command-label' });
    if ('disabled' in suggestion && suggestion.disabled) {
      el.addClass('is-disabled');
    }
  }

  selectSuggestion(suggestion: DynamicScheduleSuggestion, evt: MouseEvent | KeyboardEvent) {
    if ('disabled' in suggestion && suggestion.disabled) return;
    const ctx = this.context;
    if (!ctx) return;

    const { editor } = ctx;
    const lineNum = ctx.start.line;

    // Remove the > and any query text
    editor.replaceRange('', ctx.start, ctx.end);

    if (suggestion.id === 'direct-date' && 'date' in suggestion) {
      // Schedule to the typed date
      scheduleTask(
        this.plugin.app,
        this.plugin.settings,
        editor,
        lineNum,
        suggestion.date
      );
    } else if (suggestion.id === 'today') {
      // Schedule to today
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      scheduleTask(
        this.plugin.app,
        this.plugin.settings,
        editor,
        lineNum,
        dateStr
      );
    } else if (suggestion.id === 'tomorrow') {
      // Schedule to tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      scheduleTask(
        this.plugin.app,
        this.plugin.settings,
        editor,
        lineNum,
        dateStr
      );
    } else if (suggestion.id === 'pick-date') {
      const popup = new ScheduleDatePopup(this.plugin, editor, lineNum);
      popup.open();
    }
  }
}
