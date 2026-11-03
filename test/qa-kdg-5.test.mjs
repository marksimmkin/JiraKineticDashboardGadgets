// QA KDG-5: independent checks of selection de-duplication on a whole dashboard, and of the
// safety cases (older Controller, failed Controller, event order, superseded walks, List sort).
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_REQUEST, FILTER_SELECTED, GADGET_REFRESH, REFRESH_ANSWERED_MS } from '../static/shared.mjs';
import { createBus, fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const ADD_CONTROLLER = 'Add a Kinetic Dashboard Controller to this dashboard.';
const GADGETS = ['status-chart', 'status-pie', 'progress-bar', 'burndown', 'counter', 'dates',
  'issue-list', 'user-list', 'user-leaderboard'];
const FETCHING = GADGETS.filter(name => name !== 'dates');
const WALKING = FETCHING.filter(name => name !== 'issue-list');
const CONFIG = {
  filters: [{ name: 'Filter A', jql: 'project = A', startDate: '2026-01-01', endDate: '2026-12-31' },
    { name: 'Filter B', jql: 'project = B', startDate: '2026-01-01', endDate: '2026-12-31' }],
  statuses: selection().statuses,
};

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const makeIssues = (prefix, count) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}${i + 1}`, key: `${prefix}-${i + 1}`,
  fields: {
    summary: 's', status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    assignee: { accountId: 'u', displayName: 'U' }, created: '2026-01-02T00:00:00Z',
    updated: '2026-01-02T00:00:00Z', timetracking: { remainingEstimateSeconds: 3600 },
  },
}));
// Answers for whichever project the JQL names.
const jira = (path, body) => {
  const prefix = /project = (\w+)/.exec(body?.jql ?? '')?.[1] ?? 'X';
  if (path.includes('approximate-count')) return ok({ count: 2 });
  if (path.includes('search/jql')) return ok({ issues: makeIssues(prefix, 2), isLast: true });
  if (path.includes('bulkfetch')) {
    return ok({ issueChangeLogs: body.issueIdsOrKeys.map(issueId => ({ issueId, changeHistories: [] })) });
  }
  return undefined;
};
const isSearch = r => r.path.includes('search/jql');
const select = (g, overrides) => g.bus.send(FILTER_SELECTED, selection(overrides));
// Lets pending event deliveries settle before moving the clock, as real time would.
const tick = async ms => { await flush(); mock.timers.tick(ms); await flush(); };

const ORDERS = {
  'Controller first': names => ['controller', ...names],
  'Controller last': names => [...names, 'controller'],
  'reversed, Controller in the middle': names => {
    const r = [...names].reverse();
    return [...r.slice(0, 4), 'controller', ...r.slice(4)];
  },
};

async function dashboard(order) {
  const bus = createBus();
  const gadgets = [];
  let controller;
  for (const name of ORDERS[order](GADGETS)) {
    if (name === 'controller') controller = await startGadget('controller', { bus, configuration: CONFIG });
    else gadgets.push(await startGadget(name, { bus, jira }));
  }
  await flush();
  const perGadget = () => Object.fromEntries(gadgets.map(g => [g.name, g.requests.filter(isSearch).length]));
  let last = Object.fromEntries(gadgets.map(g => [g.name, 0]));
  // Searches per gadget since the previous call.
  const delta = () => {
    const now = perGadget();
    const d = Object.fromEntries(Object.keys(now).map(k => [k, now[k] - last[k]]));
    last = now;
    return d;
  };
  const once = Object.fromEntries(GADGETS.map(n => [n, n === 'dates' ? 0 : 1]));
  const none = Object.fromEntries(GADGETS.map(n => [n, 0]));
  const refreshTo = async (pred, payload) => {
    for (const s of bus.subscribers.filter(s => s.name === GADGET_REFRESH && pred(s.owner))) {
      await s.fn(structuredClone(payload));
    }
    await flush();
  };
  return { bus, gadgets, get controller() { return controller; }, delta, once, none, refreshTo,
    restartController: async () => {
      for (const s of bus.subscribers.filter(s => s.owner === controller.gadgetId)) {
        bus.subscribers.splice(bus.subscribers.indexOf(s), 1);
      }
      controller = await startGadget('controller', { bus, configuration: CONFIG });
    } };
}

for (const order of Object.keys(ORDERS)) {
  test(`QA KDG-5 dashboard (${order}): each step loads each data gadget exactly once`, withTimers(async () => {
    const d = await dashboard(order);
    const { once, none } = d;
    await tick(4000);
    assert.deepEqual(d.delta(), once, 'load');
    for (const g of d.gadgets) assert.ok(!g.root.textContent.includes(ADD_CONTROLLER), g.name);

    await tick(REFRESH_ANSWERED_MS);
    await d.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'dashboard refresh (refresh event first)');

    await tick(REFRESH_ANSWERED_MS);
    const isController = o => o === d.controller.gadgetId;
    await d.refreshTo(isController, { origin: 'dashboard' });
    await d.refreshTo(o => !isController(o), { origin: 'dashboard' });
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'dashboard refresh (new revision first)');

    d.controller.findAll('controller-filter-button')[1].click();
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'click Filter B');
    d.controller.findAll('controller-filter-button')[1].click();
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'click the active filter again');

    const dates = d.gadgets.find(g => g.name === 'dates');
    const requestsBefore = d.bus.emitted(FILTER_REQUEST).length;
    await d.bus.send(GADGET_REFRESH, { gadgetId: dates.gadgetId });
    await tick(3100);
    assert.deepEqual(d.delta(), none, 'Simple Dates own refresh');
    assert.equal(d.bus.emitted(FILTER_REQUEST).length, requestsBefore, 'Simple Dates sent no filter.request');

    for (const g of d.gadgets.filter(g => g.name !== 'dates')) {
      await d.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
      await tick(3100);
      assert.deepEqual(d.delta(), { ...none, [g.name]: 1 }, `${g.name} own refresh reloads only itself`);
    }

    await d.bus.send(GADGET_REFRESH, { gadgetId: d.controller.gadgetId });
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'Controller own refresh');

    await d.restartController();
    await tick(3100);
    assert.deepEqual(d.delta(), once, 'Controller reloaded with a new nonce');
    for (const g of d.gadgets) {
      assert.ok(g.root.textContent.includes('Filter A'), `${g.name} shows the first filter again`);
      assert.ok(!/Could not|superseded/i.test(g.root.textContent), `${g.name}: ${g.root.textContent}`);
    }
    assert.equal(d.bus.errors.length, 0);
  }));
}

test('QA KDG-5 dashboard: Controller frame never answers, so each gadget reloads once at 3 s',
  withTimers(async () => {
    const d = await dashboard('Controller first');
    await tick(4000);
    d.delta();
    for (const s of d.bus.subscribers.filter(s => s.owner === d.controller.gadgetId)) {
      d.bus.subscribers.splice(d.bus.subscribers.indexOf(s), 1);
    }
    await tick(REFRESH_ANSWERED_MS);
    await d.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await tick(2999);
    assert.deepEqual(d.delta(), d.none, 'nothing before 3 s');
    await tick(1);
    assert.deepEqual(d.delta(), d.once, 'one reload at 3 s');
    await tick(20000);
    assert.deepEqual(d.delta(), d.none, 'only once');
    for (const g of d.gadgets) {
      assert.ok(g.root.textContent.includes('Filter A'), g.name);
      assert.ok(!g.root.textContent.includes(ADD_CONTROLLER), g.name);
    }
  }));

test('QA KDG-5 dashboard: two dashboard refreshes 200 ms apart load at most twice per gadget',
  withTimers(async () => {
    const d = await dashboard('Controller first');
    await tick(4000);
    d.delta();
    await tick(REFRESH_ANSWERED_MS);
    await d.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await tick(200);
    await d.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await tick(10000);
    const twice = Object.fromEntries(Object.entries(d.once).map(([k, v]) => [k, v * 2]));
    assert.deepEqual(d.delta(), twice, 'one load per new revision, no fallback');
  }));

// ---- 4 s message and refresh before any selection ----

for (const name of FETCHING) {
  test(`QA KDG-5 ${name}: no Controller, a dashboard refresh asks again and the 4 s message still shows`,
    withTimers(async () => {
      const g = await startGadget(name, { jira });
      await tick(1000);
      await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
      await flush();
      assert.equal(g.emitted(FILTER_REQUEST).length, 2);
      await tick(3000);
      assert.ok(g.root.textContent.includes(ADD_CONTROLLER), g.root.textContent);
      assert.equal(g.requests.length, 0);
    }));
}

// ---- superseded walks ----

for (const name of WALKING) {
  test(`QA KDG-5 ${name}: a superseded page that later fails with 401 shows no error`, withTimers(async () => {
    const g = await startGadget(name);
    await select(g, { revision: 'n:0', jql: 'project = OLD' });
    await flush();
    const old = g.requests.find(r => isSearch(r) && r.body?.jql === 'project = OLD');
    await select(g, { revision: 'n:1', name: 'New', jql: 'project = NEW' });
    await flush();
    for (const r of g.requests.filter(r => !r.done && r !== old)) r.resolve(jira(r.path, r.body));
    await flush();
    for (const r of g.requests.filter(r => !r.done && r !== old)) r.resolve(jira(r.path, r.body));
    await flush();
    old.resolve(fail(401, { errorMessages: ['Unauthorized'] }));
    await flush();
    assert.ok(g.root.textContent.includes('New'));
    assert.ok(!/Could not|Unauthorized|401|superseded/i.test(g.root.textContent), g.root.textContent);
  }));
}

test('QA KDG-5 burndown: a superseded changelog walk is not cached, so the next load fetches it again',
  withTimers(async () => {
    const g = await startGadget('burndown');
    await select(g, { revision: 'n:0', jql: 'project = OLD' });
    await flush();
    g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('OLD', 2), isLast: true }));
    await flush();
    const batch = g.pending('bulkfetch')[0];
    await select(g, { revision: 'n:1', name: 'New', jql: 'project = NEW' });
    await flush();
    // The old batch's first page arrives with a change and a further page: neither is kept.
    batch.resolve(ok({ issueChangeLogs: [{ issueId: 'OLD1', changeHistories: [] }], nextPageToken: 'cl-2' }));
    await flush();
    assert.equal(g.requests.filter(r => r.body?.nextPageToken === 'cl-2').length, 0);
    for (let i = 0; i < 5; i += 1) {
      for (const r of g.requests.filter(r => !r.done && r !== batch)) r.resolve(jira(r.path, r.body));
      await flush();
    }
    const oldFetches = () => g.requests.filter(r => r.path.includes('bulkfetch') &&
      r.body.issueIdsOrKeys.includes('OLD1')).length;
    assert.equal(oldFetches(), 1);
    await select(g, { revision: 'n:2', name: 'Old again', jql: 'project = OLD' });
    for (let i = 0; i < 5; i += 1) {
      for (const r of g.requests.filter(r => !r.done && r !== batch)) r.resolve(jira(r.path, r.body));
      await flush();
    }
    assert.equal(oldFetches(), 2, 'OLD changelogs fetched again: the partial walk was not cached');
    assert.match(g.find('burndown-summary').textContent, /2 issues in the current JQL scope$/);
  }));

// ---- Issue List sort and page 1 ----

test('QA KDG-5 issue-list: a new revision and the fallback keep the sort and restart at page 1',
  withTimers(async () => {
    const g = await startGadget('issue-list');
    await select(g, { revision: 'n:0' });
    await flush();
    g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('A', 2), nextPageToken: 'p2', isLast: false }));
    await flush();
    g.findAll('table-sort-button')[0].click(); // Key ascending
    await flush();
    g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('A', 2), nextPageToken: 'p2', isLast: false }));
    await flush();
    g.find('issue-list-more').click();
    await flush();
    g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('B', 2), nextPageToken: 'p3', isLast: false }));
    await flush();
    assert.equal(g.root.querySelectorAll('tr').length, 5, 'header + 4 rows');
    const checkRestart = async label => {
      const [req] = g.pending('search/jql');
      assert.ok(req, `${label}: a page was requested`);
      assert.equal(req.body.nextPageToken, undefined, `${label}: from the first page`);
      assert.match(req.body.jql, /ORDER BY key ASC$/, `${label}: sort kept`);
      assert.equal(g.root.querySelectorAll('tr').length, 1, `${label}: old rows cleared`);
      assert.equal(g.findAll('table-sort-button')[0].textContent.endsWith(' ↑'), true, `${label}: heading`);
      req.resolve(ok({ issues: makeIssues('A', 1), isLast: true }));
      await flush();
    };
    await tick(REFRESH_ANSWERED_MS);
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    assert.equal(g.pending('search/jql').length, 0, 'waits for the Controller');
    await select(g, { revision: 'n:1' });
    await flush();
    await checkRestart('new revision');
    await tick(REFRESH_ANSWERED_MS);
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await tick(3000);
    await checkRestart('fallback');
  }));

// ---- older Controller: unchanged behaviour on a dashboard refresh ----

for (const name of FETCHING) {
  test(`QA KDG-5 ${name}: with an older Controller a dashboard refresh reloads at once with no fallback`,
    withTimers(async () => {
      const g = await startGadget(name, { jira });
      await select(g);
      await flush();
      await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
      await flush();
      assert.equal(g.requests.filter(isSearch).length, 2, 'reloaded at once, as before');
      await select(g); // the older Controller re-broadcasts the same payload
      await tick(10000);
      assert.equal(g.requests.filter(isSearch).length, 3, 'its repeat is not ignored; no extra fallback');
    }));
}
