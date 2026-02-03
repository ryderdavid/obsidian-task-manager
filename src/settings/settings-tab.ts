import { PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type TaskManagerPlugin from '../main';
import { TaskManagerSettings } from '../types';

// ============================================================================
// SETTINGS TAB
// ============================================================================

export class TaskManagerSettingTab extends PluginSettingTab {
  plugin: TaskManagerPlugin;

  constructor(app: App, plugin: TaskManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Task Manager Settings' });

    // SCOPE SECTION
    containerEl.createEl('h3', { text: 'Scope' });

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Enable task IDs')
      .setDesc('Automatically assign unique IDs to all tasks')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskIds)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskIds = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('ID prefix')
      .setDesc('Prefix for generated task IDs')
      .addText(text => text
        .setPlaceholder('t-')
        .setValue(this.plugin.settings.idPrefix)
        .onChange(async (value) => {
          this.plugin.settings.idPrefix = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Enable parent-child linking')
      .setDesc('Automatically link subtasks to their parent tasks')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableParentChildLinking)
        .onChange(async (value) => {
          this.plugin.settings.enableParentChildLinking = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Enable auto-sort')
      .setDesc('Automatically sort tasks by time when file is modified')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAutoSort)
        .onChange(async (value) => {
          this.plugin.settings.enableAutoSort = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Enable status sync')
      .setDesc('Sync task status between task notes and daily notes bidirectionally')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskStatusSync)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskStatusSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Show info button')
      .setDesc('Display info button (i) on tasks to view metadata')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showInfoButton)
        .onChange(async (value) => {
          this.plugin.settings.showInfoButton = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Hide metadata fields')
      .setDesc('Hide inline Dataview fields in the editor (e.g. [id::...], [parent::...])')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideMetadataFields)
        .onChange(async (value) => {
          this.plugin.settings.hideMetadataFields = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Hidden field names')
      .setDesc('Comma-separated list of Dataview field names to hide (e.g. id, parent, uid, calendar)')
      .addText(text => text
        .setPlaceholder('id, parent, uid, calendar')
        .setValue(this.plugin.settings.hiddenMetadataFieldNames)
        .onChange(async (value) => {
          this.plugin.settings.hiddenMetadataFieldNames = value;
          await this.plugin.saveSettings();
        }));

    // SHORTCUT TRIGGERS SECTION
    containerEl.createEl('h3', { text: 'Shortcut Triggers' });

    new Setting(containerEl)
      .setName('Enable > schedule trigger')
      .setDesc('Typing > on a task line shows schedule suggestions')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableScheduleTrigger)
        .onChange(async (value) => {
          this.plugin.settings.enableScheduleTrigger = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable ^ timeblock trigger')
      .setDesc('Typing ^ on a task line shows timeblock suggestions')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTimeblockTrigger)
        .onChange(async (value) => {
          this.plugin.settings.enableTimeblockTrigger = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable / slash command trigger')
      .setDesc('Typing / on a task line shows command suggestions')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableSlashCommandTrigger)
        .onChange(async (value) => {
          this.plugin.settings.enableSlashCommandTrigger = value;
          await this.plugin.saveSettings();
        }));

    // SCHEDULING SECTION
    containerEl.createEl('h3', { text: 'Scheduling' });

    new Setting(containerEl)
      .setName('Overdue tasks target header')
      .setDesc('Header under which overdue tasks are inserted (e.g. "## Tasks"). Leave empty to append to end of file.')
      .addText(text => text
        .setPlaceholder('## Tasks')
        .setValue(this.plugin.settings.overdueTasksTargetHeader)
        .onChange(async (value) => {
          this.plugin.settings.overdueTasksTargetHeader = value.trim();
          await this.plugin.saveSettings();
        }));

    // TASK NOTES SECTION
    containerEl.createEl('h3', { text: 'Task Notes' });

    new Setting(containerEl)
      .setName('Enable task notes')
      .setDesc('Show "notes" button on parent tasks to open dedicated task notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTaskNotes)
        .onChange(async (value) => {
          this.plugin.settings.enableTaskNotes = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('Enable event notes')
      .setDesc('Show "notes" button on calendar events to create/open dedicated event notes with eventUID in frontmatter')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableEventNotes)
        .onChange(async (value) => {
          this.plugin.settings.enableEventNotes = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
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

    new Setting(containerEl)
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
