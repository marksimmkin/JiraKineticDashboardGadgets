// QA KDG-7: a failed request for an older selection must not put an error on screen once the
// selection has changed. ui-gadgets.test.mjs checks this for the status chart only; removing the
// stale check from the catch block of the progress bar or issue list was not caught by any test.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const FETCHING = ['status-chart', 'status-pie', 'progress-bar', 'burndown', 'counter',
  'issue-list', 'user-list', 'user-leaderboard'];

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

function makeIssues(prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`, key: `${prefix}-${i + 1}`,
    fields: {
      summary: `${prefix} issue ${i + 1}`,
      status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      assignee: { accountId: `${prefix}-user`, displayName: `${prefix} User` },
      created: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z',
      timetracking: { remainingEstimateSeconds: 3600 },
    },
  }));
}

function jiraFor(prefix, count) {
  return (path, body) => {
    if (path.includes('approximate-count')) return ok({ count });
    if (path.includes('search/jql')) return ok({ issues: makeIssues(prefix, count), isLast: true });
    if (path.includes('changelog/bulkfetch')) {
      return ok({ issueChangeLogs: body.issueIdsOrKeys.map(issueId => ({ issueId, changeHistories: [] })) });
    }
    return undefined;
  };
}

async function answerAll(g, respond, jql) {
  for (let round = 0; round < 20; round += 1) {
    const due = g.requests.filter(r => !r.done && (r.body?.jql === undefined || r.body.jql.startsWith(jql)));
    if (!due.length) return;
    for (const r of due) r.resolve(respond(r.path, r.body));
    await flush();
  }
  throw new Error('requests kept coming');
}

const B = { name: 'Filter B', jql: 'project = B' };
const ERROR = /could not|error|failed|denied|permission|\b500\b|\b403\b/i;

for (const name of FETCHING) {
  for (const [label, failure] of [['HTTP 500', () => fail(500, { errorMessages: ['Old boom'] })],
    ['HTTP 403', () => fail(403, { errorMessages: ['Old denied'] })]]) {
    test(`QA KDG-7 ${name}: a stale ${label} after the new result is not shown`, withTimers(async () => {
      const control = await startGadget(name, { jira: jiraFor('B', 2) });
      await control.bus.send(FILTER_SELECTED, selection(B));
      await flush();
      const want = control.root.textContent;
      assert.doesNotMatch(want, ERROR, 'control instance shows no error');

      const g = await startGadget(name);
      await g.bus.send(FILTER_SELECTED, selection({ name: 'Filter A', jql: 'project = A' }));
      await flush();
      await g.bus.send(FILTER_SELECTED, selection(B));
      await flush();
      await answerAll(g, jiraFor('B', 2), 'project = B');
      assert.equal(g.root.textContent, want);
      await answerAll(g, failure, 'project = A');
      mock.timers.tick(3000); await flush();
      assert.equal(g.root.textContent, want, 'the stale failure changed nothing on screen');
    }));
  }

  test(`QA KDG-7 ${name}: a stale rejected request while the new one loads shows no error`,
    withTimers(async () => {
      const g = await startGadget(name);
      await g.bus.send(FILTER_SELECTED, selection({ name: 'Filter A', jql: 'project = A' }));
      await flush();
      const old = g.requests.filter(r => !r.done);
      await g.bus.send(FILTER_SELECTED, selection(B));
      await flush();
      for (const r of old) r.reject(new Error('Network went away'));
      await flush();
      assert.ok(!g.root.textContent.includes('Network went away'), g.root.textContent);
      await answerAll(g, jiraFor('B', 2), 'project = B');
      assert.ok(g.root.textContent.includes('Filter B'));
      assert.ok(!g.root.textContent.includes('Network went away'), g.root.textContent);
    }));
}
