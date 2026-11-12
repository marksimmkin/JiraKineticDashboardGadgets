// KDG-22 QA: edge cases for the Capacity gadget (static/capacity.mjs, static/capacity/src.mjs).
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED, GADGET_REFRESH } from '../static/shared.mjs';
import { narrowJql } from '../static/drilldown.mjs';
import { todayInTimezone } from '../static/progress.mjs';
import { capacityRows, hoursPerDay, parseHoursInput, workingDaysLeft } from '../static/capacity.mjs';
import { summarizeAssignees } from '../static/issue-data.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn, now = '2026-06-01T12:00:00Z') {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(now) });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const DAY = 8 * 3600;
let counter = 0;
function issue(accountId, displayName, seconds, status = ['To Do', '1', 'new']) {
  counter += 1;
  return { id: String(counter), key: `Q-${counter}`, fields: {
    status: { id: status[1], name: status[0], statusCategory: { key: status[2] } },
    assignee: accountId ? { accountId, displayName } : null,
    timetracking: seconds === null ? {} : { remainingEstimateSeconds: seconds },
  } };
}
const STATUSES = [{ name: 'To Do', weight: 1, show: true }, { name: 'Done', weight: 0, show: false }];
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);
const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;

async function show(issues, overrides = {}, options = {}) {
  const g = await startGadget('capacity', { jira: jiraWith(issues), ...options });
  await g.bus.send(FILTER_SELECTED, selection({ statuses: STATUSES, startDate: null, endDate: '2026-06-12',
    ...overrides }));
  await flush();
  return g;
}
const rowsOf = g => g.findAll('capacity-row');
const detail = row => row.querySelector('span.leaderboard-detail').textContent;
const meta = row => row.find('capacity-meta').textContent;

// ---- Working-day counting ----

function bruteForce(from, to) {
  let n = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n += 1;
  }
  return n;
}

test('QA KDG-22: working days across year, leap-day, month and DST boundaries', () => {
  const cases = [
    ['2026-12-28', '2027-01-08', 10], // year boundary
    ['2028-02-28', '2028-03-01', 3], // leap day 29 Feb 2028 is a Tuesday
    ['2026-03-06', '2026-03-10', 3], // US DST starts Sun 8 Mar 2026
    ['2026-10-23', '2026-10-27', 3], // EU DST ends Sun 25 Oct 2026
    ['2026-01-30', '2026-02-02', 2], // month boundary over a weekend
    ['2026-06-06', '2026-06-07', 0], // weekend only
  ];
  for (const [today, endDate, want] of cases) {
    assert.equal(workingDaysLeft({ today, endDate }).days, want, `${today}..${endDate}`);
    assert.equal(bruteForce(today, endDate), want);
  }
});

test('QA KDG-22: Start equals End, End today, and a future weekend-only range', () => {
  assert.deepEqual(workingDaysLeft({ today: '2026-06-01', startDate: '2026-06-01', endDate: '2026-06-01' }),
    { days: 1, phase: 'running' });
  assert.deepEqual(workingDaysLeft({ today: '2026-06-05', startDate: '2026-01-01', endDate: '2026-06-05' }),
    { days: 1, phase: 'running' });
  assert.deepEqual(workingDaysLeft({ today: '2026-06-06', endDate: '2026-06-05' }), { days: 0, phase: 'ended' });
  assert.deepEqual(workingDaysLeft({ today: '2026-06-01', startDate: '2026-06-06', endDate: '2026-06-07' }),
    { days: 0, phase: 'not-started' });
  // An unreadable Start Date means "from today".
  assert.deepEqual(workingDaysLeft({ today: '2026-06-01', startDate: '2026-02-30', endDate: '2026-06-05' }),
    { days: 5, phase: 'running' });
});

test('QA KDG-22: "today" follows the Jira timezone near midnight', withTimers(async () => {
  // 23:30 UTC on Friday 5 Jun is already Saturday 6 Jun in Auckland.
  assert.equal(todayInTimezone('Pacific/Auckland'), '2026-06-06');
  let g = await show([issue('s', 'Sam', DAY)], { endDate: '2026-06-12' }, { timezone: 'Pacific/Auckland' });
  assert.equal(g.find('capacity-range').textContent, 'Until 12\u00a0Jun\u00a02026 · 5 working days left');
  g = await show([issue('s', 'Sam', DAY)], { endDate: '2026-06-12' }, { timezone: 'UTC' });
  assert.equal(g.find('capacity-range').textContent, 'Until 12\u00a0Jun\u00a02026 · 6 working days left');
  // End Date Friday 5 Jun: still running in Los Angeles (15:30), ended in Auckland.
  g = await show([issue('s', 'Sam', DAY)], { endDate: '2026-06-05' }, { timezone: 'America/Los_Angeles' });
  assert.equal(g.find('capacity-range').textContent, 'Until 5\u00a0Jun\u00a02026 · 1 working day left');
  g = await show([issue('s', 'Sam', DAY)], { endDate: '2026-06-05' }, { timezone: 'Pacific/Auckland' });
  assert.equal(g.find('capacity-range').textContent, 'Until 5\u00a0Jun\u00a02026 · Ended · 0 working days left');
  // An invalid timezone falls back to UTC rather than failing.
  g = await show([issue('s', 'Sam', DAY)], { endDate: '2026-06-12' }, { timezone: 'Not/AZone' });
  assert.equal(g.find('capacity-range').textContent, 'Until 12\u00a0Jun\u00a02026 · 6 working days left');
}, '2026-06-05T23:30:00Z'));

// ---- Classification ----

test('QA KDG-22: zero Remaining Estimate is an estimate (Underallocated), not "No estimates"', () => {
  const summary = summarizeAssignees([issue('z', 'Zero', 0), issue('z', 'Zero', 0)], STATUSES);
  const [row] = capacityRows(summary, { daysLeft: 10 }).rows;
  assert.equal(row.state, 'under');
  assert.equal(row.withoutEstimate, 0);
  assert.equal(row.percent, 0);
});

test('QA KDG-22: boundary rounding at 25%, 100% and just over', () => {
  const at = (seconds, daysLeft) => capacityRows({ rows: [{ id: 'x', name: 'X', total: 1, estimatedIssues: 1,
    timeRemaining: seconds }] }, { daysLeft }).rows[0];
  assert.equal(at(2.5 * DAY, 10).state, 'normal');
  assert.equal(at(2.5 * DAY, 10).percent, 25);
  assert.equal(at(2.44 * DAY, 10).state, 'under'); // rounds to 2.4
  assert.equal(at(10.04 * DAY, 10).state, 'normal'); // rounds to 10.0
  assert.equal(at(10.04 * DAY, 10).percent, 100);
  assert.equal(at(10.05 * DAY, 10).state, 'over'); // rounds to 10.1
  assert.equal(at(100.1 * DAY, 100).percent, 101, 'never shows 100% next to Overallocated');
  assert.equal(at(24.9 * DAY, 100).state, 'under');
  assert.equal(at(24.9 * DAY, 100).percent, 24, 'never shows 25% next to Underallocated');
  // Huge allocations: percentage is real, scale is capped at 200.
  const huge = capacityRows({ rows: [{ id: 'x', name: 'X', total: 1, estimatedIssues: 1, timeRemaining: 100 * DAY }] },
    { daysLeft: 1 });
  assert.equal(huge.rows[0].percent, 10000);
  assert.equal(huge.scale, 200);
});

test('QA KDG-22: hours per day rejects invalid saved values', () => {
  for (const value of [0, 0.5, 25, -8, Number.NaN, Infinity, '8', null, undefined, true]) {
    assert.equal(hoursPerDay({ hoursPerDay: value }), 8, String(value));
  }
  assert.equal(hoursPerDay(undefined), 8);
  assert.equal(hoursPerDay({ hoursPerDay: 1 }), 1);
  assert.equal(hoursPerDay({ hoursPerDay: 24 }), 24);
  for (const text of ['1e1', '7,5,5', '7.5h', '-1', '.5', '0x10', '24.01', ' ', '8 8']) {
    assert.equal(parseHoursInput(text), null, JSON.stringify(text));
  }
  assert.equal(parseHoursInput('24'), 24);
  assert.equal(parseHoursInput('1'), 1);
  assert.equal(parseHoursInput('8.'), 8);
});

// ---- UI ----

test('QA KDG-22: names are text, never HTML', withTimers(async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const g = await show([issue('e', evil, DAY)]);
  const [row] = rowsOf(g);
  assert.equal(row.find('leaderboard-name').textContent, evil);
  assert.equal(row.querySelector('img'), null);
  assert.equal(row.find('capacity-track').getAttribute('aria-label'), `${evil} capacity`);
}));

test('QA KDG-22: drilldowns keep quotes and put ORDER BY last', withTimers(async () => {
  const jql = 'project = "A \\"B\\"" AND summary ~ "order by" ORDER BY rank ASC';
  const g = await show([issue('5b:x"y', 'Quote Person', null), issue('5b:x"y', 'Quote Person', DAY),
    issue('d', 'Done Person', DAY, ['Done', '9', 'done'])], { jql });
  const shown = narrowJql(jql, ['status in ("1")']);
  assert.ok(shown.endsWith(' ORDER BY rank ASC'));
  const links = g.findAll('issue-count-link').map(b => [b.getAttribute('aria-label'), b]);
  const open = async label => {
    const found = links.find(([l]) => l === label);
    assert.ok(found, label);
    found[1].click();
    await flush();
    return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
  };
  assert.equal(await open('Open 2 issues assigned to Quote Person'),
    narrowJql(shown, ['assignee = "5b:x\\"y"']));
  assert.equal(await open('Open 1 issues assigned to Quote Person without a remaining estimate'),
    '((project = "A \\"B\\"" AND summary ~ "order by") AND (status in ("1"))) AND (assignee = "5b:x\\"y") ' +
    'AND (remainingEstimate is EMPTY) ORDER BY rank ASC');
  assert.equal(rowsOf(g).length, 1, 'Done (hidden) person is left out');
}));

test('QA KDG-22: ended range keeps Unassigned last and people sorted by work', withTimers(async () => {
  const g = await show([issue(null, null, 50 * DAY), issue('a', 'Amy', DAY), issue('b', 'Ben', 3 * DAY),
    issue('c', 'Cal', null)], { endDate: '2026-05-01' });
  assert.deepEqual(rowsOf(g).map(r => r.find('leaderboard-name').textContent), ['Ben', 'Amy', 'Cal', 'Unassigned']);
  assert.deepEqual(rowsOf(g).map(detail), ['3.0 days of work', '1.0 day of work', '0.0 days of work',
    '50.0 days of work']);
  assert.equal(meta(rowsOf(g)[2]), '1 issue · 1 without estimate');
}));

test('QA KDG-22: a repeated selection and a refresh each search once; a superseded search is dropped',
  withTimers(async () => {
    const g = await startGadget('capacity');
    const payload = selection({ statuses: STATUSES, endDate: '2026-06-12', revision: 'r1' });
    await g.bus.send(FILTER_SELECTED, payload);
    await g.bus.send(FILTER_SELECTED, payload);
    await flush();
    assert.equal(searches(g), 1, 'duplicate selection ignored');
    // A newer selection supersedes the pending search.
    await g.bus.send(FILTER_SELECTED, { ...payload, revision: 'r2', name: 'Second', jql: 'project = B' });
    await flush();
    const [first, second] = g.pending('search/jql');
    g.answer(second, ok({ issues: [issue('n', 'New', DAY)], isLast: true }));
    g.answer(first, ok({ issues: [issue('o', 'Old', DAY)], isLast: true }));
    await flush();
    assert.deepEqual(rowsOf(g).map(r => r.find('leaderboard-name').textContent), ['New']);
    // Refresh of this gadget refetches once.
    const before = searches(g);
    await g.bus.send(GADGET_REFRESH, { gadgetId: g.gadgetId });
    await flush();
    assert.ok(searches(g) - before <= 1);
  }));

test('QA KDG-22: blocked localStorage does not affect the gadget', withTimers(async () => {
  const { createStorage } = await import('./helpers/gadget-harness.mjs');
  const g = await show([issue('s', 'Sam', DAY)], {}, { storage: createStorage({ blocked: true }) });
  assert.equal(rowsOf(g).length, 1);
}));
