// KDG-25: the User List and User Leaderboard show only statuses listed in the Controller.
// Unit tests for the listed-only visibility, then UI tests through test/helpers/gadget-harness.mjs.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, statusesClause } from '../static/drilldown.mjs';
import { hiddenNote, isStatusShown, shownIssues, statusVisibility } from '../static/status-visibility.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

// Listed: To Do (shown), In Progress (no flag), Closed (hidden), Done (no flag: hidden by category).
const STATUSES = [
  { name: 'To Do', weight: 1, color: '#0c66e4', show: true },
  { name: 'In Progress', weight: 0.5, color: '#7f5fcb' },
  { name: 'Closed', weight: 0, color: '#e2b203', show: false },
  { name: 'Done', weight: 0, color: '#22a06b' },
];
const PAYLOAD = { statuses: STATUSES, hiddenStatuses: ['Closed'], shownStatuses: ['To Do'] };

// ---- statusVisibility / isStatusShown ----

test('KDG-25 statusVisibility: listed-only adds the listed keys; without it nothing changes', () => {
  const plain = statusVisibility(PAYLOAD);
  assert.equal('listed' in plain, false);
  const listed = statusVisibility({ ...PAYLOAD, statuses: [...STATUSES, { name: '' }, null] }, { listedOnly: true });
  assert.deepEqual([...listed.listed], ['to do', 'in progress', 'closed', 'done']);
  assert.deepEqual([listed.hiddenNames, listed.shownNames], [plain.hiddenNames, plain.shownNames]);
  assert.deepEqual([...statusVisibility({}, { listedOnly: true }).listed], [], 'no statuses: nothing listed');
});

test('KDG-25 isStatusShown: listed-only hides unlisted statuses and keeps the rules for listed ones', () => {
  const visibility = statusVisibility(PAYLOAD, { listedOnly: true });
  assert.equal(isStatusShown('In QA', 'indeterminate', visibility), false, 'unlisted, not Done');
  assert.equal(isStatusShown('Released', 'done', visibility), false, 'unlisted, Done');
  assert.equal(isStatusShown('  in progress ', 'indeterminate', visibility), true, 'listed, unflagged, by key');
  assert.equal(isStatusShown('Done', 'done', visibility), false, 'listed, unflagged Done');
  assert.equal(isStatusShown('To Do', 'done', visibility), true, 'listed with show: true');
  assert.equal(isStatusShown('Closed', 'indeterminate', visibility), false, 'listed with show: false');
  // Without the option an unlisted non-Done status is still shown (Counter, List, charts).
  assert.equal(isStatusShown('In QA', 'indeterminate', statusVisibility(PAYLOAD)), true);
  const issue = (name, key) => ({ fields: { status: { name, statusCategory: { key } } } });
  assert.deepEqual(shownIssues([issue('To Do', 'new'), issue('In QA', 'indeterminate')], visibility)
    .map(i => i.fields.status.name), ['To Do']);
});

test('KDG-25 hiddenNote: an unlisted non-Done status is named after the listed hidden ones, A-Z', () => {
  const discovered = [{ name: 'To Do', category: 'new' }, { name: 'In QA', category: 'indeterminate' },
    { name: 'Blocked', category: 'indeterminate' }];
  assert.equal(hiddenNote(statusVisibility(PAYLOAD, { listedOnly: true }), { discovered }).text,
    'Hiding: Closed, Blocked, In QA');
  assert.equal(hiddenNote(statusVisibility(PAYLOAD), { discovered }).text, 'Hiding: Closed',
    'not named without listed-only');
});

// ---- User List and Leaderboard ----

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const CATEGORY = { 'To Do': ['1', 'new'], 'In Progress': ['3', 'indeterminate'], 'In QA': ['7', 'indeterminate'] };
function issue(n, statusName, user = 'u1') {
  const [id, key] = CATEGORY[statusName];
  return { id: String(n), key: `A-${n}`, fields: {
    summary: `Issue ${n}`, status: { id, name: statusName, statusCategory: { key } },
    assignee: { accountId: user, displayName: `User ${user}` },
    timetracking: { remainingEstimateSeconds: 3600 },
  } };
}
// u1: To Do + In Progress (score 1.5); u2: To Do + two In QA (score 1 once In QA is left out).
const ISSUES = [issue(1, 'To Do'), issue(2, 'In Progress'), issue(3, 'To Do', 'u2'),
  issue(4, 'In QA', 'u2'), issue(5, 'In QA', 'u2')];
const jiraWith = issues => path => (path.includes('search/jql') ? ok({ issues, isLast: true }) : undefined);

async function show(name, issues, overrides = PAYLOAD) {
  const g = await startGadget(name, { jira: jiraWith(issues) });
  await g.bus.send(FILTER_SELECTED, selection(overrides));
  await flush();
  return g;
}
async function opens(g, label) {
  const found = g.findAll('issue-count-link').find(button => button.getAttribute('aria-label') === label);
  assert.ok(found, `no link "${label}"`);
  found.click();
  await flush();
  return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
}
const shownJql = narrowJql('project = A', [statusesClause([{ name: 'To Do', ids: ['1'] },
  { name: 'In Progress', ids: ['3'] }])]);

for (const name of ['user-list', 'user-leaderboard']) {
  test(`KDG-25 ${name}: leaves out the unlisted In QA status and names it in the Hiding note`,
    withTimers(async () => {
      const g = await show(name, ISSUES);
      const note = g.find('status-hidden-note');
      assert.equal(note.hidden, false);
      assert.equal(note.textContent, 'Hiding: Closed, In QA');
      assert.equal(g.find('status').textContent,
        '3 issues in shown statuses across 2 assignees, including Unassigned where applicable');
      assert.ok(!g.root.textContent.includes('Add missing status'), 'In QA has no weight but is not reported');
      assert.equal(await opens(g, 'Open 3 issues in shown statuses'), shownJql);
      assert.equal(await opens(g, 'Open 1 issues assigned to User u2'),
        narrowJql(shownJql, ['assignee = "u2"']));
      if (name === 'user-list') {
        const headings = g.findAll('table-sort-button').map(b => b.textContent.replace(/ [↑↓]$/, ''));
        assert.deepEqual(headings, ['Assignee', 'Total tickets', 'To Do', 'In Progress']);
      } else {
        assert.deepEqual(g.findAll('leaderboard-name').map(n => n.textContent), ['User u1', 'User u2']);
        assert.deepEqual(g.findAll('leaderboard-detail').map(d => d.textContent),
          ['1.5 weighted score · 2 tickets', '1 weighted score · 1 tickets']);
      }
    }));

  test(`KDG-25 ${name}: only unlisted statuses matching says nothing is in shown statuses`, withTimers(async () => {
    const g = await show(name, [issue(1, 'In QA')]);
    assert.equal(g.find('status').textContent, 'No issues are in shown statuses (1 matching issues).');
    assert.equal(g.find('status-hidden-note').textContent, 'Hiding: Closed, In QA');
  }));
}

for (const [name, text] of [['user-list', 'Add statuses in the Controller to see the user list.'],
  ['user-leaderboard', 'Add statuses in the Controller to see the leaderboard.']]) {
  test(`KDG-25 ${name}: no Controller statuses shows "${text}" without searching`, withTimers(async () => {
    for (const overrides of [{ statuses: [] }, { statuses: undefined }]) {
      const g = await startGadget(name, { jira: jiraWith(ISSUES) });
      await g.bus.send(FILTER_SELECTED, selection(overrides));
      await flush();
      assert.equal(g.find('status').textContent, text);
      assert.equal(g.find('status-hidden-note').hidden, true);
      assert.equal(g.requests.filter(r => r.path.includes('search/jql')).length, 0, 'no Jira search');
    }
  }));
}
