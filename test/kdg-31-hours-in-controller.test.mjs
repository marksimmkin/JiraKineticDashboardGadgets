// KDG-31: "Hours per working day" moved from the Capacity, User List and User Leaderboard Edit
// views to one setting in the Controller's Edit settings (default 7), sent in its payload.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { FILTER_SELECTED, createSelectionTracker, hoursPerDay, selectedFilterPayload, selectionKey }
  from '../static/shared.mjs';
import { createBus, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

// ---- Manifest ----

function gadgetBlock(manifest, key) {
  const start = manifest.indexOf(`- key: ${key}\n`);
  assert.notEqual(start, -1, key);
  const end = manifest.indexOf('\n    - key: ', start + 1);
  return manifest.slice(start, end === -1 ? undefined : end);
}

test('KDG-31 manifest: User List, User Leaderboard and Capacity have no edit view; the Controller keeps its', () => {
  const manifest = read('manifest.yml');
  for (const key of ['kinetic-dashboard-user-list', 'kinetic-dashboard-user-leaderboard', 'kinetic-dashboard-capacity']) {
    assert.doesNotMatch(gadgetBlock(manifest, key), /^\s+edit:/m, key);
  }
  assert.match(gadgetBlock(manifest, 'kinetic-dashboard-controller'), /^\s+edit:\n\s+resource: controller$/m);
  assert.equal(existsSync(new URL('static/hours-edit.mjs', root)), true, 'reused for the Controller field');
});

// ---- Payload and selectionKey ----

test('KDG-31 selectedFilterPayload: hoursPerDay is the saved Controller value, otherwise 7', () => {
  const payload = configuration => selectedFilterPayload({ extension: { dashboard: { id: 'd' }, gadget: { id: 'c' },
    gadgetConfiguration: configuration } }, { name: 'A', jql: 'project = A' });
  assert.equal(payload(undefined).hoursPerDay, 7);
  assert.equal(payload({}).hoursPerDay, 7);
  assert.equal(payload({ hoursPerDay: 7.5 }).hoursPerDay, 7.5);
  assert.equal(payload({ hoursPerDay: 1 }).hoursPerDay, 1);
  assert.equal(payload({ hoursPerDay: 24 }).hoursPerDay, 24);
  for (const bad of [0, 25, '8', null, Number.NaN]) assert.equal(payload({ hoursPerDay: bad }).hoursPerDay, 7, String(bad));
  assert.equal(hoursPerDay({}), 7, 'an older Controller payload without hoursPerDay means 7');
});

test('KDG-31 selectionKey: changing hours reloads once; an older payload keys as 7', () => {
  const base = selectionKey(selection({ revision: 'n:1', hoursPerDay: 7 }));
  assert.notEqual(selectionKey(selection({ revision: 'n:1', hoursPerDay: 8 })), base);
  assert.equal(selectionKey(selection({ revision: 'n:1' })), base, 'missing means 7');
  const tracker = createSelectionTracker({ timers: { setTimeout() {}, clearTimeout() {}, now: () => 0 } });
  assert.equal(tracker.accept(selection({ revision: 'n:1', hoursPerDay: 7 })), true);
  assert.equal(tracker.accept(selection({ revision: 'n:1', hoursPerDay: 7 })), false);
  assert.equal(tracker.accept(selection({ revision: 'n:1', hoursPerDay: 7.5 })), true, 'new hours is a new selection');
  assert.equal(tracker.accept(selection({ revision: 'n:1', hoursPerDay: 7.5 })), false, 'and only once');
});

// ---- Controller Edit field ----

const CONFIG = {
  filters: [{ name: 'Alpha', jql: 'project = A', startDate: null, endDate: null }],
  statuses: [{ name: 'To Do', weight: 1, color: '#0c66e4' }],
};
const HELP = 'Turns Remaining Estimate into days in the Capacity, User List and User Leaderboard gadgets. ' +
  'Applies to everyone. Default 7.';
const ERROR = 'Enter hours from 1 to 24, for example 7.5.';

async function controllerEdit(configuration = CONFIG) {
  const c = await startGadget('controller', { entryPoint: 'edit', configuration,
    jira: path => (path === '/rest/api/3/status' ? ok([{ name: 'To Do' }]) : undefined) });
  const form = c.panel();
  const input = c.root.querySelector('#controller-hours');
  const submit = async value => {
    if (value !== undefined) input.value = value;
    form.dispatchEvent({ type: 'submit', preventDefault() {} });
    await flush();
  };
  const fieldError = c.root.querySelector('#controller-hours-error');
  const formError = c.findAll('error').find(node => node !== fieldError);
  return { c, form, input, submit, fieldError, formError };
}

test('KDG-31 Controller edit: hours field after the statuses, before Save, prefilled 7', withTimers(async () => {
  const { c, form, input, fieldError } = await controllerEdit();
  assert.equal(input.value, '7');
  assert.equal(input.type, 'text');
  assert.equal(input.getAttribute('inputmode'), 'decimal');
  assert.equal(input.parentNode.tagName, 'LABEL');
  assert.ok(input.parentNode.textContent.startsWith('Hours per working day'));
  const help = c.root.querySelector('#controller-hours-help');
  assert.equal(help.textContent, HELP);
  assert.equal(input.getAttribute('aria-describedby'), 'controller-hours-help');
  assert.equal(fieldError.getAttribute('role'), 'alert');
  const section = input.parentNode.parentNode;
  assert.ok(section.classList.contains('hours-edit'));
  assert.equal(section.parentNode, form);
  const order = form.children;
  const at = node => order.indexOf(node);
  assert.ok(at(section) > at(c.find('status-actions')), 'after the statuses section');
  assert.ok(at(section) < at(c.find('actions')), 'before Save');
  assert.deepEqual(c.findAll('config-heading').map(h => h.textContent), ['Filters', 'Statuses', 'Working day']);
  assert.equal((await controllerEdit({ ...CONFIG, hoursPerDay: 7.5 })).input.value, '7.5', 'saved value');
  assert.equal((await controllerEdit({ ...CONFIG, hoursPerDay: 99 })).input.value, '7', 'invalid saved value');
}));

test('KDG-31 Controller edit: validation, focus, aria-invalid, and typing clears the error', withTimers(async () => {
  const { c, input, submit, fieldError, formError } = await controllerEdit();
  for (const value of ['', '0', '25', 'abc', '7.5h']) {
    c.doc.activeElement = null;
    await submit(value);
    assert.equal(fieldError.textContent, ERROR, `"${value}"`);
    assert.equal(formError.textContent, '');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('aria-describedby'), 'controller-hours-help controller-hours-error');
    assert.equal(c.doc.activeElement, input, 'focus moves to the input');
  }
  assert.deepEqual(c.submitted, []);
  input.value = '7';
  input.dispatchEvent({ type: 'input' });
  assert.equal(fieldError.textContent, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(input.getAttribute('aria-describedby'), 'controller-hours-help');
}));

test('KDG-31 Controller edit: "7,5" saves 7.5 alongside filters and statuses, keeping other keys',
  withTimers(async () => {
    const { c, submit } = await controllerEdit({ ...CONFIG, hoursPerDay: 6, other: 'keep me' });
    await submit('7,5');
    assert.deepEqual(c.submitted, [{ ...CONFIG, other: 'keep me', hoursPerDay: 7.5 }]);
    const fresh = await controllerEdit();
    await fresh.submit();
    assert.deepEqual(fresh.c.submitted, [{ ...CONFIG, hoursPerDay: 7 }], 'untouched saves the default 7');
  }));

test('KDG-31 Controller edit: a filter error and a hours error both show; nothing is saved', withTimers(async () => {
  const { c, input, submit, fieldError, formError } = await controllerEdit();
  c.root.querySelector('.filter-name-input').value = '';
  c.doc.activeElement = null;
  await submit('0');
  assert.equal(formError.textContent, 'Every filter needs a name and JQL.');
  assert.equal(fieldError.textContent, ERROR);
  assert.notEqual(c.doc.activeElement, input, 'focus is not moved for the hours field when the form error shows');
  assert.deepEqual(c.submitted, []);
}));

// ---- Gadgets read hours from the payload ----

let next = 0;
function issue(user, seconds) {
  next += 1;
  return { id: String(next), key: `A-${next}`, fields: {
    summary: `Issue ${next}`, status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    assignee: { accountId: user, displayName: `User ${user}` },
    timetracking: { remainingEstimateSeconds: seconds },
  } };
}
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);
const STATUS_PAYLOAD = { statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: ['To Do'],
  startDate: '2026-01-01', endDate: '2026-06-12' };

// 42 hours of work for one person.
async function gadget(name, payload, configuration) {
  const g = await startGadget(name, { jira: jiraWith([issue('u1', 151200)]), configuration });
  await g.bus.send(FILTER_SELECTED, selection({ ...STATUS_PAYLOAD, ...payload }));
  await flush();
  if (name !== 'capacity') {
    const select = g.find('user-metric-select');
    select.value = 'time';
    select.dispatchEvent({ type: 'change' });
    await flush();
  }
  return g;
}

const NBSP = ' ';
const shownText = {
  'user-list': g => g.root.querySelectorAll('tr')[1].children[1].children[0].textContent,
  'user-leaderboard': g => g.find('leaderboard-detail').children[0].textContent,
  capacity: g => g.find('leaderboard-detail').textContent,
};

for (const name of ['user-list', 'user-leaderboard']) {
  test(`KDG-31 ${name}: hours from the payload; an older payload and the old saved setting mean 7`,
    withTimers(async () => {
      assert.equal(shownText[name](await gadget(name, { hoursPerDay: 8 })), `5.3d${NBSP}(42h)`);
      assert.equal(shownText[name](await gadget(name, { hoursPerDay: 7.5 })), `5.6d${NBSP}(42h)`);
      assert.equal(shownText[name](await gadget(name, {})), `6.0d${NBSP}(42h)`, 'older payload');
      assert.equal(shownText[name](await gadget(name, {}, { hoursPerDay: 8 })), `6.0d${NBSP}(42h)`,
        "the gadget's own saved hoursPerDay is ignored");
    }));

  test(`KDG-31 ${name}: an edit entry point shows the gadget, not a form`, withTimers(async () => {
    const g = await startGadget(name, { entryPoint: 'edit' });
    assert.equal(g.root.querySelector('form'), null);
    assert.equal(g.emitted('kinetic.dashboard.filter.request').length, 1);
  }));
}

test('KDG-31 capacity: hours from the payload; an older payload and the old saved setting mean 7',
  withTimers(async () => {
    // 42 hours at 7 hours a day is 6.0 days; 10 working days are left from 1 Jun to 12 Jun.
    assert.equal(shownText.capacity(await gadget('capacity', { hoursPerDay: 8 })), '5.3 of 10 days · 53%');
    assert.equal(shownText.capacity(await gadget('capacity', {})), '6.0 of 10 days · 60%', 'older payload');
    const old = await gadget('capacity', {}, { hoursPerDay: 4 });
    assert.equal(shownText.capacity(old), '6.0 of 10 days · 60%', "the gadget's own saved hoursPerDay is ignored");
    assert.equal(old.find('capacity-legend').textContent, 'The line marks full capacity. A day is 7 hours.');
  }));

test('KDG-31 capacity: a new hours value from the Controller re-renders with the same revision', withTimers(async () => {
  const bus = createBus();
  const g = await startGadget('capacity', { bus, jira: jiraWith([issue('u1', 151200)]) });
  await bus.send(FILTER_SELECTED, selection({ ...STATUS_PAYLOAD, revision: 'n:1', hoursPerDay: 7 }));
  await flush();
  assert.equal(shownText.capacity(g), '6.0 of 10 days · 60%');
  await bus.send(FILTER_SELECTED, selection({ ...STATUS_PAYLOAD, revision: 'n:1', hoursPerDay: 8 }));
  await flush();
  assert.equal(shownText.capacity(g), '5.3 of 10 days · 53%');
}));
