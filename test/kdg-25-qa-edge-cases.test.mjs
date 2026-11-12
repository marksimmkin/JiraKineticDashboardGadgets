// KDG-25 QA: edge cases for the listed-only User List and User Leaderboard.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, statusesClause } from '../static/drilldown.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const CATEGORY = {
  'To Do': ['1', 'new'], 'In QA': ['7', 'indeterminate'], 'Done': ['9', 'done'],
  'Released': ['10', 'done'], 'Blocked': ['11', 'indeterminate'],
};
function issue(n, statusName, user = 'u1') {
  const [id, key] = CATEGORY[statusName] ?? [];
  return { id: String(n), key: `A-${n}`, fields: {
    summary: `Issue ${n}`,
    status: statusName === null ? undefined : { id, name: statusName, statusCategory: { key } },
    assignee: { accountId: user, displayName: `User ${user}` },
  } };
}
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);

async function show(name, issues, overrides) {
  const g = await startGadget(name, { jira: jiraWith(issues) });
  await g.bus.send(FILTER_SELECTED, selection(overrides));
  await flush();
  return g;
}
async function opens(g, label) {
  const found = g.findAll('issue-count-link').find(button => button.getAttribute('aria-label') === label);
  assert.ok(found, `no link "${label}"; have ${g.findAll('issue-count-link').map(b => b.getAttribute('aria-label'))}`);
  found.click();
  await flush();
  return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
}
const headings = g => g.findAll('table-sort-button').map(b => b.textContent.replace(/ [↑↓]$/, ''));

for (const name of ['user-list', 'user-leaderboard']) {
  test(`KDG-25 QA ${name}: Controller name differing in case and whitespace still lists the Jira status`,
    withTimers(async () => {
      const g = await show(name, [issue(1, 'In QA'), issue(2, 'Blocked')],
        { statuses: [{ name: '  in qa ', weight: 0.5 }], hiddenStatuses: [], shownStatuses: [] });
      assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Blocked');
      assert.equal(g.find('status').textContent,
        '1 issues in shown statuses across 1 assignees, including Unassigned where applicable');
      if (name === 'user-list') assert.deepEqual(headings(g), ['Assignee', 'Total tickets', 'In QA']);
      else assert.deepEqual(g.findAll('leaderboard-detail').map(d => d.textContent), ['0.5 weighted score · 1 tickets']);
    }));

  test(`KDG-25 QA ${name}: older Controller payload (no hidden/shown lists) hides unflagged listed Done and unlisted`,
    withTimers(async () => {
      const g = await show(name, [issue(1, 'To Do'), issue(2, 'Done'), issue(3, 'In QA'), issue(4, 'Released')],
        { statuses: [{ name: 'To Do', weight: 1 }, { name: 'Done', weight: 0 }] });
      // No explicit flags: listed Done is hidden by category, so it sorts A-Z with the discovered ones.
      assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Done, In QA, Released');
      assert.equal(g.find('status').textContent,
        '1 issues in shown statuses across 1 assignees, including Unassigned where applicable');
    }));

  test(`KDG-25 QA ${name}: a listed Done status ticked Show is shown; an unlisted Done one is not`,
    withTimers(async () => {
      const g = await show(name, [issue(1, 'Done'), issue(2, 'Released')],
        { statuses: [{ name: 'Done', weight: 0, show: true }], hiddenStatuses: [], shownStatuses: ['Done'] });
      assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Released');
      if (name === 'user-list') assert.deepEqual(headings(g), ['Assignee', 'Total tickets', 'Done']);
    }));

  test(`KDG-25 QA ${name}: listed show:false vs unlisted are both hidden; listed hidden names come first`,
    withTimers(async () => {
      const g = await show(name, [issue(1, 'To Do'), issue(2, 'In QA'), issue(3, 'Blocked')], {
        statuses: [{ name: 'To Do', weight: 1 }, { name: 'In QA', weight: 0.5, show: false }],
        hiddenStatuses: ['In QA'], shownStatuses: ['To Do'],
      });
      assert.equal(g.find('status-hidden-note').textContent, 'Hiding: In QA, Blocked');
    }));

  test(`KDG-25 QA ${name}: an issue with no status is left out and named`, withTimers(async () => {
    const g = await show(name, [issue(1, 'To Do'), issue(2, null)],
      { statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: [] });
    assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Unknown status');
  }));

  test(`KDG-25 QA ${name}: narrowed link keeps quotes and puts ORDER BY last`, withTimers(async () => {
    const jql = 'project = "A \\"x\\"" AND labels in ("a)b") ORDER BY rank';
    const g = await show(name, [issue(1, 'To Do'), issue(2, 'In QA')],
      { jql, statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: [] });
    const expected = narrowJql(jql, [statusesClause([{ name: 'To Do', ids: ['1'] }])]);
    assert.equal(expected, '(project = "A \\"x\\"" AND labels in ("a)b")) AND (status in ("1")) ORDER BY rank');
    assert.equal(await opens(g, 'Open 1 issues in shown statuses'), expected);
  }));

  test(`KDG-25 QA ${name}: nothing hidden keeps the plain JQL link`, withTimers(async () => {
    const g = await show(name, [issue(1, 'To Do')],
      { statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: [] });
    assert.equal(g.find('status-hidden-note').hidden, true);
    assert.equal(await opens(g, 'Open 1 issues'), 'project = A');
  }));
}

test('KDG-25 QA user-leaderboard: issue-count metric also leaves out unlisted statuses', withTimers(async () => {
  const g = await show('user-leaderboard', [issue(1, 'To Do'), issue(2, 'In QA'), issue(3, 'In QA', 'u2')],
    { statuses: [{ name: 'To Do', weight: 1 }], hiddenStatuses: [], shownStatuses: [] });
  const select = g.find('user-metric-select');
  select.value = 'tickets';
  select.dispatchEvent({ type: 'change' });
  await flush();
  assert.deepEqual(g.findAll('leaderboard-detail').map(d => d.textContent), ['1 tickets']);
  assert.deepEqual(g.findAll('leaderboard-name').map(n => n.textContent), ['User u1'],
    'u2 has only unlisted issues, so is not ranked');
}));
