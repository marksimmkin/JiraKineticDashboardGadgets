// Enhanced JQL search does not return a total, so count each page of visible issues.
export async function countIssues(requestJira, jql) {
  let count = 0;
  let nextPageToken;
  const visitedTokens = new Set();

  for (;;) {
    const body = { jql, fields: [], maxResults: 1000 };
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
    count += page.issues.length;
    if (page.isLast === true) return count;
    nextPageToken = page.nextPageToken;
    if (!nextPageToken || visitedTokens.has(nextPageToken)) {
      throw new Error('Jira did not provide the next search page.');
    }
    visitedTokens.add(nextPageToken);
  }
}
