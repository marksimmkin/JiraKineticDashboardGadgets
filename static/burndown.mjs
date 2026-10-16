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

async function postJira(requestJira, path, body) {
  const response = await requestJira(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 400) throw new Error('The selected JQL or changelog request is invalid.');
    if (response.status === 401 || response.status === 403) {
      throw new Error('You cannot view these issues or their status history.');
    }
    throw new Error(`Jira request failed (${response.status}).`);
  }
  return response.json();
}

export async function fetchBurndownIssues(requestJira, jql) {
  const issues = [];
  let nextPageToken;
  const visited = new Set();
  for (;;) {
    const body = { jql, fields: ['created', 'status'], maxResults: 1000 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const page = await postJira(requestJira, '/rest/api/3/search/jql', body);
    if (!Array.isArray(page.issues)) throw new Error('Jira returned an invalid issue search result.');
    issues.push(...page.issues);
    if (page.isLast === true) return issues;
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || visited.has(nextPageToken)) throw new Error('Jira did not provide the next issue page.');
    visited.add(nextPageToken);
  }
}

export async function fetchStatusChanges(requestJira, issues) {
  const changes = new Map();
  for (let offset = 0; offset < issues.length; offset += 1000) {
    const ids = issues.slice(offset, offset + 1000).map(issue => String(issue.id));
    let nextPageToken;
    const visited = new Set();
    for (;;) {
      const body = { issueIdsOrKeys: ids, fieldIds: ['status'], maxResults: 1000 };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const page = await postJira(requestJira, '/rest/api/3/changelog/bulkfetch', body);
      if (!Array.isArray(page.issueChangeLogs)) throw new Error('Jira returned an invalid status history.');
      for (const item of page.issueChangeLogs) {
        const id = String(item.issueId);
        if (!Array.isArray(item.changeHistories)) throw new Error('Jira returned an invalid status history.');
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
      if (!nextPageToken) break;
      if (visited.has(nextPageToken)) throw new Error('Jira repeated a status history page.');
      visited.add(nextPageToken);
    }
  }
  for (const entries of changes.values()) entries.sort((a, b) => a.at - b.at);
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
