import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROXIMATE_COUNT_PATH, approximateCount, countIssues } from '../static/count.mjs';
import { SEARCH_PATH } from '../static/jira-search.mjs';

function recorder(response) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options, body: JSON.parse(options.body) });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, request };
}

const ok = json => ({ ok: true, status: 200, json: async () => json });

test('approximateCount posts only the filter, keeping quoted text', async () => {
  const { calls, request } = recorder(ok({ count: 153 }));
  const jql = 'project = "GAME" AND summary ~ "order by \\"x\\"" ORDER BY created DESC';
  assert.equal(await approximateCount(request, jql), 153);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, APPROXIMATE_COUNT_PATH);
  assert.equal(calls[0].path, '/rest/api/3/search/approximate-count');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { jql: 'project = "GAME" AND summary ~ "order by \\"x\\""' });
});

test('approximateCount sends JQL without ORDER BY unchanged and accepts zero', async () => {
  const { calls, request } = recorder(ok({ count: 0 }));
  assert.equal(await approximateCount(request, '  project = GAME  '), 0);
  assert.deepEqual(calls[0].body, { jql: 'project = GAME' });
});

test('approximateCount rejects order-only or empty JQL without calling Jira', async () => {
  const { calls, request } = recorder(ok({ count: 1 }));
  await assert.rejects(approximateCount(request, 'ORDER BY rank'), /needs a JQL filter/);
  await assert.rejects(approximateCount(request, '   '), /needs a JQL filter/);
  await assert.rejects(approximateCount(request, undefined), /needs a JQL filter/);
  assert.equal(calls.length, 0);
});

test('approximateCount maps 400, 401/403 and other failures', async () => {
  await assert.rejects(approximateCount(async () => ({ ok: false, status: 400 }), 'bad ='),
    /The selected JQL is invalid or cannot be searched\./);
  await assert.rejects(approximateCount(async () => ({ ok: false, status: 403 }), 'project = X'),
    /You cannot view issues for this filter\./);
  await assert.rejects(approximateCount(async () => ({ ok: false, status: 401 }), 'project = X'),
    /You cannot view issues for this filter\./);
  await assert.rejects(approximateCount(async () => ({ ok: false, status: 500 }), 'project = X'),
    /\(500\)/);
});

test('approximateCount rejects an invalid count', async () => {
  for (const json of [{}, { count: '5' }, { count: -1 }, { count: 1.5 }, { count: null },
    { count: Number.NaN }, { count: Infinity }, null]) {
    await assert.rejects(approximateCount(async () => ok(json), 'project = X'),
      /Jira returned an invalid approximate count\./, JSON.stringify(json));
  }
});

test('countIssues still pages enhanced search with the full JQL', async () => {
  const pages = [
    { issues: [{}, {}], isLast: false, nextPageToken: 'a' },
    { issues: [{}], isLast: true },
  ];
  const { calls, request } = recorder(() => ok(pages.shift()));
  assert.equal(await countIssues(request, 'project = GAME ORDER BY rank'), 3);
  assert.deepEqual(calls.map(call => call.path), [SEARCH_PATH, SEARCH_PATH]);
  assert.deepEqual(calls[0].body, { jql: 'project = GAME ORDER BY rank', fields: [], maxResults: 1000 });
  assert.deepEqual(calls[1].body,
    { jql: 'project = GAME ORDER BY rank', fields: [], maxResults: 1000, nextPageToken: 'a' });
});
