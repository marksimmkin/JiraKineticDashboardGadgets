import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityRows, DEFAULT_HOURS_PER_DAY, hoursPerDay, parseHoursInput, workingDaysLeft }
  from '../static/capacity.mjs';
import { summarizeAssignees } from '../static/issue-data.mjs';

const HOUR = 3600;

test('hours per day uses a saved number from 1 to 24 and otherwise 8', () => {
  assert.equal(DEFAULT_HOURS_PER_DAY, 8);
  assert.equal(hoursPerDay({ hoursPerDay: 7.5 }), 7.5);
  assert.equal(hoursPerDay({ hoursPerDay: 1 }), 1);
  assert.equal(hoursPerDay({ hoursPerDay: 24 }), 24);
  for (const bad of [undefined, null, 0, 0.5, 24.5, -3, NaN, Infinity, '7', true]) {
    assert.equal(hoursPerDay({ hoursPerDay: bad }), 8, String(bad));
  }
  assert.equal(hoursPerDay(undefined), 8);
  assert.equal(hoursPerDay(null), 8);
});

test('hours input accepts dot or comma decimals within 1 to 24', () => {
  assert.equal(parseHoursInput('7.5'), 7.5);
  assert.equal(parseHoursInput('7,5'), 7.5);
  assert.equal(parseHoursInput(' 8 '), 8);
  assert.equal(parseHoursInput('24'), 24);
  assert.equal(parseHoursInput('1'), 1);
  assert.equal(parseHoursInput('8.'), 8);
  assert.equal(parseHoursInput(7), 7);
  for (const bad of ['', '  ', 'abc', '0', '0.9', '24.1', '25', '-8', '7.5.1', '7,5,1', '1e1', '8h', null, undefined]) {
    assert.equal(parseHoursInput(bad), null, String(bad));
  }
});

test('working days count Monday to Friday from today to the End Date inclusive', () => {
  // 2026-11-12 is a Thursday; 2026-11-28 a Saturday.
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', startDate: '2026-11-03', endDate: '2026-11-28' }),
    { days: 12, phase: 'running' });
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', endDate: '2026-11-12' }), { days: 1, phase: 'running' });
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', startDate: '', endDate: '2026-11-13' }),
    { days: 2, phase: 'running' });
  // Today is Saturday, End Date Sunday: running with no working days.
  assert.deepEqual(workingDaysLeft({ today: '2026-11-07', endDate: '2026-11-08' }), { days: 0, phase: 'running' });
  // Saturday today still counts from Monday.
  assert.deepEqual(workingDaysLeft({ today: '2026-11-07', endDate: '2026-11-13' }), { days: 5, phase: 'running' });
  // Start Date today counts today.
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', startDate: '2026-11-12', endDate: '2026-11-13' }),
    { days: 2, phase: 'running' });
});

test('working days before the Start Date count from the Start Date', () => {
  assert.deepEqual(workingDaysLeft({ today: '2026-11-01', startDate: '2026-11-03', endDate: '2026-11-28' }),
    { days: 19, phase: 'not-started' });
});

test('working days report ended, no End Date and End before Start', () => {
  assert.deepEqual(workingDaysLeft({ today: '2026-11-29', startDate: '2026-11-03', endDate: '2026-11-28' }),
    { days: 0, phase: 'ended' });
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', startDate: '2026-11-03' }), { days: 0, phase: 'no-end' });
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', endDate: '2026-02-30' }), { days: 0, phase: 'no-end' });
  assert.deepEqual(workingDaysLeft({ today: '2026-11-12', startDate: '2026-11-20', endDate: '2026-11-19' }),
    { days: 0, phase: 'invalid' });
  assert.throws(() => workingDaysLeft({ today: 'nope', endDate: '2026-11-19' }), /today/);
});

test('working days match a day-by-day count over long ranges', () => {
  const start = Date.UTC(2026, 0, 1) / 86400000;
  for (let offset = 0; offset < 14; offset += 1) {
    for (const length of [0, 1, 6, 7, 8, 30, 400]) {
      const first = start + offset;
      const iso = day => new Date(day * 86400000).toISOString().slice(0, 10);
      let expected = 0;
      for (let day = first; day <= first + length; day += 1) {
        const dow = new Date(day * 86400000).getUTCDay();
        if (dow !== 0 && dow !== 6) expected += 1;
      }
      assert.equal(workingDaysLeft({ today: iso(first), endDate: iso(first + length) }).days, expected,
        `${iso(first)} + ${length}`);
    }
  }
});

function person(id, name, seconds, total, estimatedIssues = total) {
  return { id, name, timeRemaining: seconds, total, estimatedIssues };
}

test('capacity rows classify on rounded work days with 100% and 25% as normal', () => {
  const summary = { rows: [
    person('a', 'Alex', 124 * HOUR, 7, 5),
    person('s', 'Sam', 72 * HOUR, 5),
    person('j', 'Jo', 16 * HOUR, 1),
    person('e', 'Exact', 104 * HOUR, 2),
    person('q', 'Quarter', 26 * HOUR, 2),
    { id: '__unassigned__', name: 'Unassigned', timeRemaining: 48 * HOUR, total: 4, estimatedIssues: 3 },
  ] };
  const { rows, scale } = capacityRows(summary, { hoursPerDay: 8, daysLeft: 13 });
  assert.deepEqual(rows.map(row => row.id), ['a', 'e', 's', 'q', 'j', '__unassigned__']);
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual(byId.a, { id: 'a', name: 'Alex', unassigned: false, workDays: 15.5, total: 7, withoutEstimate: 2,
    allocation: 15.5 / 13 * 100, percent: 119, state: 'over', spareDays: null, overDays: 2.5 });
  assert.equal(byId.s.state, 'normal');
  assert.equal(byId.s.percent, 69);
  assert.equal(byId.s.spareDays, 4);
  assert.equal(byId.j.state, 'under');
  assert.equal(byId.j.percent, 15);
  assert.equal(byId.j.spareDays, 11);
  assert.equal(byId.e.state, 'normal');
  assert.equal(byId.e.percent, 100);
  assert.equal(byId.e.spareDays, 0);
  assert.equal(byId.q.workDays, 3.3);
  assert.equal(byId.q.state, 'normal', '3.3 / 13 is 25.4%');
  assert.deepEqual(byId.__unassigned__, { id: '__unassigned__', name: 'Unassigned', unassigned: true, workDays: 6,
    total: 4, withoutEstimate: 1, allocation: null, percent: null, state: 'none', spareDays: null, overDays: null });
  assert.equal(scale, 15.5 / 13 * 100);
});

test('capacity thresholds use the rounded work, not the raw estimate', () => {
  // 10.04 days rounds to 10.0 of 10: normal, not over.
  const at = capacityRows({ rows: [person('a', 'A', 10.04 * 8 * HOUR, 1)] }, { hoursPerDay: 8, daysLeft: 10 });
  assert.equal(at.rows[0].workDays, 10);
  assert.equal(at.rows[0].state, 'normal');
  // 2.46 days rounds to 2.5 of 10: exactly 25%, normal.
  const quarter = capacityRows({ rows: [person('a', 'A', 2.46 * 8 * HOUR, 1)] }, { hoursPerDay: 8, daysLeft: 10 });
  assert.equal(quarter.rows[0].workDays, 2.5);
  assert.equal(quarter.rows[0].state, 'normal');
  assert.equal(quarter.rows[0].percent, 25);
  // 2.44 rounds to 2.4: under.
  const under = capacityRows({ rows: [person('a', 'A', 2.44 * 8 * HOUR, 1)] }, { hoursPerDay: 8, daysLeft: 10 });
  assert.equal(under.rows[0].state, 'under');
});

test('capacity percentages never contradict the label', () => {
  const over = capacityRows({ rows: [person('a', 'A', 100.2 * 8 * HOUR, 1)] }, { hoursPerDay: 8, daysLeft: 100 });
  assert.equal(over.rows[0].state, 'over');
  assert.equal(over.rows[0].percent, 101);
  assert.equal(over.rows[0].overDays, 0.2);
  const under = capacityRows({ rows: [person('a', 'A', 24.8 * 8 * HOUR, 1)] }, { hoursPerDay: 8, daysLeft: 100 });
  assert.equal(under.rows[0].state, 'under');
  assert.equal(under.rows[0].percent, 24);
});

test('capacity uses the configured hours per day', () => {
  const { rows } = capacityRows({ rows: [person('a', 'A', 15 * HOUR, 1)] }, { hoursPerDay: 7.5, daysLeft: 4 });
  assert.equal(rows[0].workDays, 2);
  assert.equal(rows[0].percent, 50);
  const fallback = capacityRows({ rows: [person('a', 'A', 16 * HOUR, 1)] }, { hoursPerDay: 0, daysLeft: 4 });
  assert.equal(fallback.rows[0].workDays, 2);
});

test('a person with no estimated issues is no-estimates; one estimate is classified normally', () => {
  const { rows } = capacityRows({ rows: [
    person('n', 'None', 0, 3, 0),
    person('z', 'Zero', 0, 3, 1),
  ] }, { hoursPerDay: 8, daysLeft: 10 });
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(byId.n.state, 'no-estimates');
  assert.equal(byId.n.workDays, 0);
  assert.equal(byId.n.withoutEstimate, 3);
  assert.equal(byId.n.allocation, 0);
  assert.equal(byId.n.percent, 0);
  assert.equal(byId.n.spareDays, null);
  assert.equal(byId.z.state, 'under');
  assert.equal(byId.z.spareDays, 10);
});

test('capacity sorts by allocation, ties A to Z, Unassigned last', () => {
  const { rows } = capacityRows({ rows: [
    { id: '__unassigned__', name: 'Unassigned', timeRemaining: 999 * HOUR, total: 1, estimatedIssues: 1 },
    person('b', 'Blair', 40 * HOUR, 1),
    person('a', 'alex', 40 * HOUR, 1),
    person('c', 'Casey', 80 * HOUR, 1),
  ] }, { hoursPerDay: 8, daysLeft: 10 });
  assert.deepEqual(rows.map(row => row.name), ['Casey', 'alex', 'Blair', 'Unassigned']);
});

test('with no working days left rows are unjudged and sorted by work days', () => {
  const { rows, scale } = capacityRows({ rows: [
    { id: '__unassigned__', name: 'Unassigned', timeRemaining: 999 * HOUR, total: 1, estimatedIssues: 1 },
    person('b', 'Blair', 8 * HOUR, 1),
    person('a', 'Alex', 8 * HOUR, 1),
    person('c', 'Casey', 80 * HOUR, 1),
    person('n', 'Nobody', 0, 2, 0),
  ] }, { hoursPerDay: 8, daysLeft: 0 });
  assert.deepEqual(rows.map(row => row.name), ['Casey', 'Alex', 'Blair', 'Nobody', 'Unassigned']);
  for (const row of rows) {
    assert.equal(row.state, 'none');
    assert.equal(row.allocation, null);
    assert.equal(row.percent, null);
    assert.equal(row.spareDays, null);
    assert.equal(row.overDays, null);
  }
  assert.equal(scale, 100);
});

test('capacity scale is the highest allocation clamped to 100%..200%', () => {
  const scaleFor = days => capacityRows({ rows: [person('a', 'A', days * 8 * HOUR, 1)] },
    { hoursPerDay: 8, daysLeft: 10 }).scale;
  assert.equal(scaleFor(5), 100);
  assert.equal(scaleFor(15), 150);
  assert.equal(scaleFor(30), 200);
  assert.equal(capacityRows({ rows: [] }, { hoursPerDay: 8, daysLeft: 10 }).scale, 100);
  // Unassigned work does not stretch the scale.
  assert.equal(capacityRows({ rows: [{ id: '__unassigned__', name: 'Unassigned', timeRemaining: 300 * HOUR,
    total: 1, estimatedIssues: 1 }] }, { hoursPerDay: 8, daysLeft: 10 }).scale, 100);
});

test('capacity rows read summarizeAssignees output directly', () => {
  const issues = [
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { name: 'To Do' },
      timetracking: { remainingEstimateSeconds: 8 * HOUR } } },
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { name: 'To Do' } } },
    { fields: { assignee: null, status: { name: 'To Do' }, timeestimate: 4 * HOUR } },
  ];
  const { rows } = capacityRows(summarizeAssignees(issues, [{ name: 'To Do', weight: 1 }]),
    { hoursPerDay: 8, daysLeft: 2 });
  assert.deepEqual(rows.map(({ id, workDays, total, withoutEstimate, state }) => ({ id, workDays, total, withoutEstimate, state })), [
    { id: 'a', workDays: 1, total: 2, withoutEstimate: 1, state: 'normal' },
    { id: '__unassigned__', workDays: 0.5, total: 1, withoutEstimate: 0, state: 'none' },
  ]);
});
