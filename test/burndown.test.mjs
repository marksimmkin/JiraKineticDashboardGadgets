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
  assert.deepEqual(calls[0].body.fields, ['created', 'status']);
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
    startDate: '2026-10-01', endDate: '2026-10-05',
    actual: [
      { date: '2026-10-01', remaining: 1 },
      { date: '2026-10-02', remaining: 0.5 },
      { date: '2026-10-03', remaining: 1 },
      { date: '2026-10-04', remaining: 0.5 },
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
    { date: '2026-09-30', remaining: 0 },
    { date: '2026-09-30', remaining: 1 },
    { date: '2026-10-01', remaining: 0 },
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
    { date: '2026-10-15', remaining: 1 },
    { date: '2026-10-15', remaining: 0.5 },
    { date: '2026-10-16', remaining: 0 },
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
    { date: '2026-10-01', remaining: 0.5 },
    { date: '2026-10-03', remaining: 0.5 },
  ]);
});
