import { TaskManagerSettings } from './types';
import * as ScheduleDateUtils from './utils/schedule-date-utils';

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

export const DEFAULT_SETTINGS: TaskManagerSettings = {
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
  hiddenMetadataFieldNames: 'id, parent, uid, calendar, priority',

  // Task Notes
  enableTaskNotes: true,
  taskNotesFolder: 'Task Notes',

  // Event Notes (for calendar events)
  enableEventNotes: true,
  eventNotesFolder: 'Event Notes',

  // ICS Calendar Sync
  enableIcsSync: true,

  // Auto-Archive
  enableAutoArchive: true,

  // Scheduling
  overdueTasksTargetHeader: '',   // Header to insert overdue tasks under (e.g. '## Tasks'). Empty = append to end.

  // Shortcut Triggers
  enableScheduleTrigger: true,    // > opens schedule suggestions
  enableTimeblockTrigger: true,   // ^ opens timeblock suggestions
  enableSlashCommandTrigger: true, // / opens slash command suggestions

  // Task Status Sync
  enableTaskStatusSync: true,
  statusMappings: {
    ' ': 'incomplete',
    'x': 'complete',
    'X': 'complete',
    '/': 'in-progress',
    '-': 'cancelled',
    '>': 'scheduled'
  }
};

// ============================================================================
// SCHEDULE DATE OPTIONS
// ============================================================================

export const SCHEDULE_DATE_OPTIONS = [
  { id: 'tomorrow', label: 'Tomorrow', getDate: () => ScheduleDateUtils.getTomorrow() },
  { id: 'day-after', label: 'Day After Tomorrow', getDate: () => ScheduleDateUtils.getDayAfterTomorrow() },
  { id: 'next-monday', label: 'Next Monday', getDate: () => ScheduleDateUtils.getNextMonday() },
  { id: 'one-week', label: 'In One Week', getDate: () => ScheduleDateUtils.getOneWeekFromNow() },
  { id: 'custom', label: 'Enter a date...', isCustom: true }
];

// ============================================================================
// SHARED ICONS (Font Awesome)
// ============================================================================

export const Icons = {
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"/></svg>',
  halfCircle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M448 256c0-106-86-192-192-192V448c106 0 192-86 192-192zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  ban: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/></svg>',
  anglesRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M470.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L402.7 256 265.4 393.4c-12.5 12.5-32.8 12.5-45.3 0s-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160zm-352 160l160-160c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L210.7 256 73.4 393.4c-12.5 12.5-32.8 12.5-45.3 0z"/></svg>',
  // file-lines (solid) - document with lines icon
  fileLines: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d="M64 0C28.7 0 0 28.7 0 64V448c0 35.3 28.7 64 64 64H320c35.3 0 64-28.7 64-64V160H256c-17.7 0-32-14.3-32-32V0H64zM256 0V128H384L256 0zM112 256H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/></svg>',
  // clock (regular) - time/clock icon
  clock: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M464 256A208 208 0 1 1 48 256a208 208 0 1 1 416 0zM0 256a256 256 0 1 0 512 0A256 256 0 1 0 0 256zM232 120V256c0 8 4 15.5 10.7 20l96 64c11 7.4 25.9 4.4 33.3-6.7s4.4-25.9-6.7-33.3L280 243.2V120c0-13.3-10.7-24-24-24s-24 10.7-24 24z"/></svg>',
  // circle-right (solid) - schedule/forward icon
  circleRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M0 256a256 256 0 1 0 512 0A256 256 0 1 0 0 256zM294.6 135.1l99.9 107.1c3.5 3.8 5.5 8.7 5.5 13.8s-2 10.1-5.5 13.8L294.6 376.9c-4.2 4.5-10.1 7.1-16.3 7.1C266 384 256 374 256 361.7l0-57.7-96 0c-17.7 0-32-14.3-32-32l0-32c0-17.7 14.3-32 32-32l96 0 0-57.7c0-12.3 10-22.3 22.3-22.3c6.2 0 12.1 2.6 16.3 7.1z"/></svg>'
};

// ============================================================================
// TIMEBLOCK SHORTCUT SUGGEST (^ triggers timeblock suggestions)
// ============================================================================

export const TIMEBLOCK_SUGGESTIONS = [
  { id: 'set-time', label: 'Set Time Block...', icon: Icons.clock },
];

// ============================================================================
// SLASH COMMAND SUGGEST
// ============================================================================

export const SLASH_COMMANDS = [
  { id: 'complete', label: 'Mark Complete', icon: Icons.check, marker: 'x' },
  { id: 'in-progress', label: 'Mark In Progress', icon: Icons.halfCircle, marker: '/' },
  { id: 'cancelled', label: 'Mark Cancelled', icon: Icons.ban, marker: '-' },
  { id: 'schedule', label: 'Schedule Task', icon: Icons.anglesRight, action: 'schedule' },
  { id: 'timeblock', label: 'Set Time Block', icon: Icons.clock, action: 'timeblock' }
];

// ============================================================================
// SCHEDULE SHORTCUT SUGGEST (> triggers schedule suggestions)
// ============================================================================

export const SCHEDULE_SUGGESTIONS = [
  { id: 'tomorrow', label: 'Schedule to Tomorrow', icon: Icons.anglesRight },
  { id: 'pick-date', label: 'Pick a Date...', icon: Icons.anglesRight },
];
