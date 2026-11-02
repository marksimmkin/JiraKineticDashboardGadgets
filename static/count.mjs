import { searchPages } from './jira-search.mjs';

// Enhanced JQL search does not return a total, so count each page of visible issues.
export async function countIssues(requestJira, jql) {
  let count = 0;
  for await (const page of searchPages(requestJira, jql, [])) count += page.issues.length;
  return count;
}
