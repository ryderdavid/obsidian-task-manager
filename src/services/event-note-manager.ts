import { Notice, TFile } from 'obsidian';

// ============================================================================
// EVENT NOTE MANAGER MODULE
// ============================================================================
// Creates and manages notes for calendar events, similar to Task Notes.
// When clicking a calendar event's "notes" button, creates a note with
// the event's UID in frontmatter for tracking/linking purposes.
// ============================================================================

/**
 * Sanitize event title for use as filename
 */
export function sanitizeFilename(text) {
  if (!text) return null;
  // Remove time range at start (e.g., "10:00 - 15:00")
  let cleaned = text.replace(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '');
  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
  // Remove special characters that are problematic in filenames
  cleaned = cleaned.replace(/[<>:"/\\|?*]/g, '');
  // Trim whitespace and limit length
  cleaned = cleaned.trim().substring(0, 100);
  return cleaned || null;
}

/**
 * Extract event title from a calendar event line
 * e.g., "- [c] 10:00 - 15:00 Meeting Name https://... [uid::xxx]"
 * Returns: "Meeting Name"
 */
export function extractEventTitle(line) {
  // Remove the checkbox prefix
  let text = line.replace(/^[\t]*- \[c\]\s*/, '');
  // Remove time range
  text = text.replace(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '');
  // Remove uid metadata
  text = text.replace(/\s*\[uid::[^\]]+\]/g, '');
  // Remove calendar metadata
  text = text.replace(/\s*\[calendar::[^\]]+\]/g, '');
  // Remove URLs but keep text before them
  text = text.replace(/\s*https?:\/\/[^\s]+/g, '');
  return text.trim();
}

/**
 * Extract time range from calendar event line
 * Returns object { start: "HH:MM", end: "HH:MM" } or null
 */
export function extractTimeRange(line) {
  const match = line.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
  if (match) {
    return { start: match[1], end: match[2] };
  }
  return null;
}

/**
 * Open or create an event note for a calendar event
 * @param {App} app - Obsidian app instance
 * @param {Object} settings - Plugin settings
 * @param {string} eventTitle - The event title (used as filename)
 * @param {string} uid - The calendar event UID
 * @param {string} sourceFilePath - Path to the daily note containing this event
 * @param {string} timeRange - Optional time range string
 * @param {string} calendarSource - Optional calendar source name (e.g., "Work", "Fastmail")
 */
export async function openOrCreateEventNote(app, settings, eventTitle, uid, sourceFilePath, timeRange = null, calendarSource = null) {
  const sanitizedName = sanitizeFilename(eventTitle);
  if (!sanitizedName) {
    new Notice('Could not extract event name');
    return null;
  }

  const folderPath = settings.eventNotesFolder;
  const filePath = `${folderPath}/${sanitizedName}.md`;

  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder) {
    await app.vault.createFolder(folderPath);
  }

  let file = app.vault.getAbstractFileByPath(filePath);

  if (!file) {
    const sourceLink = sourceFilePath ? `[[${sourceFilePath.replace(/\.md$/, '')}]]` : '';
    const timeInfo = timeRange ? `${timeRange.start} - ${timeRange.end}` : '';
    const dateFromSource = sourceFilePath ? sourceFilePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1] : new Date().toISOString().split('T')[0];

    // Event note frontmatter includes eventUID for tracking
    const content = `---
event: "${eventTitle.replace(/"/g, '\\"')}"
eventUID: "${uid || ''}"
calendar: "${calendarSource || ''}"
date: ${dateFromSource}
time: "${timeInfo}"
created: ${new Date().toISOString().split('T')[0]}
sourceFile: "${sourceFilePath || ''}"
---

# ${eventTitle}

**Date:** ${dateFromSource}${timeInfo ? `  |  **Time:** ${timeInfo}` : ''}
**Source:** ${sourceLink}

---

## Agenda


## Notes


## Action Items

- [ ]

## Follow-ups


`;
    file = await app.vault.create(filePath, content);
    new Notice(`Created: ${sanitizedName}`);
  }

  if (file instanceof TFile) {
    await app.workspace.getLeaf().openFile(file);
  }

  return file;
}
