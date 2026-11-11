// KDG-24: shown statuses set once in the Controller, Done hidden by default. UI side: the
// Controller's Show boxes, and how each in-scope gadget hides statuses, shows the "Hiding:" note
// and narrows its count links and Jira requests. Run through test/helpers/gadget-harness.mjs.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, statusesClause } from '../static/drilldown.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';
import { statusVisibility } from '../static/status-visibility.mjs';
import { createBus, fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

// ---------------------------------------------------------------------------------------------
// Controller Edit

const FILTERS = [{ name: 'Alpha', jql: 'project = A', startDate: null, endDate: null }];
const JIRA_STATUSES = [
  { name: 'To Do', statusCategory: { key: 'new' } },
  { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  { name: 'Done', statusCategory: { key: 'done' } },
  // Two Jira statuses called Closed: only one is Done, so the name is not treated as Done.
  { name: 'Closed', statusCategory: { key: 'done' } },
  { name: 'Closed', statusCategory: { key: 'indeterminate' } },
  { name: 'Released', statusCategory: { key: 'done' } },
];
const statusJira = list => path => (path === '/rest/api/3/status' ? list : undefined);

async function startEdit(statuses, jiraStatuses = ok(JIRA_STATUSES)) {
  return startGadget('controller', { entryPoint: 'edit', configuration: { filters: FILTERS, statuses },
    jira: statusJira(jiraStatuses) });
}
const statusRows = c => c.findAll('status-row');
const box = row => row.find('status-show-input');
const marker = row => row.find('status-done-marker');
const change = el => el.dispatchEvent({ type: 'change' });
const toggle = (row, checked) => { box(row).checked = checked; change(box(row)); };
const choose = (row, key) => { row.find('status-select').value = key; change(row.find('status-select')); };
async function submit(c) {
  c.panel().dispatchEvent({ type: 'submit', preventDefault() {} });
  await flush();
  assert.equal(c.find('error').textContent, '');
  return c.submitted.at(-1).statuses;
}

test('KDG-24 Controller: Show box defaults, Done marker, labels and help text', withTimers(async () => {
  const c = await startEdit([
    { name: 'To Do', weight: 1, color: '#0c66e4' },
    { name: 'Done', weight: 0, color: '#22a06b' },
    { name: 'Closed', weight: 0, color: '#22a06b' },
    { name: 'In Progress', weight: 0.5, color: '#7f5fcb', show: false },
    { name: 'Released', weight: 0, color: '#22a06b', show: true },
    { name: 'Legacy', weight: 1, color: '#e2b203' },
  ]);
  const rows = statusRows(c);
  assert.deepEqual(rows.map(row => box(row).checked), [true, false, true, false, true, true],
    'non-Done ticked, unflagged Done unticked, mixed-category name ticked, saved flags win, manual ticked');
  assert.deepEqual(rows.map(row => marker(row)?.hidden ?? 'none'), [true, false, true, true, false, 'none'],
    'Done marker only for all-Done names; none on a manual row');
  assert.equal(marker(rows[1]).textContent, 'Done');
  assert.ok(marker(rows[1]).classList.contains('issue-status-lozenge') && marker(rows[1]).classList.contains('is-done'));
  assert.deepEqual(rows.map(row => box(row).getAttribute('aria-label')), ['Show To Do in gadgets',
    'Show Done in gadgets', 'Show Closed in gadgets', 'Show In Progress in gadgets', 'Show Released in gadgets',
    'Show Legacy in gadgets']);
  assert.equal(rows[0].find('status-show').textContent, 'Show');
  assert.deepEqual(rows[0].children.map(child => child.className), ['field-label', 'field-label', 'field-label',
    'status-show', 'row-actions'], 'Show sits between Pie colour and the actions');
  assert.equal(c.panel().findAll('muted')[1].textContent, 'Choose Jira statuses or enter a missing status ' +
    'name exactly as a gadget shows it. Statuses with the same name are counted together. Untick Show to ' +
    'hide a status from the counter, list, charts, and user gadgets for everyone. Done statuses start ' +
    'unticked, and Done statuses not listed here are also hidden. Weights are used by the progress, ' +
    'burndown, and leaderboard gadgets. Colours are used by the pie chart. The progress and burndown ' +
    'gadgets always include every status.');
  // Legacy is not in Jira's list, so it is a manual row: ticked, so no `show` is written.
  assert.deepEqual((await submit(c)).map(status => [status.name, status.show]), [
    ['To Do', true], ['Done', false], ['Closed', true], ['In Progress', false], ['Released', true],
    ['Legacy', undefined],
  ]);
  assert.equal(Object.hasOwn(c.submitted[0].statuses[5], 'show'), false);
}));

test('KDG-24 Controller: an untouched manual row writes show only when unticked; a touched one always', withTimers(async () => {
  const c = await startEdit([{ name: 'To Do', weight: 1, color: '#0c66e4' }]);
  c.panel().querySelectorAll('button').find(b => b.textContent === 'Add missing status').click();
  const manual = statusRows(c)[1];
  assert.equal(box(manual).checked, true, 'manual rows start ticked');
  assert.equal(box(manual).getAttribute('aria-label'), 'Show this status in gadgets', 'empty name');
  manual.find('status-name-input').value = 'Blocked';
  manual.find('status-name-input').dispatchEvent({ type: 'input' });
  assert.equal(box(manual).getAttribute('aria-label'), 'Show Blocked in gadgets');
  manual.find('status-weight').value = '1';
  assert.equal(Object.hasOwn((await submit(c))[1], 'show'), false, 'untouched and ticked: not written');
  toggle(manual, true); // touched: written (D2)
  assert.equal((await submit(c))[1].show, true);
  toggle(manual, false);
  assert.deepEqual((await submit(c))[1], { name: 'Blocked', weight: 1, color: manual.find('status-color').value,
    show: false });
}));

test('KDG-24 Controller: with unknown categories, untouched rows write no show and touched rows do',
  withTimers(async () => {
    const saved = [{ name: 'To Do', weight: 1, color: '#0c66e4' }, { name: 'Done', weight: 0, color: '#22a06b' },
      { name: 'Released', weight: 0, color: '#22a06b', show: true }];
    // Statuses failed to load: every saved row is a manual row; the saved show: true is kept.
    const failed = await startEdit(saved, fail(500));
    assert.deepEqual(statusRows(failed).map(row => [Boolean(row.find('status-name-input')), box(row).checked]),
      [[true, true], [true, true], [true, true]]);
    assert.deepEqual((await submit(failed)).map(status => status.show), [undefined, undefined, true]);
    // Statuses loaded without categories: select rows with no marker and no show written...
    const unknown = await startEdit(saved, ok([{ name: 'To Do' }, { name: 'Done' }, { name: 'Released' }]));
    const rows = statusRows(unknown);
    assert.deepEqual(rows.map(row => [box(row).checked, marker(row).hidden]), [[true, true], [true, true], [true, true]]);
    assert.deepEqual((await submit(unknown)).map(status => status.show), [undefined, undefined, true]);
    // ...until the user touches a box.
    toggle(rows[1], false);
    toggle(rows[0], true);
    assert.deepEqual((await submit(unknown)).map(status => status.show), [true, false, true]);
  }));

test('KDG-24 Controller: changing the status resets an untouched box, not a touched one', withTimers(async () => {
  const c = await startEdit([{ name: 'To Do', weight: 1, color: '#0c66e4' },
    { name: 'Released', weight: 0, color: '#22a06b', show: true }]);
  const [row, saved] = statusRows(c);
  choose(row, 'done');
  assert.deepEqual([box(row).checked, marker(row).hidden, box(row).getAttribute('aria-label')],
    [false, false, 'Show Done in gadgets']);
  choose(row, 'in progress');
  assert.deepEqual([box(row).checked, marker(row).hidden], [true, true]);
  // A saved flag is for the saved status: choosing another status uses that one's default.
  choose(saved, 'done');
  assert.equal(box(saved).checked, false);
  // Back on the saved status (untouched), the saved flag applies again (D3).
  choose(saved, 'released');
  assert.equal(box(saved).checked, true);
  choose(saved, 'done');
  toggle(row, false);
  choose(row, 'to do');
  assert.equal(box(row).checked, false, 'touched: left alone');
  choose(row, 'done');
  assert.deepEqual([box(row).checked, marker(row).hidden], [false, false]);
  toggle(row, true);
  choose(row, 'released');
  assert.equal(box(row).checked, true);
  assert.deepEqual((await submit(c)).map(status => [status.name, status.show]), [['Released', true], ['Done', false]]);
}));

test('KDG-24 Controller: the saved flags reach the gadgets as hiddenStatuses and shownStatuses',
  withTimers(async () => {
    const c = await startGadget('controller', { configuration: { filters: FILTERS, statuses: [
      { name: 'To Do', weight: 1, show: true }, { name: 'Closed', weight: 0, show: false },
      { name: 'Done', weight: 0 }] } });
    const { payload } = c.emitted(FILTER_SELECTED)[0];
    assert.deepEqual([payload.hiddenStatuses, payload.shownStatuses], [['Closed'], ['To Do']]);
    assert.deepEqual(payload.statuses.map(status => status.show), [true, false, undefined]);
  }));

// ---------------------------------------------------------------------------------------------
// Gadgets

// Listed: To Do (shown), In Progress (no flag), Closed (hidden; not a Done status), Done (no flag:
// hidden by its category). Released is not listed and is a Done status.
const STATUSES = [
  { name: 'To Do', weight: 1, color: '#0c66e4', show: true },
  { name: 'In Progress', weight: 0.5, color: '#7f5fcb' },
  { name: 'Closed', weight: 0, color: '#e2b203', show: false },
  { name: 'Done', weight: 0, color: '#22a06b' },
];
const SELECTED = { statuses: STATUSES, hiddenStatuses: ['Closed'], shownStatuses: ['To Do'] };
const CATEGORY = { 'To Do': ['1', 'new'], 'In Progress': ['3', 'indeterminate'], Closed: ['6', 'indeterminate'],
  Done: ['10', 'done'], Released: ['11', 'done'] };
const NARROWED = '(project = A) AND (status not in ("Closed")) AND (statusCategory != Done OR status in ("To Do"))';

function issue(n, statusName, user = 'u1') {
  const [id, key] = CATEGORY[statusName];
  return { id: String(n), key: `A-${n}`, fields: {
    summary: `Issue ${n}`, status: { id, name: statusName, statusCategory: { key } },
    assignee: { accountId: user, displayName: `User ${user}` },
    created: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z',
    timetracking: { remainingEstimateSeconds: 3600 },
  } };
}
const MIXED = [issue(1, 'To Do'), issue(2, 'To Do', 'u2'), issue(3, 'In Progress'), issue(4, 'Closed'),
  issue(5, 'Done'), issue(6, 'Released')];

function jiraWith(issues) {
  return (path, body) => {
    if (path.includes('approximate-count')) return ok({ count: issues.length });
    if (path.includes('search/jql')) return ok({ issues, isLast: true });
    if (path.includes('changelog/bulkfetch')) {
      return ok({ issueChangeLogs: body.issueIdsOrKeys.map(issueId => ({ issueId, changeHistories: [] })) });
    }
    return undefined;
  };
}

async function show(name, issues, overrides = SELECTED) {
  const g = await startGadget(name, { jira: jiraWith(issues) });
  await g.bus.send(FILTER_SELECTED, selection(overrides));
  await flush();
  return g;
}
const note = g => g.find('status-hidden-note');
const links = g => g.findAll('issue-count-link');
const link = (g, label) => {
  const found = links(g).find(button => button.getAttribute('aria-label') === label);
  assert.ok(found, `no link "${label}" in ${JSON.stringify(links(g).map(b => b.getAttribute('aria-label')))}`);
  return found;
};
async function opens(g, label) {
  link(g, label).click();
  await flush();
  return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
}
// The narrowed count-link JQL for the visible issues: their status IDs, in display order.
const idsJql = (...names) => narrowJql('project = A',
  [statusesClause(names.map(name => ({ name, ids: [CATEGORY[name][0]] })))]);

function assertPlainNote(g, text) {
  const element = note(g);
  assert.equal(element.hidden, false);
  assert.equal(element.textContent, text);
  assert.ok(element.classList.contains('muted'));
  assert.equal(element.getAttribute('role'), null, 'not a live region');
  assert.equal(element.getAttribute('aria-live'), null);
  assert.equal(element.getAttribute('title'), null, 'title only when truncated');
}

test('KDG-24 status-chart: hides show:false and unflagged Done statuses and narrows its links',
  withTimers(async () => {
    const g = await show('status-chart', MIXED);
    assert.deepEqual(g.findAll('status-bar-label').map(l => l.textContent), ['To Do', 'In Progress']);
    assert.deepEqual(g.findAll('status-bar-number').map(n => n.textContent), ['2', '1']);
    assertPlainNote(g, 'Hiding: Closed, Done');
    const panel = g.panel().children.map(child => child.className);
    assert.deepEqual(panel.slice(1, 4), ['chart-filter-name', 'muted status-hidden-note', 'status-bars']);
    assert.equal(g.find('status').textContent, '3 of 6 issues in shown statuses');
    assert.equal(await opens(g, 'Open 3 issues in shown statuses'), idsJql('To Do', 'In Progress'));
    assert.equal(await opens(g, 'Open all 6 matching issues'), 'project = A');
  }));

test('KDG-24 status-pie: hides show:false and unflagged Done statuses and narrows its links',
  withTimers(async () => {
    const g = await show('status-pie', MIXED);
    assert.deepEqual(g.findAll('pie-legend-name').map(l => l.textContent), ['To Do', 'In Progress']);
    assertPlainNote(g, 'Hiding: Closed, Done');
    assert.equal(g.find('status').textContent, '3 of 6 matching issues in shown statuses');
    assert.equal(g.find('pie-center').getAttribute('aria-label'), 'Open 3 issues in shown statuses');
    assert.equal(await opens(g, 'Open 3 issues in shown statuses'), idsJql('To Do', 'In Progress'));
    assert.match(g.find('pie-legend-value').textContent, /^2 · 66\.7%$/);
  }));

test('KDG-24 status-pie: "matching issues" alone when nothing matching is hidden', withTimers(async () => {
  const g = await show('status-pie', [issue(1, 'To Do'), issue(2, 'In Progress')]);
  assert.equal(g.find('status').textContent, '2 matching issues');
  assertPlainNote(g, 'Hiding: Closed');
}));

test('KDG-24 charts: a listed, unflagged, zero-count status keeps its zero bar and legend row',
  withTimers(async () => {
    // In Progress has no Show flag and no issues, so its category is unknown: it counts as shown.
    const issues = [issue(1, 'To Do'), issue(2, 'Done')];
    const chart = await show('status-chart', issues);
    assert.deepEqual(chart.findAll('status-bar-label').map(l => l.textContent), ['To Do', 'In Progress']);
    assert.deepEqual(chart.findAll('status-bar-number').map(n => n.textContent), ['1', '0']);
    assert.equal(chart.find('status').textContent, '1 of 2 issues in shown statuses');
    const pie = await show('status-pie', issues);
    assert.deepEqual(pie.findAll('pie-legend-name').map(l => l.textContent), ['To Do', 'In Progress']);
    assert.match(pie.findAll('pie-legend-value')[1].textContent, /^0 · 0%$/);
    // An older config with no flags at all: zero-count statuses keep their bars too.
    const old = await show('status-chart', [issue(1, 'To Do')], { statuses: STATUSES.map(({ show, ...s }) => s) });
    assert.deepEqual(old.findAll('status-bar-number').map(n => n.textContent), ['1', '0', '0', '0']);
  }));

for (const name of ['user-list', 'user-leaderboard']) {
  test(`KDG-24 ${name}: hides show:false, unflagged and unlisted Done statuses`, withTimers(async () => {
    const g = await show(name, MIXED);
    // Closed is listed first; Done and Released are hidden by category and follow A-Z.
    assertPlainNote(g, 'Hiding: Closed, Done, Released');
    const panel = g.panel().children.map(child => child.className);
    assert.deepEqual(panel.slice(1, 4), ['chart-filter-name', 'muted status-hidden-note', 'field-label user-metric-label']);
    assert.equal(g.find('status').textContent,
      '3 issues in shown statuses across 2 assignees, including Unassigned where applicable');
    assert.ok(!g.root.textContent.includes('Add missing status'),
      'the unweighted Released status is hidden, so it is not a missing weight');
    assert.equal(await opens(g, 'Open 3 issues in shown statuses'), idsJql('To Do', 'In Progress'));
    if (name === 'user-list') {
      const headings = g.findAll('table-sort-button').map(b => b.textContent.replace(/ [↑↓]$/, ''));
      assert.deepEqual(headings, ['Assignee', 'Total tickets', 'To Do', 'In Progress']);
    } else {
      assert.deepEqual(g.findAll('leaderboard-name').map(n => n.textContent), ['User u1', 'User u2'],
        'u1: To Do 1 + In Progress 0.5 = 1.5; u2: To Do 1');
    }
  }));

  test(`KDG-24 ${name}: drops "in shown statuses" when nothing loaded is hidden`, withTimers(async () => {
    const g = await show(name, [issue(1, 'To Do'), issue(2, 'In Progress')]);
    assert.equal(g.find('status').textContent, '2 issues across 1 assignees, including Unassigned where applicable');
    assert.equal(await opens(g, 'Open 2 issues'), 'project = A');
    assertPlainNote(g, 'Hiding: Closed');
  }));
}

test('KDG-24 counter: both counts and the link use the narrowed JQL', withTimers(async () => {
  const g = await startGadget('counter');
  await g.bus.send(FILTER_SELECTED, selection({ ...SELECTED, jql: 'project = A ORDER BY rank' }));
  await flush();
  assertPlainNote(g, 'Hiding: Closed and unlisted Done statuses');
  const panel = g.panel().children.map(child => child.className);
  assert.deepEqual(panel.slice(2, 5), ['filter-name', 'muted status-hidden-note', 'status']);
  const [approx] = g.pending('approximate-count');
  const [exact] = g.pending('search/jql');
  assert.deepEqual(approx.body, { jql: NARROWED });
  assert.equal(exact.body.jql, `${NARROWED} ORDER BY rank`);
  approx.resolve(ok({ count: 4 }));
  await flush();
  assert.equal(await opens(g, 'Open about 4 matching issues in shown statuses in Jira'), `${NARROWED} ORDER BY rank`);
  exact.resolve(ok({ issues: MIXED.slice(0, 3), isLast: true }));
  await flush();
  assert.equal(await opens(g, 'Open 3 matching issues in shown statuses in Jira'), `${NARROWED} ORDER BY rank`);
  assert.equal(g.find('count').textContent, '3');
}));

test('KDG-24 counter: an older payload still hides Done statuses', withTimers(async () => {
  const g = await startGadget('counter');
  await g.bus.send(FILTER_SELECTED, selection());
  await flush();
  assert.equal(g.pending('search/jql')[0].body.jql, '(project = A) AND (statusCategory != Done)');
  assertPlainNote(g, 'Hiding: unlisted Done statuses');
}));

test('KDG-24 counter: zero shown issues', withTimers(async () => {
  const g = await show('counter', []);
  assert.equal(g.find('count').textContent, '0');
  assert.equal(g.find('status').textContent, 'No issues in shown statuses.');
  assert.equal(await opens(g, 'Open 0 matching issues in shown statuses in Jira'), NARROWED);
}));

test('KDG-24 issue-list: pages, sorting and the link use the narrowed JQL', withTimers(async () => {
  const g = await startGadget('issue-list');
  await g.bus.send(FILTER_SELECTED, selection({ ...SELECTED, jql: 'project = A ORDER BY rank' }));
  await flush();
  assertPlainNote(g, 'Hiding: Closed and unlisted Done statuses');
  const panel = g.panel().children.map(child => child.className);
  assert.deepEqual(panel.slice(1, 4), ['chart-filter-name', 'muted status-hidden-note', 'dashboard-table-scroll']);
  const [first] = g.pending('search/jql');
  assert.equal(first.body.jql, `${NARROWED} ORDER BY rank`);
  first.resolve(ok({ issues: MIXED.slice(0, 2), nextPageToken: 'p2', isLast: false }));
  await flush();
  g.find('issue-list-more').click();
  await flush();
  const [second] = g.pending('search/jql');
  assert.deepEqual([second.body.jql, second.body.nextPageToken], [`${NARROWED} ORDER BY rank`, 'p2']);
  second.resolve(ok({ issues: MIXED.slice(2, 3), isLast: true }));
  await flush();
  assert.equal(await opens(g, 'Open the full Jira list for shown statuses; 3 issues loaded here'),
    `${NARROWED} ORDER BY rank`);
  g.findAll('table-sort-button')[0].click(); // Key ascending
  await flush();
  assert.equal(g.pending('search/jql')[0].body.jql, `${NARROWED} ORDER BY key ASC`);
}));

test('KDG-24 issue-list: no shown issues', withTimers(async () => {
  const g = await show('issue-list', []);
  assert.equal(g.find('status').textContent, 'No issues in shown statuses.');
}));

// ---- countIssuesByStatus with a visibility (review D1) ----

test('KDG-24 countIssuesByStatus: a visibility leaves out hidden issues per issue; total and categories stay full',
  async () => {
    const issues = [issue(1, 'To Do'), issue(2, 'Closed'), issue(3, 'Done'), issue(4, 'Released'),
      { id: '7', key: 'A-7', fields: { status: { id: '12', name: 'To Do', statusCategory: { key: 'done' } } } }];
    const requestJira = async () => ok({ issues, isLast: true });
    const visibility = statusVisibility({ hiddenStatuses: ['Closed'], shownStatuses: [] });
    const result = await countIssuesByStatus(requestJira, 'project = A', STATUSES, { visibility });
    assert.deepEqual(result.counts, { 'to do': 1, 'in progress': 0, closed: 0, done: 0 });
    assert.equal(result.total, 5);
    assert.deepEqual(result.unmapped, [], 'hidden unlisted Released is not unmapped');
    assert.deepEqual(result.statusIds, { 'to do': ['1'] }, 'IDs only from shown issues');
    assert.deepEqual(result.categories, { 'to do': 'new', closed: 'indeterminate', done: 'done', released: 'done' });
    const all = await countIssuesByStatus(requestJira, 'project = A', STATUSES);
    assert.deepEqual([all.counts['to do'], all.counts.closed, all.counts.done], [2, 1, 1], 'unchanged without one');
  });

// ---- Jira 400 (review R1) ----

const STATUS_NAME_ERROR = "Jira didn't accept a status name set in the Controller. " +
  "Check the status names in the Controller's Edit settings.";
const rejecting = path => (path.includes('approximate-count') || path.includes('search/jql') ? fail(400) : undefined);

for (const [name, plain] of [['counter', 'The selected JQL is invalid or cannot be searched.'],
  ['issue-list', 'The selected JQL or column selection is invalid.']]) {
  test(`KDG-24 ${name}: a 400 with explicit Controller names says a status name was not accepted`,
    withTimers(async () => {
      const g = await startGadget(name, { jira: rejecting });
      await g.bus.send(FILTER_SELECTED, selection(SELECTED));
      await flush();
      assert.equal(g.find('status').textContent, STATUS_NAME_ERROR);
    }));

  test(`KDG-24 ${name}: a 400 with no explicit names keeps the existing message`, withTimers(async () => {
    const g = await startGadget(name, { jira: rejecting });
    await g.bus.send(FILTER_SELECTED, selection());
    await flush();
    assert.equal(g.pending('search/jql').length, 0);
    assert.equal(g.find('status').textContent, plain);
  }));
}

test('KDG-24 counter: other failures with explicit names keep their own message', withTimers(async () => {
  const g = await startGadget('counter', { jira: path => (path.includes('search/jql') ? fail(403) : undefined) });
  await g.bus.send(FILTER_SELECTED, selection(SELECTED));
  await flush();
  assert.equal(g.find('status').textContent, 'You cannot view issues for this filter.');
}));

test('KDG-24 issue-list: a 400 on a sorted load keeps the existing message (the sort field may be the cause)',
  withTimers(async () => {
    const g = await startGadget('issue-list');
    await g.bus.send(FILTER_SELECTED, selection(SELECTED));
    await flush();
    g.pending('search/jql')[0].resolve(ok({ issues: MIXED.slice(0, 1), isLast: true }));
    await flush();
    g.findAll('table-sort-button')[1].click();
    await flush();
    g.pending('search/jql')[0].resolve(fail(400));
    await flush();
    assert.equal(g.find('status').textContent, 'The selected JQL or column selection is invalid.');
  }));

// ---- the note ----

const MANY = { statuses: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, weight: 1, color: '#0c66e4' })),
  hiddenStatuses: ['A', 'B', 'C', 'D'], shownStatuses: [] };

function assertTruncated(g, text, fullList) {
  const element = note(g);
  assert.equal(element.hidden, false);
  assert.equal(element.getAttribute('title'), fullList);
  const [visible, full] = element.children;
  assert.equal(visible.getAttribute('aria-hidden'), 'true');
  assert.equal(visible.textContent, text);
  assert.ok(full.classList.contains('visually-hidden'));
  assert.equal(full.textContent, `Hiding issues in these statuses: ${fullList}`);
}

for (const name of ['status-chart', 'status-pie', 'user-list', 'user-leaderboard']) {
  test(`KDG-24 ${name}: a long note is truncated with the full list for screen readers`, withTimers(async () => {
    const g = await show(name, [], MANY);
    assertTruncated(g, 'Hiding: A, B, C and 1 more', 'A, B, C, D');
  }));

  test(`KDG-24 ${name}: no note when nothing is hidden, and none before a selection`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraWith([issue(1, 'To Do')]) });
    assert.equal(note(g).hidden, true, 'before a selection');
    await g.bus.send(FILTER_SELECTED, selection());
    await flush();
    assert.equal(note(g).hidden, true);
    assert.equal(note(g).textContent, '');
    await g.bus.send(FILTER_SELECTED, selection({ ...MANY, jql: null }));
    await flush();
    assert.equal(note(g).hidden, true, 'no filter, no note');
  }));
}

for (const name of ['counter', 'issue-list']) {
  test(`KDG-24 ${name}: a long note ends with the unlisted Done clause`, withTimers(async () => {
    const g = await show(name, [], MANY);
    assertTruncated(g, 'Hiding: A, B, C, 1 more and unlisted Done statuses', 'A, B, C, D and unlisted Done statuses');
  }));
}

// ---- empty states ----

for (const name of ['status-chart', 'status-pie']) {
  test(`KDG-24 ${name}: every listed status hidden`, withTimers(async () => {
    const g = await show(name, MIXED, { ...SELECTED, hiddenStatuses: STATUSES.map(s => s.name), shownStatuses: [] });
    assert.equal(g.find('status').textContent,
      'All Controller statuses are hidden. Tick Show for a status in the Controller.');
    assert.equal(g.findAll('status-bar-row').length + g.findAll('pie-legend-row').length, 0);
  }));
}

for (const name of ['status-chart', 'status-pie', 'user-list', 'user-leaderboard']) {
  test(`KDG-24 ${name}: every matching issue hidden, and an empty JQL result`, withTimers(async () => {
    const g = await show(name, [issue(1, 'Done'), issue(2, 'Closed')]);
    assert.equal(g.find('status').textContent, 'No issues are in shown statuses (2 matching issues).');
    assert.equal(await opens(g, 'Open all 2 matching issues'), 'project = A');
    const empty = await show(name, []);
    assert.equal(empty.find('status').textContent, 'No matching issues.');
  }));
}

// ---- one dashboard ----

const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;

test('KDG-24 dashboard: a new Controller config reloads each gadget once; weighted gadgets are unchanged',
  withTimers(async () => {
    const bus = createBus();
    const statuses = STATUSES.map(({ show, ...status }) => status);
    const config = list => ({ filters: [{ name: 'Filter A', jql: 'project = A', startDate: '2026-01-01',
      endDate: '2026-12-31' }], statuses: list });
    let controller = await startGadget('controller', { bus, configuration: config(statuses) });
    const issues = MIXED.slice(0, 5);
    const names = ['status-chart', 'status-pie', 'progress-bar', 'burndown', 'counter', 'issue-list',
      'user-list', 'user-leaderboard'];
    const gadgets = {};
    // One at a time: the harness evaluates each gadget against its own fake globals.
    for (const name of names) gadgets[name] = await startGadget(name, { bus, jira: jiraWith(issues) });
    await flush();
    const weighted = () => [...gadgets['progress-bar'].findAll('progress-percent').map(p => p.textContent),
      gadgets.burndown.find('burndown-summary').textContent];
    const before = { searches: names.map(name => searches(gadgets[name])), weighted: weighted() };
    assert.deepEqual(gadgets['status-chart'].findAll('status-bar-label').map(l => l.textContent),
      ['To Do', 'In Progress', 'Closed'], 'older config: only Done is hidden, by its category');
    assert.ok(before.weighted.every(text => text && text !== '—'), JSON.stringify(before.weighted));

    // Saving the Controller's Edit reloads it with the new configuration.
    bus.subscribers.splice(0, bus.subscribers.length,
      ...bus.subscribers.filter(s => s.owner !== controller.gadgetId));
    controller = await startGadget('controller', { bus, configuration: config(STATUSES) });
    await flush();
    mock.timers.tick(10000); await flush();

    assert.deepEqual(names.map(name => searches(gadgets[name])), before.searches.map(n => n + 1),
      'each gadget searched once more');
    assert.deepEqual(weighted(), before.weighted, 'Progress Bar and Burndown numbers unchanged');
    assert.deepEqual(gadgets['status-chart'].findAll('status-bar-label').map(l => l.textContent),
      ['To Do', 'In Progress']);
    assert.deepEqual(gadgets['status-pie'].findAll('pie-legend-name').map(l => l.textContent),
      ['To Do', 'In Progress']);
    for (const name of ['status-chart', 'status-pie', 'user-list', 'user-leaderboard']) {
      assert.equal(note(gadgets[name]).textContent, 'Hiding: Closed, Done', name);
    }
    for (const name of ['counter', 'issue-list']) {
      assert.equal(note(gadgets[name]).textContent, 'Hiding: Closed and unlisted Done statuses', name);
      assert.equal(gadgets[name].requests.filter(r => r.path.includes('search/jql')).at(-1).body.jql, NARROWED, name);
    }
    assert.equal(note(gadgets['progress-bar']), null, 'no note on the weighted gadgets');
    assert.equal(note(gadgets.burndown), null);
  }));
