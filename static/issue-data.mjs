import { statusKey } from './shared.mjs';

export const DEFAULT_COLUMNS = ['key', 'summary', 'status', 'assignee'];

export function configuredColumns(context) {
  const saved = context?.extension?.gadgetConfiguration?.columns;
  if (!Array.isArray(saved)) return DEFAULT_COLUMNS;
  const columns = [...new Set(saved.filter(id =>
    typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(id)))].slice(0, 10);
  return columns.length ? columns : DEFAULT_COLUMNS;
}

export async function searchIssuePage(requestJira, jql, fields, nextPageToken, maxResults = 1000) {
  const body = { jql, fields, maxResults };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const response = await requestJira('/rest/api/3/search/jql', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 400) throw new Error('The selected JQL or column selection is invalid.');
    if (response.status === 401 || response.status === 403) throw new Error('You cannot view issues for this filter.');
    throw new Error(`Jira search failed (${response.status}).`);
  }
  const page = await response.json();
  if (!Array.isArray(page.issues)) throw new Error('Jira returned an invalid search result.');
  if (page.isLast !== true && !page.nextPageToken) throw new Error('Jira did not provide the next search page.');
  return page;
}

export async function searchAllIssues(requestJira, jql, fields) {
  const issues = [];
  let nextPageToken;
  const seen = new Set();
  for (;;) {
    const page = await searchIssuePage(requestJira, jql, fields, nextPageToken);
    issues.push(...page.issues);
    if (page.isLast === true) return issues;
    nextPageToken = page.nextPageToken;
    if (seen.has(nextPageToken)) throw new Error('Jira repeated a search page.');
    seen.add(nextPageToken);
  }
}

export function summarizeAssignees(issues, statuses) {
  const weights = new Map(statuses.map(status => [statusKey(status.name), status.weight]));
  const statusNames = new Map();
  const statusIds = new Map();
  const rows = new Map();
  const missing = new Set();
  for (const issue of issues) {
    const assignee = issue?.fields?.assignee;
    const id = assignee?.accountId || '__unassigned__';
    const name = assignee ? (assignee.displayName || assignee.accountId || 'Unknown user') : 'Unassigned';
    const statusName = issue?.fields?.status?.name || 'Unknown status';
    const key = statusKey(statusName);
    if (!statusNames.has(key)) statusNames.set(key, statusName);
    const statusId = issue?.fields?.status?.id;
    if (statusId !== null && statusId !== undefined) {
      const ids = statusIds.get(key) ?? new Set();
      ids.add(String(statusId));
      statusIds.set(key, ids);
    }
    const row = rows.get(id) ?? { id, name, total: 0, counts: Object.create(null), score: 0 };
    row.total += 1;
    row.counts[key] = (row.counts[key] ?? 0) + 1;
    if (weights.has(key)) row.score += weights.get(key);
    else missing.add(statusName);
    rows.set(id, row);
  }
  const configuredOrder = new Map(statuses.map((status, index) => [statusKey(status.name), index]));
  const columns = [...statusNames].sort((a, b) =>
    (configuredOrder.get(a[0]) ?? Infinity) - (configuredOrder.get(b[0]) ?? Infinity) ||
    a[1].localeCompare(b[1]));
  return {
    rows: [...rows.values()],
    statuses: columns.map(([key, name]) => ({ key, name, ids: [...(statusIds.get(key) ?? [])] })),
    unmapped: [...missing].sort((a, b) => a.localeCompare(b)),
    total: issues.length,
  };
}

export function formatIssueField(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(formatIssueField).join(', ') : '—';
  if (value && typeof value === 'object') {
    for (const key of ['displayName', 'name', 'value', 'key', 'title']) {
      if ((typeof value[key] === 'string' && value[key]) || typeof value[key] === 'number') {
        return String(value[key]);
      }
    }
    if (value.type === 'doc' && Array.isArray(value.content)) {
      const fragments = [];
      const visit = item => {
        if (typeof item?.text === 'string') fragments.push(item.text);
        if (Array.isArray(item?.content)) item.content.forEach(visit);
      };
      value.content.forEach(visit);
      return fragments.join(' ') || '—';
    }
  }
  return JSON.stringify(value)?.slice(0, 200) || '—';
}
