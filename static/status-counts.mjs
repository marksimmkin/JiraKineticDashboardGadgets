import { searchPages } from './jira-search.mjs';
import { recordCategory, statusKey } from './shared.mjs';
import { isStatusShown } from './status-visibility.mjs';

// `isCurrent`, if given, stops the walk early with SupersededError (see searchPages).
// KDG-24: `visibility` (from statusVisibility), if given, leaves out each issue whose status is
// hidden, judged per issue by its own category, from `counts`, `unmapped` and `statusIds`.
// `total` and `categories` still cover every issue in the JQL.
export async function countIssuesByStatus(requestJira, jql, statuses, { isCurrent, visibility } = {}) {
  const counts = Object.fromEntries(statuses.map(status => [statusKey(status.name), 0]));
  const unmapped = new Map();
  const statusIds = new Map();
  const categories = new Map();
  let total = 0;
  for await (const page of searchPages(requestJira, jql, ['status'], { isCurrent })) {
    for (const issue of page.issues) {
      total += 1;
      const rawName = issue?.fields?.status?.name;
      const name = typeof rawName === 'string' && rawName.trim() ? rawName : 'Unknown status';
      const key = statusKey(name);
      const category = issue?.fields?.status?.statusCategory?.key;
      // Categories are kept for every issue, so a chart can tell which listed names are hidden.
      recordCategory(categories, key, category);
      if (visibility && !isStatusShown(name, category, visibility)) continue;
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
    categories: Object.fromEntries(categories),
  };
}
