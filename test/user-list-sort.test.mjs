import assert from 'node:assert/strict';
import test from 'node:test';
import { sortedUserRows } from '../static/user-list-sort.mjs';

const rows = [
  { id: 'a', name: 'Alex', total: 3, score: 1, timeRemaining: 7200, counts: { done: 1, review: 0 } },
  { id: 'b', name: 'Blair', total: 1, score: 2, timeRemaining: 3600, counts: { done: 0, review: 1 } },
  { id: 'c', name: 'Casey', total: 2, score: 0, timeRemaining: 7200, counts: { done: 2, review: 0 } },
];

test('user list headings sort names, the selected total, and individual status counts', () => {
  const names = (sort, metric) => sortedUserRows(rows, sort, metric).map(row => row.name);
  assert.deepEqual(names({ column: 'assignee', direction: 'ascending' }, 'tickets'),
    ['Alex', 'Blair', 'Casey']);
  assert.deepEqual(names({ column: 'assignee', direction: 'descending' }, 'tickets'),
    ['Casey', 'Blair', 'Alex']);
  assert.deepEqual(names({ column: 'total', direction: 'descending' }, 'tickets'),
    ['Alex', 'Casey', 'Blair']);
  assert.deepEqual(names({ column: 'total', direction: 'descending' }, 'score'),
    ['Blair', 'Alex', 'Casey']);
  assert.deepEqual(names({ column: 'total', direction: 'ascending' }, 'time'),
    ['Blair', 'Alex', 'Casey']);
  assert.deepEqual(names({ column: 'status:done', direction: 'descending' }, 'tickets'),
    ['Casey', 'Alex', 'Blair']);
  assert.deepEqual(names({ column: 'status:review', direction: 'ascending' }, 'tickets'),
    ['Alex', 'Casey', 'Blair']);
  assert.deepEqual(rows.map(row => row.name), ['Alex', 'Blair', 'Casey']);
});
