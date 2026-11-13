// QA KDG-27: the Time Logging gadget is removed; the shared helpers it used keep their behaviour.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test, { mock } from 'node:test';
import { BURNDOWN_COPY, createBurndownLoader, LOAD_ERROR_TEXT, LOADED_ANNOUNCEMENT,
  LOADING_ANNOUNCE_DELAY, LOADING_ANNOUNCEMENT, LOADING_TEXT_DELAY, loadingView } from '../static/burndown-state.mjs';
import { runBatches } from '../static/burndown.mjs';
import { weekday, weekdaysBetween, workingDaysLeft } from '../static/capacity.mjs';
import * as drilldown from '../static/drilldown.mjs';
import { SupersededError } from '../static/jira-search.mjs';
import { dateOrdinal, todayInTimezone } from '../static/progress.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const NAMES = ['controller', 'counter', 'dates', 'status-chart', 'progress-bar', 'burndown',
  'status-pie', 'issue-list', 'user-list', 'user-leaderboard', 'capacity'];

test('QA KDG-27: no Time Logging gadget, resource, build entry, ignore rule or source remains', () => {
  const manifest = read('manifest.yml');
  assert.doesNotMatch(manifest, /time-logging|Time Logging/);
  assert.equal(manifest.match(/^\s+- key: kinetic-dashboard-/gm).length, 11);
  const paths = [...manifest.matchAll(/path: static\/([\w-]+)\/dist/g)].map(m => m[1]);
  assert.deepEqual([...paths].sort(), [...NAMES].sort());
  const build = read('scripts/build.mjs');
  for (const name of NAMES) assert.match(build, new RegExp(`'${name}'`));
  assert.doesNotMatch(build, /time-logging/);
  assert.doesNotMatch(read('.gitignore'), /time-logging/);
  for (const path of ['static/time-logging', 'static/time-logging.mjs', 'Kinetic Dashboard Time Logging.md']) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  assert.equal('worklogAuthorClause' in drilldown, false);
});

test('QA KDG-27: README says Eleven and lists the same gadgets as the Brief', () => {
  const readme = read('README.md');
  assert.match(readme, /^Eleven Forge Custom UI gadgets/m);
  const listed = [...readme.matchAll(/^- \*\*([^*]+)\*\*:/gm)].map(m => m[1]);
  assert.equal(listed.length, 11);
  const brief = [...read('Brief.md').matchAll(/^- \[\[Kinetic Dashboard ([^\]]+)\]\]/gm)].map(m => m[1]);
  assert.equal(brief.length, 11);
  assert.doesNotMatch(readme + read('Brief.md') + read('Kinetic Dashboard Controller.md'), /time logg|worklog/i);
});

test('QA KDG-27: Burndown loader defaults are unchanged; a copy override still works', () => {
  assert.deepEqual({ ...BURNDOWN_COPY }, { history: 'status history', loading: LOADING_ANNOUNCEMENT,
    loaded: LOADED_ANNOUNCEMENT, error: LOAD_ERROR_TEXT });
  assert.equal(loadingView({ phase: 'history', loaded: 1, approximate: null, total: 1, done: null }).text,
    'Loading status history for 1 issue…');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    for (const copy of [undefined, { history: 'x', loading: 'L.', loaded: 'D.', error: 'E.' }]) {
      const texts = []; const said = [];
      const loader = createBurndownLoader({ setText: t => texts.push(t), announce: t => said.push(t), copy });
      const run = loader.start();
      run.searchDone(); run.history({ done: 0, total: 2 }); run.history({ done: 0, total: 2 });
      mock.timers.tick(Math.max(LOADING_TEXT_DELAY, LOADING_ANNOUNCE_DELAY));
      assert.equal(texts.at(-1), `Loading ${copy ? 'x' : 'status history'}… 0 of 2 issues`);
      assert.equal(said[0], copy ? 'L.' : LOADING_ANNOUNCEMENT);
      run.fail(new Error(''));
      assert.equal(texts.at(-1), copy ? 'E.' : LOAD_ERROR_TEXT);
    }
  } finally { mock.timers.reset(); }
});

test('QA KDG-27: runBatches keeps order, limit and supersede behaviour', async () => {
  let inFlight = 0; let peak = 0;
  const result = await runBatches([3, 1, 2, 5], 2, async n => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise(r => setImmediate(r)); inFlight -= 1; return n * 10;
  });
  assert.deepEqual(result, [30, 10, 20, 50]);
  assert.equal(peak, 2);
  assert.deepEqual(await runBatches([], 4, async () => 1), []);
  let calls = 0;
  await assert.rejects(runBatches([1, 2, 3], 1, async () => { calls += 1; }, () => calls < 1),
    error => error instanceof SupersededError);
  assert.equal(calls, 1);
});

test('QA KDG-27: weekday, weekdaysBetween and todayInTimezone are unchanged', () => {
  assert.equal(weekday(0), 4); // 1970-01-01 Thursday
  const mon = dateOrdinal('2026-11-09');
  assert.equal(weekday(mon), 1);
  assert.equal(weekdaysBetween(mon, mon + 6), 5);
  assert.equal(weekdaysBetween(mon + 5, mon + 6), 0);
  assert.equal(weekdaysBetween(mon + 1, mon), 0);
  assert.deepEqual(workingDaysLeft({ today: '2026-11-13', startDate: null, endDate: '2026-11-13' }).days, 1);
  const now = new Date('2026-11-13T23:30:00Z');
  assert.equal(todayInTimezone('Pacific/Auckland', now), '2026-11-14');
  assert.equal(todayInTimezone('America/Los_Angeles', now), '2026-11-13');
  assert.equal(todayInTimezone('Not/AZone', now), '2026-11-13');
  assert.equal(todayInTimezone('Not/AZone', now), '2026-11-13'); // cached fallback
  assert.equal(todayInTimezone(null, now), '2026-11-13');
  assert.equal(todayInTimezone('Pacific/Auckland', now), '2026-11-14'); // cache keyed by zone
});
