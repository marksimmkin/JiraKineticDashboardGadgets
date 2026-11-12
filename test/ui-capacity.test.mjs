// KDG-22: the Capacity gadget (static/capacity/src.mjs), view and Edit modes, through
// test/helpers/gadget-harness.mjs. The clock is Monday 1 Jun 2026 (UTC) unless a test says otherwise.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, statusesClause } from '../static/drilldown.mjs';
import { fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn, now = '2026-06-01T12:00:00Z') {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(now) });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

// Listed: To Do (shown), In Progress (no flag, shown), Closed (hidden), Done (no flag: hidden).
const STATUSES = [
  { name: 'To Do', weight: 1, color: '#0c66e4', show: true },
  { name: 'In Progress', weight: 0.5, color: '#7f5fcb' },
  { name: 'Closed', weight: 0, color: '#e2b203', show: false },
  { name: 'Done', weight: 0, color: '#22a06b' },
];
// 1 Jun to 12 Jun 2026 has 10 working days left on 1 Jun.
const PAYLOAD = { statuses: STATUSES, hiddenStatuses: ['Closed'], shownStatuses: ['To Do'],
  startDate: '2026-01-01', endDate: '2026-06-12' };

const CATEGORY = { 'To Do': ['1', 'new'], 'In Progress': ['3', 'indeterminate'], Closed: ['5', 'done'],
  'In QA': ['7', 'indeterminate'] };
const DAY = 8 * 3600;
let counter = 0;
// `days` of remaining estimate (8-hour days), or null for no estimate.
function issue(user, days, statusName = 'To Do') {
  counter += 1;
  const [id, key] = CATEGORY[statusName];
  return { id: String(counter), key: `A-${counter}`, fields: {
    status: { id, name: statusName, statusCategory: { key } },
    assignee: user ? { accountId: user, displayName: { a: 'Alex Smith', s: 'Sam Lee', j: 'Jo Park', n: 'Nia Bell', b: 'Big Load' }[user] } : null,
    timetracking: days === null ? {} : { remainingEstimateSeconds: days * DAY },
  } };
}

// Alex 12 of 10 days (over), Sam 5 (normal), Jo 2 (under), Nia no estimates, Unassigned 3.
// Sam's Closed issue and Jo's unlisted In QA issue are left out.
const ISSUES = [
  issue('a', 8), issue('a', 4, 'In Progress'), issue('a', null),
  issue('s', 5), issue('s', 40, 'Closed'),
  issue('j', 2), issue('j', 30, 'In QA'),
  issue('n', null), issue('n', null),
  issue(null, 3), issue(null, null),
];
const shownJql = narrowJql('project = A', [statusesClause([{ name: 'To Do', ids: ['1'] },
  { name: 'In Progress', ids: ['3'] }])]);

const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);

async function show(issues = ISSUES, overrides = {}, options = {}) {
  const g = await startGadget('capacity', { jira: jiraWith(issues), ...options });
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, ...overrides }));
  await flush();
  return g;
}

const rowsOf = g => g.findAll('capacity-row');
const rowNamed = (g, name) => rowsOf(g).find(row => row.find('leaderboard-name').textContent === name);
const text = (row, className) => row.find(className)?.textContent;
const meta = row => row.find('capacity-meta').textContent;

async function opens(g, label) {
  const found = g.findAll('issue-count-link').find(button => button.getAttribute('aria-label') === label);
  assert.ok(found, `no link "${label}"`);
  found.click();
  await flush();
  return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
}

test('KDG-22 capacity: rows, copy, sort and colours for over, normal, under, no estimates and Unassigned',
  withTimers(async () => {
    const g = await show();
    assert.equal(g.find('eyebrow').textContent, 'Capacity by assignee');
    assert.equal(g.find('chart-filter-name').textContent, 'Filter A');
    assert.equal(g.find('capacity-range').textContent, '1\u00a0Jan\u00a02026 – 12\u00a0Jun\u00a02026 · 10 working days left');
    assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Closed, In QA');
    assert.deepEqual(rowsOf(g).map(row => text(row, 'leaderboard-name')),
      ['Alex Smith', 'Sam Lee', 'Jo Park', 'Nia Bell', 'Unassigned']);
    assert.deepEqual(rowsOf(g).map(row => row.querySelector('span.leaderboard-detail').textContent), [
      '12.0 of 10 days · 120%', '5.0 of 10 days · 50%', '2.0 of 10 days · 20%', '0.0 of 10 days',
      '3.0 days of work']);
    assert.deepEqual(rowsOf(g).map(meta), [
      'Overallocated 2.0 days over · 3 issues · 1 without estimate',
      '5.0 days spare · 1 issue',
      'Underallocated 8.0 days spare · 1 issue',
      'No estimates 2 issues · 2 without estimate',
      '2 issues · 1 without estimate',
    ]);

    const alex = rowNamed(g, 'Alex Smith');
    assert.ok(alex.find('capacity-lozenge').classList.contains('is-over'));
    assert.ok(alex.find('capacity-lozenge').classList.contains('issue-status-lozenge'));
    assert.equal(text(alex, 'capacity-over-days'), '2.0 days over');
    assert.ok(alex.find('capacity-fill').classList.contains('is-over'));
    assert.ok(rowNamed(g, 'Sam Lee').find('capacity-fill').classList.contains('is-normal'));
    assert.equal(rowNamed(g, 'Sam Lee').find('capacity-lozenge'), null);
    assert.ok(rowNamed(g, 'Jo Park').find('capacity-fill').classList.contains('is-under'));
    assert.ok(rowNamed(g, 'Jo Park').find('capacity-lozenge').classList.contains('is-under'));
    const nia = rowNamed(g, 'Nia Bell');
    assert.ok(nia.find('capacity-lozenge').classList.contains('is-none'));
    assert.equal(nia.find('capacity-fill').style.width, '0%', 'empty bar');
    assert.ok(nia.find('capacity-marker'), 'marker still shown');
    const unassigned = rowNamed(g, 'Unassigned');
    assert.equal(unassigned.find('capacity-track'), null, 'no bar for Unassigned');
    assert.equal(unassigned.find('capacity-lozenge'), null);

    assert.equal(g.find('capacity-legend').textContent, 'The line marks full capacity. A day is 8 hours.');
    assert.equal(g.find('status').textContent,
      '9 issues in shown statuses across 5 assignees, including Unassigned where applicable');
  }));

test('KDG-22 capacity: meters share one scale, with aria attributes and the 100% marker', withTimers(async () => {
  const g = await show();
  const track = name => rowNamed(g, name).find('capacity-track');
  const alex = track('Alex Smith');
  assert.equal(alex.getAttribute('role'), 'meter');
  assert.equal(alex.getAttribute('aria-label'), 'Alex Smith capacity');
  assert.equal(alex.getAttribute('aria-valuemin'), '0');
  assert.equal(alex.getAttribute('aria-valuemax'), '120');
  assert.equal(alex.getAttribute('aria-valuenow'), '120');
  assert.equal(alex.getAttribute('aria-valuetext'), '12.0 of 10 working days, 120%, overallocated by 2.0 days');
  assert.equal(alex.find('capacity-fill').style.width, '100%');
  const marker = alex.find('capacity-marker');
  assert.equal(marker.getAttribute('aria-hidden'), 'true');
  assert.equal(Number.parseFloat(marker.style.left).toFixed(2), (100 / 120 * 100).toFixed(2));
  assert.equal(alex.classList.contains('is-capped'), false);

  const sam = track('Sam Lee');
  assert.equal(sam.getAttribute('aria-valuenow'), '50');
  assert.equal(sam.getAttribute('aria-valuemax'), '120');
  assert.equal(sam.getAttribute('aria-valuetext'), '5.0 of 10 working days, 50%, 5.0 days spare');
  assert.equal(Number.parseFloat(sam.find('capacity-fill').style.width).toFixed(2), (50 / 120 * 100).toFixed(2));
  assert.equal(track('Jo Park').getAttribute('aria-valuetext'),
    '2.0 of 10 working days, 20%, underallocated, 8.0 days spare');
  assert.equal(track('Nia Bell').getAttribute('aria-valuetext'),
    'No remaining estimates, 2 issues without estimate');
}));

test('KDG-22 capacity: over 200% the scale stops at 200% and the bar end is square', withTimers(async () => {
  const g = await show([issue('b', 25), issue('s', 5)]);
  const big = rowNamed(g, 'Big Load').find('capacity-track');
  assert.equal(big.getAttribute('aria-valuemax'), '200');
  assert.equal(big.getAttribute('aria-valuenow'), '200');
  assert.equal(big.find('capacity-fill').style.width, '100%');
  assert.ok(big.classList.contains('is-capped'));
  assert.equal(big.find('capacity-marker').style.left, '50%');
  assert.equal(rowNamed(g, 'Big Load').querySelector('span.leaderboard-detail').textContent,
    '25.0 of 10 days · 250%');
  assert.equal(rowNamed(g, 'Sam Lee').find('capacity-fill').style.width, '25%');
}));

test('KDG-22 capacity: drilldowns use the shown-status JQL with assignee and remaining estimate clauses',
  withTimers(async () => {
    const g = await show();
    assert.equal(await opens(g, 'Open 9 issues in shown statuses'), shownJql);
    assert.equal(await opens(g, 'Open 3 issues assigned to Alex Smith'), narrowJql(shownJql, ['assignee = "a"']));
    assert.equal(await opens(g, 'Open 1 issues assigned to Alex Smith without a remaining estimate'),
      narrowJql(shownJql, ['assignee = "a"', 'remainingEstimate is EMPTY']));
    assert.equal(await opens(g, 'Open 2 unassigned issues'), narrowJql(shownJql, ['assignee is EMPTY']));
    assert.equal(await opens(g, 'Open 1 unassigned issues without a remaining estimate'),
      narrowJql(shownJql, ['assignee is EMPTY', 'remainingEstimate is EMPTY']));
    // Only the counts are links.
    const alexLinks = rowNamed(g, 'Alex Smith').findAll('issue-count-link').map(b => b.textContent);
    assert.deepEqual(alexLinks, ['3', '1']);
    assert.deepEqual(rowNamed(g, 'Sam Lee').findAll('issue-count-link').map(b => b.textContent), ['1'],
      'no "without estimate" link when 0');
  }));

test('KDG-22 capacity: hidden-status work is left out of work, allocation and counts', withTimers(async () => {
  const g = await show();
  // Sam's 40-day Closed issue and Jo's 30-day In QA issue would make both overallocated.
  assert.equal(rowNamed(g, 'Sam Lee').querySelector('span.leaderboard-detail').textContent, '5.0 of 10 days · 50%');
  assert.equal(rowNamed(g, 'Jo Park').querySelector('span.leaderboard-detail').textContent, '2.0 of 10 days · 20%');
  const search = g.requests.find(r => r.path.includes('search/jql'));
  assert.deepEqual(search.body.fields, ['assignee', 'status', 'timetracking']);
  assert.equal(search.body.jql, 'project = A');
}));

test('KDG-22 capacity: not narrowed, the footer leaves out "in shown statuses"', withTimers(async () => {
  const g = await show([issue('s', 5)]);
  assert.equal(g.find('status').textContent, '1 issues across 1 assignees, including Unassigned where applicable');
  assert.equal(await opens(g, 'Open 1 issues'), 'project = A');
  assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Closed');
}));

test('KDG-22 capacity: hours per day from the configuration', withTimers(async () => {
  const g = await show([issue('s', 5)], {}, { configuration: { hoursPerDay: 4 } });
  // 40 hours at 4 hours a day is 10 days.
  assert.equal(rowNamed(g, 'Sam Lee').querySelector('span.leaderboard-detail').textContent, '10.0 of 10 days · 100%');
  assert.equal(meta(rowNamed(g, 'Sam Lee')), '0.0 days spare · 1 issue', 'exactly 100% is normal');
  assert.equal(g.find('capacity-legend').textContent, 'The line marks full capacity. A day is 4 hours.');
  const odd = await show([issue('s', 1)], {}, { configuration: { hoursPerDay: 'x' } });
  assert.equal(odd.find('capacity-legend').textContent, 'The line marks full capacity. A day is 8 hours.');
}));

// ---- Range copy ----

test('KDG-22 capacity: range line for no Start Date, one day left, not started and ended', withTimers(async () => {
  let g = await show([issue('s', 5)], { startDate: null });
  assert.equal(g.find('capacity-range').textContent, 'Until 12\u00a0Jun\u00a02026 · 10 working days left');

  g = await show([issue('s', 0.5)], { endDate: '2026-06-01' });
  assert.equal(g.find('capacity-range').textContent, '1\u00a0Jan\u00a02026 – 1\u00a0Jun\u00a02026 · 1 working day left');
  assert.equal(rowNamed(g, 'Sam Lee').querySelector('span.leaderboard-detail').textContent, '0.5 of 1 day · 50%');

  g = await show([issue('s', 1)], { startDate: '2026-06-08', endDate: '2026-06-12' });
  assert.equal(g.find('capacity-range').textContent, '8\u00a0Jun\u00a02026 – 12\u00a0Jun\u00a02026 · Starts 8\u00a0Jun\u00a02026 · 5 working days');
  assert.equal(rowNamed(g, 'Sam Lee').querySelector('span.leaderboard-detail').textContent, '1.0 of 5 days · 20%');
  assert.equal(meta(rowNamed(g, 'Sam Lee')), 'Underallocated 4.0 days spare · 1 issue');

  g = await show([issue('s', 12), issue('a', 1), issue(null, 2)], { endDate: '2026-05-29' });
  assert.equal(g.find('capacity-range').textContent, '1\u00a0Jan\u00a02026 – 29\u00a0May\u00a02026 · Ended · 0 working days left');
  assert.deepEqual(rowsOf(g).map(row => row.querySelector('span.leaderboard-detail').textContent),
    ['12.0 days of work', '1.0 day of work', '2.0 days of work']);
  assert.deepEqual(rowsOf(g).map(meta), ['1 issue', '1 issue', '1 issue']);
  assert.equal(g.findAll('capacity-track').length, 0, 'no bars');
  assert.equal(g.findAll('capacity-lozenge').length, 0, 'no labels');
  assert.equal(g.find('capacity-legend').textContent, 'A day is 8 hours.');
}));

test('KDG-22 capacity: only weekend days left lists work without a judgement',
  withTimers(async () => {
    const g = await show([issue('s', 2), issue('a', 5)], { endDate: '2026-06-07' });
    assert.equal(g.find('capacity-range').textContent, '1\u00a0Jan\u00a02026 – 7\u00a0Jun\u00a02026 · 0 working days left');
    assert.deepEqual(rowsOf(g).map(row => row.querySelector('span.leaderboard-detail').textContent),
      ['5.0 days of work', '2.0 days of work'], 'most work first');
    assert.equal(g.findAll('capacity-track').length, 0);
    assert.equal(g.findAll('capacity-lozenge').length, 0);
    assert.equal(g.find('capacity-legend').textContent, 'A day is 8 hours.');
  }, '2026-06-06T12:00:00Z'));

// ---- States ----

const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;

test('KDG-22 capacity: waiting and no-Controller states', withTimers(async () => {
  const g = await startGadget('capacity');
  assert.equal(g.find('status').textContent, 'Waiting for the controller…');
  assert.equal(g.find('status').getAttribute('role'), 'status');
  mock.timers.tick(4000); await flush();
  assert.equal(g.find('status').textContent, 'Add a Kinetic Dashboard Controller to this dashboard.');
}));

for (const [label, overrides, want] of [
  ['no filter', { jql: null, name: null }, 'Choose a filter in the Controller.'],
  ['no statuses', { statuses: [] }, 'Add statuses in the Controller to see capacity.'],
  ['no End Date', { endDate: null }, 'Set an End Date for this filter in the Controller to see capacity.'],
  ['End Date before Start Date', { startDate: '2026-06-10', endDate: '2026-06-01' }, 'End Date is before Start Date.'],
]) {
  test(`KDG-22 capacity: ${label} shows "${want}" without searching`, withTimers(async () => {
    const g = await show(ISSUES, overrides);
    assert.equal(g.find('status').textContent, want);
    assert.equal(searches(g), 0);
    assert.equal(rowsOf(g).length, 0);
    assert.equal(g.find('status-hidden-note').hidden, true);
    if (label === 'no End Date' || label === 'End Date before Start Date') {
      assert.equal(g.find('capacity-range').hidden, true, 'no range line');
    }
  }));
}

test('KDG-22 capacity: loading, then the range line and note while it loads', withTimers(async () => {
  const g = await startGadget('capacity');
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  assert.equal(g.find('status').textContent, 'Adding up remaining estimates…');
  assert.equal(g.find('capacity-range').textContent, '1\u00a0Jan\u00a02026 – 12\u00a0Jun\u00a02026 · 10 working days left');
  assert.equal(g.find('capacity-range').hidden, false);
  assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Closed');
  g.pending('search/jql')[0].resolve(ok({ issues: ISSUES, isLast: true }));
  await flush();
  assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Closed, In QA', 'with discovered statuses');
  assert.equal(rowsOf(g).length, 5);
}));

test('KDG-22 capacity: no matching issues', withTimers(async () => {
  const g = await show([]);
  assert.equal(g.find('status').textContent, 'No matching issues.');
  assert.equal(rowsOf(g).length, 0);
  assert.equal(g.find('capacity-legend').hidden, true);
}));

test('KDG-22 capacity: none in shown statuses links all matching issues', withTimers(async () => {
  const g = await show([issue('s', 2, 'Closed'), issue('j', 1, 'In QA')]);
  assert.equal(g.find('status').textContent, 'No issues are in shown statuses (2 matching issues).');
  assert.equal(await opens(g, 'Open all 2 matching issues'), 'project = A');
  assert.equal(rowsOf(g).length, 0);
}));

test('KDG-22 capacity: a failed search shows its message or the fallback', withTimers(async () => {
  let g = await startGadget('capacity', { jira: () => fail(500) });
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  assert.match(g.find('status').textContent, /\S/);
  assert.notEqual(g.find('status').textContent, 'Adding up remaining estimates…');
  g = await startGadget('capacity');
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  g.pending('search/jql')[0].reject(new Error(''));
  await flush();
  assert.equal(g.find('status').textContent, 'Could not load capacity.');
}));

// ---- Edit view ----

async function editView(configuration) {
  const g = await startGadget('capacity', { entryPoint: 'edit', configuration });
  const form = g.root.querySelector('form');
  const input = g.root.querySelector('input');
  const submit = async value => {
    input.value = value;
    form.dispatchEvent({ type: 'submit', preventDefault() {} });
    await flush();
  };
  return { g, form, input, submit, error: g.find('error'), save: g.root.querySelector('button') };
}

test('KDG-22 capacity edit: form, prefill and attributes', withTimers(async () => {
  const { g, form, input, error, save } = await editView();
  assert.ok(form.classList.contains('panel'));
  assert.equal(g.find('config-heading').textContent, 'Capacity settings');
  const label = g.root.querySelector('label');
  assert.ok(label.textContent.startsWith('Hours per working day'));
  assert.equal(input.parentNode, label, 'a real label');
  assert.equal(input.value, '8');
  assert.equal(input.type, 'text');
  assert.equal(input.getAttribute('inputmode'), 'decimal');
  const help = g.root.querySelector('#capacity-hours-help');
  assert.equal(help.textContent, 'Turns Remaining Estimate into days. Applies to everyone. Default 8.');
  assert.equal(input.getAttribute('aria-describedby'), 'capacity-hours-help');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(save.textContent, 'Save settings');
  assert.equal(g.requests.length, 0);
  assert.equal(g.emitted('kinetic.dashboard.filter.request').length, 0, 'Edit view does not ask the Controller');
  assert.equal((await editView({ hoursPerDay: 7.5 })).input.value, '7.5');
}));

test('KDG-22 capacity edit: invalid hours show the error and are not saved', withTimers(async () => {
  const { g, input, submit, error } = await editView();
  for (const value of ['', '0', '25', 'abc']) {
    g.doc.activeElement = null;
    await submit(value);
    assert.equal(error.textContent, 'Enter hours from 1 to 24, for example 7.5.', `"${value}"`);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(g.doc.activeElement, input, 'focus moves to the input');
  }
  assert.deepEqual(g.submitted, []);
  await submit('7,5');
  assert.deepEqual(g.submitted, [{ hoursPerDay: 7.5 }]);
  assert.equal(error.textContent, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
}));

test('KDG-22 capacity edit: Save is disabled while saving and a failure can be retried', withTimers(async () => {
  const { g, submit, error, save } = await editView({ hoursPerDay: 6 });
  let finish;
  g.bridge.view.submit = () => new Promise((resolve, reject) => { finish = reject; });
  await submit('6');
  assert.equal(save.disabled, true, 'disabled while saving');
  finish(new Error('nope'));
  await flush();
  assert.equal(error.textContent, 'Could not save the settings. Please try again.');
  assert.equal(save.disabled, false);
  g.bridge.view.submit = async payload => { g.submitted.push(payload); };
  await submit(' 10 ');
  assert.deepEqual(g.submitted, [{ hoursPerDay: 10 }]);
}));

// ---- Review round ----

test('KDG-22 capacity: one issue without estimate reads "1 issue" in the meter text', withTimers(async () => {
  const g = await show([issue('n', null), issue('s', 5)]);
  assert.equal(rowNamed(g, 'Nia Bell').find('capacity-track').getAttribute('aria-valuetext'),
    'No remaining estimates, 1 issue without estimate');
}));

test('KDG-22 capacity: dates use non-breaking spaces and meta parts do not split', withTimers(async () => {
  const g = await show();
  const rangeLine = g.find('capacity-range').textContent;
  assert.ok(rangeLine.includes('1 Jan 2026') && rangeLine.includes('12 Jun 2026'), rangeLine);
  const parts = rowNamed(g, 'Alex Smith').findAll('capacity-part').map(part => part.textContent);
  assert.deepEqual(parts, ['2.0 days over', '3 issues', '1 without estimate']);
  assert.deepEqual(rowNamed(g, 'Unassigned').findAll('capacity-part').map(part => part.textContent),
    ['2 issues', '1 without estimate']);
}));

test('KDG-22 capacity: a failure working out the dates shows "Could not load capacity."', withTimers(async () => {
  const g = await startGadget('capacity', { jira: jiraWith(ISSUES) });
  // An unreadable clock makes todayInTimezone throw.
  const realFormat = Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts = () => { throw new RangeError('Invalid time value'); };
  try {
    await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
    await flush();
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = realFormat;
  }
  assert.equal(g.find('status').textContent, 'Could not load capacity.');
  assert.equal(g.find('capacity-range').hidden, true);
  assert.equal(searches(g), 0);
}));

test('KDG-22 capacity edit: typing clears the error', withTimers(async () => {
  const { input, submit, error } = await editView();
  await submit('0');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  input.value = '7';
  input.dispatchEvent({ type: 'input' });
  assert.equal(error.textContent, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(input.getAttribute('aria-describedby'), 'capacity-hours-help');
}));
