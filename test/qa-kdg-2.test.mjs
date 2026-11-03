import assert from 'node:assert/strict';
import test from 'node:test';
import { narrowJql, splitOrderBy } from '../static/drilldown.mjs';
import { orderedJql } from '../static/issue-data.mjs';

const done = 'status = "Done"';

test('QA KDG-2: realistic Controller JQL drills down and sorts unchanged', () => {
  assert.equal(narrowJql('project = GAME AND status != Done ORDER BY Rank ASC', [done]),
    '(project = GAME AND status != Done) AND (status = "Done") ORDER BY Rank ASC');
  assert.equal(narrowJql('fixVersion = "1.2" ORDER BY priority DESC, created ASC', [done]),
    '(fixVersion = "1.2") AND (status = "Done") ORDER BY priority DESC, created ASC');
  assert.equal(narrowJql('project = GAME AND assignee = currentUser()', [done]),
    '(project = GAME AND assignee = currentUser()) AND (status = "Done")');
  assert.equal(narrowJql('project in (A, B) AND sprint in openSprints() ORDER BY Rank ASC', [done]),
    '(project in (A, B) AND sprint in openSprints()) AND (status = "Done") ORDER BY Rank ASC');
  assert.equal(narrowJql('filter = 10000 ORDER BY cf[10001] DESC', [done]),
    '(filter = 10000) AND (status = "Done") ORDER BY cf[10001] DESC');
  assert.equal(orderedJql('project = GAME AND status != Done ORDER BY Rank ASC', 'customfield_10001', 'DESC'),
    'project = GAME AND status != Done ORDER BY cf[10001] DESC');
  assert.equal(orderedJql('fixVersion = "1.2" ORDER BY priority DESC, created ASC', 'key', 'ASC'),
    'fixVersion = "1.2" ORDER BY key ASC');
  assert.equal(orderedJql('project = GAME', 'key', 'ASC'), 'project = GAME ORDER BY key ASC');
});

test('QA KDG-2: empty, whitespace-only and Windows line endings', () => {
  assert.deepEqual(splitOrderBy(''), { filter: '', order: '' });
  assert.deepEqual(splitOrderBy('  \n '), { filter: '', order: '' });
  assert.equal(narrowJql('', [done]), '(status = "Done")');
  assert.equal(narrowJql('ORDER BY Rank', [done]), '(status = "Done") ORDER BY Rank');
  assert.deepEqual(splitOrderBy('project = GAME\r\nORDER BY Rank'), { filter: 'project = GAME', order: 'ORDER BY Rank' });
  assert.deepEqual(splitOrderBy('project = GAME ORDER BY Rank'), { filter: 'project = GAME', order: 'ORDER BY Rank' });
});

test('QA KDG-2: quotes and brackets that never close keep ORDER BY as filter text', () => {
  assert.deepEqual(splitOrderBy('summary ~ "open ORDER BY x'), { filter: 'summary ~ "open ORDER BY x', order: '' });
  assert.deepEqual(splitOrderBy('(a = 1 ORDER BY c'), { filter: '(a = 1 ORDER BY c', order: '' });
  // A stray closing bracket does not make depth negative.
  assert.deepEqual(splitOrderBy('a = 1) ORDER BY c'), { filter: 'a = 1)', order: 'ORDER BY c' });
  assert.deepEqual(splitOrderBy("summary ~ 'it\\'s ORDER BY' ORDER BY x"),
    { filter: "summary ~ 'it\\'s ORDER BY'", order: 'ORDER BY x' });
});

test('QA KDG-2: ORDER BY glued to a word is not split (glued to ) or a quote is, since KDG-8)', () => {
  assert.deepEqual(splitOrderBy('project = GAMEORDER BY Rank').order, '');
  assert.deepEqual(splitOrderBy('labels = x ORDER BY_x').order, '');
});

test('QA KDG-2: intended behaviour changes from the two old parsers', () => {
  // Old narrowJql used the LAST match; now the first top-level ORDER BY wins.
  assert.equal(narrowJql('project = GAME ORDER BY Rank ORDER BY created', [done]),
    '(project = GAME) AND (status = "Done") ORDER BY Rank ORDER BY created');
  // Old narrowJql only looked 16 characters ahead, missing long gaps.
  assert.equal(narrowJql('project = GAME ORDER          BY Rank', [done]),
    '(project = GAME) AND (status = "Done") ORDER          BY Rank');
  // Old orderedJql needed whitespace after BY, so it doubled ORDER BY here.
  assert.equal(orderedJql('project = GAME ORDER BY', 'key', 'ASC'), 'project = GAME ORDER BY key ASC');
  assert.equal(orderedJql('ORDER BY', 'key', 'ASC'), 'ORDER BY key ASC');
  assert.equal(orderedJql('labels = x ORDER BY(x)', 'key', 'ASC'), 'labels = x ORDER BY key ASC');
});

test('QA KDG-2: very long JQL is split quickly', () => {
  // Guards against quadratic or catastrophic behaviour on long input. It
  // measures this process's CPU time, not wall-clock time, so other load on
  // the machine does not count. A linear split of this ~200k-character JQL
  // uses about 10-40 ms of CPU; a quadratic one uses seconds.
  const jql = `${'a = 1 AND '.repeat(20000)}a = 1 ORDER BY Rank`;
  const start = process.cpuUsage();
  const { filter, order } = splitOrderBy(jql);
  const used = process.cpuUsage(start);
  assert.equal(order, 'ORDER BY Rank');
  assert.ok(filter.endsWith('a = 1'));
  const cpuMs = (used.user + used.system) / 1000;
  assert.ok(cpuMs < 1000, `splitOrderBy used ${cpuMs.toFixed(0)} ms of CPU`);
});
