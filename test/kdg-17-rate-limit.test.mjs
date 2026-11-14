// KDG-17: wait and retry when Jira returns 429 (rate limited), honouring Retry-After.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  busyMessage, JiraBusyError, MAX_WAIT_MS, requestJiraWithRetry, retryAfterMs, RETRY_LIMIT,
  SupersededError,
} from '../static/jira-request.mjs';
import { isSuperseded, searchPages } from '../static/jira-search.mjs';
import { countIssues } from '../static/count.mjs';
import { fetchStatusChanges } from '../static/burndown.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';
import { FILTER_SELECTED } from '../static/shared.mjs';

const NOW = Date.parse('2026-06-01T12:00:00Z');

// A fetch-like response. `headers` is a real Headers object, as @forge/bridge builds one.
const res = (status, headers = {}, body = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body });

function fakeJira(responses) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    if (calls.length > responses.length) throw new Error('Unexpected extra request.');
    return responses[calls.length - 1];
  };
  return { request, calls };
}

function clock() {
  const waits = [];
  return { waits, sleep: async ms => { waits.push(ms); }, now: () => NOW, random: () => 0.5 };
}

test('retryAfterMs reads seconds, HTTP dates and plain-object headers, and ignores junk', () => {
  const now = () => NOW;
  assert.equal(retryAfterMs(res(429, { 'Retry-After': '5' }), now), 5000);
  assert.equal(retryAfterMs(res(429, { 'Retry-After': ' 0 ' }), now), 0);
  assert.equal(retryAfterMs(res(429, { 'Retry-After': '1.5' }), now), 1500);
  assert.equal(retryAfterMs(res(429, { 'Retry-After': new Date(NOW + 12000).toUTCString() }), now), 12000);
  assert.equal(retryAfterMs(res(429, { 'Retry-After': new Date(NOW - 5000).toUTCString() }), now), 0);
  assert.equal(retryAfterMs({ status: 429, headers: { 'retry-after': '7' } }, now), 7000);
  for (const value of ['soon', '-3', '', '1e3', 'Fri, 99 Foo 2026']) {
    assert.equal(retryAfterMs(res(429, { 'Retry-After': value }), now), null, value);
  }
  assert.equal(retryAfterMs(res(429), now), null);
  assert.equal(retryAfterMs({ status: 429 }, now), null);
  assert.equal(retryAfterMs({ status: 429, headers: { get() { throw new Error('blocked'); } } }, now), null);
});

test('busy message rounds Retry-After up, or says shortly when it is unknown', () => {
  assert.equal(busyMessage(4200), 'Jira is busy. Try again in 5 seconds.');
  assert.equal(busyMessage(1000), 'Jira is busy. Try again in 1 second.');
  assert.equal(busyMessage(null), 'Jira is busy. Try again shortly.');
  assert.equal(busyMessage(0), 'Jira is busy. Try again shortly.');
  assert.equal(new JiraBusyError(120000).message, 'Jira is busy. Try again in 120 seconds.');
});

test('a 429 with Retry-After in seconds waits that long and retries the same request', async () => {
  const t = clock();
  const { request, calls } = fakeJira([res(429, { 'Retry-After': '3' }), res(200, {}, { a: 1 })]);
  const options = { method: 'POST', body: '{"x":1}' };
  const response = await requestJiraWithRetry(request, '/p', options, t);
  assert.equal(response.status, 200);
  assert.deepEqual(t.waits, [3000]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { path: '/p', options });
});

test('a 429 with an HTTP-date Retry-After waits until that time', async () => {
  const t = clock();
  const at = new Date(NOW + 8000).toUTCString();
  const { request } = fakeJira([res(429, { 'Retry-After': at }), res(200)]);
  await requestJiraWithRetry(request, '/p', {}, t);
  assert.deepEqual(t.waits, [8000]);
});

test('a 429 without Retry-After backs off 1s, 2s, 4s, then shows the busy message', async () => {
  const t = clock();
  const { request, calls } = fakeJira([res(429), res(429), res(429), res(429)]);
  await assert.rejects(requestJiraWithRetry(request, '/p', {}, t),
    error => error instanceof JiraBusyError && error.message === 'Jira is busy. Try again shortly.');
  assert.deepEqual(t.waits, [1000, 2000, 4000]);
  assert.equal(calls.length, RETRY_LIMIT + 1);
});

test('backoff adds jitter between 70% and 130% of the step', async () => {
  for (const [random, first] of [[0, 700], [1, 1300]]) {
    const t = { ...clock(), random: () => random };
    const { request } = fakeJira([res(429), res(200)]);
    await requestJiraWithRetry(request, '/p', {}, t);
    assert.equal(Math.round(t.waits[0]), first);
  }
});

test('retries stop after the limit, and the message uses the last Retry-After rounded up', async () => {
  const t = clock();
  const { request, calls } = fakeJira([
    res(429, { 'Retry-After': '1' }), res(429, { 'Retry-After': '2' }),
    res(429, { 'Retry-After': '3' }), res(429, { 'Retry-After': '4.2' }),
  ]);
  await assert.rejects(requestJiraWithRetry(request, '/p', {}, t),
    { name: 'JiraBusyError', message: 'Jira is busy. Try again in 5 seconds.' });
  assert.deepEqual(t.waits, [1000, 2000, 3000]);
  assert.equal(calls.length, 4);
});

test('a Retry-After above the cap is not waited for and not retried early', async () => {
  const t = clock();
  const { request, calls } = fakeJira([res(429, { 'Retry-After': String(MAX_WAIT_MS / 1000 + 90) })]);
  await assert.rejects(requestJiraWithRetry(request, '/p', {}, t),
    { message: 'Jira is busy. Try again in 120 seconds.' });
  assert.deepEqual(t.waits, []);
  assert.equal(calls.length, 1);
  // Exactly the cap is still waited for.
  const capped = fakeJira([res(429, { 'Retry-After': String(MAX_WAIT_MS / 1000) }), res(200)]);
  const t2 = clock();
  await requestJiraWithRetry(capped.request, '/p', {}, t2);
  assert.deepEqual(t2.waits, [MAX_WAIT_MS]);
});

test('a 503 retries only when Jira sends Retry-After', async () => {
  const t = clock();
  const withHeader = fakeJira([res(503, { 'Retry-After': '2' }), res(200)]);
  assert.equal((await requestJiraWithRetry(withHeader.request, '/p', {}, t)).status, 200);
  assert.deepEqual(t.waits, [2000]);

  const t2 = clock();
  const without = fakeJira([res(503)]);
  assert.equal((await requestJiraWithRetry(without.request, '/p', {}, t2)).status, 503);
  assert.deepEqual(t2.waits, []);
  assert.equal(without.calls.length, 1);

  const t3 = clock();
  const busy = fakeJira([1, 2, 3, 4].map(() => res(503, { 'Retry-After': '6' })));
  await assert.rejects(requestJiraWithRetry(busy.request, '/p', {}, t3),
    { message: 'Jira is busy. Try again in 6 seconds.' });
});

test('other statuses are returned without a retry, even with Retry-After', async () => {
  for (const status of [200, 400, 401, 403, 404, 409, 500, 502, 504]) {
    const t = clock();
    const { request, calls } = fakeJira([res(status, { 'Retry-After': '1' })]);
    assert.equal((await requestJiraWithRetry(request, '/p', {}, t)).status, status);
    assert.equal(calls.length, 1, String(status));
    assert.deepEqual(t.waits, []);
  }
});

test('errors thrown by requestJira are not retried', async () => {
  let calls = 0;
  const request = async () => { calls += 1; throw new Error('offline'); };
  await assert.rejects(requestJiraWithRetry(request, '/p', {}, clock()), { message: 'offline' });
  assert.equal(calls, 1);
});

test('a load superseded during a wait sends no retry', async () => {
  let current = true;
  const waits = [];
  const sleep = async ms => { waits.push(ms); current = false; };
  const { request, calls } = fakeJira([res(429, { 'Retry-After': '5' }), res(200)]);
  await assert.rejects(requestJiraWithRetry(request, '/p', {}, { sleep, isCurrent: () => current }),
    error => error instanceof SupersededError && isSuperseded(error));
  assert.deepEqual(waits, [5000]);
  assert.equal(calls.length, 1);

  // Already superseded when the 429 arrives: no wait at all.
  const waits2 = [];
  const second = fakeJira([res(429, { 'Retry-After': '5' })]);
  await assert.rejects(requestJiraWithRetry(second.request, '/p', {},
    { sleep: async ms => { waits2.push(ms); }, isCurrent: () => false }), SupersededError);
  assert.deepEqual(waits2, []);
});

test('search paging retries a rate-limited page and checks isCurrent before the retry', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { request, calls } = fakeJira([
      res(200, {}, { issues: [{}], nextPageToken: 'a' }),
      res(429, { 'Retry-After': '2' }),
      res(200, {}, { issues: [{}, {}], isLast: true }),
    ]);
    const counting = countIssues(request, 'project = A');
    await flush();
    assert.equal(calls.length, 2);
    mock.timers.tick(2000);
    assert.equal(await counting, 3);
    assert.equal(calls.length, 3);
    assert.equal(JSON.parse(calls[2].options.body).nextPageToken, 'a');

    let current = true;
    const superseded = fakeJira([res(429, { 'Retry-After': '2' })]);
    const walk = (async () => {
      for await (const page of searchPages(superseded.request, 'x', [], { isCurrent: () => current })) void page;
    })();
    await flush();
    current = false;
    mock.timers.tick(2000);
    await assert.rejects(walk, SupersededError);
    assert.equal(superseded.calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('changelog bulkfetch shows the busy message when retries run out', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { request, calls } = fakeJira([1, 2, 3, 4].map(() => res(429, { 'Retry-After': '1' })));
    const loading = fetchStatusChanges(request, [{ id: 1, fields: { updated: 'u' } }], { cache: new Map() });
    const outcome = loading.then(() => null, error => error);
    for (let i = 0; i < 4; i += 1) { await flush(); mock.timers.tick(1000); }
    const error = await outcome;
    assert.equal(error?.message, 'Jira is busy. Try again in 1 second.');
    assert.equal(calls.length, 4);
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------------------------
// Gadget level: the busy message appears in the gadget's existing error spot.

for (const name of ['status-chart', 'counter']) {
  test(`KDG-17 ${name}: retries a 429 and shows the busy message when retries run out`, async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
    const warn = mock.method(console, 'warn', () => {});
    try {
      const g = await startGadget(name);
      await g.bus.send(FILTER_SELECTED, selection());
      await flush();
      const searches = () => g.requests.filter(r => r.path.includes('search/jql'));
      // Approximate counts (Counter) are answered so only the exact search is rate limited.
      for (const r of g.pending('approximate-count')) r.resolve(ok({ count: 1 }));
      for (let attempt = 1; attempt <= RETRY_LIMIT + 1; attempt += 1) {
        await flush();
        const pending = g.pending('search/jql');
        assert.equal(pending.length, 1, `attempt ${attempt}`);
        assert.equal(searches().length, attempt);
        pending[0].resolve(res(429, { 'Retry-After': '10' }));
        await flush();
        assert.equal(g.pending('search/jql').length, 0, 'waits before retrying');
        if (attempt <= RETRY_LIMIT) mock.timers.tick(10000);
      }
      await flush();
      assert.equal(searches().length, RETRY_LIMIT + 1);
      assert.ok(g.root.textContent.includes('Jira is busy. Try again in 10 seconds.'), g.root.textContent);
    } finally {
      warn.mock.restore();
      mock.timers.reset();
    }
  });
}

test('KDG-17 status-chart: a retried 429 that then succeeds shows the counts', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  try {
    const g = await startGadget('status-chart');
    await g.bus.send(FILTER_SELECTED, selection());
    await flush();
    g.pending('search/jql')[0].resolve(res(429));
    await flush();
    mock.timers.tick(1300); // 1s backoff with up to 30% jitter
    await flush();
    g.pending('search/jql')[0].resolve(ok({
      issues: [{ id: '1', fields: { status: { name: 'To Do' } } }], isLast: true,
    }));
    await flush();
    assert.ok(!g.root.textContent.includes('Jira is busy'), g.root.textContent);
    assert.ok(!g.root.textContent.includes('failed'), g.root.textContent);
    assert.equal(g.requests.filter(r => r.path.includes('search/jql')).length, 2);
  } finally {
    mock.timers.reset();
  }
});
