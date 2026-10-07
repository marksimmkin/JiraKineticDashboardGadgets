import assert from 'node:assert/strict';
import test from 'node:test';
import { assigneeClause, issueSearchUrl, narrowJql, statusClause, statusesClause } from '../static/drilldown.mjs';

test('drill-down JQL keeps the base filter and moves its ordering to the end', () => {
  const base = 'project = GAME AND summary ~ "ORDER BY" ORDER BY updated DESC';
  assert.equal(narrowJql(base, [statusClause('To Do', ['10000', '10006'])]),
    '(project = GAME AND summary ~ "ORDER BY") AND (status in ("10000", "10006")) ORDER BY updated DESC');
  assert.equal(narrowJql('project = GAME', [assigneeClause('__unassigned__')]),
    '(project = GAME) AND (assignee is EMPTY)');
  assert.equal(narrowJql('project = GAME ORDER BY Rank ASC', [assigneeClause('abc:123'), statusClause('Done')]),
    '(project = GAME) AND (assignee = "abc:123") AND (status = "Done") ORDER BY Rank ASC');
});

test('status and URL clauses preserve exact status IDs and escape text', () => {
  assert.equal(statusesClause([
    { name: 'To Do', ids: ['10000', '10006'] }, { name: 'Done', ids: ['3'] },
  ]), '(status in ("10000", "10006") OR status in ("3"))');
  assert.equal(statusClause('Ready "now"'), 'status = "Ready \\"now\\""');
  assert.equal(issueSearchUrl('project = GAME AND status = "To Do"'),
    '/issues/?jql=project%20%3D%20GAME%20AND%20status%20%3D%20%22To%20Do%22');
});
