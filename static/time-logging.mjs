// Time Logging gadget logic: average time each person logs per working day (Mon-Fri) on the
// filter's issues. DOM-free; `requestJira` is passed in.
import { runBatches } from './burndown.mjs';
import { weekday, weekdaysBetween } from './capacity.mjs';
import { searchPages, SupersededError } from './jira-search.mjs';
import { dateOrdinal, todayInTimezone } from './progress.mjs';

const DAY_MS = 86400000;
export const SEARCH_FIELDS = Object.freeze(['assignee', 'worklog']);
export const WORKLOG_CONCURRENCY = 4;
export const WORKLOG_PAGE_SIZE = 5000;

const SEARCH_MESSAGES = { repeatedPage: 'Jira repeated a search page.' };

function dateFromOrdinal(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isWorkingDay(day) {
  const dow = weekday(day);
  return dow !== 0 && dow !== 6;
}

// The logging period: Start Date to today, or to the End Date once it has passed, both
// inclusive. Dates are yyyy-mm-dd; an unreadable End Date counts as no End Date.
// Returns { kind, startDate, lastDay, ended, workingDays, firstWorkingDay }:
//   kind 'no-start'        no readable Start Date (startDate null)
//        'invalid'         End Date before Start Date
//        'not-started'     today before the Start Date (lastDay null)
//        'no-working-days' started, but no Mon-Fri from startDate to lastDay; `ended` says
//                          whether that is a weekend-only range that has finished
//        'ready'           started, with at least one Mon-Fri so far
//   lastDay: today, or the End Date once it has passed (null unless started).
//   ended: today is after the End Date.
//   workingDays: Mon-Fri from startDate to lastDay inclusive (0 unless started).
//   firstWorkingDay: first Mon-Fri on or after the Start Date, null when that falls after the
//                    End Date (or there is no Start Date, or the range is invalid).
export function loggingPeriod({ today, startDate, endDate } = {}) {
  const current = dateOrdinal(today);
  if (current === null) throw new Error('Invalid today date.');
  const start = dateOrdinal(startDate);
  const empty = { startDate: null, lastDay: null, ended: false, workingDays: 0, firstWorkingDay: null };
  if (start === null) return { kind: 'no-start', ...empty };
  const end = dateOrdinal(endDate);
  if (end !== null && end < start) return { kind: 'invalid', ...empty, startDate };
  let first = start;
  while (!isWorkingDay(first)) first += 1;
  const firstWorkingDay = end !== null && first > end ? null : dateFromOrdinal(first);
  if (current < start) return { kind: 'not-started', ...empty, startDate, firstWorkingDay };
  const ended = end !== null && current > end;
  const last = ended ? end : current;
  const workingDays = weekdaysBetween(start, last);
  return { kind: workingDays ? 'ready' : 'no-working-days', startDate, lastDay: dateFromOrdinal(last),
    ended, workingDays, firstWorkingDay };
}

// "2026-11-10T09:00:00.000+0000" -> Date. Jira writes offsets without a colon.
function parseStarted(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.valueOf()) ? null : date;
}

// The yyyy-mm-dd calendar date a worklog started on in `timeZone` (an IANA name, as in
// context.timezone; unknown or missing means UTC). Null when `started` cannot be read.
export function worklogDate(started, timeZone) {
  const date = parseStarted(started);
  return date ? todayInTimezone(timeZone, date) : null;
}

// Where a worklog falls in `period` (loggingPeriod output), by its start date in `timeZone`:
// 'working-day' (Mon-Fri, counts toward time logged), 'weekend' (in the period but not
// counted), or null (outside the period, unreadable, or the period has not started).
export function worklogPeriodDay(worklog, period, timeZone) {
  const from = dateOrdinal(period?.startDate);
  const to = dateOrdinal(period?.lastDay);
  if (from === null || to === null) return null;
  const day = dateOrdinal(worklogDate(worklog?.started, timeZone));
  if (day === null || day < from || day > to) return null;
  return isWorkingDay(day) ? 'working-day' : 'weekend';
}

// The embedded search field holds at most 20 worklogs; `total` says how many exist.
// KDG-26: Jira's search can leave the field out entirely (for example when Log work is hidden
// in the project's field configuration), so a missing field means "fetch", not "none".
export function hasAllWorklogs(issue) {
  const field = issue?.fields?.worklog;
  if (!field) return false;
  if (!Array.isArray(field.worklogs)) return false;
  return !(typeof field.total === 'number' && field.total > field.worklogs.length);
}

// Epoch ms bounds for the per-issue worklog request: a day's slack each side covers every
// time zone (UTC-12 to UTC+14); worklogs are then filtered exactly by worklogPeriodDay.
export function worklogWindow(period) {
  const from = dateOrdinal(period?.startDate);
  const to = dateOrdinal(period?.lastDay);
  if (from === null || to === null) return null;
  return { startedAfter: (from - 1) * DAY_MS, startedBefore: (to + 2) * DAY_MS };
}

function worklogError(status) {
  if (status === 401 || status === 403) return new Error('You cannot view worklogs for these issues.');
  return new Error(`Jira worklog request failed (${status}).`);
}

// Every worklog on one issue that started inside `window` (worklogWindow output, or null for
// all), following startAt paging. Throws SupersededError, without sending the request, when
// `isCurrent()` is false before a further page. Returns early once `aborted()` is true.
// Returns null when Jira answers 404 (the issue was deleted or moved out of view mid-load).
export async function fetchIssueWorklogs(requestJira, issueIdOrKey, window,
  { isCurrent = () => true, aborted = () => false } = {}) {
  const worklogs = [];
  let startAt = 0;
  for (;;) {
    if (startAt > 0 && !isCurrent()) throw new SupersededError();
    const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(WORKLOG_PAGE_SIZE) });
    if (window) {
      query.set('startedAfter', String(window.startedAfter));
      query.set('startedBefore', String(window.startedBefore));
    }
    const response = await requestJira(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/worklog?${query}`,
      { headers: { Accept: 'application/json' } });
    if (aborted()) return worklogs;
    if (response.status === 404) return null;
    if (!response.ok) throw worklogError(response.status);
    const page = await response.json();
    if (!Array.isArray(page?.worklogs)) throw new Error('Jira returned an invalid worklog list.');
    worklogs.push(...page.worklogs);
    const total = typeof page.total === 'number' ? page.total : worklogs.length;
    if (startAt + page.worklogs.length >= total) return worklogs;
    if (!page.worklogs.length) throw new Error('Jira did not provide the next worklog page.');
    startAt += page.worklogs.length;
  }
}

// Phase 1: every issue matching the JQL with assignee and embedded worklogs.
// `onPage(loadedSoFar)` is called after each search page. `isCurrent()` is checked before
// each page; once false, SupersededError is thrown.
export async function fetchTimeLoggingIssues(requestJira, jql, { onPage, isCurrent } = {}) {
  const issues = [];
  for await (const page of searchPages(requestJira, jql, [...SEARCH_FIELDS],
    { messages: SEARCH_MESSAGES, isCurrent })) {
    issues.push(...page.issues);
    onPage?.(issues.length);
  }
  return issues;
}

// Phase 2: the full, date-filtered worklog list for each issue whose embedded list is
// truncated (more than 20 worklogs). Returns a Map of String(issue.id) -> worklogs for those
// issues only; summarizeTimeLogged uses it in place of the embedded list. Sends nothing when
// the period has no lastDay. `onProgress({ done, total })` is called only when at least one
// issue needs a request: once before the first (done = issues already complete, total = all
// issues), then after each issue's worklogs have all arrived. `isCurrent()` is checked before
// every request; once false, SupersededError is thrown. An issue whose worklog request gets a
// 404 (deleted mid-load) is left out of the Map, so its embedded worklogs are used instead.
export async function fetchWorklogs(requestJira, issues, period,
  { onProgress, isCurrent = () => true } = {}) {
  const worklogsByIssue = new Map();
  const window = worklogWindow(period);
  if (!window) return worklogsByIssue;
  const toFetch = issues.filter(issue => !hasAllWorklogs(issue));
  const total = issues.length;
  let done = total - toFetch.length;
  if (onProgress && toFetch.length) onProgress({ done, total });
  await runBatches(toFetch, WORKLOG_CONCURRENCY, async (issue, aborted) => {
    const id = String(issue.id ?? issue.key);
    const worklogs = await fetchIssueWorklogs(requestJira, id, window, { isCurrent, aborted });
    if (aborted() || !isCurrent()) return;
    if (worklogs) worklogsByIssue.set(id, worklogs);
    done += 1;
    onProgress?.({ done, total });
  }, isCurrent);
  return worklogsByIssue;
}

// Both phases. `onSearchDone()` is called between them.
export async function fetchTimeLogging(requestJira, jql, period,
  { onPage, onSearchDone, onProgress, isCurrent = () => true } = {}) {
  const issues = await fetchTimeLoggingIssues(requestJira, jql, { onPage, isCurrent });
  onSearchDone?.();
  const worklogsByIssue = await fetchWorklogs(requestJira, issues, period, { onProgress, isCurrent });
  return { issues, worklogsByIssue };
}

const nameCollator = new Intl.Collator('en-GB', { sensitivity: 'base' });

// People: current assignees plus authors of any worklog in the period (weekends included),
// by accountId; same name with a different accountId is two people; no Unassigned row.
//   loggedSeconds: timeSpentSeconds of the person's worklogs on working days in the period.
//   averageSeconds: loggedSeconds / workingDays, unrounded; null when workingDays is 0.
//   issueCount: issues where the person has any worklog in the period, weekends included
//               (matches worklogAuthor = X AND worklogDate >= startDate AND <= lastDay).
// Sorted by average high to low, then displayName (en-GB, base sensitivity), then accountId.
// `worklogsByIssue` (Map of String(issue.id) -> worklogs) replaces an issue's embedded list.
// Worklogs repeated with the same id on one issue count once.
// Returns { people, totalSeconds, totalIssues, loggedIssues, workingDays }:
// totalIssues = issues in the filter; loggedIssues = issues with any worklog in the period.
export function summarizeTimeLogged(issues, worklogsByIssue = new Map(), period = {}, timeZone) {
  const people = new Map();
  const person = user => {
    const accountId = user?.accountId;
    if (!accountId) return null;
    let entry = people.get(accountId);
    if (!entry) {
      entry = { accountId, displayName: user.displayName || accountId, loggedSeconds: 0,
        averageSeconds: null, issueCount: 0 };
      people.set(accountId, entry);
    } else if (entry.displayName === accountId && user.displayName) {
      entry.displayName = user.displayName;
    }
    return entry;
  };
  let totalIssues = 0;
  let loggedIssues = 0;
  for (const issue of issues ?? []) {
    totalIssues += 1;
    person(issue?.fields?.assignee);
    const id = String(issue?.id ?? issue?.key);
    const worklogs = worklogsByIssue?.get?.(id) ?? issue?.fields?.worklog?.worklogs ?? [];
    const seen = new Set();
    const authors = new Set();
    for (const worklog of worklogs) {
      if (!worklog?.author?.accountId) continue;
      if (worklog.id !== undefined && worklog.id !== null) {
        if (seen.has(String(worklog.id))) continue;
        seen.add(String(worklog.id));
      }
      const day = worklogPeriodDay(worklog, period, timeZone);
      if (!day) continue;
      const author = person(worklog.author);
      authors.add(author);
      const spent = worklog.timeSpentSeconds;
      if (day === 'working-day' && typeof spent === 'number' && Number.isFinite(spent) && spent > 0) {
        author.loggedSeconds += spent;
      }
    }
    for (const author of authors) author.issueCount += 1;
    if (authors.size) loggedIssues += 1;
  }
  const workingDays = Number.isFinite(period?.workingDays) && period.workingDays > 0 ? period.workingDays : 0;
  let totalSeconds = 0;
  const rows = [...people.values()];
  for (const row of rows) {
    totalSeconds += row.loggedSeconds;
    row.averageSeconds = workingDays ? row.loggedSeconds / workingDays : null;
  }
  rows.sort((a, b) => ((b.averageSeconds ?? 0) - (a.averageSeconds ?? 0)) ||
    nameCollator.compare(a.displayName, b.displayName) ||
    (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  return { people: rows, totalSeconds, totalIssues, loggedIssues, workingDays };
}

const hoursFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

// Jira-style time spent in hours and minutes, rounded to the nearest minute first (30 seconds
// rounds up), en-GB grouping for hours, a non-breaking space between hours and minutes:
// "0m", "45m", "6h", "6h 30m", "1,234h 5m". Missing, negative or non-finite is "0m".
export function formatTimeSpent(seconds) {
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  const text = `${hoursFormat.format(hours)}h`;
  return rest ? `${text} ${rest}m` : text;
}
