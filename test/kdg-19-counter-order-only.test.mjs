// KDG-19: an ORDER BY-only Controller JQL no longer reaches approximateCount without a filter.
// Since KDG-24 the Counter always narrows the JQL to shown statuses, so the approximate count
// gets a real filter, is sent, and nothing is logged.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

test('KDG-19 counter: ORDER BY-only JQL sends a filtered approximate count and logs no warning', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const g = await startGadget('counter');
    await g.bus.send(FILTER_SELECTED, selection({ jql: 'ORDER BY rank' }));
    await flush();
    const [approx] = g.pending('approximate-count');
    assert.ok(approx, 'the approximate count is requested');
    assert.equal(approx.body.jql, '(statusCategory != Done)');
    const [exact] = g.pending('search/jql');
    assert.equal(exact.body.jql, '(statusCategory != Done) ORDER BY rank');
    approx.resolve(ok({ count: 2 }));
    exact.resolve(ok({ issues: [{ id: '1', key: 'A-1', fields: {} }, { id: '2', key: 'A-2', fields: {} }], isLast: true }));
    await flush();
    assert.equal(g.find('count').textContent, '2');
    assert.equal(warn.mock.callCount(), 0, 'no "approximate count needs a JQL filter" warning');
  } finally {
    warn.mock.restore();
  }
});
