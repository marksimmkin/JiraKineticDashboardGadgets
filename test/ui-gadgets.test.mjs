// KDG-7: gadget entry points (static/<gadget>/src.mjs) and their side of the Controller event
// flow, run through test/helpers/gadget-harness.mjs with a fake @forge/bridge and a fake DOM.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_REQUEST, FILTER_SELECTED, GADGET_REFRESH, REFRESH_ANSWERED_MS } from '../static/shared.mjs';
import { createBus, createStorage, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

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
// The event contract every gadget follows (README (the paragraph starting "Add one Controller")).

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
  // This selection has no revision (an older Controller), so a dashboard refresh still asks the
  // Controller again. KDG-5: its own refresh re-renders the held selection without asking.
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
  await g.bus.send(GADGET_REFRESH, { gadgetId: 'another-gadget' });
  await flush();
  assert.equal(g.emitted(FILTER_REQUEST).length, 2);
  assert.equal(start.textContent, '3 Feb 2026');
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

// ---------------------------------------------------------------------------------------------
// KDG-5: repeated selections and refreshes do not repeat Jira downloads.

const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;
const revised = (revision, overrides) => ({ revision, ...overrides });
// Gadgets that walk every search page (the Issue List loads one page at a time instead).
const WALKING = FETCHING.filter(name => name !== 'issue-list');

for (const name of FETCHING) {
  test(`KDG-5 ${name}: a repeated revision is ignored and a new one reloads`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    await select(g, revised('n:0'));
    await flush();
    assert.equal(searches(g), 1);
    const shown = g.root.textContent;
    await select(g, revised('n:0'));
    await select(g, revised('n:0', { name: 'Renamed' }));
    await flush();
    assert.equal(searches(g), 1, 'the same revision and query is not loaded again');
    assert.equal(g.root.textContent, shown, 'nothing on screen changed');
    await select(g, revised('n:1'));
    await flush();
    assert.equal(searches(g), 2, 'a new revision (for example the active filter clicked again) reloads');
    await select(g, revised('n:1', { jql: 'project = A2' }));
    await flush();
    assert.equal(searches(g), 3, 'a different query under the same revision reloads');
  }));

  test(`KDG-5 ${name}: a selection with no revision (older Controller) always reloads`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    await select(g);
    await select(g);
    await flush();
    assert.equal(searches(g), 2);
  }));

  test(`KDG-5 ${name}: dashboard refresh waits for the Controller's new revision`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    await select(g, revised('n:0'));
    await flush();
    mock.timers.tick(REFRESH_ANSWERED_MS); await flush(); // the refresh is not an answered one
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    assert.equal(searches(g), 1, 'no reload of its own');
    assert.equal(g.emitted(FILTER_REQUEST).length, 1, 'no new filter.request');
    mock.timers.tick(2999); await flush();
    await select(g, revised('n:1'));
    await flush();
    assert.equal(searches(g), 2, 'the new revision reloads once');
    mock.timers.tick(10000); await flush();
    assert.equal(searches(g), 2, 'the fallback was cancelled');
  }));

  test(`KDG-5 ${name}: dashboard refresh falls back to one reload after 3 s with no answer`,
    withTimers(async () => {
      const g = await startGadget(name, { jira: jiraFor('A', 2) });
      await select(g, revised('n:0'));
      await flush();
      const settled = g.root.textContent;
      mock.timers.tick(REFRESH_ANSWERED_MS); await flush();
      await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
      await flush();
      mock.timers.tick(2999); await flush();
      await select(g, revised('n:0'));
      await flush();
      assert.equal(searches(g), 1, 'a repeat of the old revision is not the answer');
      mock.timers.tick(1); await flush();
      assert.equal(searches(g), 2, 'reloads once at 3 s');
      mock.timers.tick(10000); await flush();
      assert.equal(searches(g), 2, 'only once');
      assert.equal(g.emitted(FILTER_REQUEST).length, 1);
      assert.equal(g.root.textContent, settled);
    }));

  test(`KDG-5 ${name}: its own refresh reloads at once with a revisioned selection`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraFor('A', 2) });
    await select(g, revised('n:0'));
    await flush();
    await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
    await flush();
    assert.equal(searches(g), 2);
    assert.equal(g.emitted(FILTER_REQUEST).length, 1);
    mock.timers.tick(10000); await flush();
    assert.equal(searches(g), 2, 'no fallback for its own refresh');
  }));

  // The Controller's new revision can reach a gadget before the gadget's own dashboard refresh.
  test(`KDG-5 ${name}: a new revision that arrives before the dashboard refresh reloads once`,
    withTimers(async () => {
      const g = await startGadget(name, { jira: jiraFor('A', 2) });
      await select(g, revised('n:0'));
      await flush();
      mock.timers.tick(60000); await flush();
      await select(g, revised('n:1'));
      await flush();
      assert.equal(searches(g), 2, 'the new revision reloads');
      mock.timers.tick(REFRESH_ANSWERED_MS - 1); await flush();
      await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
      await flush();
      mock.timers.tick(10000); await flush();
      assert.equal(searches(g), 2, 'the late refresh is already answered: no second reload, no fallback');
      assert.equal(g.emitted(FILTER_REQUEST).length, 1);
    }));
}

for (const name of WALKING) {
  test(`KDG-5 ${name}: a superseded search walk requests no further page`, withTimers(async () => {
    const g = await startGadget(name);
    await select(g, revised('n:0', { jql: 'project = OLD' }));
    await flush();
    const old = g.pending('search/jql')[0];
    await select(g, revised('n:1', { name: 'New', jql: 'project = NEW' }));
    await flush();
    old.resolve(ok({ issues: makeIssues('OLD', 3), nextPageToken: 'old-2', isLast: false }));
    await flush();
    const oldRequests = g.requests.filter(r => r.path.includes('search/jql') && r.body?.jql === 'project = OLD');
    assert.equal(oldRequests.length, 1, 'page 2 of the old walk is never requested');
    assert.equal(g.pending('bulkfetch').length, 0);
    await answerAll(g, jiraFor('NEW', 2), ['project = NEW']);
    assert.ok(shows(g, 'New'));
    assert.ok(!/Could not|superseded/i.test(g.root.textContent), g.root.textContent);
  }));
}

test('KDG-5 burndown: a superseded walk stops before the next changelog page', withTimers(async () => {
  const g = await startGadget('burndown');
  await select(g, revised('n:0', { jql: 'project = OLD' }));
  await flush();
  g.pending('search/jql')[0].resolve(ok({ issues: makeIssues('OLD', 2), isLast: true }));
  await flush();
  const batch = g.pending('bulkfetch')[0];
  assert.ok(batch, 'the changelog fetch started');
  await select(g, revised('n:1', { name: 'New', jql: 'project = NEW' }));
  await flush();
  batch.resolve(ok({ issueChangeLogs: [], nextPageToken: 'cl-2' }));
  await flush();
  assert.equal(g.requests.filter(r => r.body?.nextPageToken === 'cl-2').length, 0);
  await answerAll(g, jiraFor('NEW', 2), ['project = NEW']);
  assert.match(g.find('burndown-summary').textContent, /2 issues in the current JQL scope$/);
}));

test('KDG-5 progress-bar: own refresh and the fallback also update the time half', withTimers(async () => {
  const g = await startGadget('progress-bar', { jira: jiraFor('A', 2) });
  await select(g, revised('n:0'));
  await flush();
  const percent = () => g.findAll('progress-percent')[0].textContent;
  const day = 24 * 3600 * 1000;
  const start = percent();
  // Move the clock without running the minute timer, so only a refresh can update the time half.
  // (Going forward makes that timer overdue, so no timer is ticked until the clock goes back.)
  mock.timers.setTime(Date.now() + 30 * day);
  await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
  await flush();
  const afterOwn = percent();
  assert.notEqual(afterOwn, start, 'own refresh updated the time half');
  assert.equal(searches(g), 2);
  // Back in time this time, so the overdue minute timer does not run on the tick below.
  mock.timers.setTime(Date.now() - 60 * day);
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await flush();
  assert.equal(percent(), afterOwn, 'waiting: nothing changes yet');
  mock.timers.tick(3000); await flush();
  assert.notEqual(percent(), afterOwn, 'the fallback updated the time half');
  assert.equal(searches(g), 3, 'and reloaded the work half');
}));

test('KDG-5 dates: its own refresh re-renders without asking the Controller', withTimers(async () => {
  const g = await startGadget('dates');
  await select(g, revised('n:0', { startDate: '2026-02-03' }));
  await flush();
  await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
  await flush();
  assert.equal(g.emitted(FILTER_REQUEST).length, 1, 'only the request sent on load');
  assert.equal(g.findAll('date-card-value')[0].textContent, '3 Feb 2026');
  mock.timers.tick(REFRESH_ANSWERED_MS); await flush();
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await flush();
  assert.equal(g.emitted(FILTER_REQUEST).length, 1, 'a dashboard refresh waits for the new revision');
  await select(g, revised('n:1', { name: 'Next', startDate: '2026-04-05' }));
  await flush();
  assert.equal(g.find('dates-filter-name').textContent, 'Next');
  assert.equal(g.findAll('date-card-value')[0].textContent, '5 Apr 2026');
  mock.timers.tick(10000); await flush();
  assert.equal(g.find('dates-filter-name').textContent, 'Next');
}));

test('KDG-5 dates: own refresh before any selection still asks the Controller', withTimers(async () => {
  const g = await startGadget('dates');
  await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
  await flush();
  assert.equal(g.emitted(FILTER_REQUEST).length, 2);
}));

// One dashboard: the Controller and every gadget on one bus, loaded Controller first. Counts the
// Jira search requests (search/jql) each step sends across all gadgets. Before KDG-5 these were
// load 41, dashboard refresh 24, click 8 and Simple Dates' own refresh 8.
test('KDG-5 dashboard: Jira searches for load, dashboard refresh, a click and a Simple Dates refresh',
  withTimers(async () => {
    const bus = createBus();
    const controller = await startGadget('controller', { bus, configuration: {
      filters: [{ name: 'Filter A', jql: 'project = A', startDate: '2026-01-01', endDate: '2026-12-31' },
        { name: 'Filter B', jql: 'project = B', startDate: '2026-01-01', endDate: '2026-12-31' }],
      statuses: selection().statuses,
    } });
    const gadgets = [];
    for (const name of GADGETS) gadgets.push(await startGadget(name, { bus, jira: jiraFor('A', 2) }));
    await flush();
    const total = () => gadgets.reduce((sum, g) => sum + searches(g), 0);
    const counts = {};
    let last = 0;
    const step = label => { counts[label] = total() - last; last = total(); };
    step('load');
    await bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    mock.timers.tick(3000); await flush(); // past the fallback
    step('dashboard refresh');
    controller.findAll('controller-filter-button')[1].click();
    await flush();
    step('click');
    const dates = gadgets[GADGETS.indexOf('dates')];
    await bus.send(GADGET_REFRESH, { gadgetId: dates.gadgetId });
    await flush();
    mock.timers.tick(3000); await flush();
    step('Simple Dates refresh');
    console.log(`KDG-5 dashboard search requests: ${JSON.stringify(counts)}`);
    for (const g of gadgets) {
      assert.ok(shows(g, 'Filter B'), `${g.name} shows the clicked filter`);
      assert.ok(!shows(g, ADD_CONTROLLER), g.name);
    }
    assert.deepEqual(counts, { load: FETCHING.length, 'dashboard refresh': FETCHING.length,
      click: FETCHING.length, 'Simple Dates refresh': 0 }, 'one search per data gadget, none for Simple Dates');
    for (const g of gadgets.filter(g => g.name !== 'dates')) {
      assert.equal(searches(g), 3, `${g.name}: load, dashboard refresh and click`);
    }
  }));
