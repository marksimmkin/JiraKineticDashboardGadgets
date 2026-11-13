// QA for KDG-23 (Time Logging gadget): edge cases not covered by time-logging.test.mjs and
// ui-time-logging.test.mjs. The UI clock is Friday 13 Nov 2026, 12:00 UTC.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, worklogAuthorClause } from '../static/drilldown.mjs';
import { loadingView } from '../static/burndown-state.mjs';
import { fetchIssueWorklogs, fetchWorklogs, formatTimeSpent, hasAllWorklogs, loggingPeriod,
  summarizeTimeLogged, worklogDate, worklogPeriodDay, worklogWindow } from '../static/time-logging.mjs';
import { flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const NB = ' ';
const H = 3600;
const DAY = 86400000;

const ann = { accountId: 'a1', displayName: 'Ann' };
const ann2 = { accountId: 'a2', displayName: 'Ann' };
const bob = { accountId: 'b2', displayName: 'Bob' };

let nextId = 1;
const log = (author, started, seconds, id = String(nextId++)) => ({ id, author, started, timeSpentSeconds: seconds });
function issue(id, assignee, worklogs = [], total = worklogs.length) {
  return { id: String(id), key: `K-${id}`, fields: { assignee,
    worklog: { startAt: 0, maxResults: 20, total, worklogs } } };
}
// Mon 2 Nov to Fri 13 Nov 2026: 10 working days.
const RANGE = loggingPeriod({ today: '2026-11-13', startDate: '2026-11-02' });

// ---- Time zones and offsets ----

test('QA KDG-23: offsets in every Jira format are read, including Z and colon offsets', () => {
  assert.equal(worklogDate('2026-11-06T23:30:00.000+0000', 'UTC'), '2026-11-06');
  assert.equal(worklogDate('2026-11-06T23:30:00.000Z', 'UTC'), '2026-11-06');
  assert.equal(worklogDate('2026-11-06T23:30:00.000-0230', 'UTC'), '2026-11-07');
  assert.equal(worklogDate('2026-11-07T01:00:00.000+05:30', 'UTC'), '2026-11-06');
  assert.equal(worklogDate('not a date', 'UTC'), null);
  assert.equal(worklogDate(undefined, 'UTC'), null);
});

test('QA KDG-23: the weekday/weekend edge is judged in the Jira time zone, not UTC', () => {
  // Fri 23:30 UTC is Sat 12:30 in Auckland: weekend there, working day in UTC.
  const friLate = log(ann, '2026-11-06T23:30:00.000+0000', H);
  assert.equal(worklogPeriodDay(friLate, RANGE, 'UTC'), 'working-day');
  assert.equal(worklogPeriodDay(friLate, RANGE, 'Pacific/Auckland'), 'weekend');
  // Mon 02:00 UTC is Sun 18:00 in Los Angeles.
  const monEarly = log(ann, '2026-11-09T02:00:00.000+0000', H);
  assert.equal(worklogPeriodDay(monEarly, RANGE, 'UTC'), 'working-day');
  assert.equal(worklogPeriodDay(monEarly, RANGE, 'America/Los_Angeles'), 'weekend');
  // Logged in a different zone than the viewer's: Sat 22:00 -08:00 is Sun 06:00 UTC, and
  // Mon 07:00 +09:00 in Tokyo is Sun 22:00 UTC.
  assert.equal(worklogPeriodDay(log(ann, '2026-11-07T22:00:00.000-0800', H), RANGE, 'UTC'), 'weekend');
  assert.equal(worklogPeriodDay(log(ann, '2026-11-09T07:00:00.000+0900', H), RANGE, 'UTC'), 'weekend');
  assert.equal(worklogPeriodDay(log(ann, '2026-11-09T07:00:00.000+0900', H), RANGE, 'Asia/Tokyo'), 'working-day');
});

test('QA KDG-23: period edges in the Jira time zone (start of Start Date, end of today)', () => {
  // Start Date 2 Nov in Sydney (+11): 1 Nov 13:30 UTC is 2 Nov 00:30 there -> inside.
  assert.equal(worklogPeriodDay(log(ann, '2026-11-01T13:30:00.000+0000', H), RANGE, 'Australia/Sydney'), 'working-day');
  assert.equal(worklogPeriodDay(log(ann, '2026-11-01T13:30:00.000+0000', H), RANGE, 'UTC'), null, 'Sun 1 Nov in UTC: before the period');
  // Last day 13 Nov in Los Angeles (-08): 14 Nov 07:00 UTC is 13 Nov 23:00 there -> inside.
  assert.equal(worklogPeriodDay(log(ann, '2026-11-14T07:00:00.000+0000', H), RANGE, 'America/Los_Angeles'), 'working-day');
  assert.equal(worklogPeriodDay(log(ann, '2026-11-14T07:00:00.000+0000', H), RANGE, 'UTC'), null);
});

test('QA KDG-23: the worklog request window covers both period edges in the most extreme zones', () => {
  const window = worklogWindow(RANGE);
  // Start of 2 Nov at UTC+14 (Kiritimati) and end of 13 Nov at UTC-12.
  const earliest = Date.parse('2026-11-02T00:00:00+14:00');
  const latest = Date.parse('2026-11-13T23:59:59.999-12:00');
  assert.ok(window.startedAfter <= earliest, 'startedAfter is no later than the earliest period instant');
  assert.ok(window.startedBefore > latest, 'startedBefore is after the latest period instant');
  // ... and the slack is bounded (no more than two days beyond the period each side).
  assert.ok(Date.parse('2026-11-02T00:00:00Z') - window.startedAfter <= 2 * DAY);
  assert.ok(window.startedBefore - Date.parse('2026-11-14T00:00:00Z') <= 2 * DAY);
});

test('QA KDG-23: working days are calendar days, unaffected by DST changes', () => {
  // UK clocks go back on Sun 25 Oct 2026; US on Sun 1 Nov 2026.
  assert.equal(loggingPeriod({ today: '2026-11-06', startDate: '2026-10-19' }).workingDays, 15);
  // A worklog at 00:30 BST on Sun 25 Oct is still Sunday in London.
  const period = loggingPeriod({ today: '2026-11-06', startDate: '2026-10-19' });
  assert.equal(worklogPeriodDay(log(ann, '2026-10-25T00:30:00.000+0100', H), period, 'Europe/London'), 'weekend');
  // 23:30 on Fri 23 Oct BST = 22:30 UTC: still Friday in London.
  assert.equal(worklogPeriodDay(log(ann, '2026-10-23T22:30:00.000+0000', H), period, 'Europe/London'), 'working-day');
});

test('QA KDG-23: Start Date equal to End Date, and today before the Start Date', () => {
  const same = loggingPeriod({ today: '2026-11-13', startDate: '2026-11-10', endDate: '2026-11-10' });
  assert.equal(same.kind, 'ready');
  assert.equal(same.workingDays, 1);
  assert.equal(same.lastDay, '2026-11-10');
  assert.equal(same.ended, true);
  const today = loggingPeriod({ today: '2026-11-10', startDate: '2026-11-10', endDate: '2026-11-10' });
  assert.equal(today.ended, false, 'the End Date itself is still running');
  assert.equal(today.workingDays, 1);
  const weekendSame = loggingPeriod({ today: '2026-11-13', startDate: '2026-11-07', endDate: '2026-11-07' });
  assert.equal(weekendSame.kind, 'no-working-days');
  assert.equal(weekendSame.firstWorkingDay, null);
  assert.equal(loggingPeriod({ today: '2026-11-09', startDate: '2026-11-10' }).kind, 'not-started');
});

// ---- Summary ----

test('QA KDG-23: same display name with different accountIds are two people', () => {
  const summary = summarizeTimeLogged([issue(1, ann, [log(ann2, '2026-11-03T09:00:00.000+0000', 2 * H)])],
    new Map(), RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.accountId, p.loggedSeconds]), [['a2', 2 * H], ['a1', 0]]);
});

test('QA KDG-23: people who only logged outside the period are left out unless assigned', () => {
  const summary = summarizeTimeLogged([
    issue(1, ann, [log(ann, '2026-10-30T09:00:00.000+0000', 5 * H), log(bob, '2026-11-16T09:00:00.000+0000', H)]),
  ], new Map(), RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.displayName, p.loggedSeconds, p.issueCount]), [['Ann', 0, 0]]);
  assert.equal(summary.loggedIssues, 0);
});

test('QA KDG-23: weekend-only authors in the period are listed with 0m and their issue', () => {
  const summary = summarizeTimeLogged([issue(1, null, [log(bob, '2026-11-08T09:00:00.000+0000', 3 * H)])],
    new Map(), RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.displayName, p.loggedSeconds, p.issueCount]), [['Bob', 0, 1]]);
  assert.equal(summary.totalSeconds, 0);
});

test('QA KDG-23: fetched worklogs replace the embedded 20 entirely (no double counting)', () => {
  const embedded = Array.from({ length: 20 }, (_, i) => log(ann, '2026-11-03T09:00:00.000+0000', H, `w${i}`));
  const fetched = Array.from({ length: 25 }, (_, i) => log(ann, '2026-11-03T09:00:00.000+0000', H, `w${i}`));
  // A page boundary repeat of the same id counts once.
  fetched.push(log(ann, '2026-11-03T09:00:00.000+0000', H, 'w24'));
  const summary = summarizeTimeLogged([issue(7, ann, embedded, 25)], new Map([['7', fetched]]), RANGE, 'UTC');
  assert.equal(summary.people[0].loggedSeconds, 25 * H);
  assert.equal(summary.people[0].issueCount, 1);
});

test('QA KDG-23: zero, negative and missing time spent add nothing but still count the issue', () => {
  const summary = summarizeTimeLogged([issue(1, null, [log(ann, '2026-11-03T09:00:00.000+0000', 0),
    log(ann, '2026-11-03T09:00:00.000+0000', -60), log(ann, '2026-11-03T09:00:00.000+0000', undefined)])],
  new Map(), RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.loggedSeconds, p.issueCount]), [[0, 1]]);
});

// ---- Format ----

test('QA KDG-23: formatTimeSpent rounds to the minute before splitting hours', () => {
  assert.equal(formatTimeSpent(29), '0m');
  assert.equal(formatTimeSpent(30), '1m');
  assert.equal(formatTimeSpent(89), '1m');
  assert.equal(formatTimeSpent(90), '2m');
  assert.equal(formatTimeSpent(3599), '1h', '59m 59s rounds to 1h, not "0h 60m"');
  assert.equal(formatTimeSpent(3570), '1h', '59m 30s rounds up');
  assert.equal(formatTimeSpent(3540), '59m');
  assert.equal(formatTimeSpent(7140), `1h${NB}59m`);
  assert.equal(formatTimeSpent(1234 * H + 5 * 60), `1,234h${NB}5m`);
  assert.equal(formatTimeSpent(NaN), '0m');
  assert.equal(formatTimeSpent(Infinity), '0m');
  assert.equal(formatTimeSpent(-100), '0m');
});

// ---- Fetching ----

test('QA KDG-23: exactly 20 embedded worklogs needs no request; 21 does', () => {
  const twenty = Array.from({ length: 20 }, () => log(ann, '2026-11-03T09:00:00.000+0000', H));
  assert.equal(hasAllWorklogs(issue(1, ann, twenty, 20)), true);
  assert.equal(hasAllWorklogs(issue(1, ann, twenty, 21)), false);
  assert.equal(hasAllWorklogs({ id: '1', fields: { assignee: ann } }), false, 'KDG-26: no worklog field: fetch');
});

test('QA KDG-23: worklog paging follows startAt, tolerates a missing total, and stops on an empty page', async () => {
  const paths = [];
  const pages = [
    { startAt: 0, total: 3, worklogs: [log(ann, '2026-11-03T09:00:00.000+0000', H)] },
    { startAt: 1, total: 3, worklogs: [log(ann, '2026-11-03T09:00:00.000+0000', H), log(ann, '2026-11-03T09:00:00.000+0000', H)] },
  ];
  let all = await fetchIssueWorklogs(async path => { paths.push(path); return ok(pages[paths.length - 1]); }, 'K-1', null);
  assert.equal(all.length, 3);
  assert.match(paths[1], /startAt=1/);

  all = await fetchIssueWorklogs(async () => ok({ worklogs: [log(ann, '2026-11-03T09:00:00.000+0000', H)] }), 'K-1', null);
  assert.equal(all.length, 1, 'no total: one page');

  await assert.rejects(fetchIssueWorklogs(async () => ok({ total: 5, worklogs: [] }), 'K-1', null),
    /did not provide the next worklog page/);
  await assert.rejects(fetchIssueWorklogs(async () => ({ ok: false, status: 403, json: async () => ({}) }), 'K-1', null),
    /cannot view worklogs/);
  await assert.rejects(fetchIssueWorklogs(async () => ok({ total: 1 }), 'K-1', null), /invalid worklog list/);
});

test('QA KDG-23: request count is one per truncated issue only', async () => {
  const paths = [];
  const issues = [
    issue(1, ann, [log(ann, '2026-11-03T09:00:00.000+0000', H)]),
    issue(2, ann, Array.from({ length: 20 }, () => log(ann, '2026-11-03T09:00:00.000+0000', H)), 40),
    issue(3, bob, []),
  ];
  const map = await fetchWorklogs(async path => { paths.push(path); return ok({ total: 0, worklogs: [] }); },
    issues, RANGE);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /\/rest\/api\/3\/issue\/2\/worklog\?/);
  assert.match(paths[0], new RegExp(`startedAfter=${worklogWindow(RANGE).startedAfter}`));
  assert.deepEqual([...map.keys()], ['2']);
});

// ---- Burndown regression ----

test('QA KDG-23: Burndown loading copy is unchanged by the parameterised loader', () => {
  assert.equal(loadingView({ phase: 'history', loaded: 3, approximate: null, total: 3, done: null }).text,
    'Loading status history for 3 issues…');
  assert.equal(loadingView({ phase: 'history', loaded: 3, approximate: null, total: 3, done: 1 }).text,
    'Loading status history… 1 of 3 issues');
});

// ---- UI ----

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-11-13T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const jiraWith = issues => path => {
  if (path.includes('approximate-count')) return ok({ count: issues.length });
  if (path.includes('search/jql')) return ok({ issues, isLast: true });
  return undefined;
};

test('QA KDG-23: names are shown as text, never HTML, including in labels', withTimers(async () => {
  const evil = { accountId: 'x"y\\z', displayName: '<img src=x onerror=alert(1)>' };
  const g = await startGadget('time-logging', { jira: jiraWith([issue(1, evil, [log(evil, '2026-11-03T09:00:00.000+0000', H)])]) });
  await g.bus.send(FILTER_SELECTED, selection({ jql: 'summary ~ "a \\"b\\"" ORDER BY created DESC',
    startDate: '2026-11-03', endDate: null }));
  await flush();
  const row = g.findAll('time-logging-row')[0];
  assert.equal(row.find('leaderboard-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(g.findAll('img').length, 0);
  const link = row.findAll('issue-count-link')[0];
  link.click();
  await flush();
  const jql = decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
  assert.equal(jql, narrowJql('summary ~ "a \\"b\\"" ORDER BY created DESC',
    [worklogAuthorClause('x"y\\z'), 'worklogDate >= "2026-11-03"', 'worklogDate <= "2026-11-13"']));
  assert.ok(jql.endsWith(' ORDER BY created DESC'), 'ORDER BY stays last');
  assert.ok(jql.includes('worklogAuthor = "x\\"y\\\\z"'), 'accountId quoted and escaped');
}));

test('QA KDG-23: a Jira time zone ahead of UTC moves Friday-night work to the weekend', withTimers(async () => {
  const issues = [issue(1, ann, [log(ann, '2026-11-06T23:30:00.000+0000', 9 * H), log(ann, '2026-11-05T09:00:00.000+0000', 9 * H)])];
  const g = await startGadget('time-logging', { jira: jiraWith(issues), timezone: 'Pacific/Auckland' });
  await g.bus.send(FILTER_SELECTED, selection({ startDate: '2026-11-03', endDate: null }));
  await flush();
  const row = g.findAll('time-logging-row')[0];
  // Auckland today is Sat 14 Nov 01:00, so 9 working days (3-13 Nov); only 9h counts.
  assert.equal(row.find('capacity-meta').textContent, `9h logged · 1 issue`);
  assert.equal(row.querySelector('span.leaderboard-detail').textContent, `1h${NB}a${NB}day`);
}));
