# Obsidian Task Manager Plugin

A comprehensive task management plugin for Obsidian that handles automatic ID assignment, parent-child relationships, scheduling, sorting, and task notes.

## Features

### Task Management
- **Automatic ID Assignment**: Tasks automatically receive unique IDs (`[id:: t-xxxxxxxx]`)
- **Parent-Child Linking**: Subtasks are automatically linked to their parent tasks (`[parent:: t-xxxxxxxx]`)
- **Task Sorting**: Sort tasks chronologically by time blocks
- **Hidden Metadata**: Optional hiding of ID/parent fields in the editor

### Task Scheduling
- **Schedule to Date**: Forward tasks to future dates using the slash command menu or `>` shortcut
- **Scheduled-To Tags**: Original tasks marked with `[>]` and `[> YYYY-MM-DD]`
- **Scheduled-From Tags**: Target copies include `[< YYYY-MM-DD]` showing origin
- **Subtask Handling**: When a parent task is scheduled, all its subtasks are also marked as scheduled
- **Bulk Scheduling**: Schedule all overdue tasks to today or to the current note's date

### Task Notes
- **Dedicated Note Files**: Create separate note files for complex tasks
- **Bidirectional Sync**: Subtasks sync between source files and task notes
- **Auto-Generated Structure**: Task notes include frontmatter, notes section, and subtasks

### UI Features
- **Info Button (ⓘ)**: View task metadata including human-readable names
- **Notes Button**: Quick access to create/open task notes
- **Schedule Pills**: Clickable date pills for scheduled tasks

## Task Checkbox States

| Marker | State | Description |
|--------|-------|-------------|
| `[ ]` | Incomplete | Actionable task |
| `[x]` | Completed | Finished task |
| `[-]` | Cancelled | Task won't be done |
| `[>]` | Scheduled | Forwarded to another date |
| `[/]` | In Progress | Currently being worked on |
| `[c]` | Calendar Event | Synced from external calendar |

## Slash Commands

- **Schedule** - Schedule a task to a future date
- **Overdue to Today** - Move all overdue tasks to today
- **Overdue to This Day** - Move all overdue tasks to the current note's date
- **Sort by Time** - Sort all items by time block

## Installation

1. Copy the plugin folder to `.obsidian/plugins/task-manager/`
2. Enable the plugin in Obsidian settings
3. Configure target folders and preferences

## Settings

- **Target folders**: Which folders to process for task management
- **ID prefix/length**: Customize task ID format
- **Task notes folder**: Where to store task note files
- **Display options**: Toggle info buttons and metadata hiding

## License

MIT
