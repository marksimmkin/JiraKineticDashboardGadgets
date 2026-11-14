// KDG-28: Total time remaining shown in days and hours, with hours per day set in each gadget's
// Edit view (default 7).
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { DEFAULT_HOURS_PER_DAY, hoursPerDay } from '../static/capacity.mjs';
import { DEFAULT_USER_HOURS_PER_DAY, formatMetric, timeRemainingSpoken } from '../static/user-metrics.mjs';
import { sortedUserRows } from '../static/user-list-sort.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const NBSP = ' ';
const shown = text => text.replace(' (', `${NBSP}(`);

// ---- Formatting ----

test('KDG-28 formatMetric time: every row of the spec table at 8 hours per day', () => {
  const rows = [
    [0, '0.0d (0h)'],
    [1200, '0.0d (0.3h)'],
    [14400, '0.5d (4h)'],
    [28800, '1.0d (8h)'],
    [151200, '5.3d (42h)'],
    [153000, '5.3d (42.5h)'],
    [36000000, '1,250.0d (10,000h)'],
  ];
  for (const [seconds, text] of rows) {
    assert.equal(formatMetric(seconds, 'time', { hoursPerDay: 8 }), shown(text), `${seconds}s`);
  }
});

test('KDG-28 formatMetric time: a non-breaking space before the bracket and no other spaces', () => {
  const text = formatMetric(151200, 'time', { hoursPerDay: 8 });
  assert.equal(text, `5.3d${NBSP}(42h)`);
  assert.ok(!text.includes(' '), 'no ordinary spaces');
  assert.equal(text.split(NBSP).length, 2, 'exactly one non-breaking space');
});

test('KDG-28 formatMetric time: default is 7 hours per day; 7.5 also works', () => {
  assert.equal(DEFAULT_USER_HOURS_PER_DAY, 7);
  assert.equal(formatMetric(151200, 'time'), shown('6.0d (42h)'));
  assert.equal(formatMetric(151200, 'time', {}), shown('6.0d (42h)'));
  assert.equal(formatMetric(25200, 'time'), shown('1.0d (7h)'));
  assert.equal(formatMetric(151200, 'time', { hoursPerDay: 7.5 }), shown('5.6d (42h)'));
  assert.equal(formatMetric(27000, 'time', { hoursPerDay: 7.5 }), shown('1.0d (7.5h)'));
});

test('KDG-28 formatMetric time: days come from raw seconds, not rounded hours', () => {
  // 3.58h shows as 3.6h. Raw days are 0.4475 → 0.4; days from the rounded 3.6h would be 0.45 → 0.5.
  assert.equal(formatMetric(12888, 'time', { hoursPerDay: 8 }), shown('0.4d (3.6h)'));
});

test('KDG-28 formatMetric: tickets and score are unchanged', () => {
  assert.equal(formatMetric(1234, 'tickets'), new Intl.NumberFormat().format(1234));
  assert.equal(formatMetric(1.5, 'score'), new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1.5));
});

test('KDG-28 timeRemainingSpoken: every row of the spec table at 8 hours per day', () => {
  const rows = [
    [0, '0.0 days, 0 hours'],
    [1200, '0.0 days, 0.3 hours'],
    [14400, '0.5 days, 4 hours'],
    [28800, '1.0 day, 8 hours'],
    [151200, '5.3 days, 42 hours'],
    [153000, '5.3 days, 42.5 hours'],
    [36000000, '1,250.0 days, 10,000 hours'],
  ];
  for (const [seconds, text] of rows) assert.equal(timeRemainingSpoken(seconds, 8), text, `${seconds}s`);
});

test('KDG-28 timeRemainingSpoken: singulars only for exactly 1.0 day and 1 hour', () => {
  assert.equal(timeRemainingSpoken(3600, 8), '0.1 days, 1 hour');
  assert.equal(timeRemainingSpoken(28800, 8), '1.0 day, 8 hours');
  assert.equal(timeRemainingSpoken(25200), '1.0 day, 7 hours');
  assert.equal(timeRemainingSpoken(3600, 1), '1.0 day, 1 hour');
  assert.equal(timeRemainingSpoken(1.1 * 3600, 1), '1.1 days, 1.1 hours');
  assert.equal(timeRemainingSpoken(151200), '6.0 days, 42 hours', 'default 7 hours per day');
  assert.equal(timeRemainingSpoken(151200, 7.5), '5.6 days, 42 hours');
});

test('KDG-28 hoursPerDay: User List/Leaderboard fallback 7; Capacity default stays 8', () => {
  const user = config => hoursPerDay(config, DEFAULT_USER_HOURS_PER_DAY);
  assert.equal(user(undefined), 7);
  assert.equal(user({}), 7);
  assert.equal(user({ hoursPerDay: 8 }), 8);
  assert.equal(user({ hoursPerDay: 7.5 }), 7.5);
  for (const bad of ['8', 0, 25, -1, NaN, Infinity, null]) assert.equal(user({ hoursPerDay: bad }), 7, String(bad));
  assert.equal(DEFAULT_HOURS_PER_DAY, 8);
  assert.equal(hoursPerDay(undefined), 8);
  assert.equal(hoursPerDay({ hoursPerDay: 'x' }), 8);
});

test('KDG-28 sorting: by seconds, so 0.5d is below 1.0d and 1,250.0d above 5.3d', () => {
  const rows = [
    { id: 'a', name: 'A', timeRemaining: 151200, counts: {} }, // 5.3d
    { id: 'b', name: 'B', timeRemaining: 14400, counts: {} }, // 0.5d
    { id: 'c', name: 'C', timeRemaining: 36000000, counts: {} }, // 1,250.0d
    { id: 'd', name: 'D', timeRemaining: 28800, counts: {} }, // 1.0d
  ];
  const names = direction => sortedUserRows(rows, { column: 'total', direction }, 'time').map(row => row.name);
  assert.deepEqual(names('descending'), ['C', 'A', 'D', 'B']);
  assert.deepEqual(names('ascending'), ['B', 'D', 'A', 'C']);
});

// ---- Gadgets ----

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

let next = 0;
function issue(user, seconds) {
  next += 1;
  return { id: String(next), key: `A-${next}`, fields: {
    summary: `Issue ${next}`, status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    assignee: { accountId: user, displayName: `User ${user}` },
    timetracking: seconds === null ? {} : { remainingEstimateSeconds: seconds },
  } };
}
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);
const PAYLOAD = { statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: ['To Do'] };

async function showTime(name, issues, configuration) {
  const g = await startGadget(name, { jira: jiraWith(issues), configuration });
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  const select = g.find('user-metric-select');
  select.value = 'time';
  select.dispatchEvent({ type: 'change' });
  await flush();
  return g;
}

// Each user's total time (seconds): u1 5.3d at 8h, u2 0.5d, u3 1,250.0d, u4 1.0d.
const SPREAD = [issue('u1', 100000), issue('u1', 51200), issue('u2', 14400), issue('u3', 36000000),
  issue('u4', 28800)];

function cellOf(g, userName) {
  const row = g.root.querySelectorAll('tr').find(tr => tr.children[0]?.textContent === userName);
  assert.ok(row, `no row for ${userName}`);
  return row.children[1];
}

test('KDG-28 user-list: time cell shows days and hours, hidden from screen readers, with spoken text',
  withTimers(async () => {
    const g = await showTime('user-list', SPREAD, { hoursPerDay: 8 });
    const cell = cellOf(g, 'User u1');
    assert.equal(cell.children.length, 2);
    const [visible, spoken] = cell.children;
    assert.equal(visible.tagName, 'SPAN');
    assert.equal(visible.getAttribute('aria-hidden'), 'true');
    assert.equal(visible.textContent, shown('5.3d (42h)'));
    assert.equal(spoken.tagName, 'SPAN');
    assert.equal(spoken.className, 'visually-hidden');
    assert.equal(spoken.hasAttribute('aria-hidden'), false);
    assert.equal(spoken.textContent, '5.3 days, 42 hours');
    assert.ok(cell.classList.contains('number-cell'));
  }));

test('KDG-28 user-list: no estimates shows 0.0d (0h) and keeps the tooltip', withTimers(async () => {
  const g = await showTime('user-list', [issue('u1', null), issue('u1', null)]);
  const cell = cellOf(g, 'User u1');
  assert.equal(cell.children[0].textContent, shown('0.0d (0h)'));
  assert.equal(cell.children[1].textContent, '0.0 days, 0 hours');
  assert.equal(cell.title, 'Remaining estimate set on 0 of 2 issues');
}));

test('KDG-28 user-list: sorts by seconds (0.5d below 1.0d, 1,250.0d above 5.3d)', withTimers(async () => {
  const g = await showTime('user-list', SPREAD, { hoursPerDay: 8 });
  const order = () => g.root.querySelectorAll('tr').slice(1).map(tr => tr.children[0].textContent);
  assert.deepEqual(order(), ['User u3', 'User u1', 'User u4', 'User u2'], 'largest first by default');
  const totalHeading = g.findAll('table-sort-button')[1];
  totalHeading.click();
  await flush();
  assert.deepEqual(order(), ['User u2', 'User u4', 'User u1', 'User u3']);
}));

test('KDG-28 user-list: hours per day from the configuration (default 7, saved 8, 7.5, invalid → 7)',
  withTimers(async () => {
    const text = async configuration => cellOf(await showTime('user-list', [issue('u1', 151200)], configuration),
      'User u1').children[0].textContent;
    assert.equal(await text(undefined), shown('6.0d (42h)'));
    assert.equal(await text({ hoursPerDay: 8 }), shown('5.3d (42h)'));
    assert.equal(await text({ hoursPerDay: 7.5 }), shown('5.6d (42h)'));
    assert.equal(await text({ hoursPerDay: 'eight' }), shown('6.0d (42h)'));
    assert.equal(await text({ hoursPerDay: 30 }), shown('6.0d (42h)'));
  }));

function leaderRow(g, userName) {
  const row = g.findAll('leaderboard-row').find(r => r.find('leaderboard-name').textContent === userName);
  assert.ok(row, `no row for ${userName}`);
  return row;
}

test('KDG-28 user-leaderboard: detail line, spoken value and meter aria-valuetext', withTimers(async () => {
  const issues = [issue('u1', 151200), ...[1, 2, 3, 4, 5].map(() => issue('u1', 0)), issue('u2', 3600)];
  const g = await showTime('user-leaderboard', issues, { hoursPerDay: 8 });
  const row = leaderRow(g, 'User u1');
  const detail = row.find('leaderboard-detail');
  const [visible, spoken] = detail.children;
  assert.equal(visible.getAttribute('aria-hidden'), 'true');
  assert.equal(visible.textContent, shown('5.3d (42h)'));
  assert.equal(spoken.className, 'visually-hidden');
  assert.equal(spoken.textContent, '5.3 days, 42 hours');
  const sighted = detail.childNodes.filter(n => n !== spoken).map(n => n.textContent).join('');
  assert.equal(sighted, `5.3d${NBSP}(42h) remaining · 6 tickets`);
  const meter = row.find('leaderboard-track');
  assert.equal(meter.getAttribute('aria-valuetext'), '5.3 days, 42 hours');
  assert.equal(meter.getAttribute('aria-valuenow'), '151200', 'still seconds');
  assert.equal(meter.getAttribute('aria-valuemax'), '151200', 'still seconds');
  assert.equal(leaderRow(g, 'User u2').find('leaderboard-track').getAttribute('aria-valuetext'),
    '0.1 days, 1 hour');
}));

test('KDG-28 user-leaderboard: ranks by seconds and uses the default 7 hours per day', withTimers(async () => {
  const g = await showTime('user-leaderboard', SPREAD);
  assert.deepEqual(g.findAll('leaderboard-name').map(n => n.textContent), ['User u3', 'User u1', 'User u4', 'User u2']);
  assert.equal(leaderRow(g, 'User u1').find('leaderboard-detail').children[0].textContent, shown('6.0d (42h)'));
  assert.equal(leaderRow(g, 'User u1').find('leaderboard-track').getAttribute('aria-valuetext'),
    '6.0 days, 42 hours');
}));

test('KDG-28 user-leaderboard: other metrics have no aria-valuetext and keep their detail text',
  withTimers(async () => {
    const g = await startGadget('user-leaderboard', { jira: jiraWith([issue('u1', 3600)]) });
    await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
    await flush();
    assert.equal(g.find('leaderboard-track').hasAttribute('aria-valuetext'), false);
    assert.equal(g.find('leaderboard-detail').textContent, '1 weighted score · 1 tickets');
  }));

// ---- Edit views ----

for (const [name, heading] of [['user-list', 'User list settings'], ['user-leaderboard', 'Leaderboard settings']]) {
  async function editView(configuration) {
    const g = await startGadget(name, { entryPoint: 'edit', configuration });
    const form = g.root.querySelector('form');
    const input = g.root.querySelector('input');
    const submit = async value => {
      input.value = value;
      form.dispatchEvent({ type: 'submit', preventDefault() {} });
      await flush();
    };
    return { g, form, input, submit, error: g.find('error'), save: g.root.querySelector('button') };
  }

  test(`KDG-28 ${name} edit: form, prefill 7 and attributes`, withTimers(async () => {
    const { g, form, input, error, save } = await editView();
    assert.ok(form.classList.contains('panel'));
    assert.ok(form.classList.contains('hours-edit'));
    assert.equal(form.noValidate, true);
    assert.equal(g.find('config-heading').textContent, heading);
    const label = g.root.querySelector('label');
    assert.ok(label.textContent.startsWith('Hours per working day'));
    assert.equal(input.parentNode, label);
    assert.equal(input.value, '7');
    assert.equal(input.type, 'text');
    assert.equal(input.getAttribute('inputmode'), 'decimal');
    const help = g.root.querySelector(`#${name}-hours-help`);
    assert.equal(help.textContent,
      'Turns Remaining Estimate into days for Total time remaining. Applies to everyone. Default 7.');
    assert.equal(input.getAttribute('aria-describedby'), `${name}-hours-help`);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(save.textContent, 'Save settings');
    assert.equal(g.requests.length, 0, 'no Jira requests');
    assert.equal(g.emitted('kinetic.dashboard.filter.request').length, 0, 'Edit view does not ask the Controller');
    assert.equal((await editView({ hoursPerDay: 7.5 })).input.value, '7.5');
    assert.equal((await editView({ hoursPerDay: 8 })).input.value, '8');
    assert.equal((await editView({ hoursPerDay: 99 })).input.value, '7', 'invalid saved value falls back to 7');
  }));

  test(`KDG-28 ${name} edit: validation, "7,5" saves 7.5, typing clears the error`, withTimers(async () => {
    const { g, input, submit, error } = await editView();
    for (const value of ['', '0', '25', 'abc', '7.5h']) {
      g.doc.activeElement = null;
      await submit(value);
      assert.equal(error.textContent, 'Enter hours from 1 to 24, for example 7.5.', `"${value}"`);
      assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.equal(input.getAttribute('aria-describedby'), `${name}-hours-help ${name}-hours-error`);
      assert.equal(g.doc.activeElement, input, 'focus moves to the input');
    }
    assert.deepEqual(g.submitted, []);
    input.value = '7';
    input.dispatchEvent({ type: 'input' });
    assert.equal(error.textContent, '');
    assert.equal(input.hasAttribute('aria-invalid'), false);
    assert.equal(input.getAttribute('aria-describedby'), `${name}-hours-help`);
    await submit('7,5');
    assert.deepEqual(g.submitted, [{ hoursPerDay: 7.5 }]);
  }));

  test(`KDG-28 ${name} edit: save failure can be retried; other saved settings are kept`, withTimers(async () => {
    const { g, submit, error, save } = await editView({ hoursPerDay: 6, other: 'keep me' });
    let finish;
    g.bridge.view.submit = () => new Promise((resolve, reject) => { finish = reject; });
    await submit('6');
    assert.equal(save.disabled, true, 'disabled while saving');
    finish(new Error('nope'));
    await flush();
    assert.equal(error.textContent, 'Could not save the settings. Please try again.');
    assert.equal(save.disabled, false);
    g.bridge.view.submit = async payload => { g.submitted.push(payload); };
    await submit(' 8 ');
    assert.deepEqual(g.submitted, [{ hoursPerDay: 8, other: 'keep me' }]);
  }));
}

test('KDG-28 capacity edit: shared form adds hours-edit but keeps its ids, copy and default 8', withTimers(async () => {
  const g = await startGadget('capacity', { entryPoint: 'edit' });
  const form = g.root.querySelector('form');
  assert.ok(form.classList.contains('hours-edit'));
  assert.ok(form.classList.contains('capacity-edit'));
  assert.equal(g.root.querySelector('input').id, 'capacity-hours');
  assert.equal(g.root.querySelector('input').value, '8');
  assert.equal(g.root.querySelector('#capacity-hours-help').textContent,
    'Turns Remaining Estimate into days. Applies to everyone. Default 8.');
  assert.equal(g.find('config-heading').textContent, 'Capacity settings');
}));
