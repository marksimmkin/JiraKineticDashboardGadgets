import { postJira as postJiraRequest, searchPages } from './jira-search.mjs';
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

export async function fetchBurndownIssues(requestJira, jql) {
  const issues = [];
  for await (const page of searchPages(requestJira, jql, ['created', 'status', 'updated'], { messages: BURNDOWN_MESSAGES })) {
    issues.push(...page.issues);
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
// `aborted()` reports that another batch has already failed.
async function fetchStatusChangeBatch(requestJira, ids, aborted) {
  const changes = new Map();
  let nextPageToken;
  const visited = new Set();
  for (;;) {
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
// rejects with the first error and starts no further requests.
function runBatches(batches, limit, run) {
  return new Promise((resolve, reject) => {
    const results = new Array(batches.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const aborted = () => failed;
    const startNext = () => {
      if (failed || next >= batches.length) return;
      const index = next++;
      run(batches[index], aborted).then(result => {
        if (failed) return;
        results[index] = result;
        done += 1;
        if (done === batches.length) resolve(results);
        else startNext();
      }, error => {
        if (failed) return;
        failed = true;
        reject(error);
      });
    };
    if (!batches.length) { resolve(results); return; }
    for (let i = 0; i < Math.min(limit, batches.length); i += 1) startNext();
  });
}

// Returns issueId -> status changes sorted by time. Issues whose `fields.updated` matches the
// cached value reuse their cached history; only new or changed issues are sent to bulkfetch.
export async function fetchStatusChanges(requestJira, issues, { cache = statusChangeCache } = {}) {
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
  const results = await runBatches(batches, CHANGELOG_CONCURRENCY,
    (ids, aborted) => fetchStatusChangeBatch(requestJira, ids, aborted));

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
  const actual = [{ date: startDate, remaining: baseline }];
  let remaining = baseline;
  for (const [day, delta] of [...deltas].sort((a, b) => a[0] - b[0])) {
    remaining += delta;
    actual.push({ date: dateFromDay(day), remaining });
  }
  if (actual.at(-1).date !== dateFromDay(lastObserved)) {
    actual.push({ date: dateFromDay(lastObserved), remaining });
  }
  return { kind: 'ready', baseline, remaining, actual, startDate, endDate, total: issues.length };
}
