// QA KDG-6: independent checks of the concurrent, cached changelog fetch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBurndown, fetchStatusChanges } from '../static/burndown.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r)); };

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function controlled() {
  const pending = [];
  const request = (path, options) => {
    const gate = deferred();
    pending.push({ body: JSON.parse(options.body), gate });
    return gate.promise;
  };
  return { request, pending };
}

const log = (id, to, created = '2026-10-03T00:00:00Z') =>
  ({ issueId: id, changeHistories: [{ created, items: [{ fieldId: 'status', fromString: 'To Do', toString: to }] }] });
const issue = (id, updated) => ({ id, fields: { updated, created: '2026-09-01T00:00:00Z', status: { name: 'To Do' } } });

test('QA KDG-6: overlapping calls with different snapshots never return a wrong history', async () => {
  const cache = new Map();
  const a = controlled();
  const b = controlled();
  // Call A sees issue 1 at u1; call B (later refresh) sees it at u2 with a new transition.
  const runA = fetchStatusChanges(a.request, [issue('1', 'u1'), issue('2', 'u1')], { cache });
  const runB = fetchStatusChanges(b.request, [issue('1', 'u2'), issue('3', 'u1')], { cache });
  await flush();
  b.pending[0].gate.resolve(ok({ issueChangeLogs: [log('1', 'Done'), log('3', 'Review')] }));
  const resultB = await runB;
  assert.equal(resultB.get('1')[0].to, 'Done');
  a.pending[0].gate.resolve(ok({ issueChangeLogs: [log('1', 'In Progress'), log('2', 'Review')] }));
  const resultA = await runA;
  assert.equal(resultA.get('1')[0].to, 'In Progress');

  // The cache now holds A's snapshot (u1). A refresh at u2 must refetch, not reuse A's history.
  const calls = [];
  const next = await fetchStatusChanges(async (path, options) => {
    calls.push(JSON.parse(options.body).issueIdsOrKeys);
    return ok({ issueChangeLogs: [log('1', 'Done'), log('3', 'Review')] });
  }, [issue('1', 'u2'), issue('3', 'u1')], { cache });
  assert.deepEqual(calls, [['1', '3']], 'A pruned issue 3 and holds u1 for issue 1, so both refetch');
  assert.equal(next.get('1')[0].to, 'Done');
});

test('QA KDG-6: a failed call leaves an existing cache exactly as it was, and late results do not leak', async () => {
  const cache = new Map();
  await fetchStatusChanges(async () => ok({ issueChangeLogs: [log('1', 'Done')] }), [issue('1', 'u1')], { cache });
  const before = JSON.stringify([...cache]);

  const { request, pending } = controlled();
  const ids = Array.from({ length: 2500 }, (_, i) => issue(String(i + 10), 'u1'));
  const run = fetchStatusChanges(request, ids, { cache });
  await flush();
  assert.equal(pending.length, 3);
  pending[2].gate.resolve({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(run, { message: 'You cannot view these issues or their status history.' });
  // In-flight batches finish late, one asking for another page.
  pending[0].gate.resolve(ok({ issueChangeLogs: [log('10', 'Done')], nextPageToken: 'more' }));
  pending[1].gate.resolve(ok({ issueChangeLogs: [log('1010', 'Done')] }));
  await flush();
  assert.equal(pending.length, 3, 'no page request after the failure');
  assert.equal(JSON.stringify([...cache]), before);

  // The next call is unaffected: issue 1 still comes from the cache.
  let calls = 0;
  const next = await fetchStatusChanges(async () => { calls += 1; return ok({ issueChangeLogs: [] }); },
    [issue('1', 'u1')], { cache });
  assert.equal(calls, 0);
  assert.equal(next.get('1')[0].to, 'Done');
});

test('QA KDG-6: a failure while a later batch is mid page chain stops that chain', async () => {
  const { request, pending } = controlled();
  const run = fetchStatusChanges(request, Array.from({ length: 2000 }, (_, i) => issue(String(i + 1), 'u')), { cache: new Map() });
  await flush();
  pending[1].gate.resolve(ok({ issueChangeLogs: [], nextPageToken: 't2' }));
  await flush();
  assert.equal(pending.length, 3);
  assert.equal(pending[2].body.nextPageToken, 't2');
  pending[0].gate.resolve(ok({ issueChangeLogs: 'bad' }));
  await assert.rejects(run, { message: 'Jira returned an invalid status history.' });
  pending[2].gate.resolve(ok({ issueChangeLogs: [], nextPageToken: 't3' }));
  await flush();
  assert.equal(pending.length, 3);
});

test('QA KDG-6: cache hits keep empty and absent histories distinct and match a fresh fetch', async () => {
  const cache = new Map();
  const jira = async () => ok({ issueChangeLogs: [{ issueId: 1, changeHistories: [] }, log(2, 'Done')] });
  const issues = [issue(1, 'u'), issue('2', 'u'), issue(3, 'u')];
  const fresh = await fetchStatusChanges(jira, issues, { cache });
  let calls = 0;
  const cached = await fetchStatusChanges(async () => { calls += 1; return jira(); },
    [issue('1', 'u'), issue(2, 'u'), issue('3', 'u')], { cache });
  assert.equal(calls, 0, 'numeric and string ids share a cache entry');
  assert.deepEqual(cached, fresh);
  assert.deepEqual(cached.get('1'), []);
  assert.equal(cached.has('3'), false);
  const args = [[{ name: 'To Do', weight: 1 }, { name: 'Done', weight: 0 }], '2026-10-01', '2026-10-10', '2026-10-05', 'UTC'];
  assert.deepEqual(buildBurndown(issues, cached, ...args), buildBurndown(issues, fresh, ...args));
});

test('QA KDG-6: zero issues make no request and clear the cache', async () => {
  const cache = new Map([['9', { updated: 'u', entries: [] }]]);
  let calls = 0;
  const result = await fetchStatusChanges(async () => { calls += 1; }, [], { cache });
  assert.equal(calls, 0);
  assert.equal(result.size, 0);
  assert.equal(cache.size, 0);
});

test('QA KDG-6: duplicate issue IDs across batch boundaries match the old sequential result', async () => {
  // Old code sent each 1,000-slice separately, so an ID in two slices had its history twice.
  const issues = Array.from({ length: 1001 }, (_, i) => issue(String(i + 1), 'u'));
  issues.push(issue('1', 'u'));
  const jira = async (path, options) => ok({ issueChangeLogs: JSON.parse(options.body).issueIdsOrKeys
    .filter(id => id === '1').map(id => log(id, 'Done')) });
  const result = await fetchStatusChanges(jira, issues, { cache: new Map() });
  assert.equal(result.get('1').length, 2);
});

test('QA KDG-6: change objects returned to a caller are not shared with the cache', async () => {
  const cache = new Map();
  const first = await fetchStatusChanges(async () => ok({ issueChangeLogs: [log('1', 'Done')] }), [issue('1', 'u')], { cache });
  first.get('1')[0].to = 'Mutated';
  first.get('1')[0].at.setTime(0);
  const second = await fetchStatusChanges(async () => ok({ issueChangeLogs: [] }), [issue('1', 'u')], { cache });
  assert.equal(second.get('1')[0].to, 'Done');
  assert.equal(second.get('1')[0].at.toISOString(), '2026-10-03T00:00:00.000Z');
});
