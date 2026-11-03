import { searchPages } from './jira-search.mjs';
import { statusKey } from './shared.mjs';

// `isCurrent`, if given, stops the walk early with SupersededError (see searchPages).
export async function countIssuesByStatus(requestJira, jql, statuses, { isCurrent } = {}) {
  const counts = Object.fromEntries(statuses.map(status => [statusKey(status.name), 0]));
  const unmapped = new Map();
  const statusIds = new Map();
  let total = 0;
  for await (const page of searchPages(requestJira, jql, ['status'], { isCurrent })) {
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
  }
  return {
    counts, total, unmapped: [...unmapped.values()],
    statusIds: Object.fromEntries([...statusIds].map(([key, ids]) => [key, [...ids]])),
  };
}
