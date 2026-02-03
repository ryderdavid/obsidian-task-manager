// ============================================================================
// SCHEDULE DATE OPTIONS
// ============================================================================

export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

export function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatDate(d);
}

export function getDayAfterTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return formatDate(d);
}

export function getNextMonday() {
  const d = new Date();
  const dayOfWeek = d.getDay();
  // Days until next Monday: if today is Monday (1), go to next week's Monday (7 days)
  // Otherwise calculate days remaining
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
  d.setDate(d.getDate() + daysUntilMonday);
  return formatDate(d);
}

export function getOneWeekFromNow() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return formatDate(d);
}

// Parse and normalize date input flexibly
// Supports: YYYY-MM-DD, YYYYMMDD, and natural language via nldates plugin
export function parseCustomDate(input, app) {
  if (!input) return null;
  const cleaned = input.trim();

  // Try YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  // Try YYYYMMDD format
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }

  // Try natural language parsing via nldates plugin
  if (app) {
    const parsed = parseNaturalDate(cleaned, app);
    if (parsed) return parsed;
  }

  return null;
}

// Parse natural language date string using nldates-obsidian plugin
// Returns YYYY-MM-DD string or null
export function parseNaturalDate(input, app) {
  if (!input || !app) return null;
  try {
    const nldates = app.plugins.getPlugin('nldates-obsidian');
    if (!nldates) return null;
    const result = nldates.parse(input, 'YYYY-MM-DD');
    if (result && result.formattedString && result.formattedString !== 'Invalid date') {
      // Validate the result is actually a date
      if (/^\d{4}-\d{2}-\d{2}$/.test(result.formattedString)) {
        return result.formattedString;
      }
    }
  } catch (e) {
    console.debug('Task Manager: nldates parsing failed for:', input, e);
  }
  return null;
}
