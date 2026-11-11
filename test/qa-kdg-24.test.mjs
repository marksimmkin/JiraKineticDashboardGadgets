// QA for KDG-24: edge cases of the Controller status-visibility rule, its JQL, and the gadgets.
// Tests marked `todo` reproduce defects reported by QA; they do not fail the suite.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED, selectedFilterPayload } from '../static/shared.mjs';
import { hiddenNote, isStatusShown, shownIssues, statusVisibility, visibilityJql }
  from '../static/status-visibility.mjs';
import { splitOrderBy } from '../static/drilldown.mjs';
import { orderedJql } from '../static/issue-data.mjs';
import { fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

// ---- the rule ----

test('QA KDG-24: rule matrix (explicit, category, unknown, unlisted, older payload, both lists)', () => {
  const v = statusVisibility({ hiddenStatuses: ['Closed', ' BOTH '], shownStatuses: ['Released', 'both', 'Open'] });
  assert.equal(isStatusShown('Closed', 'indeterminate', v), false, 'explicit hidden, non-Done');
  assert.equal(isStatusShown('Released', 'done', v), true, 'explicit shown wins over Done');
  assert.equal(isStatusShown('Done', 'done', v), false, 'no flag, Done category');
  assert.equal(isStatusShown('In Progress', 'indeterminate', v), true, 'no flag, non-Done category');
  assert.equal(isStatusShown('Mystery', undefined, v), true, 'unknown category is shown');
  assert.equal(isStatusShown('Mystery', null, v), true);
  assert.equal(isStatusShown('Unlisted Done', 'DONE', v), false, 'category key is case-insensitive');
  assert.equal(isStatusShown('both', 'new', v), false, 'a name in both lists is hidden');
  assert.deepEqual(v.shownNames, ['Released', 'Open'], 'both-list name dropped from shown');
  assert.equal(isStatusShown('  closed ', 'new', v), false, 'case and whitespace ignored');
  const old = statusVisibility({ statuses: [{ name: 'Done', weight: 0 }] });
  assert.equal(isStatusShown('Done', 'done', old), false, 'older payload: Done hidden by category');
  assert.equal(isStatusShown('To Do', 'new', old), true);
  assert.equal(isStatusShown('Done', 'done', undefined), false, 'no visibility at all');
});

test('QA KDG-24: shownIssues on issues with no status field keeps them (Unknown status)', () => {
  const v = statusVisibility({});
  assert.equal(shownIssues([{ fields: {} }, { fields: { status: { name: 'D', statusCategory: { key: 'done' } } } }], v).length, 1);
});

test('QA KDG-24: payload lists de-duplicate case variants and keep Controller order', () => {
  const ctx = { extension: { dashboard: { id: 'd' }, gadget: { id: 'c' }, gadgetConfiguration: { statuses: [
    { name: 'Done', weight: 0, show: true }, { name: 'DONE', weight: 0, show: false },
    { name: 'Closed', weight: 0, show: false }, { name: 'To Do', weight: 1 }] } } };
  const payload = selectedFilterPayload(ctx, { name: 'F', jql: 'x = 1' });
  // configuredStatuses keeps the first of case-equal names.
  assert.deepEqual([payload.hiddenStatuses, payload.shownStatuses], [['Closed'], ['Done']]);
});

// ---- JQL ----

test('QA KDG-24: visibilityJql quoting of double quote, backslash and single quote', () => {
  const v = statusVisibility({ hiddenStatuses: ['Say "hi"', 'Back\\slash', "Won't Do"], shownStatuses: ['It\'s "done"'] });
  assert.equal(visibilityJql('project = A', v),
    '(project = A) AND (status not in ("Say \\"hi\\"", "Back\\\\slash", "Won\'t Do")) AND ' +
    '(statusCategory != Done OR status in ("It\'s \\"done\\""))');
});

test('QA KDG-24: visibilityJql with empty, order-only, lower-case and quoted ORDER BY JQL', () => {
  const none = statusVisibility({});
  assert.equal(visibilityJql('', none), '(statusCategory != Done)');
  assert.equal(visibilityJql(null, none), '(statusCategory != Done)');
  assert.equal(visibilityJql('ORDER BY rank', none), '(statusCategory != Done) ORDER BY rank');
  assert.equal(visibilityJql('project = A order by created desc', none),
    '(project = A) AND (statusCategory != Done) order by created desc');
  assert.equal(visibilityJql('summary ~ "order by" ORDER BY key', none),
    '(summary ~ "order by") AND (statusCategory != Done) ORDER BY key');
  // An OR in the filter stays grouped, so the visibility clauses apply to every branch.
  assert.equal(visibilityJql('a = 1 OR b = 2', none), '(a = 1 OR b = 2) AND (statusCategory != Done)');
  // Approximate count drops ORDER BY and gets a non-empty filter for an order-only JQL.
  assert.equal(splitOrderBy(visibilityJql('ORDER BY rank', none)).filter, '(statusCategory != Done)');
});

test('QA KDG-24: List column sorting replaces the filter ORDER BY on the narrowed JQL', () => {
  const v = statusVisibility({ hiddenStatuses: ['Closed'] });
  const narrowed = visibilityJql('project = A ORDER BY rank', v);
  assert.equal(orderedJql(narrowed, 'customfield_10010', 'DESC'),
    '(project = A) AND (status not in ("Closed")) AND (statusCategory != Done) ORDER BY cf[10010] DESC');
  assert.equal(orderedJql(visibilityJql('ORDER BY rank', v), 'key', 'ASC'),
    '(status not in ("Closed")) AND (statusCategory != Done) ORDER BY key ASC');
});

test('QA KDG-24: very long status lists still compose one valid clause each', () => {
  const names = Array.from({ length: 200 }, (_, i) => `Status ${i}`);
  const jql = visibilityJql('project = A', statusVisibility({ hiddenStatuses: names, shownStatuses: ['X'] }));
  assert.equal((jql.match(/status not in \(/g) ?? []).length, 1);
  assert.ok(jql.endsWith('(statusCategory != Done OR status in ("X"))'));
});

// ---- the note ----

test('QA KDG-24: note copy at exactly 3 names is not truncated; empty discovered names ignored', () => {
  const v = statusVisibility({ hiddenStatuses: ['A', 'B', 'C'] });
  assert.deepEqual(hiddenNote(v), { text: 'Hiding: A, B, C', fullText: 'Hiding issues in these statuses: A, B, C',
    fullList: 'A, B, C', truncated: false });
  assert.equal(hiddenNote(statusVisibility({}), { discovered: [{ name: '', category: 'done' }, { name: 'X', category: 'new' }] }), null);
  assert.equal(hiddenNote(statusVisibility({}), { includeUnlistedDoneClause: true }).text, 'Hiding: unlisted Done statuses');
});

// ---- gadgets ----

// Two Jira statuses called "Closed": id 20 is Done, id 21 is not. Neither has a Show flag (an older
// Controller config, or a save while Jira statuses could not load).
const MIXED_CLOSED = [
  { id: '1', key: 'A-1', fields: { status: { id: '20', name: 'Closed', statusCategory: { key: 'done' } },
    assignee: { accountId: 'u', displayName: 'U' }, summary: 's', timetracking: {} } },
  { id: '2', key: 'A-2', fields: { status: { id: '21', name: 'Closed', statusCategory: { key: 'indeterminate' } },
    assignee: { accountId: 'u', displayName: 'U' }, summary: 's', timetracking: {} } },
];
const jiraWith = issues => path => {
  if (path.includes('approximate-count')) return ok({ count: issues.length });
  if (path.includes('search/jql')) return ok({ issues, isLast: true });
  return undefined;
};
const MIXED_SELECTION = { statuses: [{ name: 'Closed', weight: 1, color: '#0c66e4' }], hiddenStatuses: [], shownStatuses: [] };

test('QA KDG-24: user-list applies rule (b) per issue for a shared, mixed-category name', withTimers(async () => {
  const g = await startGadget('user-list', { jira: jiraWith(MIXED_CLOSED) });
  await g.bus.send(FILTER_SELECTED, selection(MIXED_SELECTION));
  await flush();
  assert.match(g.find('status').textContent, /^1 issues in shown statuses/);
}));

// QA defect D1 (fixed): the charts apply rule (b) per issue, as the Counter and User List do.
for (const name of ['status-chart', 'status-pie']) {
  test(`QA KDG-24: ${name} excludes the Done-category issue of a mixed-category name`, withTimers(async () => {
    const g = await startGadget(name, { jira: jiraWith(MIXED_CLOSED) });
    await g.bus.send(FILTER_SELECTED, selection(MIXED_SELECTION));
    await flush();
    // Producer decision: rule (b) still applies per issue to unflagged statuses, so only A-2 is shown.
    if (name === 'status-chart') assert.deepEqual(g.findAll('status-bar-number').map(n => n.textContent), ['1']);
    else assert.match(g.find('pie-legend-value').textContent, /^1 · 100%$/);
    assert.equal(g.find('status').textContent, name === 'status-chart'
      ? '1 of 2 issues in shown statuses' : '1 of 2 matching issues in shown statuses');
    assert.equal(g.find('status-hidden-note').hidden, true, 'Closed is not hidden by name');
    // The shown-count link uses the shown issue's status ID only.
    g.findAll('issue-count-link').find(b => b.getAttribute('aria-label') === 'Open 1 issues in shown statuses').click();
    await flush();
    assert.equal(decodeURIComponent(g.opened.at(-1)), '/issues/?jql=(project = A) AND (status in ("21"))');
  }));
}

// The Controller: a saved show: true on a Done status is lost when the select is moved away and back.
const FILTERS = [{ name: 'Alpha', jql: 'project = A', startDate: null, endDate: null }];
const JIRA_STATUSES = [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }];

// QA defect D3 (fixed).
test('QA KDG-24: moving an untouched row away from its saved status and back restores the saved flag',
  withTimers(async () => {
    const c = await startGadget('controller', { entryPoint: 'edit', jira: path => (path === '/rest/api/3/status' ? ok(JIRA_STATUSES) : undefined),
      configuration: { filters: FILTERS, statuses: [{ name: 'Done', weight: 0, color: '#22a06b', show: true }] } });
    const [row] = c.findAll('status-row');
    const select = row.find('status-select');
    assert.equal(row.find('status-show-input').checked, true);
    select.value = 'to do'; select.dispatchEvent({ type: 'change' });
    select.value = 'done'; select.dispatchEvent({ type: 'change' });
    assert.equal(row.find('status-show-input').checked, true, 'back on the saved status, the saved flag applies');
    c.panel().dispatchEvent({ type: 'submit', preventDefault() {} });
    await flush();
    assert.equal(c.submitted.at(-1).statuses[0].show, true, 'and the saved flag is what is written');
  }));

test('QA KDG-24: with statuses unavailable, a saved unflagged Done row shows a tick that does not apply',
  withTimers(async () => {
    const c = await startGadget('controller', { entryPoint: 'edit', jira: path => (path === '/rest/api/3/status' ? fail(500) : undefined),
      configuration: { filters: FILTERS, statuses: [{ name: 'Done', weight: 0, color: '#22a06b' }] } });
    const [row] = c.findAll('status-row');
    assert.equal(row.find('status-show-input').checked, true, 'ticked (category unknown)');
    c.panel().dispatchEvent({ type: 'submit', preventDefault() {} });
    await flush();
    // No flag is written, so every gadget still hides Done by its category (QA observation D2).
    assert.equal(Object.hasOwn(c.submitted.at(-1).statuses[0], 'show'), false);
  }));

// KDG-24 review R1: a 400 with explicit Controller names gets a message pointing at them.
test('QA KDG-24: a mistyped manual hidden name goes into the Counter JQL; Jira 400 names the cause',
  withTimers(async () => {
    const g = await startGadget('counter', { jira: path => {
      if (path.includes('approximate-count')) return fail(400);
      if (path.includes('search/jql')) return fail(400);
      return undefined;
    } });
    await g.bus.send(FILTER_SELECTED, selection({ statuses: [{ name: 'Clsoed', weight: 0, show: false }],
      hiddenStatuses: ['Clsoed'], shownStatuses: [] }));
    await flush();
    const exact = g.requests.find(r => r.path.includes('search/jql'));
    assert.equal(exact.body.jql, '(project = A) AND (status not in ("Clsoed")) AND (statusCategory != Done)');
    assert.equal(g.find('status').textContent, "Jira didn't accept a status name set in the Controller. " +
      "Check the status names in the Controller's Edit settings.");
  }));

// ---- recheck after review fixes ----

test('QA KDG-24 recheck: a listed unflagged Done status with only hidden issues is in the note, has no bar, and counts in the total',
  withTimers(async () => {
    const issues = [
      { id: '1', key: 'A-1', fields: { status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } } },
      { id: '2', key: 'A-2', fields: { status: { id: '10', name: 'Done', statusCategory: { key: 'done' } } } },
      { id: '3', key: 'A-3', fields: { status: { id: '10', name: 'Done', statusCategory: { key: 'done' } } } },
    ];
    for (const name of ['status-chart', 'status-pie']) {
      const g = await startGadget(name, { jira: jiraWith(issues) });
      await g.bus.send(FILTER_SELECTED, selection({ hiddenStatuses: [], shownStatuses: [] }));
      await flush();
      assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Done', name);
      const labels = [...g.findAll('status-bar-label'), ...g.findAll('pie-legend-name')].map(l => l.textContent);
      assert.deepEqual(labels, ['To Do'], name);
      assert.match(g.find('status').textContent, /^1 of 3 /, name);
    }
  }));

test('QA KDG-24 recheck: approximate 400 stays silent; exact 403 keeps its message with explicit names',
  withTimers(async () => {
    const g = await startGadget('counter', { jira: path => {
      if (path.includes('approximate-count')) return fail(400);
      if (path.includes('search/jql')) return fail(403);
      return undefined;
    } });
    await g.bus.send(FILTER_SELECTED, selection({ statuses: [{ name: 'Closed', weight: 0, show: false }],
      hiddenStatuses: ['Closed'], shownStatuses: [] }));
    await flush();
    assert.equal(g.find('status').textContent, 'You cannot view issues for this filter.');
    assert.ok(!g.root.textContent.includes("didn't accept"));
  }));

test('QA KDG-24 recheck: exact 400 with no explicit names keeps the generic JQL message', withTimers(async () => {
  const g = await startGadget('counter', { jira: path => (path.includes('search/jql') || path.includes('approximate-count')
    ? fail(400) : undefined) });
  await g.bus.send(FILTER_SELECTED, selection());
  await flush();
  assert.match(g.find('status').textContent, /JQL is invalid/);
}));
