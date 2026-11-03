import assert from 'node:assert/strict';
import test from 'node:test';
import { assigneeClause, issueSearchUrl, narrowJql, splitOrderBy, statusClause, statusesClause } from '../static/drilldown.mjs';
import { orderedJql } from '../static/issue-data.mjs';

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

test('KDG-2: narrowJql and orderedJql split ORDER BY the same way', () => {
  const cases = [
    // Quoted "order by" text, either quote style, is filter text.
    ['summary ~ "order by x" ORDER BY created', 'summary ~ "order by x"', 'ORDER BY created'],
    ["summary ~ 'ORDER BY x' ORDER BY created", "summary ~ 'ORDER BY x'", 'ORDER BY created'],
    // Bracketed ORDER BY is not the outer order.
    ['(ORDER BY x) AND project = GAME', '(ORDER BY x) AND project = GAME', ''],
    ['project = GAME AND (a = 1 ORDER BY b) ORDER BY c', 'project = GAME AND (a = 1 ORDER BY b)', 'ORDER BY c'],
    // Escaped quote stays inside the string; escaped backslash closes it.
    ['summary ~ "a \\" ORDER BY x"', 'summary ~ "a \\" ORDER BY x"', ''],
    ['summary ~ "a \\\\" ORDER BY x', 'summary ~ "a \\\\"', 'ORDER BY x'],
    // Leading ORDER BY, with case, tabs, newlines and surrounding whitespace.
    ['ORDER BY created DESC', '', 'ORDER BY created DESC'],
    ['\n  order\tby created\n', '', 'order\tby created'],
    ['ORDER\nBY created, key ASC', '', 'ORDER\nBY created, key ASC'],
    // Lookalikes are not ORDER BY.
    ['xORDER BY y', 'xORDER BY y', ''],
    ['ORDERBY x', 'ORDERBY x', ''],
    // Resolved differences: first top-level ORDER BY wins, long whitespace gaps
    // still match, and a bare trailing ORDER BY is still found.
    ['a = 1 ORDER BY b ORDER BY c', 'a = 1', 'ORDER BY b ORDER BY c'],
    ['a = 1 ORDER          BY created', 'a = 1', 'ORDER          BY created'],
    ['a = 1 ORDER BY', 'a = 1', 'ORDER BY'],
    // KDG-8: ORDER BY straight after a closing bracket or quote is found.
    ['project="A"ORDER BY x', 'project="A"', 'ORDER BY x'],
    ["project='A'ORDER BY x", "project='A'", 'ORDER BY x'],
    ['project in (A, B)ORDER BY x', 'project in (A, B)', 'ORDER BY x'],
    ['(a = 1)order by x DESC', '(a = 1)', 'order by x DESC'],
    ['summary ~ "a \\\\"ORDER BY x', 'summary ~ "a \\\\"', 'ORDER BY x'],
    // KDG-8 negatives: still not after a word character, inside a string right
    // after an opening or escaped quote, or inside brackets after a ).
    ['aORDER BY x', 'aORDER BY x', ''],
    ['summary ~ "ORDER BY x"', 'summary ~ "ORDER BY x"', ''],
    ["summary ~ 'a' AND b ~ 'ORDER BY x'", "summary ~ 'a' AND b ~ 'ORDER BY x'", ''],
    ['summary ~ "a \\"ORDER BY x"', 'summary ~ "a \\"ORDER BY x"', ''],
    ['((a = 1)ORDER BY x)', '((a = 1)ORDER BY x)', ''],
  ];
  for (const [jql, filter, order] of cases) {
    assert.deepEqual(splitOrderBy(jql), { filter, order }, jql);
    assert.equal(narrowJql(jql, ['status = "Done"']),
      `${filter ? `(${filter}) AND ` : ''}(status = "Done")${order ? ` ${order}` : ''}`, jql);
    assert.equal(orderedJql(jql, 'key', 'ASC'), `${filter ? `${filter} ` : ''}ORDER BY key ASC`, jql);
  }
});
