// Shared access to Jira's enhanced JQL search (POST /rest/api/3/search/jql).
// The endpoint pages with nextPageToken and returns no total, so callers walk every page.

export const SEARCH_PATH = '/rest/api/3/search/jql';

// Each gadget shows its own wording, so every message can be overridden per caller.
export const DEFAULT_SEARCH_MESSAGES = Object.freeze({
  badRequest: 'The selected JQL is invalid or cannot be searched.',
  forbidden: 'You cannot view issues for this filter.',
  failed: status => `Jira search failed (${status}).`,
  invalidResult: 'Jira returned an invalid search result.',
  missingPage: 'Jira did not provide the next search page.',
  repeatedPage: 'Jira did not provide the next search page.',
});

function searchMessages(messages) {
  return { ...DEFAULT_SEARCH_MESSAGES, ...messages };
}

// POSTs a JSON body to Jira and maps 400, 401/403 and other failures to user-facing errors.
export async function postJira(requestJira, path, body, messages) {
  const text = searchMessages(messages);
  const response = await requestJira(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 400) throw new Error(text.badRequest);
    if (response.status === 401 || response.status === 403) throw new Error(text.forbidden);
    throw new Error(text.failed(response.status));
  }
  return response.json();
}

// Fetches one search page. Throws unless `issues` is an array and, when the page is not
// the last, a next page token is present.
export async function searchPage(requestJira, jql, fields,
  { nextPageToken, maxResults = 1000, messages } = {}) {
  const text = searchMessages(messages);
  const body = { jql, fields, maxResults };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const page = await postJira(requestJira, SEARCH_PATH, body, text);
  if (!Array.isArray(page?.issues)) throw new Error(text.invalidResult);
  if (page.isLast !== true && !page.nextPageToken) throw new Error(text.missingPage);
  return page;
}

// Thrown when a walk stops because `isCurrent()` reported that its result is no longer wanted.
// A superseded walk never returns normally, so a partial result cannot be mistaken for a
// complete one (or cached as one).
export class SupersededError extends Error {
  constructor(message = 'The Jira request was superseded.') {
    super(message);
    this.name = 'SupersededError';
  }
}

export function isSuperseded(error) {
  return error instanceof SupersededError;
}

// Yields every search page in order. Throws if Jira omits the next token or repeats one.
// `isCurrent()`, if given, is checked before each page request (including the first); once it
// returns false no further request is sent and the walk throws SupersededError.
export async function* searchPages(requestJira, jql, fields,
  { maxResults = 1000, messages, isCurrent } = {}) {
  const text = searchMessages(messages);
  let nextPageToken;
  const visitedTokens = new Set();
  for (;;) {
    if (isCurrent && !isCurrent()) throw new SupersededError();
    const page = await searchPage(requestJira, jql, fields, { nextPageToken, maxResults, messages: text });
    yield page;
    if (page.isLast === true) return;
    nextPageToken = page.nextPageToken;
    if (visitedTokens.has(nextPageToken)) throw new Error(text.repeatedPage);
    visitedTokens.add(nextPageToken);
  }
}
