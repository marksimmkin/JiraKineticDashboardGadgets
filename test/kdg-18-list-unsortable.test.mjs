// KDG-18: a List column Jira can't sort by must never leave the List stuck in an error.
// View mode reads Jira's field catalogue and makes headings of non-orderable fields plain text;
// if Jira still rejects a sorted search (400), the List drops the sort, makes that heading
// plain, reloads in the filter's order and says so in a note above the table.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED, GADGET_REFRESH } from '../static/shared.mjs';
import { FIELD_CATALOGUE, fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const CONFIG = {
  columns: ['key', 'summary', 'description', 'status'],
  columnLabels: { key: 'Issue key', summary: 'Summary', description: 'Description', status: 'Status' },
};
const TITLE = "Jira can't sort by this field";
const NOTE = "Jira couldn't sort by Description, so issues are in the filter's order.";
const CATALOGUE = [
  { id: 'summary', name: 'Summary', orderable: true },
  { id: 'description', name: 'Description', orderable: false },
  { id: 'status', name: 'Status', orderable: true },
  { id: 'created', name: 'Created', orderable: false }, // built-in fallback field: stays sortable
];

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const makeIssues = (prefix, count) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}${i + 1}`, key: `${prefix}-${i + 1}`,
  fields: { summary: `${prefix} ${i + 1}`, description: null,
    status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } },
}));

const headings = g => g.root.querySelectorAll('th');
const heading = (g, label) => headings(g).find(th => th.textContent.replace(/ [↑↓]$/, '') === label);
const button = (g, label) => heading(g, label).querySelector('button');
const sortNote = g => g.find('issue-list-sort-note');
const searches = g => g.pending('search/jql');
const rows = g => g.root.querySelectorAll('tr').slice(1).map(r => r.children[0].textContent);

async function start({ catalogue } = {}) {
  const g = await startGadget('issue-list', { configuration: CONFIG });
  const [field] = g.pending(FIELD_CATALOGUE);
  if (catalogue !== undefined) {
    field.resolve(catalogue);
    await flush();
  }
  return { g, field };
}

async function selectAndLoad(g, overrides, page = { issues: makeIssues('A', 2), isLast: true }) {
  await g.bus.send(FILTER_SELECTED, selection(overrides));
  await flush();
  searches(g)[0].resolve(ok(page));
  await flush();
}

function assertPlain(g, label) {
  const th = heading(g, label);
  assert.equal(th.querySelector('button'), null, `${label} has no sort button`);
  assert.equal(th.textContent, label);
  assert.equal(th.hasAttribute('aria-sort'), false, `${label} has no aria-sort at all`);
  assert.equal(th.getAttribute('title'), TITLE);
  assert.equal(th.scope, 'col');
}

function assertSortable(g, label) {
  const th = heading(g, label);
  assert.ok(th.querySelector('button.table-sort-button'), `${label} is a sort button`);
  assert.ok(th.hasAttribute('aria-sort'), `${label} keeps aria-sort`);
  assert.equal(th.getAttribute('title'), null);
}

test('KDG-18 issue-list: view mode reads the field catalogue once on load', withTimers(async () => {
  const { g, field } = await start();
  assert.ok(field, 'a /rest/api/3/field request was sent');
  assert.equal(g.requests.filter(r => r.path === FIELD_CATALOGUE).length, 1);
  await selectAndLoad(g);
  await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await flush();
  assert.equal(g.requests.filter(r => r.path === FIELD_CATALOGUE).length, 1, 'not again on refresh');
}));

test('KDG-18 issue-list: headings are sort buttons while the catalogue loads, then non-orderable ones turn plain',
  withTimers(async () => {
    const { g, field } = await start();
    for (const label of ['Issue key', 'Summary', 'Description', 'Status']) assertSortable(g, label);
    assert.equal(heading(g, 'Description').getAttribute('aria-sort'), 'none');
    field.resolve(ok(CATALOGUE));
    await flush();
    assertPlain(g, 'Description');
    for (const label of ['Issue key', 'Summary', 'Status']) assertSortable(g, label);
    assert.equal(g.findAll('table-sort-button').length, 3);
    assert.deepEqual(headings(g).map(th => th.textContent.replace(/ [↑↓]$/, '')),
      ['Issue key', 'Summary', 'Description', 'Status'], 'swapped in place');
  }));

test('KDG-18 issue-list: key, built-in fields and fields missing from the catalogue stay sortable',
  withTimers(async () => {
    const g = await startGadget('issue-list', { configuration: {
      columns: ['key', 'created', 'customfield_1'], columnLabels: { customfield_1: 'Team' } } });
    g.pending(FIELD_CATALOGUE)[0].resolve(ok([{ id: 'key', orderable: false },
      { id: 'created', orderable: false }]));
    await flush();
    assert.equal(g.findAll('table-sort-button').length, 3);
  }));

for (const [what, response] of [['a failed response', fail(500)], ['a non-array body', ok({ nope: 1 })],
  ['a rejected request', null]]) {
  test(`KDG-18 issue-list: ${what} for the catalogue keeps every heading sortable, with no message`,
    withTimers(async () => {
      const { g, field } = await start();
      const before = g.root.textContent;
      if (response) field.resolve(response); else field.reject(new Error('network'));
      await flush();
      assert.equal(g.findAll('table-sort-button').length, 4);
      assert.equal(g.root.textContent, before, 'nothing shown');
      assert.equal(sortNote(g).hidden, true);
    }));
}

test('KDG-18 issue-list: a sorted 400 clears the sort, makes the heading plain and reloads in filter order with a note',
  withTimers(async () => {
    const { g } = await start({ catalogue: fail(500) });
    await selectAndLoad(g);
    assert.equal(sortNote(g).hidden, true, 'no note before a fallback');
    assert.equal(sortNote(g).getAttribute('role'), 'status');
    button(g, 'Description').click();
    await flush();
    const [sorted] = searches(g);
    assert.match(sorted.body.jql, / ORDER BY description ASC$/);
    sorted.resolve(fail(400));
    await flush();
    assertPlain(g, 'Description');
    for (const label of ['Issue key', 'Summary', 'Status']) {
      assert.equal(heading(g, label).getAttribute('aria-sort'), 'none');
      assert.ok(!button(g, label).textContent.match(/[↑↓]/), 'no arrow anywhere');
    }
    const [reload] = searches(g);
    assert.equal(reload.body.jql, '(project = A) AND (statusCategory != Done)', 'the filter\'s own order');
    assert.equal(reload.body.nextPageToken, undefined, 'from page 1');
    assert.equal(sortNote(g).hidden, false);
    assert.equal(sortNote(g).textContent, NOTE);
    reload.resolve(ok({ issues: makeIssues('R', 2), isLast: true }));
    await flush();
    assert.deepEqual(rows(g), ['R-1', 'R-2']);
    assert.equal(g.find('status').textContent, '2 issues loaded here · click count for the full Jira list');
    assert.equal(sortNote(g).textContent, NOTE, 'note kept once the reload succeeds');
    // Later filter changes and refreshes do not fail on the dropped sort.
    await g.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
    await flush();
    assert.ok(!searches(g)[0].body.jql.includes('ORDER BY'));
    assert.equal(sortNote(g).textContent, NOTE, 'a dashboard refresh keeps the note');
  }));

test('KDG-18 issue-list: the filter\'s own ORDER BY is kept by the fallback reload', withTimers(async () => {
  const { g } = await start({ catalogue: fail(500) });
  await selectAndLoad(g, { jql: 'project = A ORDER BY rank' });
  button(g, 'Description').click();
  await flush();
  searches(g)[0].resolve(fail(400));
  await flush();
  assert.match(searches(g)[0].body.jql, / ORDER BY rank$/);
}));

test('KDG-18 issue-list: a 400 on a sorted Load more also falls back from page 1', withTimers(async () => {
  const { g } = await start({ catalogue: fail(500) });
  await selectAndLoad(g);
  button(g, 'Description').click();
  await flush();
  searches(g)[0].resolve(ok({ issues: makeIssues('S', 2), nextPageToken: 'p2', isLast: false }));
  await flush();
  g.find('issue-list-more').click();
  await flush();
  const [more] = searches(g);
  assert.equal(more.body.nextPageToken, 'p2');
  more.resolve(fail(400));
  await flush();
  assertPlain(g, 'Description');
  const [reload] = searches(g);
  assert.equal(reload.body.nextPageToken, undefined);
  assert.ok(!reload.body.jql.includes('ORDER BY'));
  assert.deepEqual(rows(g), [], 'sorted rows cleared');
  assert.equal(sortNote(g).textContent, NOTE);
}));

test('KDG-18 issue-list: the note is kept through Load more and cleared by a sort click', withTimers(async () => {
  const { g } = await start({ catalogue: fail(500) });
  await selectAndLoad(g);
  button(g, 'Description').click();
  await flush();
  searches(g)[0].resolve(fail(400));
  await flush();
  searches(g)[0].resolve(ok({ issues: makeIssues('R', 2), nextPageToken: 'p2', isLast: false }));
  await flush();
  g.find('issue-list-more').click();
  await flush();
  assert.equal(sortNote(g).textContent, NOTE, 'kept while the next page loads');
  searches(g)[0].resolve(ok({ issues: makeIssues('Q', 1), isLast: true }));
  await flush();
  assert.equal(sortNote(g).textContent, NOTE, 'kept after Load more');
  assert.deepEqual(rows(g), ['R-1', 'R-2', 'Q-1']);
  button(g, 'Summary').click();
  await flush();
  assert.equal(sortNote(g).hidden, true);
  assert.equal(sortNote(g).textContent, '');
  assert.match(searches(g)[0].body.jql, / ORDER BY summary ASC$/);
  assert.equal(heading(g, 'Summary').getAttribute('aria-sort'), 'ascending');
}));

test('KDG-18 issue-list: the note is cleared when the Controller sends a new filter', withTimers(async () => {
  const { g } = await start({ catalogue: fail(500) });
  await selectAndLoad(g);
  button(g, 'Description').click();
  await flush();
  searches(g)[0].resolve(fail(400));
  await flush();
  assert.equal(sortNote(g).hidden, false);
  await g.bus.send(FILTER_SELECTED, selection({ name: 'Filter B', jql: 'project = B', revision: 'r2' }));
  await flush();
  assert.equal(sortNote(g).hidden, true);
  assertPlain(g, 'Description'); // plain for the rest of the session
}));

test('KDG-18 issue-list: an unsorted reload that also fails shows the normal error and no note',
  withTimers(async () => {
    const { g } = await start({ catalogue: fail(500) });
    await selectAndLoad(g);
    button(g, 'Description').click();
    await flush();
    searches(g)[0].resolve(fail(400));
    await flush();
    searches(g)[0].resolve(fail(400));
    await flush();
    assert.equal(g.find('status').textContent, 'The selected JQL or column selection is invalid.');
    assert.equal(sortNote(g).hidden, true);
    assert.equal(sortNote(g).textContent, '');
    assert.equal(searches(g).length, 0, 'no retry loop');
  }));

test('KDG-18 issue-list: a sorted failure that is not a 400 keeps its own message and the sort',
  withTimers(async () => {
    const { g } = await start({ catalogue: fail(500) });
    await selectAndLoad(g);
    button(g, 'Description').click();
    await flush();
    searches(g)[0].resolve(fail(403));
    await flush();
    assert.equal(searches(g).length, 0);
    assert.equal(sortNote(g).hidden, true);
    assert.equal(heading(g, 'Description').getAttribute('aria-sort'), 'ascending');
  }));

test('KDG-18 issue-list: focus moves to the first sortable heading when the focused one turns plain',
  withTimers(async () => {
    const { g } = await start({ catalogue: fail(500) });
    await selectAndLoad(g);
    const description = button(g, 'Description');
    description.focus();
    description.click();
    await flush();
    searches(g)[0].resolve(fail(400));
    await flush();
    assert.equal(g.doc.activeElement, button(g, 'Issue key'));
  }));

test('KDG-18 issue-list: focus moves to the table when no sortable heading is left', withTimers(async () => {
  const g = await startGadget('issue-list', { configuration: {
    columns: ['description'], columnLabels: { description: 'Description' } } });
  g.pending(FIELD_CATALOGUE)[0].resolve(fail(500));
  await flush();
  await selectAndLoad(g);
  const description = button(g, 'Description');
  description.focus();
  description.click();
  await flush();
  searches(g)[0].resolve(fail(400));
  await flush();
  const table = g.root.querySelector('table');
  assert.equal(g.doc.activeElement, table);
  assert.equal(table.tabIndex, -1);
}));

test('KDG-18 issue-list: a late catalogue swap of an already plain column is harmless', withTimers(async () => {
  const { g, field } = await start();
  await selectAndLoad(g);
  button(g, 'Description').click();
  await flush();
  searches(g)[0].resolve(fail(400));
  await flush();
  field.resolve(ok(CATALOGUE));
  await flush();
  assertPlain(g, 'Description');
  assert.equal(g.findAll('table-sort-button').length, 3);
}));

test('KDG-18 issue-list: the Edit view help mentions fields that can\'t be sorted', withTimers(async () => {
  const g = await startGadget('issue-list', { entryPoint: 'edit', configuration: CONFIG });
  g.pending(FIELD_CATALOGUE)[0].resolve(ok(CATALOGUE));
  await flush();
  assert.ok(g.root.textContent.includes('Choose up to 10 columns and arrange their order. Click a heading in ' +
    "the list to sort all matching issues; some fields, such as Description, can't be sorted. " +
    'The list loads 50 issues at a time.'));
}));
