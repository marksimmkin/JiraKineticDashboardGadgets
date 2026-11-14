// QA regression tests for KDG-3 (shared Jira search paging helper).
// They lock in the request shapes and per-gadget wording the four callers had before the refactor.
import assert from 'node:assert/strict';
import test from 'node:test';
import { countIssues } from '../static/count.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';
import { searchAllIssues, searchIssuePage } from '../static/issue-data.mjs';
import { fetchBurndownIssues, fetchStatusChanges } from '../static/burndown.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });

function mock(responses) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    if (calls.length > responses.length) throw new Error('Unexpected extra request.');
    return responses[calls.length - 1];
  };
  return { request, calls };
}

const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

const searchCallers = [
  { name: 'countIssues', fields: [], run: (r, jql) => countIssues(r, jql),
    invalid: 'Jira returned an invalid search result.', failed: s => `Jira search failed (${s}).`,
    forbidden: 'You cannot view issues for this filter.' },
  { name: 'countIssuesByStatus', fields: ['status'], run: (r, jql) => countIssuesByStatus(r, jql, [{ name: 'Done' }]),
    invalid: 'Jira returned an invalid search result.', failed: s => `Jira search failed (${s}).`,
    forbidden: 'You cannot view issues for this filter.' },
  { name: 'searchAllIssues', fields: ['assignee', 'status', 'timetracking'],
    run: (r, jql) => searchAllIssues(r, jql, ['assignee', 'status', 'timetracking']),
    invalid: 'Jira returned an invalid search result.', failed: s => `Jira search failed (${s}).`,
    forbidden: 'You cannot view issues for this filter.' },
  { name: 'fetchBurndownIssues', fields: ['created', 'status', 'updated'], run: (r, jql) => fetchBurndownIssues(r, jql),
    invalid: 'Jira returned an invalid issue search result.', failed: s => `Jira request failed (${s}).`,
    forbidden: 'You cannot view these issues or their status history.' },
];

for (const caller of searchCallers) {
  test(`${caller.name} sends byte-identical search requests across pages`, async () => {
    const jql = 'summary ~ "a \\"quoted\\" [x]" ORDER BY created DESC';
    const { request, calls } = mock([
      ok({ issues: [], isLast: false, nextPageToken: 't1' }),
      ok({ issues: [], nextPageToken: 't2' }), // isLast absent, token present: keep paging
      ok({ issues: [], isLast: true, nextPageToken: 'ignored' }),
    ]);
    await caller.run(request, jql);
    assert.equal(calls.length, 3);
    const bodies = [
      { jql, fields: caller.fields, maxResults: 1000 },
      { jql, fields: caller.fields, maxResults: 1000, nextPageToken: 't1' },
      { jql, fields: caller.fields, maxResults: 1000, nextPageToken: 't2' },
    ];
    calls.forEach((call, i) => {
      assert.equal(call.path, '/rest/api/3/search/jql');
      assert.deepEqual(call.options, { method: 'POST', headers: HEADERS, body: JSON.stringify(bodies[i]) });
    });
  });

  test(`${caller.name} treats a truthy isLast that is not true as more pages`, async () => {
    for (const isLast of ['true', 1]) {
      await assert.rejects(caller.run(mock([ok({ issues: [], isLast })]).request, 'x'));
      const { request, calls } = mock([ok({ issues: [], isLast, nextPageToken: 'n' }), ok({ issues: [], isLast: true })]);
      await caller.run(request, 'x');
      assert.equal(calls.length, 2);
    }
  });

  // KDG-17: a 429 is now retried (see kdg-17-rate-limit.test.mjs), so a 502 shows the wording.
  test(`${caller.name} shows its own wording for a null body, 502 and errors on a later page`, async () => {
    await assert.rejects(caller.run(mock([ok(null)]).request, 'x'), { message: caller.invalid });
    await assert.rejects(caller.run(mock([fail(502)]).request, 'x'), { message: caller.failed(502) });
    await assert.rejects(caller.run(mock([ok({ issues: [], nextPageToken: 'a' }), fail(403)]).request, 'x'),
      { message: caller.forbidden });
  });
}

test('searchIssuePage keeps the List page size, omits an empty token and rejects a null body', async () => {
  const { request, calls } = mock([ok({ issues: [], isLast: true })]);
  await searchIssuePage(request, 'x', ['key'], '', 50);
  assert.equal(calls[0].options.body, JSON.stringify({ jql: 'x', fields: ['key'], maxResults: 50 }));
  await assert.rejects(searchIssuePage(mock([ok(null)]).request, 'x', ['key'], undefined, 50),
    { message: 'Jira returned an invalid search result.' });
  await assert.rejects(searchIssuePage(mock([fail(502)]).request, 'x', ['key'], undefined, 50),
    { message: 'Jira search failed (502).' });
});

test('fetchStatusChanges keeps its request body and Burndown error wording', async () => {
  const { request, calls } = mock([ok({ issueChangeLogs: [], nextPageToken: 'p' }), ok({ issueChangeLogs: [] })]);
  await fetchStatusChanges(request, [{ id: 1 }]);
  assert.equal(calls[0].path, '/rest/api/3/changelog/bulkfetch');
  assert.deepEqual(calls[0].options, { method: 'POST', headers: HEADERS,
    body: JSON.stringify({ issueIdsOrKeys: ['1'], fieldIds: ['status'], maxResults: 1000 }) });
  assert.equal(calls[1].options.body,
    JSON.stringify({ issueIdsOrKeys: ['1'], fieldIds: ['status'], maxResults: 1000, nextPageToken: 'p' }));

  const run = response => fetchStatusChanges(mock([response]).request, [{ id: 1 }]);
  await assert.rejects(run(fail(400)), { message: 'The selected JQL or changelog request is invalid.' });
  await assert.rejects(run(fail(401)), { message: 'You cannot view these issues or their status history.' });
  await assert.rejects(run(fail(403)), { message: 'You cannot view these issues or their status history.' });
  await assert.rejects(run(fail(500)), { message: 'Jira request failed (500).' });
  await assert.rejects(run(ok({})), { message: 'Jira returned an invalid status history.' });
  await assert.rejects(fetchStatusChanges(mock([
    ok({ issueChangeLogs: [], nextPageToken: 'p' }), ok({ issueChangeLogs: [], nextPageToken: 'p' }),
  ]).request, [{ id: 1 }]), { message: 'Jira repeated a status history page.' });
});
