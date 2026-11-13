import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isSuperseded } from '../static/jira-search.mjs';
import { todayInTimezone } from '../static/progress.mjs';
import { worklogAuthorClause, narrowJql } from '../static/drilldown.mjs';
import { fetchIssueWorklogs, fetchTimeLogging, fetchTimeLoggingIssues, fetchWorklogs, formatTimeSpent,
  hasAllWorklogs, loggingPeriod, summarizeTimeLogged, worklogDate, worklogPeriodDay, worklogWindow,
  WORKLOG_CONCURRENCY } from '../static/time-logging.mjs';

const HOUR = 3600;

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

function fail(status) {
  return { ok: false, status, json: async () => ({}) };
}

const ann = { accountId: 'a1', displayName: 'Ann' };
const bob = { accountId: 'b2', displayName: 'Bob' };
const cat = { accountId: 'c3', displayName: 'Cat' };

let nextId = 1;
function log(author, started, seconds, id = nextId++) {
  return { id: String(id), author, started, timeSpentSeconds: seconds };
}

function issue(id, assignee, worklogs = [], total = worklogs.length) {
  return { id: String(id), key: `K-${id}`, fields: { assignee, worklog: { startAt: 0, maxResults: 20, total, worklogs } } };
}

// 2026-11-02 is a Monday; 2026-11-13 (today in these tests) a Friday.
const RANGE = { kind: 'ready', startDate: '2026-11-02', lastDay: '2026-11-13', ended: false, workingDays: 10,
  firstWorkingDay: '2026-11-02' };
const NBSP = '\u00a0';

const period = (today, startDate, endDate) => loggingPeriod({ today, startDate, endDate });

test('logging period counts Mon-Fri from the Start Date to today, or the End Date once passed', () => {
  assert.deepEqual(period('2026-11-13', '2026-11-02', '2026-11-30'), { kind: 'ready', startDate: '2026-11-02',
    lastDay: '2026-11-13', ended: false, workingDays: 10, firstWorkingDay: '2026-11-02' });
  assert.deepEqual(period('2026-11-13', '2026-11-02'), { kind: 'ready', startDate: '2026-11-02',
    lastDay: '2026-11-13', ended: false, workingDays: 10, firstWorkingDay: '2026-11-02' });
  // Today is the End Date: not ended, both inclusive.
  assert.deepEqual(period('2026-11-13', '2026-11-13', '2026-11-13'), { kind: 'ready', startDate: '2026-11-13',
    lastDay: '2026-11-13', ended: false, workingDays: 1, firstWorkingDay: '2026-11-13' });
  // Ended: counts to the End Date (a Sunday), not today.
  assert.deepEqual(period('2026-11-13', '2026-11-02', '2026-11-08'), { kind: 'ready', startDate: '2026-11-02',
    lastDay: '2026-11-08', ended: true, workingDays: 5, firstWorkingDay: '2026-11-02' });
  // Started on a Saturday, today Sunday: no working days yet; the first is Monday.
  assert.deepEqual(period('2026-11-15', '2026-11-14', '2026-11-30'), { kind: 'no-working-days',
    startDate: '2026-11-14', lastDay: '2026-11-15', ended: false, workingDays: 0, firstWorkingDay: '2026-11-16' });
  // A weekend-only range that has finished: no working day at all.
  assert.deepEqual(period('2026-11-20', '2026-11-14', '2026-11-15'), { kind: 'no-working-days',
    startDate: '2026-11-14', lastDay: '2026-11-15', ended: true, workingDays: 0, firstWorkingDay: null });
  assert.deepEqual(period('2026-11-13', '2026-11-16', '2026-11-30'), { kind: 'not-started', startDate: '2026-11-16',
    lastDay: null, ended: false, workingDays: 0, firstWorkingDay: '2026-11-16' });
  assert.deepEqual(period('2026-11-13', '2026-11-21', '2026-11-22'), { kind: 'not-started', startDate: '2026-11-21',
    lastDay: null, ended: false, workingDays: 0, firstWorkingDay: null });
  assert.deepEqual(period('2026-11-13', '2026-11-10', '2026-11-09'), { kind: 'invalid', startDate: '2026-11-10',
    lastDay: null, ended: false, workingDays: 0, firstWorkingDay: null });
  for (const startDate of [undefined, null, '', '2026-02-30', 'soon']) {
    assert.deepEqual(period('2026-11-13', startDate, '2026-11-30'), { kind: 'no-start', startDate: null,
      lastDay: null, ended: false, workingDays: 0, firstWorkingDay: null }, String(startDate));
  }
  // An unreadable End Date counts as no End Date.
  assert.equal(period('2026-11-13', '2026-11-02', 'x').kind, 'ready');
  assert.throws(() => period('nope', '2026-11-02'), /Invalid today/);
  // Long ranges: 2026 has 261 weekdays.
  assert.equal(period('2027-01-05', '2026-01-01', '2026-12-31').workingDays, 261);
});

test('worklog date is the start time converted to the Jira time zone, across midnight', () => {
  assert.equal(worklogDate('2026-11-10T09:00:00.000+0000', 'UTC'), '2026-11-10');
  assert.equal(worklogDate('2026-11-10T09:00:00.000+0000', undefined), '2026-11-10');
  // 23:30 UTC Tuesday is Wednesday morning in Sydney and still Tuesday in New York.
  assert.equal(worklogDate('2026-11-10T23:30:00.000+0000', 'Australia/Sydney'), '2026-11-11');
  assert.equal(worklogDate('2026-11-10T23:30:00.000+0000', 'America/New_York'), '2026-11-10');
  // 01:00 at +1000 is the previous day in UTC and London.
  assert.equal(worklogDate('2026-11-11T01:00:00.000+1000', 'Europe/London'), '2026-11-10');
  assert.equal(worklogDate('2026-11-11T01:00:00.000+1000', 'Australia/Brisbane'), '2026-11-11');
  assert.equal(worklogDate('2026-11-10T20:00:00.000-0500', 'UTC'), '2026-11-11');
  assert.equal(worklogDate('2026-11-10T20:00:00.000-05:00', 'UTC'), '2026-11-11');
  // Unknown time zone falls back to UTC, like todayInTimezone.
  assert.equal(worklogDate('2026-11-10T23:30:00.000+0000', 'Not/AZone'), '2026-11-10');
  for (const bad of [undefined, null, '', 'yesterday', 1234]) assert.equal(worklogDate(bad, 'UTC'), null);
});

test('worklogs are placed on working days, weekends or outside the period in the Jira time zone', () => {
  const at = started => worklogPeriodDay({ started }, RANGE, 'UTC');
  assert.equal(at('2026-11-02T00:00:00.000+0000'), 'working-day'); // first day, Monday
  assert.equal(at('2026-11-13T23:59:00.000+0000'), 'working-day'); // last day, Friday
  assert.equal(at('2026-11-01T12:00:00.000+0000'), null); // before
  assert.equal(at('2026-11-14T00:00:00.000+0000'), null); // after
  assert.equal(at('2026-11-07T12:00:00.000+0000'), 'weekend');
  assert.equal(at('2026-11-08T12:00:00.000+0000'), 'weekend');
  assert.equal(at('garbage'), null);
  // Friday 23:00 UTC is Saturday in Sydney; Saturday 03:00 UTC is still Friday in Los Angeles.
  assert.equal(worklogPeriodDay({ started: '2026-11-06T23:00:00.000+0000' }, RANGE, 'Australia/Sydney'), 'weekend');
  assert.equal(worklogPeriodDay({ started: '2026-11-07T03:00:00.000+0000' }, RANGE, 'America/Los_Angeles'), 'working-day');
  // Monday 01:00 UTC is Sunday evening in New York: before the period there.
  assert.equal(worklogPeriodDay({ started: '2026-11-02T01:00:00.000+0000' }, RANGE, 'America/New_York'), null);
  assert.equal(worklogPeriodDay({ started: '2026-11-02T01:00:00.000+0000' }, RANGE, 'UTC'), 'working-day');
  for (const p of [{}, null, period('2026-11-13', '2026-11-16'), period('2026-11-13')]) {
    assert.equal(worklogPeriodDay({ started: '2026-11-03T12:00:00.000+0000' }, p, 'UTC'), null);
  }
});

const row = (accountId, displayName, loggedSeconds, averageSeconds, issueCount) =>
  ({ accountId, displayName, loggedSeconds, averageSeconds, issueCount });

test('summary lists assignees and in-period worklog authors with averages over working days', () => {
  const dee = { accountId: 'd4', displayName: 'Dee' };
  const eve = { accountId: 'e5', displayName: 'Eve' };
  const issues = [
    issue(1, ann, [
      log(ann, '2026-11-03T09:00:00.000+0000', 6 * HOUR),
      log(bob, '2026-11-04T09:00:00.000+0000', 2 * HOUR),
      log(ann, '2026-11-07T09:00:00.000+0000', 8 * HOUR), // Saturday: no time, still an issue
      log(ann, '2026-10-30T09:00:00.000+0000', 8 * HOUR), // before the period
    ]),
    issue(2, cat, [log(ann, '2026-11-05T09:00:00.000+0000', 4 * HOUR)]),
    issue(3, null, [log(dee, '2026-11-08T09:00:00.000+0000', HOUR)]), // Sunday only
    issue(4, null, [log(eve, '2026-11-14T09:00:00.000+0000', HOUR)]), // after: Eve is not listed
    issue(5, undefined),
  ];
  const result = summarizeTimeLogged(issues, new Map(), RANGE, 'UTC');
  assert.deepEqual(result, {
    people: [
      row('a1', 'Ann', 10 * HOUR, HOUR, 2),
      row('b2', 'Bob', 2 * HOUR, 0.2 * HOUR, 1),
      row('c3', 'Cat', 0, 0, 0),
      row('d4', 'Dee', 0, 0, 1),
    ],
    totalSeconds: 12 * HOUR,
    totalIssues: 5,
    loggedIssues: 3,
    workingDays: 10,
  });
  // issueCount matches the drilldown JQL for that person.
  assert.equal(narrowJql('project = K', [worklogAuthorClause('a1'), 'worklogDate >= "2026-11-02"']),
    '(project = K) AND (worklogAuthor = "a1") AND (worklogDate >= "2026-11-02")');
});

test('worklog author clause quotes and escapes the account id', () => {
  assert.equal(worklogAuthorClause('abc:123'), 'worklogAuthor = "abc:123"');
  assert.equal(worklogAuthorClause('a"b\\c'), 'worklogAuthor = "a\\"b\\\\c"');
});

test('summary uses fetched worklogs in place of a truncated embedded list and counts each once', () => {
  const embedded = [log(ann, '2026-11-03T09:00:00.000+0000', HOUR, 'w1')];
  const truncated = issue(1, bob, embedded, 25);
  const fetched = new Map([['1', [
    log(ann, '2026-11-03T09:00:00.000+0000', HOUR, 'w1'),
    log(ann, '2026-11-04T09:00:00.000+0000', HOUR, 'w2'),
    log(ann, '2026-11-04T09:00:00.000+0000', HOUR, 'w2'), // repeated across pages
    log(bob, '2026-11-05T09:00:00.000+0000', 30 * 60, 'w3'),
  ]]]);
  const result = summarizeTimeLogged([truncated], fetched, RANGE, 'UTC');
  assert.deepEqual(result.people.map(p => [p.displayName, p.loggedSeconds, p.issueCount]),
    [['Ann', 2 * HOUR, 1], ['Bob', 1800, 1]]);
  assert.equal(result.totalSeconds, 2 * HOUR + 1800);
});

test('summary sorts by unrounded average, then name ignoring case and accents, then accountId', () => {
  const at = '2026-11-03T09:00:00.000+0000';
  const issues = [issue(1, null, [
    log({ accountId: 'z', displayName: 'Zed' }, at, HOUR),
    log({ accountId: 'y', displayName: 'amy' }, at, HOUR),
    log({ accountId: 'x', displayName: 'Bea' }, at, 2 * HOUR),
    log({ accountId: 'v', displayName: 'Bea' }, at, 2 * HOUR + 1), // a second faster than the other Bea
    log({ accountId: 'u2', displayName: 'Émile' }, at, 60),
    log({ accountId: 'u1', displayName: 'emile' }, at, 60),
    log({ displayName: 'No id' }, at, 5 * HOUR),
    log({ accountId: 'x' }, at, -5),
    log({ accountId: 'x' }, at, 'lots'),
    log({ accountId: 'w' }, at),
  ])];
  const { people, totalSeconds } = summarizeTimeLogged(issues, new Map(), RANGE, 'UTC');
  assert.deepEqual(people.map(p => p.accountId), ['v', 'x', 'y', 'z', 'u1', 'u2', 'w']);
  assert.equal(totalSeconds, 6 * HOUR + 121);
  assert.equal(people.find(p => p.accountId === 'w').displayName, 'w'); // no display name: accountId
  // Same name, different accountId: two people.
  assert.equal(people.filter(p => p.displayName === 'Bea').length, 2);
});

test('with no working days every average is null', () => {
  const p = period('2026-11-15', '2026-11-14');
  const issues = [issue(1, ann, [log(ann, '2026-11-14T09:00:00.000+0000', HOUR)]), issue(2, bob)];
  const result = summarizeTimeLogged(issues, new Map(), p, 'UTC');
  assert.deepEqual(result.people, [row('a1', 'Ann', 0, null, 1), row('b2', 'Bob', 0, null, 0)]);
  assert.equal(result.workingDays, 0);
  // Not started: nobody's worklog is in the period; only assignees are listed.
  const before = summarizeTimeLogged(issues, new Map(), period('2026-11-13', '2026-11-16'), 'UTC');
  assert.deepEqual(before.people.map(x => [x.displayName, x.issueCount]), [['Ann', 0], ['Bob', 0]]);
  assert.deepEqual(summarizeTimeLogged([], undefined, RANGE, 'UTC'),
    { people: [], totalSeconds: 0, totalIssues: 0, loggedIssues: 0, workingDays: 10 });
});

test('time spent shows Jira-style hours and minutes rounded to the nearest minute', () => {
  assert.equal(formatTimeSpent(6.5 * HOUR), `6h${NBSP}30m`);
  assert.equal(formatTimeSpent(6 * HOUR), '6h');
  assert.equal(formatTimeSpent(45 * 60), '45m');
  assert.equal(formatTimeSpent(0), '0m');
  assert.equal(formatTimeSpent(120 * HOUR), '120h');
  assert.equal(formatTimeSpent(1234 * HOUR + 5 * 60), `1,234h${NBSP}5m`);
  assert.equal(formatTimeSpent(29), '0m');
  assert.equal(formatTimeSpent(30), '1m');
  assert.equal(formatTimeSpent(HOUR - 30), '1h');
  assert.equal(formatTimeSpent(HOUR - 31), '59m');
  assert.equal(formatTimeSpent(HOUR + 89), `1h${NBSP}1m`);
  assert.equal(formatTimeSpent(HOUR + 90), `1h${NBSP}2m`);
  assert.equal(formatTimeSpent(8 * HOUR / 3), `2h${NBSP}40m`);
  for (const bad of [undefined, null, NaN, -60, Infinity, '60']) assert.equal(formatTimeSpent(bad), '0m', String(bad));
});

test('an issue needs a worklog request only when its embedded list is truncated', () => {
  assert.equal(hasAllWorklogs(issue(1, ann, [log(ann, 'x', 1)])), true);
  assert.equal(hasAllWorklogs(issue(1, ann, [], 0)), true);
  assert.equal(hasAllWorklogs(issue(1, ann, new Array(20).fill(log(ann, 'x', 1)), 21)), false);
  assert.equal(hasAllWorklogs({ id: '1', fields: { worklog: { total: 3 } } }), false);
  assert.equal(hasAllWorklogs({ id: '1', fields: {} }), false, 'KDG-26: a missing field is fetched');
});

test('worklog window allows a day of slack each side of the range', () => {
  const window = worklogWindow(RANGE);
  assert.equal(window.startedAfter, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(window.startedBefore, Date.parse('2026-11-15T00:00:00Z'));
  // Covers the range's first and last local day in every time zone.
  assert.ok(Date.parse('2026-11-02T00:00:00+14:00') >= window.startedAfter);
  assert.ok(Date.parse('2026-11-13T23:59:59-12:00') < window.startedBefore);
  assert.equal(worklogWindow(period('2026-11-13', '2026-11-16')), null);
  assert.equal(worklogWindow(null), null);
});

// A fake Jira: search pages from `pages`, worklogs per issue from `worklogs` (id -> list).
function fakeJira({ pages, worklogs = {}, pageSize = 2, onWorklog } = {}) {
  const calls = [];
  const fn = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/rest/api/3/search/jql')) {
      const body = JSON.parse(options.body);
      const index = body.nextPageToken ? Number(body.nextPageToken) : 0;
      const last = index === pages.length - 1;
      return ok({ issues: pages[index], isLast: last, ...(last ? {} : { nextPageToken: String(index + 1) }) });
    }
    const match = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog\?(.*)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const query = new URLSearchParams(match[2]);
      await onWorklog?.(id, query);
      const all = worklogs[id] ?? [];
      const startAt = Number(query.get('startAt'));
      return ok({ startAt, maxResults: pageSize, total: all.length, worklogs: all.slice(startAt, startAt + pageSize) });
    }
    throw new Error(`Unexpected ${path}`);
  };
  fn.calls = calls;
  return fn;
}

test('fetching searches assignee and worklog, then requests only truncated issues by date', async () => {
  const full = issue(1, ann, [log(ann, '2026-11-03T09:00:00.000+0000', HOUR)]);
  const truncatedA = issue(2, bob, [log(bob, '2026-11-03T09:00:00.000+0000', HOUR)], 30);
  const truncatedB = issue(3, null, [], 21);
  const fetched = [1, 2, 3, 4, 5].map(n => log(bob, `2026-11-0${n + 2}T09:00:00.000+0000`, HOUR, `b${n}`));
  const jira = fakeJira({ pages: [[full, truncatedA], [truncatedB]], worklogs: { 2: fetched, 3: [] } });
  const progress = [];
  const result = await fetchTimeLogging(jira, 'project = K', RANGE, { onProgress: p => progress.push(p) });
  assert.deepEqual(result.issues.map(i => i.id), ['1', '2', '3']);
  assert.deepEqual([...result.worklogsByIssue.keys()].sort(), ['2', '3']);
  assert.deepEqual(result.worklogsByIssue.get('2').map(w => w.id), ['b1', 'b2', 'b3', 'b4', 'b5']);
  const searches = jira.calls.filter(c => c.path.startsWith('/rest/api/3/search/jql'));
  assert.equal(searches.length, 2);
  assert.deepEqual(JSON.parse(searches[0].options.body).fields, ['assignee', 'worklog']);
  const worklogCalls = jira.calls.filter(c => c.path.includes('/worklog?'));
  // Issue 2: 5 worklogs at 2 a page = 3 requests; issue 3: 1 request. Issue 1: none.
  assert.equal(worklogCalls.length, 4);
  for (const call of worklogCalls) {
    const query = new URLSearchParams(call.path.split('?')[1]);
    assert.equal(query.get('startedAfter'), String(Date.parse('2026-11-01T00:00:00Z')));
    assert.equal(query.get('startedBefore'), String(Date.parse('2026-11-15T00:00:00Z')));
    assert.equal(query.get('maxResults'), '5000');
  }
  assert.deepEqual(worklogCalls.filter(c => c.path.startsWith('/rest/api/3/issue/2/'))
    .map(c => new URLSearchParams(c.path.split('?')[1]).get('startAt')), ['0', '2', '4']);
  assert.deepEqual(progress[0], { done: 1, total: 3 });
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 });
  assert.equal(progress.length, 3);
  const summary = summarizeTimeLogged(result.issues, result.worklogsByIssue, RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.displayName, p.loggedSeconds]), [['Bob', 4 * HOUR], ['Ann', HOUR]]); // b5 is a Saturday
});

test('fetching sends no worklog requests or progress when nothing is truncated or there is no range', async () => {
  const truncated = issue(1, ann, [], 50);
  for (const range of [period('2026-11-13', '2026-11-16'), period('2026-11-13'),
    period('2026-11-13', '2026-11-10', '2026-11-09')]) {
    const jira = fakeJira({ pages: [[truncated]] });
    const progress = [];
    const result = await fetchTimeLogging(jira, 'project = K', range, { onProgress: p => progress.push(p) });
    assert.equal(jira.calls.length, 1);
    assert.equal(result.worklogsByIssue.size, 0);
    assert.deepEqual(progress, []);
  }
  const jira = fakeJira({ pages: [[issue(1, ann, [log(ann, '2026-11-03T09:00:00.000+0000', HOUR)])]] });
  const progress = [];
  await fetchTimeLogging(jira, 'project = K', RANGE, { onProgress: p => progress.push(p) });
  assert.equal(jira.calls.length, 1);
  assert.deepEqual(progress, []);
});

test('worklog requests run at most four at a time', async () => {
  const issues = Array.from({ length: 10 }, (_, i) => issue(i + 1, ann, [], 21));
  let inFlight = 0;
  let peak = 0;
  const jira = fakeJira({ pages: [issues], onWorklog: async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
  } });
  const result = await fetchTimeLogging(jira, 'project = K', RANGE);
  assert.equal(WORKLOG_CONCURRENCY, 4);
  assert.equal(peak, 4);
  assert.equal(result.worklogsByIssue.size, 10);
});

test('a superseded walk stops sending requests and throws SupersededError', async () => {
  const issues = Array.from({ length: 10 }, (_, i) => issue(i + 1, ann, [], 21));
  let current = true;
  let sent = 0;
  const jira = fakeJira({ pages: [issues], onWorklog: async () => {
    sent += 1;
    if (sent === 2) current = false;
  } });
  await assert.rejects(fetchTimeLogging(jira, 'project = K', RANGE, { isCurrent: () => current }), isSuperseded);
  assert.ok(sent <= WORKLOG_CONCURRENCY, `sent ${sent}`);
  // Superseded before the search: nothing is sent.
  const idle = fakeJira({ pages: [issues] });
  await assert.rejects(fetchTimeLogging(idle, 'project = K', RANGE, { isCurrent: () => false }), isSuperseded);
  assert.equal(idle.calls.length, 0);
  // Superseded between worklog pages of one issue.
  let pageCalls = 0;
  const paging = fakeJira({ worklogs: { 9: [1, 2, 3, 4, 5].map(n => log(ann, '2026-11-03T09:00:00.000+0000', n)) },
    onWorklog: () => { pageCalls += 1; } });
  await assert.rejects(fetchIssueWorklogs(paging, '9', worklogWindow(RANGE), { isCurrent: () => pageCalls < 1 }),
    isSuperseded);
  assert.equal(pageCalls, 1);
});

test('worklog request errors are reported and stop further requests', async () => {
  const issues = Array.from({ length: 8 }, (_, i) => issue(i + 1, ann, [], 21));
  for (const [status, pattern] of [[403, /cannot view worklogs/], [401, /cannot view worklogs/], [500, /failed \(500\)/]]) {
    let worklogCalls = 0;
    const jira = async (path, options) => {
      if (path.startsWith('/rest/api/3/search/jql')) return ok({ issues, isLast: true });
      worklogCalls += 1;
      return fail(status);
    };
    await assert.rejects(fetchTimeLogging(jira, 'project = K', RANGE), pattern);
    assert.ok(worklogCalls <= WORKLOG_CONCURRENCY, `${status}: ${worklogCalls}`);
  }
  const invalid = async () => ok({ total: 3 });
  await assert.rejects(fetchIssueWorklogs(invalid, '1', null), /invalid worklog list/);
  // A page that is empty before `total` is reached would loop forever; it is an error instead.
  const stuck = async () => ok({ startAt: 0, total: 5, worklogs: [] });
  await assert.rejects(fetchIssueWorklogs(stuck, '1', null), /next worklog page/);
  // Search errors surface as from the other gadgets.
  const badJql = async () => fail(400);
  await assert.rejects(fetchTimeLogging(badJql, 'nonsense', RANGE), /JQL/);
});

test('worklog request paths encode the issue key and omit dates without a window', async () => {
  const paths = [];
  const jira = async path => { paths.push(path); return ok({ startAt: 0, total: 0, worklogs: [] }); };
  await fetchIssueWorklogs(jira, 'A B/1', null);
  assert.equal(paths[0], '/rest/api/3/issue/A%20B%2F1/worklog?startAt=0&maxResults=5000');
});

test('todayInTimezone still falls back to UTC and reuses a formatter per time zone', () => {
  const now = new Date('2026-11-10T23:30:00Z');
  assert.equal(todayInTimezone('Australia/Sydney', now), '2026-11-11');
  assert.equal(todayInTimezone('Australia/Sydney', new Date('2026-11-10T10:00:00Z')), '2026-11-10');
  assert.equal(todayInTimezone('Bad/Zone', now), '2026-11-10');
  assert.equal(todayInTimezone('Bad/Zone', now), '2026-11-10');
  assert.equal(todayInTimezone(undefined, now), '2026-11-10');
});

test('the Time Logging gadget is registered without an edit view or new scopes', async () => {
  const manifest = await readFile(new URL('../manifest.yml', import.meta.url), 'utf8');
  const block = manifest.slice(manifest.indexOf('- key: kinetic-dashboard-time-logging'));
  const gadget = block.slice(0, block.indexOf('\n    - key:') === -1 ? block.indexOf('\n\n') : block.indexOf('\n    - key:'));
  assert.match(gadget, /title: Kinetic Dashboard Time Logging\n/);
  assert.match(gadget, /description: Show each person's average time logged per working day\.\n/);
  assert.match(gadget, /resource: time-logging\n/);
  assert.match(gadget, /refreshable: false/);
  assert.doesNotMatch(gadget, /edit:/);
  assert.match(manifest, /- key: time-logging\n {4}path: static\/time-logging\/dist\n/);
  assert.match(manifest, /scopes:\n {4}- read:jira-work\n {2}external:/);
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /'time-logging'/);
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^static\/time-logging\/dist\/$/m);
});


test('fetching reports search pages, the end of the search, then worklog progress in order', async () => {
  const truncated = issue(3, null, [], 21);
  const jira = fakeJira({ pages: [[issue(1, ann), issue(2, bob)], [truncated]], worklogs: { 3: [] } });
  const events = [];
  await fetchTimeLogging(jira, 'project = K', RANGE, {
    onPage: loaded => events.push(['page', loaded]),
    onSearchDone: () => events.push(['searchDone']),
    onProgress: p => events.push(['worklogs', p.done, p.total]),
  });
  assert.deepEqual(events, [['page', 2], ['page', 3], ['searchDone'], ['worklogs', 2, 3], ['worklogs', 3, 3]]);
  // The phases are also available separately, as the Burndown loads them.
  const issues = await fetchTimeLoggingIssues(fakeJira({ pages: [[truncated]] }), 'project = K');
  const byIssue = await fetchWorklogs(fakeJira({ worklogs: { 3: [log(ann, '2026-11-03T09:00:00.000+0000', 60)] } }),
    issues, RANGE);
  assert.equal(byIssue.get('3').length, 1);
});

test('a 404 on one issue\'s worklogs (deleted mid-load) falls back to its embedded worklogs', async () => {
  const embedded = [log(ann, '2026-11-03T09:00:00.000+0000', HOUR)];
  const gone = issue(1, ann, embedded, 21);
  const kept = issue(2, bob, [], 21);
  const keptLogs = [log(bob, '2026-11-04T09:00:00.000+0000', 2 * HOUR)];
  const progress = [];
  const jira = async path => {
    if (path.startsWith('/rest/api/3/search/jql')) return ok({ issues: [gone, kept], isLast: true });
    if (path.includes('/issue/1/worklog')) return fail(404);
    return ok({ startAt: 0, total: 1, worklogs: keptLogs });
  };
  const { issues, worklogsByIssue } = await fetchTimeLogging(jira, 'project = K', RANGE,
    { onProgress: p => progress.push([p.done, p.total]) });
  assert.equal(worklogsByIssue.has('1'), false, 'no fetched list for the deleted issue');
  assert.deepEqual(worklogsByIssue.get('2'), keptLogs);
  assert.deepEqual(progress.at(-1), [2, 2], 'the deleted issue still counts as done');
  const summary = summarizeTimeLogged(issues, worklogsByIssue, RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.displayName, p.loggedSeconds]), [['Bob', 2 * HOUR], ['Ann', HOUR]]);
  assert.equal(await fetchIssueWorklogs(async () => fail(404), '1', null), null);
});

test('KDG-26: an issue whose search result has no worklog field has its worklogs fetched and counted', async () => {
  const bare = { id: '7', key: 'K-7', fields: { assignee: ann } };
  const paths = [];
  const requestJira = async path => {
    paths.push(path);
    return { ok: true, status: 200, json: async () => ({ startAt: 0, maxResults: 5000, total: 1,
      worklogs: [log(ann, '2026-11-10T09:00:00.000+0000', 7200)] }) };
  };
  const worklogsByIssue = await fetchWorklogs(requestJira, [bare], RANGE);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /^\/rest\/api\/3\/issue\/7\/worklog\?/);
  const summary = summarizeTimeLogged([bare], worklogsByIssue, RANGE, 'UTC');
  assert.equal(summary.people[0].loggedSeconds, 7200);
  assert.equal(summary.people[0].issueCount, 1);
});
