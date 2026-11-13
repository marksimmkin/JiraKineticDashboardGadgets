import { postJira as postJiraRequest, searchPages, SupersededError } from './jira-search.mjs';
import { statusKey } from './shared.mjs';
import { todayInTimezone } from './progress.mjs';

const DAY_MS = 86400000;

function dayNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? null : Math.floor(date.valueOf() / DAY_MS);
}

function dateFromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function jiraInstant(value) {
  const date = typeof value === 'number'
    ? new Date(value < 1e11 ? value * 1000 : value)
    : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('Jira returned a status change with an invalid date.');
  return date;
}

const BURNDOWN_MESSAGES = {
  badRequest: 'The selected JQL or changelog request is invalid.',
  forbidden: 'You cannot view these issues or their status history.',
  failed: status => `Jira request failed (${status}).`,
  invalidResult: 'Jira returned an invalid issue search result.',
  missingPage: 'Jira did not provide the next issue page.',
  repeatedPage: 'Jira did not provide the next issue page.',
};

function postJira(requestJira, path, body) {
  return postJiraRequest(requestJira, path, body, BURNDOWN_MESSAGES);
}

// `onPage(loadedSoFar)`, if given, is called after each search page with the running total.
// `isCurrent`, if given, stops the walk early with SupersededError (see searchPages).
export async function fetchBurndownIssues(requestJira, jql, { onPage, isCurrent } = {}) {
  const issues = [];
  for await (const page of searchPages(requestJira, jql, ['created', 'status', 'updated'],
    { messages: BURNDOWN_MESSAGES, isCurrent })) {
    issues.push(...page.issues);
    onPage?.(issues.length);
  }
  return issues;
}

const CHANGELOG_BATCH_SIZE = 1000;
const CHANGELOG_CONCURRENCY = 3;
const INVALID_HISTORY = 'Jira returned an invalid status history.';

// Deep-copies status changes so callers and the cache never share objects or Dates.
const copyEntries = entries => entries.map(change => ({ ...change, at: new Date(change.at) }));

// Session cache of status histories: issueId -> { updated, entries }. It lives as long as the
// gadget iframe, is reused only while an issue's `updated` value is unchanged, and is pruned to
// the issues in the latest successful fetch so it cannot grow without limit.
const statusChangeCache = new Map();

export function clearStatusChangeCache() {
  statusChangeCache.clear();
}

// Fetches one batch of issue IDs, following its nextPageToken chain in order. Returns a
// batch-local Map so that concurrent batches never write to shared state. Stops early when
// `aborted()` reports that another batch has already failed. Throws SupersededError, without
// sending the request, when `isCurrent()` is false before a nextPageToken page.
async function fetchStatusChangeBatch(requestJira, ids, aborted, isCurrent) {
  const changes = new Map();
  let nextPageToken;
  const visited = new Set();
  for (;;) {
    if (nextPageToken && !isCurrent()) throw new SupersededError();
    const body = { issueIdsOrKeys: ids, fieldIds: ['status'], maxResults: 1000 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const page = await postJira(requestJira, '/rest/api/3/changelog/bulkfetch', body);
    if (aborted()) return changes;
    if (!Array.isArray(page?.issueChangeLogs)) throw new Error(INVALID_HISTORY);
    for (const item of page.issueChangeLogs) {
      if (!item || !Array.isArray(item.changeHistories)) throw new Error(INVALID_HISTORY);
      const id = String(item.issueId);
      const entries = changes.get(id) ?? [];
      for (const history of item.changeHistories) {
        for (const field of history.items ?? []) {
          if (statusKey(field.fieldId ?? field.field) !== 'status') continue;
          entries.push({
            at: jiraInstant(history.created),
            from: field.fromString || 'Unknown status',
            to: field.toString || 'Unknown status',
          });
        }
      }
      changes.set(id, entries);
    }
    nextPageToken = page.nextPageToken;
    if (!nextPageToken) return changes;
    if (visited.has(nextPageToken)) throw new Error('Jira repeated a status history page.');
    visited.add(nextPageToken);
  }
}

// Runs every batch with at most `limit` in flight. Resolves with results in batch order, or
// rejects with the first error and starts no further requests. Once `isCurrent()` is false it
// starts no new batch, discards any batch that finishes, and rejects with SupersededError.
export function runBatches(batches, limit, run, isCurrent = () => true) {
  return new Promise((resolve, reject) => {
    const results = new Array(batches.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const aborted = () => failed;
    const fail = error => {
      failed = true;
      reject(error);
    };
    const startNext = () => {
      if (failed || next >= batches.length) return;
      if (!isCurrent()) { fail(new SupersededError()); return; }
      const index = next++;
      run(batches[index], aborted).then(result => {
        if (failed) return;
        if (!isCurrent()) { fail(new SupersededError()); return; }
        results[index] = result;
        done += 1;
        if (done === batches.length) resolve(results);
        else startNext();
      }, error => {
        if (failed) return;
        fail(error);
      });
    };
    if (!batches.length) { resolve(results); return; }
    for (let i = 0; i < Math.min(limit, batches.length); i += 1) startNext();
  });
}

// Returns issueId -> status changes sorted by time. Issues whose `fields.updated` matches the
// cached value reuse their cached history; only new or changed issues are sent to bulkfetch.
// `onProgress({ done, total })`, if given, is called only when at least one issue needs a
// request: once before the first request (done = issues served from the cache), then each time
// a whole batch finishes, including all of its nextPageToken pages (done grows by its ID count).
// It is never called when everything is cached, nor for batches that end after a failure.
// `isCurrent()`, if given, is checked before each batch and each nextPageToken page; once it is
// false no further request is sent, the cache is left untouched and SupersededError is thrown.
export async function fetchStatusChanges(requestJira, issues,
  { cache = statusChangeCache, onProgress, isCurrent = () => true } = {}) {
  const changes = new Map();
  const updatedById = new Map();
  const toFetch = [];
  for (const issue of issues) {
    const id = String(issue.id);
    const updated = issue.fields?.updated;
    updatedById.set(id, updated);
    const cached = cache.get(id);
    if (updated && cached && cached.updated === updated) {
      if (cached.entries) changes.set(id, copyEntries(cached.entries));
    } else {
      toFetch.push(id);
    }
  }

  const batches = [];
  for (let offset = 0; offset < toFetch.length; offset += CHANGELOG_BATCH_SIZE) {
    batches.push(toFetch.slice(offset, offset + CHANGELOG_BATCH_SIZE));
  }
  const total = issues.length;
  let done = total - toFetch.length;
  if (onProgress && toFetch.length) onProgress({ done, total });
  const results = await runBatches(batches, CHANGELOG_CONCURRENCY, async (ids, aborted) => {
    const batch = await fetchStatusChangeBatch(requestJira, ids, aborted, isCurrent);
    if (onProgress && !aborted() && isCurrent()) {
      done += ids.length;
      onProgress({ done, total });
    }
    return batch;
  }, isCurrent);

  const fetched = new Map();
  for (const batch of results) {
    for (const [id, entries] of batch) {
      const existing = fetched.get(id);
      if (existing) existing.push(...entries);
      else fetched.set(id, entries);
    }
  }
  for (const entries of fetched.values()) entries.sort((a, b) => a.at - b.at);

  for (const id of toFetch) {
    const updated = updatedById.get(id);
    const entries = fetched.get(id);
    if (updated) cache.set(id, { updated, entries: entries && copyEntries(entries) });
    else cache.delete(id);
  }
  for (const id of cache.keys()) {
    if (!updatedById.has(id)) cache.delete(id);
  }
  for (const [id, entries] of fetched) changes.set(id, entries);
  return changes;
}

export function buildBurndown(issues, changes, statuses, startDate, endDate, today, timezone) {
  const start = dayNumber(startDate);
  const end = dayNumber(endDate);
  const current = dayNumber(today);
  if (start === null || end === null || current === null) return { kind: 'missing' };
  if (end < start) return { kind: 'invalid' };
  if (current < start) return { kind: 'future' };
  if (!issues.length) return { kind: 'empty' };

  const lastObserved = Math.min(current, end);
  const weights = new Map(statuses.map(status => [statusKey(status.name), status.weight]));
  const missing = new Set();
  const score = name => {
    const key = statusKey(name);
    if (weights.has(key)) return weights.get(key);
    missing.add(name || 'Unknown status');
    return 0;
  };
  const deltas = new Map();
  let baseline = 0;

  for (const issue of issues) {
    if (!issue?.id || !issue?.fields?.created) throw new Error('Jira returned an issue without its creation date.');
    const created = dayNumber(todayInTimezone(timezone, jiraInstant(issue.fields.created)));
    const history = changes.get(String(issue.id)) ?? [];
    let state = history[0]?.from ?? issue.fields.status?.name ?? 'Unknown status';
    const laterStates = new Map();
    for (const change of history) {
      const day = dayNumber(todayInTimezone(timezone, change.at));
      if (day < start) state = change.to;
      else if (day <= lastObserved) laterStates.set(day, change.to);
    }

    let previous = created < start ? score(state) : 0;
    baseline += previous;
    const eventDays = new Set(laterStates.keys());
    if (created >= start && created <= lastObserved) eventDays.add(created);
    for (const day of [...eventDays].sort((a, b) => a - b)) {
      if (laterStates.has(day)) state = laterStates.get(day);
      const next = day >= created ? score(state) : 0;
      deltas.set(day, (deltas.get(day) ?? 0) + next - previous);
      previous = next;
    }
  }

  if (missing.size) return { kind: 'unmapped', statuses: [...missing].sort((a, b) => a.localeCompare(b)) };
  // Each point is tagged with its kind and `offset`, the day boundary it sits on counted in days
  // from Start Date 00:00: 0 for the baseline ('start'), and day - start + 1 (that day's 24:00)
  // for an end-of-day score ('end') or today's current score while today <= End Date ('today').
  const point = (day, remaining) => ({
    date: dateFromDay(day), remaining, kind: day === current ? 'today' : 'end', offset: day - start + 1,
  });
  const actual = [{ date: startDate, remaining: baseline, kind: 'start', offset: 0 }];
  let remaining = baseline;
  for (const [day, delta] of [...deltas].sort((a, b) => a[0] - b[0])) {
    remaining += delta;
    actual.push(point(day, remaining));
  }
  if (actual.at(-1).offset !== lastObserved - start + 1) actual.push(point(lastObserved, remaining));
  return {
    kind: 'ready', baseline, remaining, actual, startDate, endDate, days: end - start + 1, total: issues.length,
  };
}
