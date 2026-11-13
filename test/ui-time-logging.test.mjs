// KDG-23: the Time Logging gadget (static/time-logging/src.mjs) through
// test/helpers/gadget-harness.mjs. The clock is Friday 13 Nov 2026, 12:00 UTC unless a test says
// otherwise; the default period starts Tuesday 3 Nov 2026, so 9 working days so far.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FILTER_SELECTED } from '../static/shared.mjs';
import { narrowJql, worklogAuthorClause } from '../static/drilldown.mjs';
import { fail, flush, ok, selection, startGadget } from './helpers/gadget-harness.mjs';

const NOW = '2026-11-13T12:00:00Z';
const NB = ' ';
const H = 3600;
const M = 60;

function withTimers(fn, now = NOW) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(now) });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn(); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

const PEOPLE = {
  a: { accountId: 'a', displayName: 'Alex Chen' },
  s: { accountId: 's', displayName: 'Sam Patel' },
  j: { accountId: 'j', displayName: 'Jo Rivers' },
  b: { accountId: 'b', displayName: 'bea' },
  n: { accountId: 'n', displayName: 'Anna' },
};
let nextLog = 1;
const log = (who, date, seconds) => ({ id: String(nextLog++), author: PEOPLE[who],
  started: `${date}T09:00:00.000+0000`, timeSpentSeconds: seconds });
let nextIssue = 1;
function issue(assignee, worklogs = [], total = worklogs.length) {
  const id = String(nextIssue++);
  return { id, key: `A-${id}`, fields: { assignee: assignee ? PEOPLE[assignee] : null,
    worklog: { startAt: 0, maxResults: 20, total, worklogs } } };
}

// Alex 58h 30m on working days (+ weekend work on an unassigned issue): 6h 30m a day, 2 issues.
// Sam 37h 30m (and work before the period): 4h 10m a day, 1 issue. Jo assigned, nothing logged.
const ISSUES = () => [
  issue('a', [log('a', '2026-11-03', 30 * H), log('a', '2026-11-04', 28 * H + 30 * M)]),
  issue('s', [log('s', '2026-11-05', 37 * H + 30 * M), log('s', '2026-11-02', 10 * H)]),
  issue('j'),
  issue(null, [log('a', '2026-11-07', 5 * H)]),
];
const PAYLOAD = { startDate: '2026-11-03', endDate: null };

const jiraWith = issues => path => {
  if (path.includes('approximate-count')) return ok({ count: issues.length });
  if (path.includes('search/jql')) return ok({ issues, isLast: true });
  return undefined;
};

async function show(issues = ISSUES(), overrides = {}, options = {}) {
  const g = await startGadget('time-logging', { jira: jiraWith(issues), ...options });
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, ...overrides }));
  await flush();
  return g;
}

const rowsOf = g => g.findAll('time-logging-row');
const rowNamed = (g, name) => rowsOf(g).find(row => row.find('leaderboard-name').textContent === name);
const detail = row => row.querySelector('span.leaderboard-detail').textContent;
const meta = row => row.find('capacity-meta').textContent;
const width = row => row.find('leaderboard-fill').style.width;
const messageText = g => g.find('time-logging-message').textContent;
const searches = g => g.requests.filter(r => r.path.includes('search/jql')).length;

function assertNoResults(g) {
  assert.equal(rowsOf(g).length, 0, 'no rows');
  assert.equal(g.find('capacity-legend').hidden, true, 'no legend');
  assert.equal(g.find('time-logging-footer').hidden, true, 'no footer');
}

async function opens(g, label) {
  const found = g.findAll('issue-count-link').find(button => button.getAttribute('aria-label') === label);
  assert.ok(found, `no link "${label}"; have ${g.findAll('issue-count-link').map(b => b.getAttribute('aria-label'))}`);
  found.click();
  await flush();
  return decodeURIComponent(g.opened.at(-1).replace('/issues/?jql=', ''));
}

// ---- Ready ----

test('KDG-23 time logging: rows, copy, sort, bars, legend and footer', withTimers(async () => {
  const g = await show();
  assert.ok(g.panel().classList.contains('time-logging'));
  assert.ok(g.panel().classList.contains('panel'));
  assert.equal(g.find('eyebrow').textContent, 'Time logged per person');
  assert.equal(g.find('chart-filter-name').textContent, 'Filter A');
  const range = g.find('capacity-range');
  assert.equal(range.hidden, false);
  assert.equal(range.textContent, `3${NB}Nov${NB}2026 – today · 9 working days so far`);
  assert.deepEqual(range.findAll('capacity-part').map(p => p.textContent),
    [`3${NB}Nov${NB}2026 – today`, '9 working days so far'], 'wraps only at " · "');

  assert.deepEqual(rowsOf(g).map(row => row.find('leaderboard-name').textContent),
    ['Alex Chen', 'Sam Patel', 'Jo Rivers'], 'highest average first, 0m people listed, no Unassigned');
  assert.deepEqual(rowsOf(g).map(detail),
    [`6h${NB}30m${NB}a${NB}day`, `4h${NB}10m${NB}a${NB}day`, `0m${NB}a${NB}day`]);
  assert.deepEqual(rowsOf(g).map(meta),
    [`58h${NB}30m logged · 2 issues`, `37h${NB}30m logged · 1 issue`, '0m logged']);
  assert.deepEqual(rowNamed(g, 'Alex Chen').findAll('capacity-part').map(p => p.textContent),
    [`58h${NB}30m logged`, '2 issues']);
  assert.equal(rowNamed(g, 'Jo Rivers').findAll('issue-count-link').length, 0, '0-issue person has no link');
  assert.ok(rowNamed(g, 'Jo Rivers').find('leaderboard-track'), 'a 0m row still shows its track');

  assert.equal(width(rowNamed(g, 'Alex Chen')), '100%');
  assert.equal(Number.parseFloat(width(rowNamed(g, 'Sam Patel'))).toFixed(2), (250 / 390 * 100).toFixed(2));
  assert.equal(width(rowNamed(g, 'Jo Rivers')), '0%');
  assert.equal(g.findAll('capacity-marker').length, 0, 'no marker');
  assert.equal(g.findAll('capacity-lozenge').length, 0, 'no judgement');

  const legend = g.find('capacity-legend');
  assert.equal(legend.hidden, false);
  assert.equal(legend.textContent, "Weekend work isn't counted.");
  assert.equal(g.find('time-logging-footer').hidden, false);
  // 96h over 3 people x 9 days = 3h 33m 20s.
  assert.equal(g.find('time-logging-average').textContent, `Average across 3 people: 3h${NB}33m${NB}a${NB}day`);
  assert.equal(g.find('time-logging-total').textContent, '4 issues in the current JQL scope');
  assert.equal(messageText(g), '');
  // Order: eyebrow, filter name, range, rows, legend, footer, message, live region.
  assert.deepEqual(g.panel().children.map(c => c.className), ['eyebrow', 'chart-filter-name',
    'muted capacity-range', 'leaderboard-rows time-logging-rows', 'muted capacity-legend',
    'time-logging-footer', 'status time-logging-message', 'visually-hidden']);
  assert.equal(g.panel().children.at(-1).getAttribute('role'), 'status');
  const search = g.requests.find(r => r.path.includes('search/jql'));
  assert.equal(search.body.jql, 'project = A', 'the whole JQL, ignoring Show ticks');
  assert.deepEqual(search.body.fields, ['assignee', 'worklog']);
}));

test('KDG-23 time logging: meters share one scale in minutes with aria text', withTimers(async () => {
  const g = await show();
  const track = name => rowNamed(g, name).find('leaderboard-track');
  const alex = track('Alex Chen');
  assert.equal(alex.getAttribute('role'), 'meter');
  assert.equal(alex.getAttribute('aria-label'), 'Alex Chen average time logged a day');
  assert.equal(alex.getAttribute('aria-valuemin'), '0');
  assert.equal(alex.getAttribute('aria-valuemax'), '390');
  assert.equal(alex.getAttribute('aria-valuenow'), '390');
  assert.equal(alex.getAttribute('aria-valuetext'),
    `6h${NB}30m${NB}a${NB}day, 58h${NB}30m logged over 9 working days`);
  assert.equal(track('Sam Patel').getAttribute('aria-valuenow'), '250');
  assert.equal(track('Sam Patel').getAttribute('aria-valuemax'), '390');
  assert.equal(track('Jo Rivers').getAttribute('aria-valuenow'), '0');
  assert.equal(track('Jo Rivers').getAttribute('aria-valuetext'), `0m${NB}a${NB}day, 0m logged over 9 working days`);
}));

test('KDG-23 time logging: drilldowns add worklogAuthor and the period to the JQL', withTimers(async () => {
  const g = await show(ISSUES(), { jql: 'project = A ORDER BY rank' });
  const period = ['worklogDate >= "2026-11-03"', 'worklogDate <= "2026-11-13"'];
  assert.equal(await opens(g,
    `Open 2 issues Alex Chen logged work on from 3${NB}Nov${NB}2026 to 13${NB}Nov${NB}2026, including weekends`),
  narrowJql('project = A ORDER BY rank', [worklogAuthorClause('a'), ...period]));
  assert.equal(await opens(g,
    `Open 1 issue Sam Patel logged work on from 3${NB}Nov${NB}2026 to 13${NB}Nov${NB}2026, including weekends`),
  narrowJql('project = A ORDER BY rank', [worklogAuthorClause('s'), ...period]));
  assert.equal(await opens(g, 'Open all 4 matching issues'), 'project = A ORDER BY rank');
  assert.deepEqual(rowNamed(g, 'Alex Chen').findAll('issue-count-link').map(b => b.textContent), ['2']);
}));

test('KDG-23 time logging: once the End Date has passed the drilldown and range end on it', withTimers(async () => {
  const g = await show(ISSUES(), { endDate: '2026-11-12' });
  assert.equal(g.find('capacity-range').textContent,
    `3${NB}Nov${NB}2026 – 12${NB}Nov${NB}2026 · Ended · 8 working days`);
  assert.equal(await opens(g,
    `Open 1 issue Sam Patel logged work on from 3${NB}Nov${NB}2026 to 12${NB}Nov${NB}2026, including weekends`),
  narrowJql('project = A', [worklogAuthorClause('s'), 'worklogDate >= "2026-11-03"', 'worklogDate <= "2026-11-12"']));
  // 58h 30m over 8 days = 7h 18m 45s, rounds to 7h 19m.
  assert.equal(detail(rowNamed(g, 'Alex Chen')), `7h${NB}19m${NB}a${NB}day`);
}));

test('KDG-23 time logging: ties sort by name ignoring case, then accountId', withTimers(async () => {
  const g = await show([issue('b', [log('b', '2026-11-03', H)]), issue('n', [log('n', '2026-11-04', H)])]);
  assert.deepEqual(rowsOf(g).map(row => row.find('leaderboard-name').textContent), ['Anna', 'bea']);
  assert.deepEqual(rowsOf(g).map(width), ['100%', '100%']);
  assert.equal(g.find('time-logging-average').textContent, `Average across 2 people: 7m${NB}a${NB}day`);
}));

test('KDG-23 time logging: nothing logged leaves every bar empty and says so in the footer', withTimers(async () => {
  let g = await show([issue('a'), issue('s', [log('s', '2026-11-07', 3 * H)])]);
  assert.deepEqual(rowsOf(g).map(row => row.find('leaderboard-name').textContent), ['Alex Chen', 'Sam Patel']);
  assert.deepEqual(rowsOf(g).map(width), ['0%', '0%'], 'never divides by 0');
  assert.deepEqual(rowsOf(g).map(row => row.find('leaderboard-track').getAttribute('aria-valuemax')), ['1', '1'],
    'aria-valuemax is never 0');
  assert.deepEqual(rowsOf(g).map(meta), ['0m logged', '0m logged · 1 issue'], 'weekend-only work still counts the issue');
  assert.equal(g.find('time-logging-average').textContent, 'No work logged on working days so far.');
  assert.equal(g.find('time-logging-total').textContent, '2 issues in the current JQL scope');

  g = await show([issue('a')], { endDate: '2026-11-12' });
  assert.equal(g.find('time-logging-average').textContent, 'No work logged on working days in this period.');
}));

test('KDG-23 time logging: time that averages under a minute reads "under 1m a day"', withTimers(async () => {
  const g = await show([issue('a', [log('a', '2026-11-03', 4 * M)]), issue('j')]);
  assert.equal(detail(rowNamed(g, 'Alex Chen')), `under${NB}1m${NB}a${NB}day`);
  assert.equal(meta(rowNamed(g, 'Alex Chen')), '4m logged · 1 issue');
  assert.equal(detail(rowNamed(g, 'Jo Rivers')), `0m${NB}a${NB}day`, 'nothing logged is 0m');
  assert.equal(width(rowNamed(g, 'Alex Chen')), '100%');
  assert.equal(rowNamed(g, 'Alex Chen').find('leaderboard-track').getAttribute('aria-valuetext'),
    `under${NB}1m${NB}a${NB}day, 4m logged over 9 working days`);
  assert.equal(g.find('time-logging-average').textContent, `Average across 2 people: under${NB}1m${NB}a${NB}day`);
}));

test('KDG-23 time logging: one person, one working day', withTimers(async () => {
  const g = await show([issue('a', [log('a', '2026-11-13', 6 * H)])], { startDate: '2026-11-13' });
  assert.equal(g.find('capacity-range').textContent, `13${NB}Nov${NB}2026 – today · 1 working day so far`);
  assert.equal(detail(rowNamed(g, 'Alex Chen')), `6h${NB}a${NB}day`);
  assert.equal(g.find('time-logging-average').textContent, `Average across 1 person: 6h${NB}a${NB}day`);
  assert.equal(g.find('time-logging-total').textContent, '1 issues in the current JQL scope');
}));

// ---- States ----

test('KDG-23 time logging: waiting and no-Controller states', withTimers(async () => {
  const g = await startGadget('time-logging');
  assert.equal(messageText(g), 'Waiting for the controller…');
  assertNoResults(g);
  mock.timers.tick(4000); await flush();
  assert.equal(messageText(g), 'Add a Kinetic Dashboard Controller to this dashboard.');
  assert.equal(g.requests.length, 0);
}));

for (const [label, overrides, want, rangeLine] of [
  ['no filter', { jql: null, name: null }, 'Choose a filter in the Controller.', null],
  ['no Start Date', { startDate: null, endDate: '2026-11-30' },
    'Set a Start Date for this filter in the Controller to see time logged.', null],
  ['End Date before Start Date', { startDate: '2026-11-10', endDate: '2026-11-03' }, 'End Date is before Start Date.', null],
  ['not started', { startDate: '2026-11-20', endDate: '2026-12-04' }, `The period starts on 20${NB}Nov${NB}2026.`,
    `20${NB}Nov${NB}2026 – 4${NB}Dec${NB}2026`],
  ['not started, no End Date', { startDate: '2026-11-20', endDate: null }, `The period starts on 20${NB}Nov${NB}2026.`,
    `From 20${NB}Nov${NB}2026`],
  ['over with no working days', { startDate: '2026-11-07', endDate: '2026-11-08' }, 'This period has no working days.',
    `7${NB}Nov${NB}2026 – 8${NB}Nov${NB}2026 · Ended · 0 working days`],
]) {
  test(`KDG-23 time logging: ${label} shows "${want}" without searching`, withTimers(async () => {
    const g = await show(ISSUES(), overrides);
    assert.equal(messageText(g), want);
    assert.equal(searches(g), 0);
    assertNoResults(g);
    const range = g.find('capacity-range');
    if (rangeLine === null) assert.equal(range.hidden, true, 'no range line');
    else {
      assert.equal(range.hidden, false);
      assert.equal(range.textContent, rangeLine);
    }
    assert.equal(g.find('visually-hidden').textContent, want, 'announced');
  }));
}

test('KDG-23 time logging: started on a weekend with no working days yet', withTimers(async () => {
  const g = await show(ISSUES(), { startDate: '2026-11-14' });
  assert.equal(messageText(g), `No working days so far. Averages start on 16${NB}Nov${NB}2026.`);
  assert.equal(g.find('capacity-range').textContent, `14${NB}Nov${NB}2026 – today · 0 working days so far`);
  assert.equal(searches(g), 0);
  assertNoResults(g);
}, '2026-11-15T12:00:00Z'));

test('KDG-23 time logging: a weekend-only period that has not ended shows the whole period', withTimers(async () => {
  const g = await show(ISSUES(), { startDate: '2026-11-14', endDate: '2026-11-15' });
  assert.equal(messageText(g), 'This period has no working days.');
  assert.equal(g.find('capacity-range').textContent, `14${NB}Nov${NB}2026 – 15${NB}Nov${NB}2026 · 0 working days`);
  assert.equal(searches(g), 0);
  assertNoResults(g);
}, '2026-11-14T12:00:00Z'));

test('KDG-23 time logging: not started with an unreadable End Date reads "From"', withTimers(async () => {
  const g = await show(ISSUES(), { startDate: '2026-11-20', endDate: 'soon' });
  assert.equal(messageText(g), `The period starts on 20${NB}Nov${NB}2026.`);
  assert.equal(g.find('capacity-range').textContent, `From 20${NB}Nov${NB}2026`);
}));

test('KDG-23 time logging: no matching issues', withTimers(async () => {
  const g = await show([]);
  assert.equal(messageText(g), 'No matching issues.');
  assertNoResults(g);
}));

test('KDG-23 time logging: issues but no people links all matching issues', withTimers(async () => {
  const g = await show([issue(null), issue(null, [log('a', '2026-11-02', H)])]);
  assert.equal(messageText(g), 'No one is assigned to or has logged work on the 2 matching issues.');
  assert.equal(await opens(g, 'Open all 2 matching issues'), 'project = A');
  assertNoResults(g);
  const one = await show([issue(null)]);
  assert.equal(messageText(one), 'No one is assigned to or has logged work on the 1 matching issue.');
  assert.equal(one.find('visually-hidden').textContent, 'No one is assigned to or has logged work on the 1 matching issue.');
  assert.equal(await opens(one, 'Open the 1 matching issue'), 'project = A');
}));

test('KDG-23 time logging: a failed load shows its message or the fallback', withTimers(async () => {
  let g = await show(ISSUES(), {}, { jira: () => fail(400) });
  assert.match(messageText(g), /JQL/);
  assertNoResults(g);
  g = await startGadget('time-logging');
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  g.pending('search/jql')[0].reject(new Error(''));
  await flush();
  assert.equal(messageText(g), 'Could not load time logged.');
  assert.equal(g.find('visually-hidden').textContent, 'Could not load time logged.');
  assertNoResults(g);
}));

test('KDG-23 time logging: a worklog request failure is shown', withTimers(async () => {
  const issues = [issue('a', [], 21)];
  const g = await show(issues, {}, { jira: path => (path.includes('/worklog') ? fail(403) : jiraWith(issues)(path)) });
  assert.equal(messageText(g), 'You cannot view worklogs for these issues.');
  assertNoResults(g);
}));

// ---- Loading ----

test('KDG-23 time logging: loading copy for issues, then worklogs, and its announcements', withTimers(async () => {
  const truncated = [log('a', '2026-11-03', 9 * H)];
  const issues = [issue('a', [], 21), issue('s'), issue('j', [], 25)];
  const g = await startGadget('time-logging');
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  assert.equal(messageText(g), '', 'nothing for the first 400 ms');
  mock.timers.tick(400); await flush();
  assert.equal(messageText(g), 'Loading issues…');
  g.pending('approximate-count')[0].resolve(ok({ count: 340 }));
  await flush();
  g.pending('search/jql')[0].resolve(ok({ issues: issues.slice(0, 2), nextPageToken: 'p2', isLast: false }));
  await flush();
  assert.equal(messageText(g), 'Loading issues… 2 of about 340');
  mock.timers.tick(600); await flush();
  assert.equal(g.find('visually-hidden').textContent, 'Loading time logged.');
  g.pending('search/jql')[0].resolve(ok({ issues: issues.slice(2), isLast: true }));
  await flush();
  assert.equal(messageText(g), 'Loading worklogs for 3 issues…');
  const [first, second] = g.pending('/worklog');
  assert.match(first.path, /^\/rest\/api\/3\/issue\/\d+\/worklog\?/);
  first.resolve(ok({ startAt: 0, total: 1, worklogs: truncated }));
  await flush();
  assert.equal(messageText(g), 'Loading worklogs… 2 of 3 issues');
  second.resolve(ok({ startAt: 0, total: 0, worklogs: [] }));
  await flush();
  assert.equal(messageText(g), '');
  assert.equal(rowsOf(g).length, 3);
  assert.equal(meta(rowNamed(g, 'Alex Chen')), `9h logged · 1 issue`, 'fetched worklogs replace the embedded list');
  assert.equal(g.find('visually-hidden').textContent, 'Time logged loaded.');
  assert.deepEqual(g.texts('status').filter(t => t.startsWith('Loading')), ['Loading issues…',
    'Loading issues… 2 of about 340', 'Loading issues… 3 of about 340', 'Loading worklogs for 3 issues…',
    'Loading worklogs… 2 of 3 issues', 'Loading worklogs… 3 of 3 issues']);
}));

test('KDG-23 time logging: a large filter shows the hint', withTimers(async () => {
  const g = await startGadget('time-logging');
  await g.bus.send(FILTER_SELECTED, selection(PAYLOAD));
  await flush();
  g.pending('approximate-count')[0].resolve(ok({ count: 12000 }));
  mock.timers.tick(400); await flush();
  assert.equal(messageText(g), 'Loading issues… Large filters can take a minute or more.');
}));

// ---- Refresh ----

test('KDG-23 time logging: reloads when the date changes in the Jira time zone', withTimers(async () => {
  const g = await show();
  assert.equal(searches(g), 1);
  mock.timers.tick(60000); await flush();
  assert.equal(searches(g), 1, 'same date: no reload');
  // 13 Nov 23:59:30, then 14 Nov 00:00:30 UTC.
  mock.timers.setTime(Date.parse('2026-11-13T23:58:30Z'));
  mock.timers.tick(60000); await flush();
  assert.equal(searches(g), 1, 'still 13 Nov');
  mock.timers.tick(60000); await flush();
  assert.equal(searches(g), 2, 'the date changed: reload');
  assert.equal(g.find('capacity-range').textContent, `3${NB}Nov${NB}2026 – today · 9 working days so far`);
  assert.equal(rowsOf(g).length, 3);
}));

test('KDG-23 time logging: the date check uses the Jira time zone', withTimers(async () => {
  // 10:59:30 UTC on 13 Nov is 23:59:30 in Auckland (UTC+13); a minute later it is 14 Nov there
  // but still 13 Nov in UTC.
  const g = await show(ISSUES(), {}, { timezone: 'Pacific/Auckland' });
  assert.equal(searches(g), 1);
  mock.timers.tick(60000); await flush();
  assert.equal(searches(g), 2, 'midnight in Auckland reloads');
}, '2026-11-13T10:59:30Z'));

test('KDG-23 time logging: a new selection supersedes a load in progress', withTimers(async () => {
  const g = await startGadget('time-logging');
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, jql: 'project = OLD' }));
  await flush();
  const old = g.pending('search/jql')[0];
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, name: 'New', jql: 'project = NEW' }));
  await flush();
  old.resolve(ok({ issues: [issue('a', [], 21)], nextPageToken: 'old-2', isLast: false }));
  await flush();
  assert.equal(g.requests.filter(r => r.body?.jql === 'project = OLD' && r.path.includes('search/jql')).length, 1,
    'no further old page');
  assert.equal(g.pending('/worklog').length, 0, 'no worklogs for the old selection');
  g.pending('search/jql').find(r => r.body.jql === 'project = NEW').resolve(ok({ issues: [issue('s')], isLast: true }));
  await flush();
  assert.equal(g.find('chart-filter-name').textContent, 'New');
  assert.deepEqual(rowsOf(g).map(row => row.find('leaderboard-name').textContent), ['Sam Patel']);
  assert.ok(!/Could not|superseded/i.test(g.root.textContent), g.root.textContent);
}));

test('KDG-23 time logging: a new selection mid-worklogs drops the old worklogs', withTimers(async () => {
  const g = await startGadget('time-logging');
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, jql: 'project = OLD' }));
  await flush();
  g.pending('search/jql')[0].resolve(ok({ issues: [issue('a', [], 21)], isLast: true }));
  await flush();
  const worklogs = g.pending('/worklog')[0];
  assert.ok(worklogs);
  await g.bus.send(FILTER_SELECTED, selection({ ...PAYLOAD, name: 'New', jql: 'project = NEW', startDate: null }));
  await flush();
  worklogs.resolve(ok({ startAt: 0, total: 1, worklogs: [log('a', '2026-11-03', H)] }));
  await flush();
  assert.equal(messageText(g), 'Set a Start Date for this filter in the Controller to see time logged.');
  assertNoResults(g);
}));
