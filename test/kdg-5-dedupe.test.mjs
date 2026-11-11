// KDG-5: selection de-duplication, refresh decisions and stopping superseded Jira walks early.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createSelectionTracker, REFRESH_ANSWERED_MS, REFRESH_FALLBACK_MS, selectionKey } from '../static/shared.mjs';
import { isSuperseded, searchPages, SupersededError } from '../static/jira-search.mjs';
import { countIssues } from '../static/count.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';
import { searchAllIssues } from '../static/issue-data.mjs';
import { fetchBurndownIssues, fetchStatusChanges } from '../static/burndown.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });

// ---- selectionKey ----

const selection = (overrides = {}) => ({
  dashboardId: 'd1', controllerId: 'c1', name: 'Sprint', jql: 'project = A',
  startDate: '2026-10-01', endDate: '2026-10-31',
  statuses: [{ name: 'Done', weight: 0, color: '#22a06b' }], revision: 'n1:1', ...overrides,
});

test('selectionKey is null when the revision is missing or null', () => {
  assert.equal(selectionKey(selection({ revision: null })), null);
  assert.equal(selectionKey(selection({ revision: undefined })), null);
  const { revision, ...old } = selection();
  assert.equal(selectionKey(old), null);
  assert.equal(selectionKey(null), null);
  assert.equal(selectionKey(undefined), null);
});

test('selectionKey has the documented shape and defaults', () => {
  assert.equal(selectionKey(selection()), JSON.stringify(['n1:1', 'project = A', '2026-10-01',
    '2026-10-31', [{ name: 'Done', weight: 0, color: '#22a06b' }], [], []]));
  assert.equal(selectionKey({ revision: 'n:0' }), JSON.stringify(['n:0', null, null, null, [], [], []]));
});

test('selectionKey changes with revision, JQL, dates or statuses, but not name or ids', () => {
  const base = selectionKey(selection());
  assert.equal(selectionKey(selection({ name: 'Other', controllerId: 'c2' })), base);
  for (const change of [{ revision: 'n1:2' }, { revision: 'n2:1' }, { jql: 'project = B' },
    { startDate: '2026-10-02' }, { endDate: null }, { statuses: [] },
    { statuses: [{ name: 'Done', weight: 0.5, color: '#22a06b' }] }]) {
    assert.notEqual(selectionKey(selection(change)), base, JSON.stringify(change));
  }
});

// ---- createSelectionTracker ----

function mockTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) { pending.delete(id); entry.fn(); }
      }
    },
    now() { return now; },
    get count() { return pending.size; },
  };
}

const DASHBOARD = { origin: 'dashboard' };
const OWN = { gadgetId: 'g1' };

function tracker(options = {}) {
  const timers = mockTimers();
  let fallbacks = 0;
  const t = createSelectionTracker({ gadgetId: 'g1', timers, onFallback: () => { fallbacks += 1; }, ...options });
  return { t, timers, fallbacks: () => fallbacks };
}

test('accept ignores a repeated key and handles a new one', () => {
  const { t } = tracker();
  assert.equal(t.hasSelection, false);
  assert.equal(t.accept(selection()), true);
  assert.equal(t.hasSelection, true);
  assert.equal(t.accept(selection()), false);
  assert.equal(t.accept(selection({ name: 'Renamed' })), false);
  assert.equal(t.accept(selection({ revision: 'n1:2' })), true);
  assert.equal(t.accept(selection({ revision: 'n1:2', jql: 'project = B' })), true);
  assert.equal(t.accept(selection({ revision: 'n1:2', jql: 'project = B' })), false);
});

test('accept never ignores a selection without a revision', () => {
  const { t } = tracker();
  const old = selection({ revision: undefined });
  assert.equal(t.accept(old), true);
  assert.equal(t.accept(old), true);
  // A revisioned selection after a null one is handled, and a null one after it too.
  assert.equal(t.accept(selection()), true);
  assert.equal(t.accept(old), true);
});

test('refreshAction ignores refreshes for other gadgets', () => {
  const { t } = tracker();
  t.accept(selection());
  assert.equal(t.refreshAction({ gadgetId: 'other' }), 'none');
  assert.equal(t.refreshAction({}), 'none');
  assert.equal(t.refreshAction(undefined), 'none');
});

test('refreshAction requests a selection when none has been handled yet', () => {
  const { t, timers } = tracker();
  assert.equal(t.refreshAction(DASHBOARD), 'request');
  assert.equal(t.refreshAction(OWN), 'request');
  assert.equal(timers.count, 0);
});

test('own refresh refetches now with any selection', () => {
  const { t, timers } = tracker();
  t.accept(selection());
  assert.equal(t.refreshAction(OWN), 'refetch');
  const old = tracker();
  old.t.accept(selection({ revision: null }));
  assert.equal(old.t.refreshAction(OWN), 'refetch');
  assert.equal(timers.count, 0);
});

test('dashboard refresh with an older Controller refetches now, as before', () => {
  const { t, timers } = tracker();
  t.accept(selection({ revision: null }));
  assert.equal(t.refreshAction(DASHBOARD), 'refetch');
  assert.equal(timers.count, 0);
});

test('dashboard refresh waits, and a new revision cancels the fallback', () => {
  const { t, timers, fallbacks } = tracker();
  t.accept(selection());
  timers.advance(REFRESH_ANSWERED_MS);
  assert.equal(t.refreshAction(DASHBOARD), 'wait');
  assert.equal(timers.count, 1);
  timers.advance(REFRESH_FALLBACK_MS - 1);
  assert.equal(t.accept(selection({ revision: 'n1:2' })), true);
  assert.equal(timers.count, 0);
  timers.advance(10000);
  assert.equal(fallbacks(), 0);
});

test('dashboard refresh falls back once after 3 s without a new revision', () => {
  const { t, timers, fallbacks } = tracker();
  t.accept(selection());
  assert.equal(REFRESH_FALLBACK_MS, 3000);
  timers.advance(REFRESH_ANSWERED_MS);
  assert.equal(t.refreshAction(DASHBOARD), 'wait');
  timers.advance(2999);
  assert.equal(fallbacks(), 0);
  // A repeat of the same selection does not count as the Controller's answer.
  assert.equal(t.accept(selection()), false);
  timers.advance(1);
  assert.equal(fallbacks(), 1);
  timers.advance(10000);
  assert.equal(fallbacks(), 1);
});

test('a second dashboard refresh restarts the single fallback timer', () => {
  const { t, timers, fallbacks } = tracker();
  t.accept(selection());
  timers.advance(REFRESH_ANSWERED_MS);
  t.refreshAction(DASHBOARD);
  timers.advance(2000);
  t.refreshAction(DASHBOARD);
  assert.equal(timers.count, 1);
  timers.advance(2000);
  assert.equal(fallbacks(), 0);
  timers.advance(1000);
  assert.equal(fallbacks(), 1);
});

test('cancel clears a pending fallback', () => {
  const { t, timers, fallbacks } = tracker();
  t.accept(selection());
  timers.advance(REFRESH_ANSWERED_MS);
  assert.equal(t.refreshAction(DASHBOARD), 'wait');
  t.cancel();
  assert.equal(timers.count, 0);
  timers.advance(5000);
  assert.equal(fallbacks(), 0);
  t.cancel();
});

test('fallbackMs is configurable', () => {
  const { t, timers, fallbacks } = tracker({ fallbackMs: 50 });
  t.accept(selection());
  timers.advance(REFRESH_ANSWERED_MS);
  t.refreshAction(DASHBOARD);
  timers.advance(50);
  assert.equal(fallbacks(), 1);
});

test('rerender mode (Simple Dates) re-renders on its own refresh and never refetches', () => {
  const { t, timers } = tracker({ rerender: true });
  assert.equal(t.refreshAction(OWN), 'request');
  assert.equal(t.refreshAction(DASHBOARD), 'request');
  t.accept(selection({ revision: null }));
  assert.equal(t.refreshAction(OWN), 'rerender');
  assert.equal(t.refreshAction(DASHBOARD), 'request');
  t.accept(selection());
  assert.equal(t.refreshAction(OWN), 'rerender');
  assert.equal(timers.count, 0);
  assert.equal(t.refreshAction(DASHBOARD), 'none', 'just answered by the new selection');
  timers.advance(REFRESH_ANSWERED_MS);
  assert.equal(t.refreshAction(OWN), 'rerender');
  assert.equal(t.refreshAction(DASHBOARD), 'wait');
  assert.equal(timers.count, 1);
});

test('the tracker uses the global timers and Date.now by default', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    let called = 0;
    const t = createSelectionTracker({ gadgetId: 'g1', onFallback: () => { called += 1; } });
    t.accept(selection());
    assert.equal(t.refreshAction(DASHBOARD), 'none');
    mock.timers.tick(REFRESH_ANSWERED_MS);
    assert.equal(t.refreshAction(DASHBOARD), 'wait');
    mock.timers.tick(REFRESH_FALLBACK_MS - 1);
    assert.equal(called, 0);
    mock.timers.tick(1);
    assert.equal(called, 1);
  } finally {
    mock.timers.reset();
  }
});

// ---- Both delivery orders of a dashboard refresh (the Controller's answer may arrive first) ----

// Counts reloads the way a data gadget does: an accepted selection, 'refetch' or the fallback.
function reloadingGadget() {
  const timers = mockTimers();
  let reloads = 0;
  const t = createSelectionTracker({ gadgetId: 'g1', timers, onFallback: () => { reloads += 1; } });
  const select = payload => { if (t.accept(payload)) reloads += 1; };
  const refresh = payload => {
    const action = t.refreshAction(payload);
    if (action === 'refetch') reloads += 1;
    return action;
  };
  select(selection({ revision: 'n:0' }));
  timers.advance(60000);
  reloads = 0;
  return { t, timers, select, refresh, reloads: () => reloads };
}

test('refresh then new revision: one reload, fallback cancelled', () => {
  const g = reloadingGadget();
  assert.equal(g.refresh(DASHBOARD), 'wait');
  g.timers.advance(200);
  g.select(selection({ revision: 'n:1' }));
  g.timers.advance(10000);
  assert.equal(g.reloads(), 1);
  assert.equal(g.timers.count, 0);
});

test('new revision then refresh: one reload, no fallback armed', () => {
  const g = reloadingGadget();
  g.select(selection({ revision: 'n:1' }));
  g.timers.advance(REFRESH_ANSWERED_MS - 1);
  assert.equal(g.refresh(DASHBOARD), 'none');
  assert.equal(g.timers.count, 0, 'no fallback timer');
  g.timers.advance(10000);
  assert.equal(g.reloads(), 1);
});

test('a revision older than REFRESH_ANSWERED_MS does not answer a later dashboard refresh', () => {
  assert.equal(REFRESH_ANSWERED_MS, 1000);
  const g = reloadingGadget();
  g.select(selection({ revision: 'n:1' }));
  g.timers.advance(REFRESH_ANSWERED_MS);
  assert.equal(g.refresh(DASHBOARD), 'wait');
  g.timers.advance(REFRESH_FALLBACK_MS);
  assert.equal(g.reloads(), 2, 'the revision, then the fallback');
});

test('a repeated (ignored) selection does not count as a new answer', () => {
  const g = reloadingGadget();
  g.select(selection({ revision: 'n:0' }));
  assert.equal(g.reloads(), 0);
  assert.equal(g.refresh(DASHBOARD), 'wait');
});

test('the answered window does not change own, null-key or Simple Dates refreshes', () => {
  const g = reloadingGadget();
  g.select(selection({ revision: 'n:1' }));
  assert.equal(g.refresh(OWN), 'refetch', 'own refresh still refetches at once');
  const old = tracker();
  old.t.accept(selection({ revision: null }));
  assert.equal(old.t.refreshAction(DASHBOARD), 'refetch', 'older Controller: as before');
  const dates = tracker({ rerender: true });
  dates.t.accept(selection({ revision: null }));
  assert.equal(dates.t.refreshAction(DASHBOARD), 'request');
  dates.t.accept(selection());
  assert.equal(dates.t.refreshAction(OWN), 'rerender');
});

test('a clock that goes backwards is not treated as a recent answer', () => {
  const g = reloadingGadget();
  g.select(selection({ revision: 'n:1' }));
  g.timers.advance(-5000);
  assert.equal(g.refresh(DASHBOARD), 'wait');
});

// ---- isCurrent in search walks ----

// Serves endless non-final pages, flipping `current` to false after `stopAfter` requests.
function supersedingRequest(stopAfter, pageIssues = [{ id: '1', fields: { status: { name: 'Done', id: '3' } } }]) {
  const state = { calls: 0, current: true };
  const request = async () => {
    state.calls += 1;
    if (state.calls >= stopAfter) state.current = false;
    return ok({ issues: pageIssues, isLast: false, nextPageToken: `t${state.calls}` });
  };
  return { request, state, isCurrent: () => state.current };
}

test('SupersededError is recognisable', () => {
  const error = new SupersededError();
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'SupersededError');
  assert.equal(isSuperseded(error), true);
  assert.equal(isSuperseded(new Error('x')), false);
  assert.equal(isSuperseded(undefined), false);
});

test('searchPages sends no request when isCurrent is already false', async () => {
  let calls = 0;
  const request = async () => { calls += 1; return ok({ issues: [], isLast: true }); };
  await assert.rejects(async () => { for await (const _ of searchPages(request, 'x', [], { isCurrent: () => false })); },
    SupersededError);
  assert.equal(calls, 0);
});

test('searchPages completes normally while isCurrent stays true', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return ok(calls < 3 ? { issues: [], isLast: false, nextPageToken: `t${calls}` } : { issues: [], isLast: true });
  };
  const pages = [];
  for await (const page of searchPages(request, 'x', [], { isCurrent: () => true })) pages.push(page);
  assert.equal(pages.length, 3);
});

const walkers = {
  searchPages: async (request, isCurrent) => { for await (const _ of searchPages(request, 'x', [], { isCurrent })); },
  searchAllIssues: (request, isCurrent) => searchAllIssues(request, 'x', ['key'], { isCurrent }),
  countIssues: (request, isCurrent) => countIssues(request, 'x', { isCurrent }),
  countIssuesByStatus: (request, isCurrent) => countIssuesByStatus(request, 'x', [{ name: 'Done', weight: 0 }], { isCurrent }),
  fetchBurndownIssues: (request, isCurrent) => fetchBurndownIssues(request, 'x', { isCurrent }),
};

for (const [name, walk] of Object.entries(walkers)) {
  test(`${name} stops with SupersededError after at most one more page`, async () => {
    // isCurrent turns false while page 2 is in flight; page 3 must never be requested.
    const { request, state, isCurrent } = supersedingRequest(2);
    await assert.rejects(walk(request, isCurrent), SupersededError);
    assert.equal(state.calls, 2);
  });
}

test('fetchBurndownIssues reports progress only for pages that were requested', async () => {
  const { request, isCurrent } = supersedingRequest(2);
  const seen = [];
  await assert.rejects(fetchBurndownIssues(request, 'x', { isCurrent, onPage: n => seen.push(n) }), SupersededError);
  assert.deepEqual(seen, [1, 2]);
});

// ---- isCurrent in the Burndown changelog fetch ----

const issuesFor = (count, updated = '2026-10-01T00:00:00.000+0000') =>
  Array.from({ length: count }, (_, i) => ({ id: String(i + 1), fields: { updated } }));

const changeLogsFor = ids => ids.map(id => ({ issueId: id, changeHistories: [
  { created: '2026-10-02T00:00:00Z', items: [{ fieldId: 'status', fromString: 'To Do', toString: 'Done' }] },
] }));

test('fetchStatusChanges starts no new batch once superseded and leaves the cache untouched', async () => {
  // 7,000 issues -> 7 batches, 3 in flight. Supersede after the first batch answers.
  const state = { current: true, calls: 0 };
  const request = async (path, options) => {
    state.calls += 1;
    const ids = JSON.parse(options.body).issueIdsOrKeys;
    await new Promise(resolve => setImmediate(resolve));
    state.current = false;
    return ok({ issueChangeLogs: changeLogsFor(ids) });
  };
  const cache = new Map([['stale', { updated: 'u', entries: [] }]]);
  const before = [...cache];
  const progress = [];
  await assert.rejects(fetchStatusChanges(request, issuesFor(7000),
    { cache, isCurrent: () => state.current, onProgress: p => progress.push(p) }), SupersededError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls, 3, 'only the batches already in flight were requested');
  assert.deepEqual([...cache], before);
  // Only the initial progress report; no superseded batch reports progress.
  assert.deepEqual(progress, [{ done: 0, total: 7000 }]);
});

test('fetchStatusChanges sends no request when isCurrent is already false', async () => {
  let calls = 0;
  const cache = new Map();
  await assert.rejects(fetchStatusChanges(async () => { calls += 1; return ok({ issueChangeLogs: [] }); },
    issuesFor(10), { cache, isCurrent: () => false }), SupersededError);
  assert.equal(calls, 0);
  assert.equal(cache.size, 0);
});

test('fetchStatusChanges skips the next changelog page once superseded', async () => {
  const state = { current: true, calls: 0 };
  const request = async (path, options) => {
    state.calls += 1;
    state.current = false;
    return ok({ issueChangeLogs: changeLogsFor(JSON.parse(options.body).issueIdsOrKeys), nextPageToken: 'more' });
  };
  const cache = new Map();
  await assert.rejects(fetchStatusChanges(request, issuesFor(5), { cache, isCurrent: () => state.current }),
    SupersededError);
  assert.equal(state.calls, 1);
  assert.equal(cache.size, 0);
});

test('fetchStatusChanges caches normally while isCurrent stays true', async () => {
  const cache = new Map();
  const changes = await fetchStatusChanges(
    async (path, options) => ok({ issueChangeLogs: changeLogsFor(JSON.parse(options.body).issueIdsOrKeys) }),
    issuesFor(1500), { cache, isCurrent: () => true });
  assert.equal(changes.size, 1500);
  assert.equal(cache.size, 1500);
});
