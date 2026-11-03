import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBurndown, fetchBurndownIssues, fetchStatusChanges } from '../static/burndown.mjs';

const statuses = [
  { name: 'To Do', weight: 1 },
  { name: 'In Progress', weight: 0.5 },
  { name: 'Done', weight: 0 },
];

test('burndown search and bulk status history follow their pagination tokens', async () => {
  const calls = [];
  const request = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    const page = path.includes('search/jql')
      ? body.nextPageToken
        ? { issues: [{ id: '2', fields: { created: '2026-10-01T12:00:00Z', status: { name: 'Done' } } }], isLast: true }
        : { issues: [{ id: '1', fields: { created: '2026-09-30T12:00:00Z', status: { name: 'Done' } } }], isLast: false, nextPageToken: 'search-2' }
      : body.nextPageToken
        ? { issueChangeLogs: [{ issueId: '2', changeHistories: [] }] }
        : { issueChangeLogs: [{ issueId: '1', changeHistories: [{
          created: 1791032400, items: [{ fieldId: 'status', fromString: 'To Do', toString: 'Done' }],
        }] }], nextPageToken: 'changes-2' };
    return { ok: true, json: async () => page };
  };
  const issues = await fetchBurndownIssues(request, 'project = GAME');
  const changes = await fetchStatusChanges(request, issues);
  assert.equal(issues.length, 2);
  assert.equal(changes.get('1')[0].from, 'To Do');
  assert.equal(changes.get('1')[0].at.getUTCFullYear(), 2026);
  assert.deepEqual(calls[0].body.fields, ['created', 'status', 'updated']);
  assert.equal(calls[1].body.nextPageToken, 'search-2');
  assert.deepEqual(calls[2].body.fieldIds, ['status']);
  assert.equal(calls[3].body.nextPageToken, 'changes-2');
});

test('burndown includes scope additions and daily status changes', () => {
  const issues = [
    { id: '1', fields: { created: '2026-09-30T10:00:00Z', status: { name: 'Done' } } },
    { id: '2', fields: { created: '2026-10-03T10:00:00Z', status: { name: 'In Progress' } } },
  ];
  const changes = new Map([
    ['1', [
      { at: new Date('2026-10-02T12:00:00Z'), from: 'To Do', to: 'In Progress' },
      { at: new Date('2026-10-03T12:00:00Z'), from: 'In Progress', to: 'Done' },
    ]],
    ['2', [{ at: new Date('2026-10-04T12:00:00Z'), from: 'To Do', to: 'In Progress' }]],
  ]);
  assert.deepEqual(buildBurndown(issues, changes, statuses,
    '2026-10-01', '2026-10-05', '2026-10-04', 'UTC'), {
    kind: 'ready', baseline: 1, remaining: 0.5, total: 2,
    startDate: '2026-10-01', endDate: '2026-10-05', days: 5,
    actual: [
      { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
      { date: '2026-10-02', remaining: 0.5, kind: 'end', offset: 2 },
      { date: '2026-10-03', remaining: 1, kind: 'end', offset: 3 },
      { date: '2026-10-04', remaining: 0.5, kind: 'today', offset: 4 },
    ],
  });
});

test('burndown uses viewer day boundaries and rejects unmapped historical statuses', () => {
  const issues = [{ id: '1', fields: {
    created: '2026-10-01T00:30:00Z', status: { name: 'Done' },
  } }];
  const changes = new Map([['1', [{
    at: new Date('2026-10-02T00:30:00Z'), from: 'To Do', to: 'Done',
  }]]]);
  const result = buildBurndown(issues, changes, statuses,
    '2026-09-30', '2026-10-02', '2026-10-01', 'America/Los_Angeles');
  assert.deepEqual(result.actual, [
    { date: '2026-09-30', remaining: 0, kind: 'start', offset: 0 },
    { date: '2026-09-30', remaining: 1, kind: 'end', offset: 1 },
    { date: '2026-10-01', remaining: 0, kind: 'today', offset: 2 },
  ]);
  assert.deepEqual(buildBurndown(issues, changes, [{ name: 'Done', weight: 0 }],
    '2026-09-30', '2026-10-02', '2026-10-01', 'America/Los_Angeles'), {
    kind: 'unmapped', statuses: ['To Do'],
  });
});

test('burndown shows progress made on the start date and subsequent day', () => {
  const issues = [{ id: '1', fields: {
    created: '2026-10-10T09:00:00Z', status: { name: 'Done' },
  } }];
  const changes = new Map([['1', [
    { at: new Date('2026-10-15T12:00:00Z'), from: 'To Do', to: 'In Progress' },
    { at: new Date('2026-10-16T12:00:00Z'), from: 'In Progress', to: 'Done' },
  ]]]);
  const result = buildBurndown(issues, changes, statuses,
    '2026-10-15', '2026-10-30', '2026-10-16', 'Europe/London');
  assert.equal(result.baseline, 1);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.actual, [
    { date: '2026-10-15', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-15', remaining: 0.5, kind: 'end', offset: 1 },
    { date: '2026-10-16', remaining: 0, kind: 'today', offset: 2 },
  ]);
});

test('burndown starts from the status at the start date and stops at the end date', () => {
  const issues = [{ id: '1', fields: {
    created: '2026-09-20T10:00:00Z', status: { name: 'Done' },
  } }];
  const changes = new Map([['1', [
    { at: new Date('2026-09-30T10:00:00Z'), from: 'To Do', to: 'In Progress' },
    { at: new Date('2026-10-05T10:00:00Z'), from: 'In Progress', to: 'Done' },
  ]]]);
  const result = buildBurndown(issues, changes, statuses,
    '2026-10-01', '2026-10-03', '2026-10-06', 'UTC');
  assert.equal(result.baseline, 0.5);
  assert.equal(result.remaining, 0.5);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 0.5, kind: 'start', offset: 0 },
    { date: '2026-10-03', remaining: 0.5, kind: 'end', offset: 3 },
  ]);
  assert.equal(result.days, 3);
});

test('burndown points sit on day boundaries of an inclusive period', () => {
  const issues = [{ id: '1', fields: { created: '2026-09-20T10:00:00Z', status: { name: 'To Do' } } }];
  const noChanges = new Map();
  const withChange = at => new Map([['1', [{ at: new Date(at), from: 'To Do', to: 'Done' }]]]);
  const run = (changes, start, end, today) => buildBurndown(issues, changes, statuses, start, end, today, 'UTC');

  // One-day period viewed on its day: baseline at the left edge, today so far at the right edge.
  let result = run(noChanges, '2026-10-01', '2026-10-01', '2026-10-01');
  assert.equal(result.days, 1);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-01', remaining: 1, kind: 'today', offset: 1 },
  ]);

  // One-day period viewed after it ended, with a change on that day (the End Date) counted.
  result = run(withChange('2026-10-01T15:00:00Z'), '2026-10-01', '2026-10-01', '2026-10-05');
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-01', remaining: 0, kind: 'end', offset: 1 },
  ]);

  // Today is the Start Date of a longer period: a flat today-so-far segment across the first day.
  result = run(noChanges, '2026-10-01', '2026-10-05', '2026-10-01');
  assert.equal(result.days, 5);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-01', remaining: 1, kind: 'today', offset: 1 },
  ]);

  // Today after the End Date: a change on the End Date is included and sits on the right edge;
  // later changes are not counted.
  result = run(new Map([['1', [
    { at: new Date('2026-10-05T23:00:00Z'), from: 'To Do', to: 'In Progress' },
    { at: new Date('2026-10-06T09:00:00Z'), from: 'In Progress', to: 'Done' },
  ]]]), '2026-10-01', '2026-10-05', '2026-10-09');
  assert.equal(result.remaining, 0.5);
  assert.deepEqual(result.actual, [
    { date: '2026-10-01', remaining: 1, kind: 'start', offset: 0 },
    { date: '2026-10-05', remaining: 0.5, kind: 'end', offset: 5 },
  ]);

  // Today after the End Date with no changes: the End Date's score closes the period.
  result = run(noChanges, '2026-10-01', '2026-10-05', '2026-10-09');
  assert.deepEqual(result.actual.at(-1), { date: '2026-10-05', remaining: 1, kind: 'end', offset: 5 });
});
