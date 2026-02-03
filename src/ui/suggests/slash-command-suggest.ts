import { EditorSuggest } from 'obsidian';
import { isTask } from '../../utils/task-utils';
import { TimePickerPopup } from '../popups/time-picker-popup';
import { ScheduleDatePopup } from '../popups/schedule-date-popup';
import { SLASH_COMMANDS } from '../../constants';

// ============================================================================
// SLASH COMMAND SUGGEST
// ============================================================================

export class SlashCommandSuggest extends EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
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

    return {
      start: { line: cursor.line, ch: slashIndex },
      end: cursor,
      query: afterSlash.toLowerCase()
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
