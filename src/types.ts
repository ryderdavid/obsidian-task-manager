// ============================================================================
// TYPES
// ============================================================================

export interface TaskManagerSettings {
  // Scope
  targetFolders: string[];

  // Task IDs
  enableTaskIds: boolean;
  idPrefix: string;
  noteIdPrefix: string;
  idLength: number;

  // Parent-Child Linking
  enableParentChildLinking: boolean;
  preserveExistingParentLinks: boolean;

  // Sorting
  enableAutoSort: boolean;
  sortDebounceMs: number;
  tasksWithoutTimePosition: string;

  // UI
  hideMetadataFields: boolean;
  hiddenMetadataFieldNames: string;
  alwaysVisibleMetadataFieldNames: string;
  disableSpellcheckOnTaskLines: boolean;

  // Task Notes
  enableTaskNotes: boolean;
  taskNotesFolder: string;

  // Event Notes
  enableEventNotes: boolean;
  eventNotesFolder: string;

  // ICS Calendar Sync
  enableIcsSync: boolean;

  // Auto-Archive
  enableAutoArchive: boolean;

  // Scheduling
  overdueTasksTargetHeader: string;

  // Shortcut Triggers
  enableScheduleTrigger: boolean;
  enableTimeblockTrigger: boolean;
  enableSlashCommandTrigger: boolean;

  // Task Status Sync
  enableTaskStatusSync: boolean;
  statusMappings: Record<string, string>;
}
