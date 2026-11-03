import { statusKey } from './shared.mjs';

function dateOrdinal(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return null;
  return Math.floor(date.valueOf() / 86400000);
}

export function todayInTimezone(timezone, now = new Date()) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function calendarProgress(startDate, endDate, today) {
  const start = dateOrdinal(startDate);
  const end = dateOrdinal(endDate);
  const current = dateOrdinal(today);
  if (start === null || end === null || current === null) return { kind: 'missing' };
  if (end < start) return { kind: 'invalid' };
  // Whole-day inclusive model: the period runs from Start Date 00:00 to End Date 24:00, so an
  // n-day period has n = end - start + 1 and today counts as not yet elapsed. `day` is today's
  // 1-based index while the period is running ('during') and null before or after it.
  const days = end - start + 1;
  const elapsed = Math.min(days, Math.max(0, current - start));
  const phase = current < start ? 'before' : current > end ? 'after' : 'during';
  const day = phase === 'during' ? current - start + 1 : null;
  return { kind: 'ready', fraction: elapsed / days, day, days, phase };
}

export function weightedProgress(result, statuses) {
  if (result.total === 0) return { kind: 'empty' };
  if (result.unmapped.length) return { kind: 'unmapped', statuses: result.unmapped };
  const remaining = statuses.reduce((sum, status) =>
    sum + (result.counts[statusKey(status.name)] ?? 0) * status.weight, 0);
  return {
    kind: 'ready',
    fraction: Math.min(1, Math.max(0, 1 - remaining / result.total)),
    remaining,
    total: result.total,
  };
}
