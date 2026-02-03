import { isCalendarEvent, shouldProcessFile } from '../utils/task-utils';

// ============================================================================
// ICS CALENDAR EVENT SYNC MODULE
// ============================================================================

// Pattern to extract UID from calendar event line
export const UID_PATTERN = /\[uid::([^\]]+)\]/;
// Pattern to extract calendar source from calendar event line
export const CALENDAR_PATTERN = /\[calendar::([^\]]+)\]/;

// Extract UID from a calendar event line
export function extractUid(line) {
  const match = line.match(UID_PATTERN);
  return match ? match[1].trim() : null;
}

// Extract calendar source name from a calendar event line
export function extractCalendar(line) {
  const match = line.match(CALENDAR_PATTERN);
  return match ? match[1].trim() : null;
}

// Format time as HH:MM
export function formatTime(hour, minute) {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

// Build a calendar event line from ICS event data
// ICS plugin returns: { uid, time, endTime, summary, location, callUrl, utime, icsName, ... }
export function buildEventLine(event, settings) {
  // ICS plugin already formats times as strings like "10:00"
  const startTime = event.time || '00:00';
  const endTime = event.endTime || startTime;

  // Build event text - include location and URL if present
  let text = event.summary || 'Untitled Event';
  if (event.location) {
    text += ` ${event.location}`;
  }
  // Add video call URL if present
  if (event.callUrl) {
    text += ` ${event.callUrl}`;
  }

  // Use the real UID from the ICS file (from our forked plugin)
  const uid = event.uid || `fallback-${event.utime}`;

  // Get calendar source name from ICS plugin
  const calendarName = event.icsName || '';

  // Build the line with UID and calendar source
  let line = `- [c] ${startTime} - ${endTime} ${text} [uid::${uid}]`;
  if (calendarName) {
    line += ` [calendar::${calendarName}]`;
  }
  return line;
}

// Check if a file is a daily note for a specific date
export function getDailyNoteDate(file, settings) {
  // Check if file is in target folders
  if (!shouldProcessFile(file, settings)) return null;

  // Try to parse date from filename (YYYY-MM-DD.md)
  const match = file.basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
}

// Get events from ICS plugin for a specific date
export async function getIcsEvents(app, date) {
  try {
    const icsPlugin = app.plugins.getPlugin('ics');
    if (!icsPlugin || !icsPlugin.getEvents) {
      return null; // ICS plugin not available
    }

    // ICS plugin expects a moment object
    const moment = window.moment;
    if (!moment) return null;

    const events = await icsPlugin.getEvents(moment(date));
    return events;
  } catch (e) {
    console.error('Task Manager: Error fetching ICS events', e);
    return null;
  }
}

// Sync ICS events into a daily note
export async function syncEventsToNote(app, file, settings) {
  const noteDate = getDailyNoteDate(file, settings);
  if (!noteDate) return false;

  // Get ICS events for this date
  const icsEvents = await getIcsEvents(app, noteDate);
  if (!icsEvents || icsEvents.length === 0) {
    // No events to sync - but we should still remove stale events
    // For now, return false if no ICS events
    return false;
  }

  // Read current file content
  const content = await app.vault.read(file);
  const lines = content.split('\n');

  // Separate calendar events from other content
  const calendarLines = [];
  const otherLines = [];

  for (const line of lines) {
    if (isCalendarEvent(line)) {
      calendarLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  // Build a map of existing events by UID
  const existingByUid = new Map();
  for (const line of calendarLines) {
    const uid = extractUid(line);
    if (uid) {
      existingByUid.set(uid, line);
    }
  }

  // Build new calendar events list
  const newCalendarLines = [];

  for (const event of icsEvents) {
    // Always use fresh data from ICS (overwrite)
    const newLine = buildEventLine(event, settings);
    newCalendarLines.push({
      line: newLine,
      utime: event.utime || 0  // Use utime for sorting
    });
  }

  // Sort calendar events by start time (using utime from ICS plugin)
  newCalendarLines.sort((a, b) => a.utime - b.utime);

  // Find where to insert calendar events (at the top of the file, before tasks)
  // Strategy: calendar events go at the very top
  const sortedEventLines = newCalendarLines.map(e => e.line);

  // Rebuild file: calendar events first, then everything else
  const newContent = [...sortedEventLines, ...otherLines].join('\n');

  // Only write if content changed
  if (newContent !== content) {
    await app.vault.modify(file, newContent);
    return true;
  }

  return false;
}
