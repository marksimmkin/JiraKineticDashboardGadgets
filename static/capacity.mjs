import { dateOrdinal } from './progress.mjs';

export const DEFAULT_HOURS_PER_DAY = 8;
const UNASSIGNED_ID = '__unassigned__';

function validHours(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 24;
}

// `config` is the gadget's saved configuration (context.extension.gadgetConfiguration).
export function hoursPerDay(config) {
  const value = config?.hoursPerDay;
  return validHours(value) ? value : DEFAULT_HOURS_PER_DAY;
}

// Edit-form input: "7.5", "7,5", " 8 " are accepted. Returns the number, or null when the text is
// empty, not a plain decimal, or outside 1 to 24.
export function parseHoursInput(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const trimmed = String(text).trim();
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed.replace(',', '.'));
  return validHours(value) ? value : null;
}

// Day ordinal 0 is 1970-01-01, a Thursday. Returns 0 (Sunday) to 6 (Saturday).
export function weekday(day) {
  return ((day + 4) % 7 + 7) % 7;
}

// Monday to Friday from day ordinal `first` to `last` (see dateOrdinal), both inclusive.
export function weekdaysBetween(first, last) {
  if (last < first) return 0;
  const span = last - first + 1;
  let days = Math.floor(span / 7) * 5;
  for (let day = first + Math.floor(span / 7) * 7; day <= last; day += 1) {
    const dow = weekday(day);
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

// Monday to Friday from max(today, startDate) to endDate, both inclusive. Dates are yyyy-mm-dd.
// A missing or unreadable startDate means "from today".
export function workingDaysLeft({ today, startDate, endDate } = {}) {
  const current = dateOrdinal(today);
  if (current === null) throw new Error('Invalid today date.');
  const end = dateOrdinal(endDate);
  if (end === null) return { days: 0, phase: 'no-end' };
  const start = dateOrdinal(startDate);
  if (start !== null && end < start) return { days: 0, phase: 'invalid' };
  if (current > end) return { days: 0, phase: 'ended' };
  if (start !== null && current < start) return { days: weekdaysBetween(start, end), phase: 'not-started' };
  return { days: weekdaysBetween(current, end), phase: 'running' };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function displayPercent(allocation, state) {
  const percent = Math.round(allocation);
  // Keep the shown percentage consistent with the label next to it.
  if (state === 'over' && percent <= 100) return 101;
  if (state === 'under' && percent >= 25) return 24;
  return percent;
}

// `summary` is summarizeAssignees() output. With daysLeft 0 (range ended, or only weekend days
// left) every row is 'none': work is listed without a judgement.
export function capacityRows(summary, { hoursPerDay: hours = DEFAULT_HOURS_PER_DAY, daysLeft = 0 } = {}) {
  const perDay = validHours(hours) ? hours : DEFAULT_HOURS_PER_DAY;
  const judged = Number.isFinite(daysLeft) && daysLeft > 0;
  const rows = (summary?.rows ?? []).map(source => {
    const unassigned = source.id === UNASSIGNED_ID;
    const workDays = round1((source.timeRemaining ?? 0) / 3600 / perDay);
    const total = source.total ?? 0;
    const withoutEstimate = total - (source.estimatedIssues ?? 0);
    const row = { id: source.id, name: source.name, unassigned, workDays, total, withoutEstimate,
      allocation: null, percent: null, state: 'none', spareDays: null, overDays: null };
    if (unassigned || !judged) return row;
    row.allocation = workDays / daysLeft * 100;
    if (total > 0 && withoutEstimate === total) {
      row.state = 'no-estimates';
      row.percent = 0;
      return row;
    }
    if (workDays > daysLeft) {
      row.state = 'over';
      row.overDays = round1(workDays - daysLeft);
    } else {
      row.state = workDays / daysLeft < 0.25 ? 'under' : 'normal';
      row.spareDays = round1(daysLeft - workDays);
    }
    row.percent = displayPercent(row.allocation, row.state);
    return row;
  });
  rows.sort((a, b) => (a.unassigned - b.unassigned) ||
    (judged ? (b.allocation ?? -1) - (a.allocation ?? -1) : b.workDays - a.workDays) ||
    a.name.localeCompare(b.name));
  const highest = Math.max(0, ...rows.map(row => row.allocation ?? 0));
  return { rows, scale: Math.min(200, Math.max(100, highest)) };
}
