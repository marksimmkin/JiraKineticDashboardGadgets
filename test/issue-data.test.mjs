import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredColumns, formatIssueField, orderedJql, searchAllIssues, summarizeAssignees } from '../static/issue-data.mjs';

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
    { fields: { assignee: { accountId: 'a', displayName: 'Alex' }, status: { id: '10000', name: 'To Do' }, timetracking: { remainingEstimateSeconds: 3600 } } },
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
  assert.equal(summary.rows.find(row => row.id === 'a').timeRemaining, 3600);
  assert.equal(summary.rows.find(row => row.id === 'a').estimatedIssues, 1);
  assert.equal(summary.rows.find(row => row.id === 'a').counts['to do'], 1);
  assert.equal(summary.rows.find(row => row.id === '__unassigned__').score, 1);
  assert.deepEqual(summary.unmapped, ['Review']);
});

test('issue list sorting replaces the outer JQL order without changing quoted text', () => {
  assert.equal(orderedJql('project = GAME ORDER BY updated DESC', 'priority', 'ASC'),
    'project = GAME ORDER BY priority ASC');
  assert.equal(orderedJql('summary ~ "ORDER BY" AND project = GAME', 'customfield_10001', 'DESC'),
    'summary ~ "ORDER BY" AND project = GAME ORDER BY cf[10001] DESC');
});

test('issue list sorting replaces a filter that is only an ORDER BY clause', () => {
  assert.equal(orderedJql('ORDER BY created DESC', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('  order by created desc', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('ORDER BY created DESC', 'customfield_10001', 'DESC'),
    'ORDER BY cf[10001] DESC');
  assert.equal(orderedJql('', 'key', 'DESC'), 'ORDER BY key DESC');
  assert.equal(orderedJql('(ORDER BY x) AND project = GAME', 'key', 'ASC'),
    '(ORDER BY x) AND project = GAME ORDER BY key ASC');
  assert.throws(() => orderedJql('ORDER BY created DESC', 'bad field', 'ASC'), /Invalid issue sort/);
  assert.throws(() => orderedJql('ORDER BY created DESC', 'key', 'UP'), /Invalid issue sort/);
});

test('QA KDG-1: leading ORDER BY handles whitespace, case and textarea newlines', () => {
  assert.equal(orderedJql('\nORDER BY created', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('\tORDER\tBY\tcreated', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('Order  By created DESC\n', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('ORDER\nBY created, key ASC', 'priority', 'DESC'), 'ORDER BY priority DESC');
  assert.equal(orderedJql('project = GAME\nORDER BY created', 'key', 'ASC'), 'project = GAME ORDER BY key ASC');
  assert.equal(orderedJql('   ', 'key', 'ASC'), 'ORDER BY key ASC');
});

test('QA KDG-1: ORDER BY lookalikes and quoted text are not treated as the outer order', () => {
  for (const jql of ['xORDER BY y', 'reorder by y', 'ORDERBY x', '"ORDER BY x"', "summary ~ 'ORDER BY x'",
    'summary ~ "a \\" ORDER BY x"', '(ORDER BY x)']) {
    assert.equal(orderedJql(jql, 'key', 'ASC'), `${jql} ORDER BY key ASC`);
  }
  assert.equal(orderedJql('summary ~ "a \\\\" ORDER BY x', 'key', 'ASC'), 'summary ~ "a \\\\" ORDER BY key ASC');
  assert.equal(orderedJql('summary ~ "ORDER BY" ORDER BY x', 'key', 'ASC'), 'summary ~ "ORDER BY" ORDER BY key ASC');
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
