// KDG-24: shown statuses set once in the Controller, Done hidden by default.
import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredStatuses, selectedFilterPayload, selectionKey, validateStatuses } from '../static/shared.mjs';
import { hiddenNote, isStatusShown, shownIssues, statusVisibility, visibilityJql }
  from '../static/status-visibility.mjs';
import { orderedJql, summarizeAssignees } from '../static/issue-data.mjs';
import { countIssuesByStatus } from '../static/status-counts.mjs';

const contextWith = statuses => ({ extension: {
  dashboard: { id: 'd1' }, gadget: { id: 'c1' }, gadgetConfiguration: { statuses },
} });
const filter = { name: 'F', jql: 'project = A', startDate: null, endDate: null };

// ---- shared.mjs ----

test('configuredStatuses keeps a boolean show and leaves it unset otherwise', () => {
  const statuses = configuredStatuses(contextWith([
    { name: 'To Do', weight: 0, show: true },
    { name: 'Closed', weight: 1, show: false },
    { name: 'Done', weight: 1 },
    { name: 'Odd', weight: 1, show: 'no' },
  ]));
  assert.deepEqual(statuses.map(status => status.show), [true, false, undefined, undefined]);
  assert.equal(Object.hasOwn(statuses[2], 'show'), false);
  assert.equal(Object.hasOwn(statuses[3], 'show'), false);
});

test('validateStatuses accepts show only as a boolean or undefined', () => {
  assert.equal(validateStatuses([{ name: 'A', weight: 0, show: true }, { name: 'B', weight: 0, show: false },
    { name: 'C', weight: 0 }, { name: 'D', weight: 0, show: undefined }]), '');
  for (const show of ['yes', 1, null]) {
    assert.equal(validateStatuses([{ name: 'A', weight: 0, show }]), 'Choose whether each status is shown.');
  }
});

test('selectedFilterPayload lists explicitly hidden and shown names in Controller order', () => {
  const payload = selectedFilterPayload(contextWith([
    { name: 'Won\'t Do', weight: 1, show: false },
    { name: 'To Do', weight: 0, show: true },
    { name: 'Done', weight: 1 },
    { name: 'Closed', weight: 1, show: false },
    { name: 'Released', weight: 1, show: true },
  ]), filter);
  assert.deepEqual(payload.hiddenStatuses, ['Won\'t Do', 'Closed']);
  assert.deepEqual(payload.shownStatuses, ['To Do', 'Released']);
  const none = selectedFilterPayload(contextWith([{ name: 'Done', weight: 1 }]), filter);
  assert.deepEqual([none.hiddenStatuses, none.shownStatuses], [[], []]);
});

test('selectionKey changes when the hidden or shown lists change', () => {
  const base = { revision: 'n:1', jql: 'x', statuses: [], hiddenStatuses: [], shownStatuses: [] };
  const key = selectionKey(base);
  assert.notEqual(selectionKey({ ...base, hiddenStatuses: ['Done'] }), key);
  assert.notEqual(selectionKey({ ...base, shownStatuses: ['Done'] }), key);
  // An older payload without the lists keys the same as empty lists.
  const { hiddenStatuses, shownStatuses, ...old } = base;
  assert.equal(selectionKey(old), key);
});

// ---- statusVisibility / isStatusShown ----

test('statusVisibility normalises names and treats older payloads as nothing explicit', () => {
  const visibility = statusVisibility({ hiddenStatuses: [' Closed ', 'closed', 'Done'],
    shownStatuses: ['Released', 'DONE', 42, ''] });
  assert.deepEqual([...visibility.hidden], ['closed', 'done']);
  assert.deepEqual(visibility.hiddenNames, ['Closed', 'Done']);
  assert.deepEqual([...visibility.shown], ['released']);
  assert.deepEqual(visibility.shownNames, ['Released']);
  for (const old of [{ statuses: [{ name: 'Done', weight: 1 }] }, null, undefined]) {
    const empty = statusVisibility(old);
    assert.deepEqual([empty.hidden.size, empty.shown.size, empty.hiddenNames, empty.shownNames], [0, 0, [], []]);
  }
});

test('isStatusShown: explicit hidden, then explicit shown, then category', () => {
  const visibility = statusVisibility({ hiddenStatuses: ['Closed'], shownStatuses: ['Released'] });
  assert.equal(isStatusShown('closed', 'indeterminate', visibility), false);
  assert.equal(isStatusShown(' Released ', 'done', visibility), true);
  assert.equal(isStatusShown('Done', 'done', visibility), false);
  assert.equal(isStatusShown('Done', 'DONE', visibility), false);
  assert.equal(isStatusShown('In Progress', 'indeterminate', visibility), true);
  assert.equal(isStatusShown('Mystery', undefined, visibility), true);
  const old = statusVisibility({});
  assert.equal(isStatusShown('Done', 'done', old), false);
  assert.equal(isStatusShown('To Do', 'new', old), true);
  assert.equal(isStatusShown('Done', 'done', undefined), false);
});

test('shownIssues filters each issue by its own status category', () => {
  const issue = (name, key) => ({ fields: { status: { name, statusCategory: { key } } } });
  const issues = [issue('Done', 'done'), issue('Done', 'indeterminate'), issue('Closed', 'new'),
    issue('Released', 'done'), issue('To Do', 'new'), { fields: {} }];
  const visibility = statusVisibility({ hiddenStatuses: ['Closed'], shownStatuses: ['Released'] });
  assert.deepEqual(shownIssues(issues, visibility), [issues[1], issues[3], issues[4], issues[5]]);
});

// ---- visibilityJql ----

test('visibilityJql with nothing explicit hides only the Done category', () => {
  assert.equal(visibilityJql('project = A', statusVisibility({})), '(project = A) AND (statusCategory != Done)');
  assert.equal(visibilityJql('', statusVisibility({})), '(statusCategory != Done)');
});

test('visibilityJql combines explicit hidden and shown names', () => {
  assert.equal(visibilityJql('project = A', statusVisibility({ hiddenStatuses: ['Closed', 'Won\'t Do'] })),
    '(project = A) AND (status not in ("Closed", "Won\'t Do")) AND (statusCategory != Done)');
  assert.equal(visibilityJql('project = A', statusVisibility({ shownStatuses: ['Released', 'To Do'] })),
    '(project = A) AND (statusCategory != Done OR status in ("Released", "To Do"))');
  assert.equal(visibilityJql('a = 1 OR b = 2',
    statusVisibility({ hiddenStatuses: ['Closed'], shownStatuses: ['Released'] })),
  '(a = 1 OR b = 2) AND (status not in ("Closed")) AND (statusCategory != Done OR status in ("Released"))');
});

test('visibilityJql quotes and escapes quotes and backslashes in names', () => {
  const jql = visibilityJql('project = A', statusVisibility({
    hiddenStatuses: ['Say "no"'], shownStatuses: ['Back\\slash'] }));
  assert.equal(jql, '(project = A) AND (status not in ("Say \\"no\\"")) AND ' +
    '(statusCategory != Done OR status in ("Back\\\\slash"))');
});

test('visibilityJql keeps ORDER BY at the end, including quoted ORDER BY text', () => {
  const visibility = statusVisibility({ hiddenStatuses: ['Closed'] });
  assert.equal(visibilityJql('project = A ORDER BY created DESC', visibility),
    '(project = A) AND (status not in ("Closed")) AND (statusCategory != Done) ORDER BY created DESC');
  assert.equal(visibilityJql('summary ~ "ORDER BY" ORDER BY key', visibility),
    '(summary ~ "ORDER BY") AND (status not in ("Closed")) AND (statusCategory != Done) ORDER BY key');
  assert.equal(visibilityJql('ORDER BY rank', visibility),
    '(status not in ("Closed")) AND (statusCategory != Done) ORDER BY rank');
});

test('visibilityJql composes with orderedJql in either order', () => {
  const visibility = statusVisibility({ hiddenStatuses: ['Closed'], shownStatuses: ['Released'] });
  const narrowed = '(project = A) AND (status not in ("Closed")) AND ' +
    '(statusCategory != Done OR status in ("Released"))';
  assert.equal(orderedJql(visibilityJql('project = A ORDER BY created DESC', visibility), 'key', 'ASC'),
    `${narrowed} ORDER BY key ASC`);
  assert.equal(visibilityJql(orderedJql('project = A ORDER BY created DESC', 'key', 'ASC'), visibility),
    `${narrowed} ORDER BY key ASC`);
});

// ---- hiddenNote ----

test('hiddenNote returns null when nothing is hidden', () => {
  assert.equal(hiddenNote(statusVisibility({})), null);
  assert.equal(hiddenNote(statusVisibility({ shownStatuses: ['Done'] }),
    { discovered: [{ name: 'Done', category: 'done' }, { name: 'To Do', category: 'new' }] }), null);
});

test('hiddenNote copy for listed names, with and without the clause', () => {
  const two = statusVisibility({ hiddenStatuses: ['Closed', 'Won\'t Do'] });
  assert.deepEqual(hiddenNote(two), { text: 'Hiding: Closed, Won\'t Do',
    fullText: 'Hiding issues in these statuses: Closed, Won\'t Do', fullList: 'Closed, Won\'t Do',
    truncated: false });
  assert.equal(hiddenNote(two, { includeUnlistedDoneClause: true }).text,
    'Hiding: Closed, Won\'t Do and unlisted Done statuses');
  assert.equal(hiddenNote(statusVisibility({ hiddenStatuses: ['Closed'] })).text, 'Hiding: Closed');
  assert.deepEqual(hiddenNote(statusVisibility({}), { includeUnlistedDoneClause: true }), {
    text: 'Hiding: unlisted Done statuses',
    fullText: 'Hiding issues in these statuses: unlisted Done statuses',
    fullList: 'unlisted Done statuses', truncated: false });
});

test('hiddenNote truncates after 3 names, with and without the clause', () => {
  const many = statusVisibility({ hiddenStatuses: ['Closed', 'Won\'t Do', 'Released', 'A', 'B', 'C', 'D'] });
  assert.deepEqual(hiddenNote(many), {
    text: 'Hiding: Closed, Won\'t Do, Released and 4 more',
    fullText: 'Hiding issues in these statuses: Closed, Won\'t Do, Released, A, B, C, D',
    fullList: 'Closed, Won\'t Do, Released, A, B, C, D', truncated: true });
  assert.deepEqual(hiddenNote(many, { includeUnlistedDoneClause: true }), {
    text: 'Hiding: Closed, Won\'t Do, Released, 4 more and unlisted Done statuses',
    fullText: 'Hiding issues in these statuses: Closed, Won\'t Do, Released, A, B, C, D and unlisted Done statuses',
    fullList: 'Closed, Won\'t Do, Released, A, B, C, D and unlisted Done statuses', truncated: true });
  const three = hiddenNote(statusVisibility({ hiddenStatuses: ['A', 'B', 'C'] }));
  assert.deepEqual([three.text, three.truncated], ['Hiding: A, B, C', false]);
});

test('hiddenNote adds discovered Done statuses after listed ones, sorted A-Z and de-duplicated', () => {
  const visibility = statusVisibility({ hiddenStatuses: ['Won\'t Do', 'Closed'], shownStatuses: ['Released'] });
  const note = hiddenNote(visibility, { discovered: [
    { name: 'Shipped', category: 'done' }, { name: 'closed', category: 'done' },
    { name: 'Released', category: 'done' }, { name: 'In Progress', category: 'indeterminate' },
    { name: 'Archived', category: 'done' }, { name: 'archived', category: 'done' },
  ] });
  assert.equal(note.text, 'Hiding: Won\'t Do, Closed, Archived and 1 more');
  assert.equal(note.fullList, 'Won\'t Do, Closed, Archived, Shipped');
  assert.equal(hiddenNote(statusVisibility({}), { discovered: [{ name: 'Done', category: 'done' }] }).text,
    'Hiding: Done');
});

// ---- categories in the data ----

test('countIssuesByStatus exposes each status category; shared names are Done only if all are', async () => {
  const status = (id, name, key) => ({ fields: { status: { id, name, ...(key ? { statusCategory: { key } } : {}) } } });
  const request = async () => ({ ok: true, json: async () => ({ isLast: true, issues: [
    status('1', 'To Do', 'new'), status('2', 'Done', 'done'), status('3', 'done', 'done'),
    status('4', 'Closed', 'done'), status('5', 'closed', 'indeterminate'), status('6', 'Other'),
  ] }) });
  const result = await countIssuesByStatus(request, 'x', [{ name: 'To Do' }, { name: 'Done' }, { name: 'Closed' }]);
  assert.deepEqual(result.categories, { 'to do': 'new', done: 'done', closed: 'indeterminate' });
});

test('summarizeAssignees exposes each discovered status category', () => {
  const issue = (name, key) => ({ fields: { assignee: null, status: { name, statusCategory: { key } } } });
  const summary = summarizeAssignees([issue('To Do', 'new'), issue('Done', 'done'),
    { fields: { assignee: null, status: { name: 'Mystery' } } }], [{ name: 'To Do', weight: 0 }]);
  assert.deepEqual(summary.statuses.map(({ name, category }) => [name, category]),
    [['To Do', 'new'], ['Done', 'done'], ['Mystery', null]]);
});
