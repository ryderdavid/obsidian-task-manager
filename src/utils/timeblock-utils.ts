// ============================================================================
// TIMEBLOCK UTILITIES
// ============================================================================

// Extract existing timeblock from a task line (format: "HH:MM - HH:MM" at start)
export function extractTimeblock(line: string): {
  prefix: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  fullMatch: string;
} | null {
  const match = line.match(/^([\t]*- \[.\]\s*)(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s*/);
  if (match) {
    return {
      prefix: match[1],
      startHour: parseInt(match[2]),
      startMinute: parseInt(match[3]),
      endHour: parseInt(match[4]),
      endMinute: parseInt(match[5]),
      fullMatch: match[0]
    };
  }
  return null;
}

// Format time as HH:MM
export function formatTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

// Format time for display (e.g., "09 AM", "12 PM")
export function formatDisplayTime(hour: number): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${pad(hour)} AM`;
  return `${pad(hour - 12)} PM`;
}

// Add timeblock to a task line
export function addTimeblock(line: string, startHour: number, startMinute: number, endHour: number, endMinute: number): string {
  const existing = extractTimeblock(line);
  const timeblock = `${formatTime(startHour, startMinute)} - ${formatTime(endHour, endMinute)} `;

  if (existing) {
    // Replace existing timeblock
    return line.replace(existing.fullMatch, existing.prefix + timeblock);
  } else {
    // Insert after the task marker "- [x] "
    return line.replace(/^([\t]*- \[.\]\s*)/, `$1${timeblock}`);
  }
}

// Remove timeblock from a task line
export function removeTimeblock(line: string): string {
  return line.replace(/^([\t]*- \[.\]\s*)\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*/, '$1');
}

// Calculate default end time (start + 30 minutes)
export function getDefaultEndTime(startHour: number, startMinute: number): { hour: number; minute: number } {
  let endMinute = startMinute + 30;
  let endHour = startHour;
  if (endMinute >= 60) {
    endMinute -= 60;
    endHour = (endHour + 1) % 24;
  }
  return { hour: endHour, minute: endMinute };
}
