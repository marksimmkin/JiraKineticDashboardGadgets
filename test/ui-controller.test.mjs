// KDG-7: Controller entry point (static/controller/src.mjs) and its event messages, run through
// test/helpers/gadget-harness.mjs with a fake @forge/bridge and a fake DOM.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_REQUEST, FILTER_SELECTED, GADGET_REFRESH } from '../static/shared.mjs';
import { createBus, flush, ok, startGadget } from './helpers/gadget-harness.mjs';

const CONFIG = {
  filters: [
    { name: 'Alpha', jql: 'project = A', startDate: '2026-01-01', endDate: '2026-03-31' },
    { name: 'Beta', jql: 'project = B ORDER BY rank' },
  ],
  statuses: [{ name: 'To Do', weight: 1, color: '#0c66e4' }, { name: 'Done', weight: 0, color: '#22a06b' }],
};
const STATUSES = CONFIG.statuses;

function expected(controller, overrides) {
  return { dashboardId: 'd1', controllerId: controller.gadgetId, name: 'Alpha', jql: 'project = A',
    startDate: '2026-01-01', endDate: '2026-03-31', statuses: STATUSES,
    // KDG-24: neither saved status has an explicit Show flag.
    hiddenStatuses: [], shownStatuses: [], ...overrides };
}
const BETA = { name: 'Beta', jql: 'project = B ORDER BY rank', startDate: null, endDate: null };

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}

const startController = (options = {}) => startGadget('controller', { configuration: CONFIG, ...options });
// KDG-5 added `revision` to every selection; it is checked on its own below, so the payload
// checks here leave it out.
const selections = c => c.emitted(FILTER_SELECTED).map(({ payload: { revision, ...rest } }) => rest);
const revisions = c => c.emitted(FILTER_SELECTED).map(e => e.payload.revision);
const buttons = c => c.findAll('controller-filter-button');

test('KDG-7 Controller: sends the first filter on load and marks it active', withTimers(async () => {
  const c = await startController();
  assert.deepEqual(selections(c), [expected(c)]);
  assert.deepEqual(buttons(c).map(b => b.textContent), ['Alpha', 'Beta']);
  assert.deepEqual(buttons(c).map(b => b.getAttribute('aria-pressed')), ['true', 'false']);
  assert.deepEqual(buttons(c).map(b => b.classList.contains('is-active')), [true, false]);
  assert.equal(c.find('controller-filter-buttons').getAttribute('aria-label'), 'Active filter');
  assert.equal(c.requests.length, 0, 'display mode makes no Jira request');
}));

test('KDG-7 Controller: clicking a filter sends it and moves the active state', withTimers(async () => {
  const c = await startController();
  buttons(c)[1].click();
  await flush();
  assert.deepEqual(selections(c), [expected(c), expected(c, BETA)]);
  assert.deepEqual(buttons(c).map(b => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.deepEqual(buttons(c).map(b => b.classList.contains('is-active')), [false, true]);
  buttons(c)[0].click();
  await flush();
  assert.deepEqual(selections(c).at(-1), expected(c));
}));

test('KDG-7 Controller: answers filter.request for its dashboard only, with the current filter',
  withTimers(async () => {
    const c = await startController();
    buttons(c)[1].click();
    await flush();
    const before = selections(c).length;
    await c.bus.send(FILTER_REQUEST, { dashboardId: 'd2' });
    await c.bus.send(FILTER_REQUEST, {});
    await c.bus.send(FILTER_REQUEST, undefined);
    await flush();
    assert.equal(selections(c).length, before, 'other or missing dashboard IDs are ignored');
    await c.bus.send(FILTER_REQUEST, { dashboardId: 'd1' });
    await flush();
    assert.equal(selections(c).length, before + 1);
    assert.deepEqual(selections(c).at(-1), expected(c, BETA), 'the clicked filter, not the first');
  }));

test('KDG-7 Controller: JIRA_DASHBOARD_GADGET_REFRESH re-sends the selection', withTimers(async () => {
  const c = await startController();
  await c.bus.send(GADGET_REFRESH, { origin: 'dashboard' });
  await flush();
  assert.equal(selections(c).length, 2, 'dashboard refresh re-sends');
  await c.bus.send(GADGET_REFRESH, { gadgetId: c.gadgetId });
  await flush();
  assert.equal(selections(c).length, 3, 'refresh of this gadget re-sends');
  await c.bus.send(GADGET_REFRESH, { gadgetId: 'someone-else' });
  await c.bus.send(GADGET_REFRESH, {});
  await flush();
  assert.equal(selections(c).length, 3, 'refresh of another gadget is ignored');
  assert.deepEqual(selections(c).at(-1), expected(c));
}));

test('KDG-7 Controller: with no filters it says so and sends an empty selection', withTimers(async () => {
  const c = await startGadget('controller', { configuration: { statuses: STATUSES } });
  assert.equal(c.find('status').textContent, 'Use the gadget menu to configure a filter.');
  assert.equal(buttons(c).length, 0);
  assert.deepEqual(selections(c), [expected(c, { name: null, jql: null, startDate: null, endDate: null })]);
}));

test('KDG-7 Controller: without a dashboard ID it sends nothing and does not listen', withTimers(async () => {
  const c = await startController({ dashboardId: '' });
  assert.equal(c.find('status').textContent, 'Dashboard context is unavailable.');
  assert.equal(c.bus.log.length, 0);
  assert.equal(c.bus.subscribers.length, 0);
}));

test('KDG-7 Controller: a failed send on click shows an error', withTimers(async () => {
  const c = await startController();
  c.bridge.events.emit = async () => { throw new Error('bridge down'); };
  buttons(c)[1].click();
  await flush();
  assert.equal(c.find('status').textContent, 'Could not update the other gadgets.');
  assert.equal(buttons(c)[1].getAttribute('aria-pressed'), 'true', 'the click is still shown');
}));

test('KDG-7 Controller: edit mode loads statuses and submits the configuration', withTimers(async () => {
  const c = await startController({ entryPoint: 'edit',
    jira: path => (path === '/rest/api/3/status' ? ok([{ name: 'To Do' }, { name: 'Done' }]) : undefined) });
  assert.equal(c.bus.subscribers.length, 0, 'edit mode does not join the event flow');
  assert.equal(c.bus.log.length, 0);
  const form = c.panel();
  assert.equal(form.tagName, 'FORM');
  // KDG-16: the intro says the period includes the End Date.
  assert.equal(form.find('muted').textContent, 'Name each filter and enter its JQL. Optional dates are ' +
    'shared with other Kinetic gadgets. The period includes the End Date. Dates do not change the JQL count.');
  assert.equal(form.querySelectorAll('.filter-row').length, 2);
  form.dispatchEvent(Object.assign({ type: 'submit', preventDefault() {} }));
  await flush();
  assert.equal(c.find('error').textContent, '');
  assert.deepEqual(c.submitted, [{
    filters: CONFIG.filters.map(f => ({ startDate: null, endDate: null, ...f })),
    statuses: STATUSES,
  }]);
}));

test('KDG-7 Controller + gadget: a gadget loaded first gets the selection once the Controller loads',
  withTimers(async () => {
    const bus = createBus();
    const dates = await startGadget('dates', { bus });
    assert.equal(dates.emitted(FILTER_REQUEST).length, 1, 'request sent with no Controller yet');
    assert.equal(dates.find('status').textContent, 'Waiting for the controller…');
    const c = await startController({ bus });
    await flush();
    assert.equal(dates.find('dates-filter-name').textContent, 'Alpha');
    assert.equal(dates.find('status').textContent, '');
    mock.timers.tick(4000); await flush();
    assert.equal(dates.find('status').textContent, '', 'no "Add a Controller" once a selection arrived');
    buttons(c)[1].click();
    await flush();
    assert.equal(dates.find('dates-filter-name').textContent, 'Beta');
    assert.equal(dates.find('status').textContent, 'No dates set for this filter.');
  }));

test('KDG-7 Controller + gadget: a gadget loaded later asks for and gets the current selection',
  withTimers(async () => {
    const bus = createBus();
    const c = await startController({ bus });
    buttons(c)[1].click();
    await flush();
    const chart = await startGadget('status-chart', { bus });
    await flush();
    assert.equal(chart.emitted(FILTER_REQUEST).length, 1);
    assert.equal(selections(c).length, 3, 'load, click, then the reply to the new gadget');
    assert.equal(chart.find('chart-filter-name').textContent, 'Beta');
    const search = chart.pending('search/jql');
    assert.equal(search.length, 1);
    assert.equal(search[0].body.jql, 'project = B ORDER BY rank');
  }));

test('KDG-7 Controller + gadget: Controllers on other dashboards do not reach the gadget',
  withTimers(async () => {
    const bus = createBus();
    const chart = await startGadget('status-chart', { bus });
    await startController({ bus, dashboardId: 'd2' });
    await flush();
    assert.equal(chart.find('chart-filter-name').textContent, '');
    assert.equal(chart.requests.length, 0);
    mock.timers.tick(4000); await flush();
    assert.equal(chart.find('status').textContent, 'Add a Kinetic Dashboard Controller to this dashboard.');
  }));

// ---------------------------------------------------------------------------------------------
// KDG-5: the selection revision.

test('KDG-5 Controller: revision is load-nonce:n and n rises on clicks and refreshes only',
  withTimers(async () => {
    const c = await startController();
    const [first] = revisions(c);
    assert.match(first, /^.+:0$/, 'load sends revision n = 0');
    const nonce = first.slice(0, first.lastIndexOf(':'));
    buttons(c)[1].click(); await flush();
    buttons(c)[1].click(); await flush(); // the active filter again
    await c.bus.send(FILTER_REQUEST, { dashboardId: 'd1' }); await flush();
    await c.bus.send(GADGET_REFRESH, { origin: 'dashboard' }); await flush();
    await c.bus.send(FILTER_REQUEST, { dashboardId: 'd1' }); await flush();
    await c.bus.send(GADGET_REFRESH, { gadgetId: c.gadgetId }); await flush();
    await c.bus.send(GADGET_REFRESH, { gadgetId: 'someone-else' }); await flush();
    await c.bus.send(FILTER_REQUEST, { dashboardId: 'd2' }); await flush();
    assert.deepEqual(revisions(c), [0, 1, 2, 2, 3, 3, 4].map(n => `${nonce}:${n}`),
      'load, click, re-click, request reply, dashboard refresh, request reply, own refresh');
    assert.deepEqual(selections(c).at(-1), expected(c, BETA), 'the filter is unchanged by a refresh');
  }));

test('KDG-5 Controller: each load uses a different nonce', withTimers(async () => {
  const one = await startController();
  const two = await startController();
  assert.notEqual(revisions(one)[0], revisions(two)[0]);
  assert.match(revisions(two)[0], /:0$/);
}));
