// KDG-6: concurrent changelog batches, session cache of status histories, null-body handling.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clearStatusChangeCache, fetchBurndownIssues, fetchStatusChanges } from '../static/burndown.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const issuesFor = (count, updated = '2026-10-01T00:00:00.000+0000') =>
  Array.from({ length: count }, (_, i) => ({ id: String(i + 1), fields: { updated } }));

// Two status changes per issue, the later one listed first, so sorting is exercised.
function changeLogsFor(ids) {
  return ids.map(id => ({ issueId: id, changeHistories: [
    { created: `2026-10-0${(Number(id) % 5) + 3}T00:00:00Z`, items: [{ fieldId: 'status', fromString: 'In Progress', toString: 'Done' }] },
    { created: '2026-10-02T00:00:00Z', items: [{ fieldId: 'status', fromString: 'To Do', toString: 'In Progress' }] },
  ] }));
}

// Mock where each bulkfetch call waits until the test settles it.
function controlledRequest() {
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const request = (path, options) => {
    const body = JSON.parse(options.body);
    const gate = deferred();
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    pending.push({ path, body, gate });
    return gate.promise.finally(() => { inFlight -= 1; });
  };
  return { request, pending, stats: () => ({ inFlight, maxInFlight }) };
}

test('batches of 1,000 run at most 3 at a time and the result matches sequential order', async () => {
  const issues = issuesFor(4500);
  const reference = await fetchStatusChanges(
    async (path, options) => ok({ issueChangeLogs: changeLogsFor(JSON.parse(options.body).issueIdsOrKeys) }),
    issues, { cache: new Map() });

  const { request, pending, stats } = controlledRequest();
  const run = fetchStatusChanges(request, issues, { cache: new Map() });
  await flush();
  assert.equal(pending.length, 3);
  assert.equal(stats().inFlight, 3);
  assert.deepEqual(pending.map(call => call.body.issueIdsOrKeys.length), [1000, 1000, 1000]);

  // Finish batches in reverse order of starting.
  pending[2].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[2].body.issueIdsOrKeys) }));
  await flush();
  assert.equal(pending.length, 4);
  pending[3].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[3].body.issueIdsOrKeys) }));
  await flush();
  assert.equal(pending.length, 5);
  assert.equal(pending[4].body.issueIdsOrKeys.length, 500);
  for (const index of [4, 1, 0]) {
    pending[index].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[index].body.issueIdsOrKeys) }));
    await flush();
  }
  const changes = await run;
  assert.equal(pending.length, 5);
  assert.equal(stats().maxInFlight, 3);
  assert.equal(changes.size, 4500);
  assert.deepEqual(changes, reference);
  assert.ok(changes.get('1')[0].at < changes.get('1')[1].at);
});

test('an issue split across pages of one batch keeps the sequential page order', async () => {
  const pages = {
    first: { issueChangeLogs: [{ issueId: '1', changeHistories: [
      { created: '2026-10-05T00:00:00Z', items: [{ fieldId: 'status', fromString: 'A', toString: 'B' }] }] }], nextPageToken: 'p2' },
    second: { issueChangeLogs: [{ issueId: '1', changeHistories: [
      { created: '2026-10-03T00:00:00Z', items: [{ fieldId: 'status', fromString: 'X', toString: 'A' }] }] }] },
  };
  const changes = await fetchStatusChanges(async (path, options) =>
    ok(JSON.parse(options.body).nextPageToken ? pages.second : pages.first), [{ id: 1 }], { cache: new Map() });
  assert.deepEqual(changes.get('1').map(change => change.from), ['X', 'A']);
});

test('a failure in one batch rejects with its message and starts no more batches', async () => {
  const { request, pending } = controlledRequest();
  const run = fetchStatusChanges(request, issuesFor(5000), { cache: new Map() });
  await flush();
  assert.equal(pending.length, 3);
  pending[1].gate.resolve({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(run, { message: 'Jira request failed (500).' });
  pending[0].gate.resolve(ok({ issueChangeLogs: [], nextPageToken: 'more' }));
  pending[2].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[2].body.issueIdsOrKeys) }));
  await flush();
  assert.equal(pending.length, 3, 'no batch or page requests start after the failure');
});

test('a failed call does not populate the cache', async () => {
  const cache = new Map();
  const { request, pending } = controlledRequest();
  const run = fetchStatusChanges(request, issuesFor(2500), { cache });
  await flush();
  pending[0].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[0].body.issueIdsOrKeys) }));
  await flush();
  pending[1].gate.resolve({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(run, { message: 'You cannot view these issues or their status history.' });
  assert.equal(cache.size, 0);
});

function countingRequest() {
  const calls = [];
  const request = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return ok({ issueChangeLogs: changeLogsFor(body.issueIdsOrKeys) });
  };
  return { request, calls };
}

test('cache: unchanged issues are reused and no bulkfetch call is made', async () => {
  const cache = new Map();
  const { request, calls } = countingRequest();
  const issues = issuesFor(3);
  const first = await fetchStatusChanges(request, issues, { cache });
  const second = await fetchStatusChanges(request, issues, { cache });
  assert.equal(calls.length, 1);
  assert.deepEqual(second, first);
});

test('cache: a changed or missing updated value refetches only that issue', async () => {
  const cache = new Map();
  const { request, calls } = countingRequest();
  await fetchStatusChanges(request, issuesFor(3), { cache });
  const changed = issuesFor(3);
  changed[1].fields.updated = '2026-10-02T00:00:00.000+0000';
  delete changed[2].fields.updated;
  const result = await fetchStatusChanges(request, changed, { cache });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].issueIdsOrKeys, ['2', '3']);
  assert.equal(result.size, 3);
  assert.equal(cache.get('2').updated, '2026-10-02T00:00:00.000+0000');
  assert.equal(cache.has('3'), false, 'an issue without updated is never cached');
});

test('cache: new issues are fetched alongside cached ones', async () => {
  const cache = new Map();
  const { request, calls } = countingRequest();
  await fetchStatusChanges(request, issuesFor(2), { cache });
  const result = await fetchStatusChanges(request, issuesFor(4), { cache });
  assert.deepEqual(calls[1].issueIdsOrKeys, ['3', '4']);
  assert.equal(result.size, 4);
});

test('cache: issues not in the latest fetch are dropped so the cache stays bounded', async () => {
  const cache = new Map();
  const { request } = countingRequest();
  await fetchStatusChanges(request, issuesFor(1500), { cache });
  assert.equal(cache.size, 1500);
  await fetchStatusChanges(request, issuesFor(10), { cache });
  assert.deepEqual([...cache.keys()].sort(), issuesFor(10).map(issue => issue.id).sort());
  await fetchStatusChanges(request, [], { cache });
  assert.equal(cache.size, 0);
});

test('cache: returned histories are copies, so callers cannot corrupt the cache', async () => {
  const cache = new Map();
  const { request } = countingRequest();
  const first = await fetchStatusChanges(request, issuesFor(1), { cache });
  first.get('1').length = 0;
  const second = await fetchStatusChanges(request, issuesFor(1), { cache });
  assert.equal(second.get('1').length, 2);
});

test('the default session cache is used and can be cleared', async () => {
  clearStatusChangeCache();
  const { request, calls } = countingRequest();
  await fetchStatusChanges(request, issuesFor(2));
  await fetchStatusChanges(request, issuesFor(2));
  assert.equal(calls.length, 1);
  clearStatusChangeCache();
  await fetchStatusChanges(request, issuesFor(2));
  assert.equal(calls.length, 2);
  clearStatusChangeCache();
});

test('a 200 response with a null body gives the friendly invalid history message', async () => {
  await assert.rejects(fetchStatusChanges(async () => ok(null), [{ id: 1 }], { cache: new Map() }),
    { message: 'Jira returned an invalid status history.' });
  await assert.rejects(fetchStatusChanges(async () => ok({ issueChangeLogs: [null] }), [{ id: 1 }], { cache: new Map() }),
    { message: 'Jira returned an invalid status history.' });
});

// KDG-13: progress callbacks.
test('fetchBurndownIssues calls onPage with the running total after each page', async () => {
  const pages = [
    { issues: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })), nextPageToken: 't1', isLast: false },
    { issues: Array.from({ length: 1000 }, (_, i) => ({ id: String(1000 + i) })), nextPageToken: 't2', isLast: false },
    { issues: [{ id: 'last' }], isLast: true },
  ];
  let call = 0;
  const seen = [];
  const issues = await fetchBurndownIssues(async () => ok(pages[call++]), 'project = A',
    { onPage: loaded => seen.push(loaded) });
  assert.deepEqual(seen, [1000, 2000, 2001]);
  assert.equal(issues.length, 2001);
  assert.equal((await fetchBurndownIssues(async () => ok({ issues: [], isLast: true }), 'x')).length, 0,
    'onPage is optional');
});

test('onProgress starts at the cached count and adds each batch when it completes', async () => {
  const cache = new Map();
  const { request: warm } = countingRequest();
  await fetchStatusChanges(warm, issuesFor(1200), { cache });
  const issues = issuesFor(3500);
  const events = [];
  const { request, pending } = controlledRequest();
  const run = fetchStatusChanges(request, issues, { cache, onProgress: progress => events.push(progress) });
  assert.deepEqual(events, [{ done: 1200, total: 3500 }], 'reported before any request');
  await flush();
  assert.deepEqual(pending.map(call => call.body.issueIdsOrKeys.length), [1000, 1000, 300]);
  pending[2].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[2].body.issueIdsOrKeys) }));
  await flush();
  assert.deepEqual(events.at(-1), { done: 1500, total: 3500 });
  pending[0].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[0].body.issueIdsOrKeys) }));
  pending[1].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[1].body.issueIdsOrKeys) }));
  const changes = await run;
  assert.deepEqual(events, [
    { done: 1200, total: 3500 }, { done: 1500, total: 3500 },
    { done: 2500, total: 3500 }, { done: 3500, total: 3500 },
  ]);
  assert.equal(changes.size, 3500);
  assert.equal(cache.size, 3500);
});

test('onProgress reports a multi-page batch once, after its last page', async () => {
  const events = [];
  const { request, pending } = controlledRequest();
  const run = fetchStatusChanges(request, issuesFor(2), { cache: new Map(), onProgress: p => events.push(p) });
  await flush();
  pending[0].gate.resolve(ok({ issueChangeLogs: changeLogsFor(['1']), nextPageToken: 'p2' }));
  await flush();
  assert.equal(pending.length, 2);
  assert.deepEqual(events, [{ done: 0, total: 2 }], 'no report after the first page');
  pending[1].gate.resolve(ok({ issueChangeLogs: changeLogsFor(['2']) }));
  await run;
  assert.deepEqual(events, [{ done: 0, total: 2 }, { done: 2, total: 2 }]);
});

test('onProgress is not called when every issue is cached', async () => {
  const cache = new Map();
  const { request, calls } = countingRequest();
  await fetchStatusChanges(request, issuesFor(3), { cache });
  const events = [];
  const result = await fetchStatusChanges(request, issuesFor(3), { cache, onProgress: p => events.push(p) });
  assert.deepEqual(events, []);
  assert.equal(calls.length, 1);
  assert.equal(result.size, 3);
  await fetchStatusChanges(request, [], { cache, onProgress: p => events.push(p) });
  assert.deepEqual(events, []);
});

test('onProgress is not called for batches that finish after a failure', async () => {
  const events = [];
  const { request, pending } = controlledRequest();
  const run = fetchStatusChanges(request, issuesFor(3000), { cache: new Map(), onProgress: p => events.push(p) });
  await flush();
  pending[0].gate.resolve({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(run, { message: 'Jira request failed (500).' });
  pending[1].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[1].body.issueIdsOrKeys) }));
  pending[2].gate.resolve(ok({ issueChangeLogs: changeLogsFor(pending[2].body.issueIdsOrKeys) }));
  await flush();
  assert.deepEqual(events, [{ done: 0, total: 3000 }]);
});
