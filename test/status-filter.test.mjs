import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAssignees } from '../static/issue-data.mjs';
import { matchingStatusIssues, visibleIssueJql } from '../static/status-filter.mjs';

test('status selection changes assignee totals and ignores hidden unmapped weights', () => {
  const issues = [
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { id: '1', name: 'To Do' } } },
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { id: '2', name: 'Done' } } },
    { fields: { assignee: { accountId: 'b', displayName: 'Blair' }, status: { id: '3', name: 'Old Review' } } },
  ];
  const visible = [{ name: 'to do', ids: ['1'] }, { name: 'Done', ids: ['2'] }];
  const selected = matchingStatusIssues(issues, visible);
  const summary = summarizeAssignees(selected, [
    { name: 'To Do', weight: 1 }, { name: 'Done', weight: 0 },
  ]);
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.rows.map(row => [row.name, row.total, row.score]), [['Alex', 2, 1]]);
  assert.deepEqual(summary.unmapped, []);
});

test('selected status links open the same filtered issue scope', () => {
  const base = 'project = GAME ORDER BY created DESC';
  const all = [
    { name: 'To Do', ids: ['10000', '10001'] },
    { name: 'Done', ids: ['10002'] },
  ];
  assert.equal(visibleIssueJql(base, all, all), base);
  assert.equal(visibleIssueJql(base, all, [all[0]]),
    '(project = GAME) AND (status in ("10000", "10001")) ORDER BY created DESC');
  assert.equal(visibleIssueJql(base, all, []), null);
});
