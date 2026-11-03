// QA KDG-16: inclusive End Dates. The period runs from Start Date 00:00 to End Date 24:00 in the
// viewer's Jira time zone. Locks in calendarProgress boundaries, Burndown day boundaries in
// time zones far from UTC (including DST changes) and the gadget-level geometry and copy.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { calendarProgress } from '../static/progress.mjs';
import { buildBurndown } from '../static/burndown.mjs';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const STATUSES = [{ name: 'To Do', weight: 1 }, { name: 'In Progress', weight: 0.5 }, { name: 'Done', weight: 0 }];

// ---------------------------------------------------------------------------------------------
// calendarProgress

test('QA KDG-16 calendarProgress: every day of a 5-day period steps by 1/5', () => {
  const expected = [
    ['2020-01-01', 0, null, 'before'],
    ['2026-09-27', 0, null, 'before'],
    ['2026-09-28', 0, 1, 'during'],
    ['2026-09-29', 0.2, 2, 'during'],
    ['2026-09-30', 0.4, 3, 'during'],
    ['2026-10-01', 0.6, 4, 'during'],
    ['2026-10-02', 0.8, 5, 'during'],
    ['2026-10-03', 1, null, 'after'],
    ['2099-12-31', 1, null, 'after'],
  ];
  for (const [today, fraction, day, phase] of expected) {
    assert.deepEqual(calendarProgress('2026-09-28', '2026-10-02', today),
      { kind: 'ready', fraction, day, days: 5, phase }, today);
  }
});

test('QA KDG-16 calendarProgress: one-day period is 0% on its day and 100% after', () => {
  assert.equal(calendarProgress('2026-10-01', '2026-10-01', '2026-09-30').fraction, 0);
  assert.equal(calendarProgress('2026-10-01', '2026-10-01', '2026-10-01').fraction, 0);
  assert.equal(calendarProgress('2026-10-01', '2026-10-01', '2026-10-01').day, 1);
  assert.equal(calendarProgress('2026-10-01', '2026-10-01', '2026-10-02').fraction, 1);
});

test('QA KDG-16 calendarProgress: month, year, leap-day and DST boundaries count calendar days', () => {
  // 28 Feb to 1 Mar 2028 (leap year) is 3 days.
  assert.deepEqual(calendarProgress('2028-02-28', '2028-03-01', '2028-02-29'),
    { kind: 'ready', fraction: 1 / 3, day: 2, days: 3, phase: 'during' });
  // Across New Year: 30 Dec to 2 Jan is 4 days.
  assert.equal(calendarProgress('2026-12-30', '2027-01-02', '2027-01-02').fraction, 0.75);
  // US DST ends 1 Nov 2026, NZ DST starts 27 Sep 2026: whole days are unaffected.
  assert.equal(calendarProgress('2026-10-31', '2026-11-02', '2026-11-02').fraction, 2 / 3);
  assert.equal(calendarProgress('2026-09-26', '2026-09-28', '2026-09-28').fraction, 2 / 3);
  // A full year: 365 days; the End Date is 364/365.
  const year = calendarProgress('2026-01-01', '2026-12-31', '2026-12-31');
  assert.equal(year.days, 365);
  assert.equal(year.fraction, 364 / 365);
});

test('QA KDG-16 calendarProgress: invalid and missing dates', () => {
  for (const bad of [null, undefined, '', '2026-13-01', '2026-02-30', '2026-1-01', '2026-10-01T00:00',
    20261001, ' 2026-10-01']) {
    assert.deepEqual(calendarProgress(bad, '2026-10-05', '2026-10-02'), { kind: 'missing' }, `start ${bad}`);
    assert.deepEqual(calendarProgress('2026-10-01', bad, '2026-10-02'), { kind: 'missing' }, `end ${bad}`);
    assert.deepEqual(calendarProgress('2026-10-01', '2026-10-05', bad), { kind: 'missing' }, `today ${bad}`);
  }
  assert.deepEqual(calendarProgress('2026-10-02', '2026-10-01', '2026-10-01'), { kind: 'invalid' });
});

// ---------------------------------------------------------------------------------------------
// buildBurndown: day boundaries in the viewer's time zone

const issue = (id, created) => ({ id, fields: { created, status: { name: 'To Do' } } });
const toDone = at => [{ at: new Date(at), from: 'To Do', to: 'Done' }];

test('QA KDG-16 burndown: Los Angeles, 23:30 on End Date (next day in UTC) is counted, 00:30 next day is not', () => {
  const issues = [issue('1', '2026-09-01T00:00:00Z'), issue('2', '2026-09-01T00:00:00Z')];
  const changes = new Map([
    ['1', toDone('2026-10-06T06:30:00Z')], // 5 Oct 23:30 PDT
    ['2', toDone('2026-10-06T07:30:00Z')], // 6 Oct 00:30 PDT
  ]);
  const result = buildBurndown(issues, changes, STATUSES, '2026-10-01', '2026-10-05', '2026-10-09',
    'America/Los_Angeles');
  assert.equal(result.remaining, 1);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 2, kind: 'start', offset: 0 },
    { date: '2026-10-05', remaining: 1, kind: 'end', offset: 5 },
  ]);
  // The same instants in UTC: both fall on 6 Oct, after the End Date, so neither counts.
  assert.equal(buildBurndown(issues, changes, STATUSES, '2026-10-01', '2026-10-05', '2026-10-09', 'UTC').remaining, 2);
});

test('QA KDG-16 burndown: Auckland, 00:30 the day after End Date (still End Date in UTC) is not counted', () => {
  const issues = [issue('1', '2026-09-01T00:00:00Z'), issue('2', '2026-09-01T00:00:00Z')];
  const changes = new Map([
    ['1', toDone('2026-10-05T10:30:00Z')], // 5 Oct 23:30 NZDT
    ['2', toDone('2026-10-05T11:30:00Z')], // 6 Oct 00:30 NZDT
  ]);
  const result = buildBurndown(issues, changes, STATUSES, '2026-10-01', '2026-10-05', '2026-10-09',
    'Pacific/Auckland');
  assert.equal(result.remaining, 1);
  assert.deepEqual(result.actual.at(-1), { date: '2026-10-05', remaining: 1, kind: 'end', offset: 5 });
});

test('QA KDG-16 burndown: issues created on End Date count, created the day after do not (Auckland)', () => {
  const issues = [
    issue('1', '2026-09-01T00:00:00Z'),
    issue('2', '2026-10-05T10:30:00Z'), // 5 Oct 23:30 NZDT: added on the End Date
    issue('3', '2026-10-05T11:30:00Z'), // 6 Oct 00:30 NZDT: after the period
  ];
  const result = buildBurndown(issues, new Map(), STATUSES, '2026-10-01', '2026-10-05', '2026-10-09',
    'Pacific/Auckland');
  assert.equal(result.baseline, 1);
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-05', remaining: 2, kind: 'end', offset: 5 },
  ]);
});

test('QA KDG-16 burndown: a Start Date change (00:30 local) is a step at the end of the first day', () => {
  const issues = [issue('1', '2026-09-01T00:00:00Z')];
  const changes = new Map([['1', toDone('2026-09-30T11:30:00Z')]]); // 1 Oct 00:30 NZDT
  const result = buildBurndown(issues, changes, STATUSES, '2026-10-01', '2026-10-05', '2026-10-03',
    'Pacific/Auckland');
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-01', remaining: 0, kind: 'end', offset: 1 },
    { date: '2026-10-03', remaining: 0, kind: 'today', offset: 3 },
  ]);
  // 23:30 the evening before the Start Date is part of the baseline, not a step.
  const before = buildBurndown(issues, new Map([['1', toDone('2026-09-30T10:30:00Z')]]), STATUSES,
    '2026-10-01', '2026-10-05', '2026-10-03', 'Pacific/Auckland');
  assert.equal(before.baseline, 0);
});

test('QA KDG-16 burndown: periods across DST changes keep one point per calendar day', () => {
  // US DST ends 1 Nov 2026 at 02:00 PDT. 1 Nov 23:30 PST is 2 Nov 07:30Z.
  const issues = [issue('1', '2026-10-01T00:00:00Z'), issue('2', '2026-10-01T00:00:00Z')];
  let result = buildBurndown(issues, new Map([
    ['1', toDone('2026-11-02T07:30:00Z')],
    ['2', toDone('2026-11-02T08:30:00Z')], // 2 Nov 00:30 PST: after the End Date
  ]), STATUSES, '2026-10-30', '2026-11-01', '2026-11-05', 'America/Los_Angeles');
  assert.equal(result.days, 3);
  assert.deepEqual(result.actual.at(-1), { date: '2026-11-01', remaining: 1, kind: 'end', offset: 3 });
  // NZ DST starts 27 Sep 2026: 27 Sep 23:30 NZDT is 27 Sep 10:30Z.
  const early = [issue('1', '2026-09-01T00:00:00Z'), issue('2', '2026-09-01T00:00:00Z')];
  result = buildBurndown(early, new Map([['1', toDone('2026-09-27T10:30:00Z')]]), STATUSES,
    '2026-09-26', '2026-09-27', '2026-09-30', 'Pacific/Auckland');
  assert.equal(result.days, 2);
  assert.deepEqual(result.actual.at(-1), { date: '2026-09-27', remaining: 1, kind: 'end', offset: 2 });
});

test('QA KDG-16 burndown: today = End Date is a today-so-far point on the right edge', () => {
  const issues = [issue('1', '2026-09-01T00:00:00Z')];
  const result = buildBurndown(issues, new Map(), STATUSES, '2026-10-01', '2026-10-05', '2026-10-05', 'UTC');
  assert.deepEqual(result.actual.at(-1), { date: '2026-10-05', remaining: 1, kind: 'today', offset: 5 });
  assert.equal(result.days, 5);
  // Offsets always increase and stay inside [0, days].
  const many = buildBurndown([issue('1', '2026-09-01T00:00:00Z'), issue('2', '2026-10-02T09:00:00Z')],
    new Map([['1', [{ at: new Date('2026-10-01T09:00:00Z'), from: 'To Do', to: 'In Progress' },
      { at: new Date('2026-10-04T09:00:00Z'), from: 'In Progress', to: 'Done' }]]]),
    STATUSES, '2026-10-01', '2026-10-05', '2026-10-09', 'UTC');
  const offsets = many.actual.map(p => p.offset);
  assert.deepEqual(offsets, [0, 1, 2, 4, 5]);
  assert.deepEqual(many.actual.map(p => p.kind), ['start', 'end', 'end', 'end', 'end']);
});

test('QA KDG-16 burndown: future, invalid and missing states are unchanged', () => {
  const issues = [issue('1', '2026-09-01T00:00:00Z')];
  assert.deepEqual(buildBurndown(issues, new Map(), STATUSES, '2026-10-02', '2026-10-05', '2026-10-01', 'UTC'),
    { kind: 'future' });
  assert.deepEqual(buildBurndown(issues, new Map(), STATUSES, '2026-10-05', '2026-10-04', '2026-10-06', 'UTC'),
    { kind: 'invalid' });
  assert.deepEqual(buildBurndown(issues, new Map(), STATUSES, null, '2026-10-04', '2026-10-06', 'UTC'),
    { kind: 'missing' });
  assert.deepEqual(buildBurndown([], new Map(), STATUSES, '2026-10-01', '2026-10-04', '2026-10-06', 'UTC'),
    { kind: 'empty' });
});

// ---------------------------------------------------------------------------------------------
// Gadget level, with a viewer time zone far from UTC.

function withClock(iso, fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(iso) });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

// A fake Jira with the given issues ({ id, created, change? }) all in To Do, weight 1; `change` is
// an instant at which the issue moved to Done.
function jiraWith(specs) {
  const issues = specs.map(({ id, created }) => ({
    id, key: `A-${id}`,
    fields: { summary: id, status: { id: '1', name: 'To Do' }, created, updated: created },
  }));
  return (path, body) => {
    if (path.includes('approximate-count')) return ok({ count: issues.length });
    if (path.includes('search/jql')) return ok({ issues, isLast: true });
    if (path.includes('changelog/bulkfetch')) {
      return ok({ issueChangeLogs: body.issueIdsOrKeys.map(issueId => {
        const spec = specs.find(s => s.id === issueId);
        return { issueId, changeHistories: spec?.change ? [{ created: spec.change,
          items: [{ fieldId: 'status', fromString: 'To Do', toString: 'Done' }] }] : [] };
      }) });
    }
    return undefined;
  };
}

const LEFT = 52;
const RIGHT = 737;

async function burndown(timezone, specs, startDate, endDate) {
  const g = await startGadget('burndown', { timezone, jira: jiraWith(specs) });
  await g.bus.send(FILTER_SELECTED, selection({ startDate, endDate }));
  await flush();
  const chart = g.find('burndown-chart');
  assert.ok(chart, g.root.textContent);
  return {
    chart,
    markers: g.findAll('burndown-marker').map(m => ({
      x: Number(m.find('burndown-point').getAttribute('cx')),
      title: m.querySelector('title').textContent,
    })),
    summary: g.find('burndown-summary')?.textContent ?? '',
  };
}

test('QA KDG-16 UI burndown: Los Angeles viewer counts a 23:30 End Date change on the right edge',
  withClock('2026-06-03T12:00:00Z', async () => {
    const { chart, markers } = await burndown('America/Los_Angeles', [
      { id: '1', created: '2026-05-01T00:00:00Z', change: '2026-05-30T06:30:00Z' }, // 29 May 23:30 PDT
      { id: '2', created: '2026-05-01T00:00:00Z', change: '2026-05-30T07:30:00Z' }, // 30 May 00:30 PDT
    ], '2026-05-25', '2026-05-29');
    assert.equal(chart.getAttribute('aria-label'), 'Weighted remaining work from 25 May 2026 to the end of ' +
      '29 May 2026. Starts at 2 and is 1 at the latest point.');
    assert.deepEqual(markers.map(m => m.x), [LEFT, RIGHT]);
    assert.match(markers[1].title, /^29 May 2026 · end of day\nRemaining weighted score: 1\nIdeal remaining: 0\n/);
  }));

test('QA KDG-16 UI burndown: Auckland viewer, End Date already over locally while still today in UTC',
  withClock('2026-06-01T12:30:00Z', async () => { // 2 Jun 00:30 NZST
    const { markers } = await burndown('Pacific/Auckland', [
      { id: '1', created: '2026-05-01T00:00:00Z', change: '2026-06-01T11:30:00Z' }, // 1 Jun 23:30 NZST
      { id: '2', created: '2026-05-01T00:00:00Z', change: '2026-06-01T12:15:00Z' }, // 2 Jun 00:15 NZST
    ], '2026-05-28', '2026-06-01');
    assert.equal(markers.length, 2);
    assert.equal(markers.at(-1).x, RIGHT);
    assert.match(markers.at(-1).title, /^1 Jun 2026 · end of day\nRemaining weighted score: 1\n/);
  }));

test('QA KDG-16 UI burndown: End Date is today, today so far on the right edge',
  withClock('2026-06-01T12:00:00Z', async () => {
    const { markers } = await burndown('UTC', [
      { id: '1', created: '2026-05-01T00:00:00Z', change: '2026-06-01T09:00:00Z' },
      { id: '2', created: '2026-05-01T00:00:00Z' },
    ], '2026-05-28', '2026-06-01');
    assert.deepEqual(markers.map(m => m.x), [LEFT, RIGHT]);
    assert.match(markers[1].title, /^1 Jun 2026 · today so far\nRemaining weighted score: 1\nIdeal remaining: 0\n/);
  }));

test('QA KDG-16 UI burndown: Start Date change sits at the end of the first day',
  withClock('2026-06-01T12:00:00Z', async () => {
    const { markers } = await burndown('UTC', [
      { id: '1', created: '2026-05-01T00:00:00Z', change: '2026-05-28T09:00:00Z' },
      { id: '2', created: '2026-05-01T00:00:00Z' },
    ], '2026-05-28', '2026-06-06'); // 10 days
    assert.equal(markers[0].x, LEFT);
    assert.ok(Math.abs(markers[1].x - (LEFT + (RIGHT - LEFT) / 10)) < 1e-9, String(markers[1].x));
    assert.match(markers[1].title, /^28 May 2026 · end of day\nRemaining weighted score: 1\nIdeal remaining: 1\.8\n/);
    assert.match(markers[0].title, /^28 May 2026 · start of day\n/);
  }));

test('QA KDG-16 UI progress-bar: Auckland viewer uses the local date for whole days',
  withClock('2026-06-01T12:30:00Z', async () => { // 2 Jun 00:30 NZST, 1 Jun in UTC
    const issues = [{ id: '1', key: 'A-1', fields: { status: { id: '1', name: 'To Do' } } }];
    const jira = path => path.includes('search/jql') ? ok({ issues, isLast: true })
      : path.includes('approximate-count') ? ok({ count: 1 }) : undefined;
    const g = await startGadget('progress-bar', { timezone: 'Pacific/Auckland', jira });
    const [timeTrack] = g.findAll('split-track');
    const show = async (startDate, endDate) => {
      await g.bus.send(FILTER_SELECTED, selection({ startDate, endDate }));
      await flush();
      return [timeTrack.getAttribute('aria-valuetext'), g.find('today-label')?.textContent ?? null];
    };
    assert.deepEqual(await show('2026-05-29', '2026-06-02'), ['80%. Day 5 of 5.', 'Today · 2 Jun 2026']);
    assert.deepEqual(await show('2026-05-28', '2026-06-01'), ['100%. The period ended on 1 Jun 2026.', 'Today · 2 Jun 2026']);
    assert.deepEqual(await show('2026-06-02', '2026-06-02'), ['0%. Day 1 of 1.', 'Today · 2 Jun 2026']);
    assert.deepEqual(await show('2026-06-03', '2026-06-04'), ['0%. The period starts on 3 Jun 2026.', 'Today · 2 Jun 2026']);
  }));

test('QA KDG-16 UI dates: Simple Dates shows the payload dates unchanged in a far time zone',
  withClock('2026-06-01T12:30:00Z', async () => {
    for (const timezone of ['Pacific/Auckland', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      const g = await startGadget('dates', { timezone });
      await g.bus.send(FILTER_SELECTED, selection({ startDate: '2026-06-01', endDate: '2026-06-01' }));
      await flush();
      const [start, end] = g.findAll('date-card-value');
      assert.deepEqual([start.textContent, end.textContent, end.getAttribute('datetime')],
        ['1 Jun 2026', '1 Jun 2026', '2026-06-01'], timezone);
    }
  }));
