import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredColumns, formatIssueField, searchAllIssues, summarizeAssignees } from '../static/issue-data.mjs';

test('issue search follows every page and rejects a repeated cursor', async () => {
  const bodies = [];
  const request = async (_, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return { ok: true, json: async () => body.nextPageToken
      ? { issues: [{ id: '2' }], isLast: true }
      : { issues: [{ id: '1' }], isLast: false, nextPageToken: 'next' } };
  };
  assert.deepEqual(await searchAllIssues(request, 'project = GAME', ['assignee', 'status']),
    [{ id: '1' }, { id: '2' }]);
  assert.deepEqual(bodies[0].fields, ['assignee', 'status']);
  assert.equal(bodies[1].nextPageToken, 'next');
  await assert.rejects(searchAllIssues(async () => ({ ok: true, json: async () => ({
    issues: [], isLast: false, nextPageToken: 'same',
  }) }), 'x', []), /repeated/);
});

test('assignee summaries count statuses and weighted scores, including Unassigned', () => {
  const issues = [
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { id: '10000', name: 'To Do' } } },
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { name: 'Done' } } },
    { fields: { assignee: null, status: { id: '10006', name: 'to do' } } },
    { fields: { assignee: { accountId: 'b', displayName: 'Blair' }, status: { name: 'Review' } } },
  ];
  const summary = summarizeAssignees(issues, [
    { name: 'To Do', weight: 1 }, { name: 'Done', weight: 0 },
  ]);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.statuses.map(status => status.name), ['To Do', 'Done', 'Review']);
  assert.deepEqual(summary.statuses[0].ids, ['10000', '10006']);
  assert.equal(summary.rows.find(row => row.id === 'a').score, 1);
  assert.equal(summary.rows.find(row => row.id === 'a').counts['to do'], 1);
  assert.equal(summary.rows.find(row => row.id === '__unassigned__').score, 1);
  assert.deepEqual(summary.unmapped, ['Review']);
});

test('issue list columns are normalized and common field values are readable', () => {
  assert.deepEqual(configuredColumns({}), ['key', 'summary', 'status', 'assignee']);
  assert.deepEqual(configuredColumns({ extension: { gadgetConfiguration: {
    columns: ['key', 'customfield_10001', 'key', 'bad field'],
  } } }), ['key', 'customfield_10001']);
  assert.equal(formatIssueField({ displayName: 'Alex' }), 'Alex');
  assert.equal(formatIssueField([{ name: 'A' }, { name: 'B' }]), 'A, B');
  assert.equal(formatIssueField({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
  ] }), 'Hello');
});
