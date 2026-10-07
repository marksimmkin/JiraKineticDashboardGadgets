import { statusKey } from './shared.mjs';

export async function countIssuesByStatus(requestJira, jql, statuses) {
  const counts = Object.fromEntries(statuses.map(status => [statusKey(status.name), 0]));
  const unmapped = new Map();
  const statusIds = new Map();
  let total = 0;
  let nextPageToken;
  const visitedTokens = new Set();

  for (;;) {
    const body = { jql, fields: ['status'], maxResults: 1000 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await requestJira('/rest/api/3/search/jql', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 400) throw new Error('The selected JQL is invalid or cannot be searched.');
      if (response.status === 401 || response.status === 403) throw new Error('You cannot view issues for this filter.');
      throw new Error(`Jira search failed (${response.status}).`);
    }
    const page = await response.json();
    if (!Array.isArray(page.issues)) throw new Error('Jira returned an invalid search result.');
    for (const issue of page.issues) {
      total += 1;
      const rawName = issue?.fields?.status?.name;
      const name = typeof rawName === 'string' && rawName.trim() ? rawName : 'Unknown status';
      const key = statusKey(name);
      const id = issue?.fields?.status?.id;
      if (id !== null && id !== undefined) {
        const ids = statusIds.get(key) ?? new Set();
        ids.add(String(id));
        statusIds.set(key, ids);
      }
      if (Object.hasOwn(counts, key)) counts[key] += 1;
      else {
        const entry = unmapped.get(key) ?? { name, count: 0 };
        entry.count += 1;
        unmapped.set(key, entry);
      }
    }
    if (page.isLast === true) return {
      counts, total, unmapped: [...unmapped.values()],
      statusIds: Object.fromEntries([...statusIds].map(([key, ids]) => [key, [...ids]])),
    };
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || visitedTokens.has(nextPageToken)) {
      throw new Error('Jira did not provide the next search page.');
    }
    visitedTokens.add(nextPageToken);
  }
}
