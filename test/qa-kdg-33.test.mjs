// QA KDG-33: with no working days left, all remaining work is over capacity.
// Edge cases beyond test/ui-capacity.test.mjs and test/capacity.test.mjs.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { capacityRows } from '../static/capacity.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn, now = '2026-06-01T12:00:00Z') {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(now) });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const STATUSES = [
  { name: 'To Do', weight: 1, color: '#0c66e4', show: true },
  { name: 'Closed', weight: 0, color: '#e2b203', show: false },
];
const PAYLOAD = { statuses: STATUSES, hiddenStatuses: ['Closed'], shownStatuses: ['To Do'],
  startDate: '2026-01-01', endDate: '2026-05-29' };
const CATEGORY = { 'To Do': ['1', 'new'], Closed: ['5', 'done'] };
const NAMES = { a: 'Alex Smith', s: 'Sam Lee', j: 'Jo Park' };
const DAY = 8 * 3600;
let counter = 0;
function issue(user, days, statusName = 'To Do') {
  counter += 1;
  const [id, key] = CATEGORY[statusName];
  return { id: String(counter), key: `A-${counter}`, fields: {
    status: { id, name: statusName, statusCategory: { key } },
    assignee: user ? { accountId: user, displayName: NAMES[user] } : null,
    timetracking: days === null ? {} : { remainingEstimateSeconds: days * DAY },
  } };
}
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);

async function show(issues, overrides = {}, options = {}) {
  const g = await startGadget('capacity', { jira: jiraWith(issues), ...options });
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, ...overrides }));
  await flush();
  return g;
}
const rowsOf = g => g.findAll('capacity-row');
const rowNamed = (g, name) => rowsOf(g).find(row => row.find('leaderboard-name').textContent === name);
const meta = row => row.find('capacity-meta').textContent;
const detail = row => row.querySelector('span.leaderboard-detail').textContent;
const NO_DAYS_LEGEND = 'No working days left, so all remaining work is over capacity. A day is 8 hours.';

test('QA KDG-33: exactly 0.05 days rounds to 0.1 and is over', () => {
  const { rows } = capacityRows({ rows: [{ id: 'a', name: 'A', timeRemaining: 0.05 * DAY, total: 1,
    estimatedIssues: 1 }] }, { hoursPerDay: 8, daysLeft: 0 });
  assert.equal(rows[0].workDays, 0.1);
  assert.equal(rows[0].state, 'over');
  assert.equal(rows[0].overDays, 0.1);
});

test('QA KDG-33: a not-started range with only weekend days is treated as no working days',
  withTimers(async () => {
    const g = await show([issue('s', 2)], { startDate: '2026-06-06', endDate: '2026-06-07' });
    assert.equal(g.find('capacity-range').textContent,
      '6 Jun 2026 – 7 Jun 2026 · Starts 6 Jun 2026 · 0 working days');
    assert.equal(meta(rowNamed(g, 'Sam Lee')), 'Overallocated 2.0 days over · 1 issue');
    assert.equal(g.findAll('capacity-marker').length, 0);
    assert.equal(g.find('capacity-legend').textContent, NO_DAYS_LEGEND);
  }));

test('QA KDG-33: 0.0 days estimated plus an unestimated issue is normal, not no-estimates',
  withTimers(async () => {
    const g = await show([issue('j', 0), issue('j', null)]);
    const jo = rowNamed(g, 'Jo Park');
    assert.equal(detail(jo), '0.0 of 0 days');
    assert.equal(meta(jo), '0.0 days spare · 2 issues · 1 without estimate');
    assert.equal(jo.find('capacity-lozenge'), null);
    assert.equal(jo.find('capacity-fill').style.width, '0%');
    assert.equal(jo.find('capacity-track').getAttribute('aria-valuetext'), '0.0 of 0 working days');
    assert.equal(g.find('capacity-legend').textContent, NO_DAYS_LEGEND, 'a meter is drawn');
  }));

test('QA KDG-33: hidden-status work does not make someone over once the range has ended',
  withTimers(async () => {
    const g = await show([issue('s', 0), issue('s', 40, 'Closed')]);
    const sam = rowNamed(g, 'Sam Lee');
    assert.equal(meta(sam), '0.0 days spare · 1 issue');
    assert.equal(sam.find('capacity-fill').classList.contains('is-normal'), true);
  }));

test('QA KDG-33: no End Date and End Date before Start Date still show their messages, no rows',
  withTimers(async () => {
    let g = await show([issue('s', 2)], { endDate: undefined });
    assert.equal(g.find('status').textContent, 'Set an End Date for this filter in the Controller to see capacity.');
    assert.equal(rowsOf(g).length, 0);
    g = await show([issue('s', 2)], { startDate: '2026-06-10', endDate: '2026-06-05' });
    assert.equal(g.find('status').textContent, 'End Date is before Start Date.');
    assert.equal(rowsOf(g).length, 0);
  }));

test('QA KDG-33: today equal to the End Date (a weekday) is 1 day left and keeps the running meter',
  withTimers(async () => {
    const g = await show([issue('s', 2), issue('a', 0.5)]);
    assert.equal(g.find('capacity-range').textContent, '1 Jan 2026 – 29 May 2026 · 1 working day left');
    const sam = rowNamed(g, 'Sam Lee');
    assert.equal(detail(sam), '2.0 of 1 day · 200%');
    assert.equal(meta(sam), 'Overallocated 1.0 day over · 1 issue');
    assert.equal(sam.find('capacity-track').getAttribute('aria-valuemax'), '200');
    assert.equal(sam.find('capacity-marker').style.left, '50%');
    assert.equal(detail(rowNamed(g, 'Alex Smith')), '0.5 of 1 day · 50%');
    assert.equal(g.find('capacity-legend').textContent, 'The line marks full capacity. A day is 8 hours.');
  }, '2026-05-29T12:00:00Z'));

test('QA KDG-33: switching from an ended filter to a running one restores the scale and marker',
  withTimers(async () => {
    const g = await show([issue('s', 12), issue('a', 1)]);
    assert.equal(g.findAll('capacity-marker').length, 0);
    await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, endDate: '2026-06-12', jql: 'project = B' }));
    await flush();
    const sam = rowNamed(g, 'Sam Lee');
    assert.equal(detail(sam), '12.0 of 10 days · 120%');
    assert.equal(sam.find('capacity-track').getAttribute('aria-valuemax'), '120');
    assert.equal(g.findAll('capacity-marker').length, 2);
    assert.equal(g.find('capacity-legend').textContent, 'The line marks full capacity. A day is 8 hours.');
    await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, endDate: '2026-05-29', jql: 'project = C' }));
    await flush();
    assert.equal(g.findAll('capacity-marker').length, 0);
    assert.equal(meta(rowNamed(g, 'Sam Lee')), 'Overallocated 12.0 days over · 1 issue');
    assert.equal(g.find('capacity-legend').textContent, NO_DAYS_LEGEND);
  }));

test('QA KDG-33: the no-days legend uses the configured hours per day', withTimers(async () => {
  const g = await show([issue('s', 2)], {}, { configuration: { hoursPerDay: 7.5 } });
  assert.match(g.find('capacity-legend').textContent,
    /^No working days left, so all remaining work is over capacity\. A day is 7\.5 hours\.$/);
}));
