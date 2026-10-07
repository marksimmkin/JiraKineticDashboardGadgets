import assert from 'node:assert/strict';
import test from 'node:test';
import { countIssues } from '../static/count.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';
import { calendarProgress, todayInTimezone, weightedProgress } from '../static/progress.mjs';
import { configuredFilters, configuredStatuses, isForDashboard, selectedFilterPayload,
  statusKey, validateFilters, validateStatuses } from '../static/shared.mjs';

test('saved filters are normalized and invalid entries are ignored', () => {
  const context = { extension: { gadgetConfiguration: { filters: [
    { name: ' Release ', jql: ' project = GAME ', startDate: '2026-01-01', endDate: '2026-03-31' },
    { name: 'Empty', jql: ' ' },
    { name: 'Legacy', jql: 'project = OLD' },
  ] } } };
  assert.deepEqual(configuredFilters(context), [
    { name: 'Release', jql: 'project = GAME', startDate: '2026-01-01', endDate: '2026-03-31' },
    { name: 'Legacy', jql: 'project = OLD', startDate: null, endDate: null },
  ]);
  assert.equal(validateFilters([{ name: 'A', jql: 'x' }, { name: 'a', jql: 'y' }]), 'Filter names must be unique.');
  assert.equal(validateFilters([{ name: 'A', jql: 'x', startDate: '2026-03-31', endDate: '2026-01-01' }]), 'Start Date must be on or before End Date.');
  assert.equal(validateFilters([{ name: 'A', jql: 'x', startDate: '2026-02-30' }]), 'Enter a valid Start Date.');
  assert.equal(isForDashboard({ dashboardId: '12' }, '12'), true);
  assert.equal(isForDashboard({ dashboardId: '13' }, '12'), false);
  const selectedContext = { extension: {
    dashboard: { id: '12' }, gadget: { id: '7' },
    gadgetConfiguration: { statuses: [
      { id: '100', name: 'In Progress', weight: 0.5 },
      { id: '200', name: 'in progress', weight: 0.8 },
    ] },
  } };
  assert.deepEqual(selectedFilterPayload(selectedContext, configuredFilters(context)[0]), {
    dashboardId: '12', controllerId: '7', name: 'Release', jql: 'project = GAME',
    startDate: '2026-01-01', endDate: '2026-03-31',
    statuses: [{ name: 'In Progress', weight: 0.5 }],
  });
  assert.deepEqual(configuredStatuses({ extension: { gadgetConfiguration: {} } }), []);
  assert.equal(statusKey(' To Do '), 'to do');
  assert.equal(validateStatuses([{ name: 'In Progress', weight: 0.5 }]), '');
  assert.equal(validateStatuses([{ name: 'To Do', weight: 0 }, { name: 'to do', weight: 1 }]), 'Each Jira status name can be added only once.');
  assert.equal(validateStatuses([{ name: 'Done', weight: 1.1 }]), 'Each status weight must be between 0 and 1.');
});

test('counter follows enhanced search pagination and counts all issues', async () => {
  const bodies = [];
  const request = async (_, options) => {
    bodies.push(JSON.parse(options.body));
    const page = bodies.length === 1
      ? { issues: [{ id: '1' }, { id: '2' }], isLast: false, nextPageToken: 'page-2' }
      : { issues: [{ id: '3' }], isLast: true };
    return { ok: true, json: async () => page };
  };
  assert.equal(await countIssues(request, 'project = GAME'), 3);
  assert.equal(bodies[0].jql, 'project = GAME');
  assert.equal(bodies[1].nextPageToken, 'page-2');
});

test('counter reports invalid JQL and refuses a missing next page', async () => {
  await assert.rejects(countIssues(async () => ({ ok: false, status: 400 }), 'bad'), /invalid/);
  await assert.rejects(countIssues(async () => ({ ok: true, json: async () => ({ issues: [], isLast: false }) }), 'x'), /next search page/);
});

test('status chart combines equal status names across IDs and search pages', async () => {
  const bodies = [];
  const request = async (_, options) => {
    bodies.push(JSON.parse(options.body));
    const page = bodies.length === 1
      ? { issues: [
        { fields: { status: { id: '100', name: 'To Do' } } },
        { fields: { status: { id: '200', name: 'In Progress' } } },
      ], isLast: false, nextPageToken: 'next' }
      : { issues: [
        { fields: { status: { id: '101', name: 'to do' } } },
        { fields: { status: { id: '999', name: 'Other' } } },
      ], isLast: true };
    return { ok: true, json: async () => page };
  };
  const statuses = [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }];
  assert.deepEqual(await countIssuesByStatus(request, 'project = GAME', statuses), {
    counts: { 'to do': 2, 'in progress': 1, 'done': 0 }, total: 4,
    unmapped: [{ name: 'Other', count: 1 }],
    statusIds: { 'to do': ['100', '101'], 'in progress': ['200'], other: ['999'] },
  });
  assert.deepEqual(bodies[0].fields, ['status']);
  assert.equal(bodies[1].nextPageToken, 'next');
});

test('calendar progress uses calendar dates and clamps at the boundaries', () => {
  assert.deepEqual(calendarProgress('2026-09-28', '2026-10-02', '2026-09-27'), { kind: 'ready', fraction: 0 });
  assert.deepEqual(calendarProgress('2026-09-28', '2026-10-02', '2026-09-30'), { kind: 'ready', fraction: 0.5 });
  assert.deepEqual(calendarProgress('2026-09-28', '2026-10-02', '2026-10-03'), { kind: 'ready', fraction: 1 });
  assert.deepEqual(calendarProgress('2026-10-01', '2026-10-01', '2026-10-01'), { kind: 'ready', fraction: 1 });
  assert.deepEqual(calendarProgress(null, '2026-10-02', '2026-10-01'), { kind: 'missing' });
  assert.deepEqual(calendarProgress('2026-10-02', '2026-10-01', '2026-10-01'), { kind: 'invalid' });
  assert.deepEqual(calendarProgress('2026-02-29', '2026-03-01', '2026-03-01'), { kind: 'missing' });
});

test('today is determined in the viewer timezone', () => {
  const instant = new Date('2026-10-01T00:30:00Z');
  assert.equal(todayInTimezone('Europe/London', instant), '2026-10-01');
  assert.equal(todayInTimezone('America/Los_Angeles', instant), '2026-09-30');
});

test('weighted work progresses from 1 to 0 and blocks missing weights', () => {
  const statuses = [
    { name: 'To Do', weight: 1 },
    { name: 'In Progress', weight: 0.5 },
    { name: 'Done', weight: 0 },
  ];
  assert.deepEqual(weightedProgress({
    counts: { 'to do': 1, 'in progress': 1, done: 1 }, total: 3, unmapped: [],
  }, statuses), { kind: 'ready', fraction: 0.5, remaining: 1.5, total: 3 });
  assert.deepEqual(weightedProgress({ counts: {}, total: 0, unmapped: [] }, statuses), { kind: 'empty' });
  assert.deepEqual(weightedProgress({
    counts: { 'to do': 1 }, total: 2, unmapped: [{ name: 'Review', count: 1 }],
  }, statuses), { kind: 'unmapped', statuses: [{ name: 'Review', count: 1 }] });
});
