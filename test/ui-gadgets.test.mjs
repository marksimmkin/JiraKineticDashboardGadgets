// KDG-7: gadget entry points (static/<gadget>/src.mjs) and their side of the Controller event
// flow, run through test/helpers/gadget-harness.mjs with a fake @forge/bridge and a fake DOM.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_REQUEST, FILTER_SELECTED, GADGET_REFRESH } from '../static/shared.mjs';
import { createStorage, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const ADD_CONTROLLER = 'Add a Kinetic Dashboard Controller to this dashboard.';
// Every display gadget (the Controller has its own tests in ui-controller.test.mjs).
const GADGETS = ['status-chart', 'status-pie', 'progress-bar', 'burndown', 'counter', 'dates',
  'issue-list', 'user-list', 'user-leaderboard'];
// Gadgets that load Jira data for a selection. Simple Dates only shows the payload.
const FETCHING = GADGETS.filter(name => name !== 'dates');

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

function makeIssues(prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`, key: `${prefix}-${i + 1}`,
    fields: {
      summary: `${prefix} issue ${i + 1}`,
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      assignee: { accountId: `${prefix}-user`, displayName: `${prefix} User` },
      created: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z',
      timetracking: { remainingEstimateSeconds: 3600 },
    },
  }));
}

// A fake Jira that answers every request for one filter: `count` issues keyed `prefix`.
function jiraFor(prefix, count) {
  return (path, body) => {
    if (path.includes('approximate-count')) return ok({ count });
    if (path.includes('search/jql')) return ok({ issues: makeIssues(prefix, count), isLast: true });
    if (path.includes('changelog/bulkfetch')) {
      return ok({ issueChangeLogs: body.issueIdsOrKeys.map(issueId => ({ issueId, changeHistories: [] })) });
    }
    return undefined;
  };
}

// Answers this gadget's pending requests (for any JQL in `jqls`, plus follow-up requests
// without JQL such as changelog batches) until none are left.
async function answerAll(g, jira, jqls) {
  for (let round = 0; round < 20; round += 1) {
    const due = g.requests.filter(r => !r.done && (r.body?.jql === undefined ||
      jqls.some(jql => r.body.jql.startsWith(jql.replace(/ ORDER BY.*$/, '')))));
    if (!due.length) return;
    for (const r of due) r.resolve(jira(r.path, r.body));
    await flush();
  }
  throw new Error('requests kept coming');
}

const select = (g, overrides) => g.bus.send(FILTER_SELECTED, selection(overrides));
const shows = (g, text) => g.root.textContent.includes(text);

// ---------------------------------------------------------------------------------------------
// The event contract every gadget follows (README "Controller events").

for (const name of GADGETS) {
  test(`KDG-7 ${name}: sends filter.request for its dashboard on load`, withTimers(async () => {
    const g = await startGadget(name);
    assert.deepEqual(g.emitted(FILTER_REQUEST).map(e => e.payload), [{ dashboardId: 'd1' }]);
    assert.equal(g.requests.length, 0, 'no Jira request before a selection');
    assert.ok(shows(g, 'Waiting for the controller…') || name === 'progress-bar',
      g.root.textContent);
  }));

  test(`KDG-7 ${name}: ignores selections for other dashboards`, withTimers(async () => {
    const g = await startGadget(name);
    const before = g.root.textContent;
    await select(g, { dashboardId: 'd2', name: 'Other dashboard' });
    await select(g, { dashboardId: undefined, name: 'No dashboard' });
    await select(g, { dashboardId: 'D1', name: 'Wrong case' });
    await flush();
    assert.equal(g.requests.length, 0);
    assert.equal(g.root.textContent, before, 'nothing on screen changed');
    mock.timers.tick(4000); await flush();
    assert.ok(shows(g, ADD_CONTROLLER), 'still treated as having no Controller');
  }));

  test(`KDG-7 ${name}: shows "${ADD_CONTROLLER}" after 4 seconds with no selection`, withTimers(async () => {
    const g = await startGadget(name);
    mock.timers.tick(3999); await flush();
    assert.ok(!shows(g, ADD_CONTROLLER), 'not before 4 s');
    mock.timers.tick(1); await flush();
    assert.ok(shows(g, ADD_CONTROLLER), g.root.textContent);
  }));

  test(`KDG-7 ${name}: no "Add a Controller" message once a selection has arrived`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    mock.timers.tick(3999); await flush();
    await select(g);
    await flush();
    mock.timers.tick(10000); await flush();
    assert.ok(!shows(g, ADD_CONTROLLER), g.root.textContent);
    assert.ok(shows(g, 'Filter A'), 'the filter name is shown');
  }));

  test(`KDG-7 ${name}: an empty selection from the Controller is not treated as "no Controller"`,
    withTimers(async () => {
      const g = await startGadget(name);
      await select(g, { name: null, jql: null, startDate: null, endDate: null });
      await flush();
      mock.timers.tick(4000); await flush();
      assert.equal(g.requests.length, 0);
      assert.ok(!shows(g, ADD_CONTROLLER), g.root.textContent);
      assert.match(g.root.textContent, /(Choose|Configure) a filter in the [Cc]ontroller\./);
    }));

  test(`KDG-7 ${name}: refresh before any selection asks the Controller again`, withTimers(async () => {
    const g = await startGadget(name);
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    assert.equal(g.emitted(FILTER_REQUEST).length, 2, 'dashboard refresh');
    await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
    await flush();
    assert.equal(g.emitted(FILTER_REQUEST).length, 3, 'refresh of this gadget');
    await g.bus.send(GADGET_REFRESH, { gadgetId: 'another-gadget' });
    await g.bus.send(GADGET_REFRESH, undefined);
    await flush();
    assert.equal(g.emitted(FILTER_REQUEST).length, 3, 'refresh of another gadget is ignored');
    assert.equal(g.requests.length, 0);
  }));

  test(`KDG-7 ${name}: without a dashboard ID it shows an error and sends nothing`, withTimers(async () => {
    const g = await startGadget(name, { dashboardId: '' });
    assert.equal(g.root.textContent, 'Dashboard context is unavailable.');
    assert.equal(g.bus.log.length, 0);
    assert.equal(g.bus.subscribers.length, 0);
    mock.timers.tick(4000); await flush();
    assert.equal(g.root.textContent, 'Dashboard context is unavailable.');
  }));
}

for (const name of FETCHING) {
  test(`KDG-7 ${name}: refresh after a selection reloads from Jira`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    await select(g);
    await flush();
    const loaded = g.requests.length;
    assert.ok(loaded > 0, 'the selection started a load');
    const settled = g.root.textContent;
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    const afterDashboard = g.requests.length;
    assert.ok(afterDashboard > loaded, 'dashboard refresh reloads');
    assert.ok(afterDashboard - loaded <= loaded, 'at most one reload');
    await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
    await flush();
    assert.ok(g.requests.length > afterDashboard, 'refresh of this gadget reloads');
    const afterOwn = g.requests.length;
    await g.bus.send(GADGET_REFRESH, { gadgetId: 'another-gadget' });
    await flush();
    assert.equal(g.requests.length, afterOwn, 'refresh of another gadget is ignored');
    assert.equal(g.emitted(FILTER_REQUEST).length, 1, 'no new filter.request once a selection is held');
    assert.equal(g.root.textContent, settled, 'the reloaded data is shown the same way');
    assert.ok(g.requests.every(r => r.body?.jql === undefined || r.body.jql === 'project = A'),
      'every reload uses the held selection');
  }));

  // Older search results must be dropped when the selection changes mid-fetch. The final screen
  // must match a control instance that only ever saw filter B.
  for (const order of ['old answered last', 'old answered first']) {
    test(`KDG-7 ${name}: results for an older selection are ignored (${order})`, withTimers(async () => {
      const B = { name: 'Filter B', jql: 'project = B' };
      const control = await startGadget(name, { jira: jiraFor('B', 2) });
      await select(control, B);
      await flush();
      const want = control.root.textContent;
      assert.ok(want.includes('Filter B'));

      const g = await startGadget(name);
      await select(g, { name: 'Filter A', jql: 'project = A' });
      await flush();
      assert.ok(g.requests.some(r => r.body?.jql === 'project = A'), 'filter A load started');
      await select(g, B);
      await flush();
      if (order === 'old answered first') {
        await answerAll(g, jiraFor('A', 7), ['project = A']);
        assert.ok(!shows(g, 'A-1') && !shows(g, 'A User'), 'no filter A data while B loads');
        await answerAll(g, jiraFor('B', 2), ['project = B']);
      } else {
        await answerAll(g, jiraFor('B', 2), ['project = B']);
        assert.equal(g.root.textContent, want);
        await answerAll(g, jiraFor('A', 7), ['project = A']);
      }
      mock.timers.tick(1000); await flush();
      mock.timers.tick(1000); await flush(); // let both instances' timers run alike
      mock.timers.tick(1000); await flush();
      assert.equal(g.root.textContent, control.root.textContent);
      assert.ok(!shows(g, 'A-1'), 'no issue from filter A');
      assert.equal(g.requests.filter(r => !r.done).length, 0, 'the stale load started nothing further');
    }));
  }
}

// ---------------------------------------------------------------------------------------------
// Gadget-specific checks.

test('KDG-7 status-chart: counts bars from the search and drops a stale count', withTimers(async () => {
  const g = await startGadget('status-chart');
  await select(g, { jql: 'project = OLD' });
  await flush();
  assert.equal(g.find('status').textContent, 'Counting visible issues…');
  const old = g.pending('search/jql')[0];
  assert.deepEqual(old.body.fields, ['status']);
  await select(g, { name: 'New', jql: 'project = NEW' });
  await flush();
  old.resolve(ok({ issues: makeIssues('OLD', 9), isLast: true }));
  await flush();
  assert.equal(g.findAll('status-bar-row').length, 0, 'no bars from the stale result');
  assert.equal(g.find('status').textContent, 'Counting visible issues…');
  g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('NEW', 3), isLast: true }));
  await flush();
  const numbers = g.findAll('status-bar-number').map(b => b.textContent);
  assert.deepEqual(numbers, ['3', '0'], 'To Do and Done');
  assert.equal(g.find('status').textContent, '3 of 3 issues in selected statuses');
  assert.equal(g.find('chart-filter-name').textContent, 'New');
}));

test('KDG-7 status-chart: a stale error is not shown over the newer result', withTimers(async () => {
  const g = await startGadget('status-chart');
  await select(g, { jql: 'project = OLD' });
  await flush();
  const old = g.pending('search/jql')[0];
  await select(g, { jql: 'project = NEW' });
  await flush();
  g.pending('search/jql').find(r => r.body.jql === 'project = NEW')
    .resolve(ok({ issues: makeIssues('N', 1), isLast: true }));
  await flush();
  old.resolve({ ok: false, status: 500, json: async () => ({}) });
  await flush();
  assert.equal(g.find('status').textContent, '1 of 1 issues in selected statuses');
}));

test('KDG-7 issue-list: a stale page is not appended after a new selection', withTimers(async () => {
  const g = await startGadget('issue-list');
  await select(g, { jql: 'project = OLD' });
  await flush();
  const old = g.pending('search/jql')[0];
  assert.equal(old.body.maxResults, 50);
  await select(g, { name: 'New', jql: 'project = NEW' });
  await flush();
  const fresh = g.pending('search/jql').find(r => r.body.jql === 'project = NEW');
  assert.ok(fresh, 'the new selection starts its own page load');
  old.resolve(ok({ issues: makeIssues('OLD', 4), nextPageToken: 'old-2', isLast: false }));
  await flush();
  assert.equal(g.root.querySelectorAll('tr').length, 1, 'header row only');
  assert.equal(g.find('issue-list-more').hidden, true);
  fresh.resolve(ok({ issues: makeIssues('NEW', 2), isLast: true }));
  await flush();
  const rows = g.root.querySelectorAll('tr').slice(1);
  assert.deepEqual(rows.map(r => r.children[0].textContent), ['NEW-1', 'NEW-2']);
  assert.equal(g.find('status').textContent,
    '2 issues loaded here · click count for the full Jira list');
  assert.equal(g.find('issue-list-more').disabled, false);
}));

test('KDG-7 issue-list: refresh reloads from the first page and replaces the rows', withTimers(async () => {
  const g = await startGadget('issue-list');
  await select(g);
  await flush();
  g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('A', 2), nextPageToken: 'p2', isLast: false }));
  await flush();
  assert.equal(g.find('issue-list-more').hidden, false);
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await flush();
  const again = g.pending('search/jql');
  assert.equal(again.length, 1);
  assert.equal(again[0].body.nextPageToken, undefined, 'starts from the first page');
  assert.equal(g.root.querySelectorAll('tr').length, 1, 'old rows cleared');
  again[0].resolve(ok({ issues: makeIssues('A', 1), isLast: true }));
  await flush();
  assert.equal(g.root.querySelectorAll('tr').length, 2);
  assert.equal(g.find('issue-list-more').hidden, true);
}));

test('KDG-7 counter: a stale exact or approximate count is not shown', withTimers(async () => {
  const g = await startGadget('counter');
  await select(g, { jql: 'project = OLD' });
  await flush();
  const oldApprox = g.pending('approximate-count')[0];
  const oldSearch = g.pending('search/jql')[0];
  await select(g, { name: 'New', jql: 'project = NEW' });
  await flush();
  oldApprox.resolve(ok({ count: 900 }));
  oldSearch.resolve(ok({ issues: makeIssues('OLD', 9), isLast: true }));
  await flush();
  assert.equal(g.find('count').textContent, '…', 'still loading the new count');
  assert.ok(!shows(g, '900') && !g.find('count').textContent.includes('9'));
  g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('NEW', 3), isLast: true }));
  await flush();
  assert.equal(g.find('count').textContent, '3');
  assert.equal(g.find('filter-name').textContent, 'New');
  g.pending('approximate-count')[0].resolve(ok({ count: 5 }));
  await flush();
  assert.equal(g.find('count').textContent, '3', 'a late approximate count does not replace the exact one');
}));

test('KDG-7 counter: the "Add a Controller" message is also announced', withTimers(async () => {
  const g = await startGadget('counter');
  mock.timers.tick(4000); await flush();
  assert.equal(g.find('status').textContent, ADD_CONTROLLER);
  assert.equal(g.find('visually-hidden').textContent, ADD_CONTROLLER);
  assert.equal(g.find('visually-hidden').getAttribute('role'), 'status');
}));

test('KDG-7 burndown: the "Add a Controller" message is also announced', withTimers(async () => {
  const g = await startGadget('burndown');
  mock.timers.tick(4000); await flush();
  assert.equal(g.find('status').textContent, ADD_CONTROLLER);
  assert.equal(g.find('visually-hidden').textContent, ADD_CONTROLLER);
}));

test('KDG-7 burndown: a stale search does not start the changelog fetch', withTimers(async () => {
  const g = await startGadget('burndown');
  await select(g, { jql: 'project = OLD' });
  await flush();
  const oldSearch = g.pending('search/jql')[0];
  await select(g, { name: 'New', jql: 'project = NEW' });
  await flush();
  oldSearch.resolve(ok({ issues: makeIssues('OLD', 5), isLast: true }));
  await flush();
  assert.equal(g.pending('bulkfetch').length, 0);
  await answerAll(g, jiraFor('NEW', 2), ['project = NEW']);
  assert.equal(g.requests.filter(r => r.path.includes('bulkfetch')).length, 1, 'one batch, for NEW only');
  assert.match(g.find('burndown-summary').textContent, /^2 remaining from 0 at the start of 1 Jan 2026 · 2 issues in the current JQL scope$/);
}));

test('KDG-7 dates: shows the selected dates and refresh asks the Controller again', withTimers(async () => {
  const g = await startGadget('dates');
  await select(g, { startDate: '2026-02-03', endDate: null });
  await flush();
  const [start, end] = g.findAll('date-card-value');
  assert.equal(start.textContent, '3 Feb 2026');
  assert.equal(start.getAttribute('datetime'), '2026-02-03');
  assert.equal(end.textContent, 'Not set');
  assert.equal(end.getAttribute('datetime'), null);
  assert.equal(g.find('status').textContent, '');
  // Simple Dates keeps no copy of the selection, so every refresh re-requests it.
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
  await g.bus.send(GADGET_REFRESH, { gadgetId: 'another-gadget' });
  await flush();
  assert.equal(g.emitted(FILTER_REQUEST).length, 3);
  await select(g, { name: 'No dates', startDate: null, endDate: null });
  await flush();
  assert.equal(g.find('status').textContent, 'No dates set for this filter.');
  assert.equal(g.find('dates-filter-name').textContent, 'No dates');
  await select(g, { name: null });
  await flush();
  assert.equal(g.find('status').textContent, 'Configure a filter in the controller.');
  assert.deepEqual(g.findAll('date-card-value').map(n => n.textContent), ['—', '—']);
}));

test('KDG-7 status-chart: hidden statuses survive blocked browser storage', withTimers(async () => {
  const g = await startGadget('status-chart', { storage: createStorage({ blocked: true }), jira: jiraFor('A', 2) });
  await select(g);
  await flush();
  assert.equal(g.find('status').textContent, '2 of 2 issues in selected statuses');
  const [todo] = g.root.querySelectorAll('input[type="checkbox"]');
  todo.checked = false;
  todo.dispatchEvent({ type: 'change' });
  await flush();
  assert.equal(g.find('status').textContent, '0 of 2 issues in selected statuses');
  assert.equal(g.find('status-filter-summary').textContent, 'Statuses: 1 of 2');
}));
