// QA KDG-26: the Time Logging gadget must count worklogs when Jira's search leaves out the
// worklog field (for example Log work hidden in the project's field configuration).
import assert from 'node:assert/strict';
import test from 'node:test';
import { SEARCH_PATH } from '../static/jira-search.mjs';
import { fetchTimeLogging, fetchWorklogs, hasAllWorklogs, summarizeTimeLogged, worklogWindow,
  WORKLOG_CONCURRENCY } from '../static/time-logging.mjs';

const HOUR = 3600;
const ann = { accountId: 'a1', displayName: 'Ann' };
const bob = { accountId: 'b2', displayName: 'Bob' };
const RANGE = { kind: 'ready', startDate: '2026-11-02', lastDay: '2026-11-13', ended: false, workingDays: 10,
  firstWorkingDay: '2026-11-02' };

const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({}) });
let nextId = 1;
const log = (author, started, seconds) => ({ id: String(nextId++), author, started, timeSpentSeconds: seconds });
const bare = (id, assignee) => ({ id: String(id), key: `K-${id}`, fields: { assignee } });
const embedded = (id, assignee, worklogs) => ({ id: String(id), key: `K-${id}`,
  fields: { assignee, worklog: { startAt: 0, maxResults: 20, total: worklogs.length, worklogs } } });

test('QA KDG-26: a null or non-object worklog field is fetched too', () => {
  assert.equal(hasAllWorklogs({ id: '1', fields: { worklog: null } }), false);
  assert.equal(hasAllWorklogs({ id: '1', fields: { worklog: {} } }), false);
  assert.equal(hasAllWorklogs({ id: '1' }), false);
  assert.equal(hasAllWorklogs(null), false);
  // A complete embedded list (including an empty one with total 0) still needs no request.
  assert.equal(hasAllWorklogs(embedded(1, ann, [])), true);
});

test('QA KDG-26: end to end, a search with no worklog field still counts everyone\'s time', async () => {
  const calls = [];
  const requestJira = async (path, options = {}) => {
    calls.push({ path, body: options.body && JSON.parse(options.body) });
    if (path === SEARCH_PATH) {
      return ok({ issues: [bare(1, ann), bare(2, bob)], isLast: true });
    }
    const id = path.match(/issue\/(\d+)\/worklog/)[1];
    const author = id === '1' ? ann : bob;
    return ok({ startAt: 0, maxResults: 5000, total: 1,
      worklogs: [log(author, '2026-11-10T09:00:00.000+0000', 2 * HOUR * Number(id))] });
  };
  const { issues, worklogsByIssue } = await fetchTimeLogging(requestJira, 'project = K', RANGE);
  assert.deepEqual(calls[0].body.fields, ['assignee', 'worklog'], 'search asks for the worklog field');
  assert.equal(calls.length, 3, '1 search + 1 worklog request per issue without the field');
  for (const call of calls.slice(1)) {
    const query = new URL(call.path, 'https://x').searchParams;
    const window = worklogWindow(RANGE);
    assert.equal(query.get('startedAfter'), String(window.startedAfter));
    assert.equal(query.get('startedBefore'), String(window.startedBefore));
    assert.equal(query.get('startAt'), '0');
  }
  const summary = summarizeTimeLogged(issues, worklogsByIssue, RANGE, 'UTC');
  assert.deepEqual(summary.people.map(p => [p.displayName, p.loggedSeconds]), [['Bob', 4 * HOUR], ['Ann', 2 * HOUR]]);
  assert.equal(summary.totalSeconds, 6 * HOUR);
});

test('QA KDG-26: only issues missing the field are fetched; progress counts the rest as done', async () => {
  const paths = [];
  const progress = [];
  const requestJira = async path => {
    paths.push(path);
    return ok({ startAt: 0, maxResults: 5000, total: 0, worklogs: [] });
  };
  const issues = [embedded(1, ann, []), bare(2, ann), embedded(3, bob, [log(bob, '2026-11-03T09:00:00.000+0000', HOUR)]), bare(4, bob)];
  await fetchWorklogs(requestJira, issues, RANGE, { onProgress: p => progress.push(p) });
  assert.deepEqual(paths.map(p => p.match(/issue\/(\d+)/)[1]).sort(), ['2', '4']);
  assert.deepEqual(progress[0], { done: 2, total: 4 });
  assert.deepEqual(progress.at(-1), { done: 4, total: 4 });
});

test('QA KDG-26: many issues without the field run at most WORKLOG_CONCURRENCY at once', async () => {
  let inFlight = 0;
  let peak = 0;
  let count = 0;
  const requestJira = async () => {
    count += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
    return ok({ startAt: 0, maxResults: 5000, total: 0, worklogs: [] });
  };
  const issues = Array.from({ length: 50 }, (_, i) => bare(i + 1, ann));
  await fetchWorklogs(requestJira, issues, RANGE);
  assert.equal(count, 50, 'one request per issue');
  assert.equal(peak, WORKLOG_CONCURRENCY);
});

test('QA KDG-26: a 404 on an issue without the field counts nothing for it and does not fail', async () => {
  const requestJira = async path => (path.includes('/issue/1/')
    ? fail(404) : ok({ startAt: 0, total: 1, worklogs: [log(ann, '2026-11-04T10:00:00.000+0000', HOUR)] }));
  const issues = [bare(1, ann), bare(2, ann)];
  const byIssue = await fetchWorklogs(requestJira, issues, RANGE);
  const summary = summarizeTimeLogged(issues, byIssue, RANGE, 'UTC');
  assert.equal(summary.people[0].loggedSeconds, HOUR);
  assert.equal(summary.people[0].issueCount, 1);
});

test('QA KDG-26: a 403 on one issue without the field fails the whole load (behaviour lock-in)', async () => {
  const requestJira = async path => (path.includes('/issue/1/')
    ? fail(403) : ok({ startAt: 0, total: 0, worklogs: [] }));
  await assert.rejects(fetchWorklogs(requestJira, [bare(1, ann), bare(2, ann)], RANGE),
    /cannot view worklogs/);
});

test('QA KDG-26: no request when the period has no lastDay, even with the field missing', async () => {
  let count = 0;
  const byIssue = await fetchWorklogs(async () => { count += 1; return ok({}); }, [bare(1, ann)],
    { kind: 'not-started', startDate: '2026-12-01', lastDay: null });
  assert.equal(count, 0);
  assert.equal(byIssue.size, 0);
});

test('QA KDG-26: fetched worklogs use the viewer time zone and Jira offsets without a colon', async () => {
  // 23:30 on Fri 13 Nov in New York is 04:30 UTC on Sat 14 Nov.
  const late = log(ann, '2026-11-13T23:30:00.000-0500', HOUR);
  const byIssue = new Map([['1', [late]]]);
  const issues = [bare(1, ann)];
  assert.equal(summarizeTimeLogged(issues, byIssue, RANGE, 'America/New_York').people[0].loggedSeconds, HOUR);
  assert.equal(summarizeTimeLogged(issues, byIssue, RANGE, 'UTC').people[0].loggedSeconds, 0,
    'in UTC it falls on Saturday 14th, outside the period');
});
