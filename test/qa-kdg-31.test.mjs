// QA KDG-31: end to end Controller -> gadgets for hours per day, save failure copy, and reload counts.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { createBus, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const CONFIG = {
  filters: [{ name: 'Alpha', jql: 'project = A', startDate: '2026-01-01', endDate: '2026-06-12' }],
  statuses: [{ name: 'To Do', weight: 1, color: '#0c66e4', show: true }],
};
const issue = { id: '1', key: 'A-1', fields: { summary: 'x',
  status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
  assignee: { accountId: 'u1', displayName: 'User u1' }, timetracking: { remainingEstimateSeconds: 151200 } } };
const jira = path => (path.includes('search/jql') ? ok({ issues: [issue], isLast: true }) : undefined);
const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;

test('QA KDG-31: a view-mode Controller with saved 8 drives Capacity, User List and Leaderboard; each loads once',
  withTimers(async () => {
    const bus = createBus();
    const cap = await startGadget('capacity', { bus, jira });
    const list = await startGadget('user-list', { bus, jira });
    const board = await startGadget('user-leaderboard', { bus, jira });
    const c = await startGadget('controller', { bus, configuration: { ...CONFIG, hoursPerDay: 8 } });
    await flush();
    const sent = c.emitted(FILTER_SELECTED);
    assert.ok(sent.length >= 1);
    assert.equal(sent.at(-1).payload.hoursPerDay, 8);
    assert.equal(cap.find('leaderboard-detail').textContent, '5.3 of 10 days · 53%');
    assert.equal(cap.find('capacity-legend').textContent, 'The line marks full capacity. A day is 8 hours.');
    for (const g of [cap, list, board]) assert.equal(searches(g), 1, `${g.name} loads once`);
    // The same selection repeated (e.g. a filter.request reply) does not reload.
    await bus.send(FILTER_SELECTED, sent.at(-1).payload);
    await flush();
    for (const g of [cap, list, board]) assert.equal(searches(g), 1, `${g.name} ignores the repeat`);
  }));

test('QA KDG-31: hours-only change with the same revision reloads each gadget exactly once', withTimers(async () => {
  const bus = createBus();
  const gs = [];
  for (const n of ['capacity', 'user-list', 'user-leaderboard']) gs.push(await startGadget(n, { bus, jira }));
  const base = { jql: 'project = A', statuses: CONFIG.statuses, hiddenStatuses: [], shownStatuses: ['To Do'],
    startDate: '2026-01-01', endDate: '2026-06-12', revision: 'n:1' };
  await bus.send(FILTER_SELECTED, selection({ ...base, hoursPerDay: 7 }));
  await flush();
  await bus.send(FILTER_SELECTED, selection({ ...base, hoursPerDay: 7 }));
  await flush();
  for (const g of gs) assert.equal(searches(g), 1, `${g.name}: unchanged hours, no reload`);
  await bus.send(FILTER_SELECTED, selection({ ...base, hoursPerDay: 8 }));
  await flush();
  for (const g of gs) assert.equal(searches(g), 2, `${g.name}: exactly one reload for new hours`);
}));

test('QA KDG-31: Controller Save button copy and failure message; Save re-enabled', withTimers(async () => {
  const c = await startGadget('controller', { entryPoint: 'edit', configuration: CONFIG,
    jira: path => (path === '/rest/api/3/status' ? ok([{ name: 'To Do' }]) : undefined) });
  const save = [...c.root.querySelectorAll('button')].find(b => b.type === 'submit');
  assert.equal(save.textContent, 'Save settings');
  c.bridge.view.submit = async () => { throw new Error('nope'); };
  c.panel().dispatchEvent({ type: 'submit', preventDefault() {} });
  await flush();
  const texts = c.findAll('error').map(n => n.textContent);
  assert.ok(texts.includes('Could not save the settings. Please try again.'), texts.join('|'));
  assert.equal(save.disabled, false);
}));

test('QA KDG-31: saving keeps filters and statuses exactly as before (only hoursPerDay added)', withTimers(async () => {
  const c = await startGadget('controller', { entryPoint: 'edit', configuration: CONFIG,
    jira: path => (path === '/rest/api/3/status' ? ok([{ name: 'To Do' }]) : undefined) });
  c.panel().dispatchEvent({ type: 'submit', preventDefault() {} });
  await flush();
  assert.equal(c.submitted.length, 1);
  const { hoursPerDay, ...rest } = c.submitted[0];
  assert.equal(hoursPerDay, 7);
  assert.deepEqual(Object.keys(rest).sort(), ['filters', 'statuses']);
  assert.equal(rest.filters[0].jql, 'project = A');
  assert.equal(rest.statuses[0].name, 'To Do');
}));
