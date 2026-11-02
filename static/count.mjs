import { splitOrderBy } from './drilldown.mjs';
import { postJira, searchPages } from './jira-search.mjs';

export const APPROXIMATE_COUNT_PATH = '/rest/api/3/search/approximate-count';

// Enhanced JQL search does not return a total, so count each page of visible issues.
export async function countIssues(requestJira, jql) {
  let count = 0;
  for await (const page of searchPages(requestJira, jql, [])) count += page.issues.length;
  return count;
}

// Jira's fast estimated count. It may lag recent updates, so callers should replace it with
// countIssues. ORDER BY is dropped in case the endpoint rejects it, and an order-only
// JQL is rejected here rather than sent.
export async function approximateCount(requestJira, jql) {
  const { filter } = splitOrderBy(String(jql ?? ''));
  if (!filter) throw new Error('An approximate count needs a JQL filter.');
  const result = await postJira(requestJira, APPROXIMATE_COUNT_PATH, { jql: filter });
  const count = result?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Jira returned an invalid approximate count.');
  }
  return count;
}
