import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPage, searchPages, SEARCH_PATH } from '../static/jira-search.mjs';
import { countIssues } from '../static/count.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';
import { searchAllIssues, searchIssuePage } from '../static/issue-data.mjs';
import { fetchBurndownIssues } from '../static/burndown.mjs';

// Serves the given pages in order and records each request.
function mockPages(pages) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options, body: JSON.parse(options.body) });
    const page = pages[calls.length - 1];
    if (calls.length > pages.length) throw new Error('Unexpected extra request.');
    return { ok: true, json: async () => page };
  };
  return { request, calls };
}

async function collect(iterable) {
  const pages = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

const failing = status => async () => ({ ok: false, status });

test('searchPages yields every page and sends the next token', async () => {
  const pages = [
    { issues: [{ id: '1' }], isLast: false, nextPageToken: 'p2' },
    { issues: [{ id: '2' }], isLast: false, nextPageToken: 'p3' },
    { issues: [{ id: '3' }], isLast: true },
  ];
  const { request, calls } = mockPages(pages);
  assert.deepEqual(await collect(searchPages(request, 'project = GAME', ['status'])), pages);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].path, SEARCH_PATH);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].body, { jql: 'project = GAME', fields: ['status'], maxResults: 1000 });
  assert.equal(calls[1].body.nextPageToken, 'p2');
  assert.equal(calls[2].body.nextPageToken, 'p3');
});

test('searchPages rejects a repeated token', async () => {
  const { request, calls } = mockPages([
    { issues: [], isLast: false, nextPageToken: 'a' },
    { issues: [], isLast: false, nextPageToken: 'b' },
    { issues: [], isLast: false, nextPageToken: 'a' },
  ]);
  await assert.rejects(collect(searchPages(request, 'x', [])),
    { message: 'Jira did not provide the next search page.' });
  assert.equal(calls.length, 3);
});

test('searchPages rejects a missing token on a page that is not the last', async () => {
  for (const page of [{ issues: [], isLast: false }, { issues: [] }, { issues: [], nextPageToken: '' }]) {
    const { request } = mockPages([page]);
    await assert.rejects(collect(searchPages(request, 'x', [])),
      { message: 'Jira did not provide the next search page.' });
  }
});

test('searchPages rejects a result without an issues array', async () => {
  for (const page of [{ isLast: true }, { issues: {}, isLast: true }, null]) {
    const { request } = mockPages([page]);
    await assert.rejects(collect(searchPages(request, 'x', [])),
      { message: 'Jira returned an invalid search result.' });
  }
});

test('searchPage maps HTTP errors and accepts message overrides', async () => {
  await assert.rejects(searchPage(failing(400), 'x', []), { message: 'The selected JQL is invalid or cannot be searched.' });
  await assert.rejects(searchPage(failing(401), 'x', []), { message: 'You cannot view issues for this filter.' });
  await assert.rejects(searchPage(failing(403), 'x', []), { message: 'You cannot view issues for this filter.' });
  await assert.rejects(searchPage(failing(500), 'x', []), { message: 'Jira search failed (500).' });
  await assert.rejects(searchPage(failing(400), 'x', [], { messages: { badRequest: 'Custom.' } }),
    { message: 'Custom.' });
});

test('searchPage sends the given token and page size', async () => {
  const { request, calls } = mockPages([{ issues: [], isLast: true }]);
  await searchPage(request, 'x', ['key'], { nextPageToken: 't', maxResults: 50 });
  assert.deepEqual(calls[0].body, { jql: 'x', fields: ['key'], maxResults: 50, nextPageToken: 't' });
});

// Each gadget keeps its own wording.
const callers = {
  countIssues: {
    run: request => countIssues(request, 'x'),
    badRequest: 'The selected JQL is invalid or cannot be searched.',
    forbidden: 'You cannot view issues for this filter.',
    failed: 'Jira search failed (502).',
    invalidResult: 'Jira returned an invalid search result.',
    missingPage: 'Jira did not provide the next search page.',
    repeatedPage: 'Jira did not provide the next search page.',
  },
  countIssuesByStatus: {
    run: request => countIssuesByStatus(request, 'x', []),
    badRequest: 'The selected JQL is invalid or cannot be searched.',
    forbidden: 'You cannot view issues for this filter.',
    failed: 'Jira search failed (502).',
    invalidResult: 'Jira returned an invalid search result.',
    missingPage: 'Jira did not provide the next search page.',
    repeatedPage: 'Jira did not provide the next search page.',
  },
  searchAllIssues: {
    run: request => searchAllIssues(request, 'x', []),
    badRequest: 'The selected JQL or column selection is invalid.',
    forbidden: 'You cannot view issues for this filter.',
    failed: 'Jira search failed (502).',
    invalidResult: 'Jira returned an invalid search result.',
    missingPage: 'Jira did not provide the next search page.',
    repeatedPage: 'Jira repeated a search page.',
  },
  fetchBurndownIssues: {
    run: request => fetchBurndownIssues(request, 'x'),
    badRequest: 'The selected JQL or changelog request is invalid.',
    forbidden: 'You cannot view these issues or their status history.',
    failed: 'Jira request failed (502).',
    invalidResult: 'Jira returned an invalid issue search result.',
    missingPage: 'Jira did not provide the next issue page.',
    repeatedPage: 'Jira did not provide the next issue page.',
  },
};

for (const [name, expected] of Object.entries(callers)) {
  test(`${name} keeps its error messages word for word`, async () => {
    await assert.rejects(expected.run(failing(400)), { message: expected.badRequest });
    await assert.rejects(expected.run(failing(401)), { message: expected.forbidden });
    await assert.rejects(expected.run(failing(403)), { message: expected.forbidden });
    await assert.rejects(expected.run(failing(502)), { message: expected.failed });
    await assert.rejects(expected.run(mockPages([{ isLast: true }]).request), { message: expected.invalidResult });
    await assert.rejects(expected.run(mockPages([{ issues: [], isLast: false }]).request),
      { message: expected.missingPage });
    await assert.rejects(expected.run(mockPages([
      { issues: [], isLast: false, nextPageToken: 'a' },
      { issues: [], isLast: false, nextPageToken: 'a' },
    ]).request), { message: expected.repeatedPage });
  });
}

test('searchIssuePage returns one page with its token and the List error wording', async () => {
  const { request, calls } = mockPages([{ issues: [{ id: '1' }], isLast: false, nextPageToken: 'n' }]);
  assert.deepEqual(await searchIssuePage(request, 'x', ['key'], 'prev', 50),
    { issues: [{ id: '1' }], isLast: false, nextPageToken: 'n' });
  assert.deepEqual(calls[0].body, { jql: 'x', fields: ['key'], maxResults: 50, nextPageToken: 'prev' });
  await assert.rejects(searchIssuePage(failing(400), 'x', []), { message: 'The selected JQL or column selection is invalid.' });
  await assert.rejects(searchIssuePage(mockPages([{ issues: [], isLast: false }]).request, 'x', []),
    { message: 'Jira did not provide the next search page.' });
});
