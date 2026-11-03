// KDG-13: Weighted Burndown loading copy and timing rules.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createBurndownLoader, initialLoading, LARGE_FILTER_THRESHOLD, LOADING_ANNOUNCE_DELAY,
  LOADING_TEXT_DELAY, loadingView, PROGRESS_ANNOUNCE_INTERVAL, withApproximate, withHistory,
  withPage, withSearchDone } from '../static/burndown-state.mjs';

const view = state => loadingView(state);
const HINT = 'Large filters can take a minute or more.';

test('timing constants match the spec', () => {
  assert.equal(LOADING_TEXT_DELAY, 400);
  assert.equal(LOADING_ANNOUNCE_DELAY, 1000);
  assert.equal(PROGRESS_ANNOUNCE_INTERVAL, 15000);
  assert.equal(LARGE_FILTER_THRESHOLD, 10000);
});

test('phase 1 copy before and after pages, with en-GB grouping', () => {
  assert.deepEqual(view(initialLoading()), { text: 'Loading issues…', announcement: 'Loading issues.' });
  assert.deepEqual(view(withPage(initialLoading(), 3000)),
    { text: 'Loading issues… 3,000 found', announcement: 'Loading issues… 3,000 found.' });
  const approx = withApproximate(withPage(initialLoading(), 3000), 5400);
  assert.deepEqual(view(approx), { text: 'Loading issues… 3,000 of about 5,400',
    announcement: 'Loading issues… 3,000 of about 5,400.' });
});

test('"of about" switches to "found" once the approximate count is reached or exceeded', () => {
  const approx = withApproximate(initialLoading(), 5400);
  assert.equal(view(withPage(approx, 5399)).text, 'Loading issues… 5,399 of about 5,400');
  assert.equal(view(withPage(approx, 5400)).text, 'Loading issues… 5,400 found');
  assert.equal(view(withPage(approx, 6000)).text, 'Loading issues… 6,000 found');
});

test('an unavailable approximate count shows the "found" form and no hint', () => {
  // The gadget never calls approximate() when the request fails, so the state stays null.
  const shown = view(withPage(initialLoading(), 12000));
  assert.equal(shown.text, 'Loading issues… 12,000 found');
});

test('phase 2 copy, including singular "issue"', () => {
  const started = withHistory(withPage(initialLoading(), 4500), { done: 0, total: 4500 });
  assert.deepEqual(view(started), {
    text: 'Loading status history for 4,500 issues…',
    announcement: 'Loading status history for 4,500 issues.',
  });
  // done from the start call (the cached count) is not shown before a batch finishes.
  const cachedStart = withHistory(initialLoading(), { done: 1200, total: 4500 });
  assert.equal(view(cachedStart).text, 'Loading status history for 4,500 issues…');
  const progressed = withHistory(cachedStart, { done: 2200, total: 4500 });
  assert.deepEqual(view(progressed), {
    text: 'Loading status history… 2,200 of 4,500 issues',
    announcement: 'Loading status history… 2,200 of 4,500 issues.',
  });
  assert.equal(view(withHistory(initialLoading(), { done: 0, total: 1 })).text,
    'Loading status history for 1 issue…');
  assert.equal(view(withHistory(withHistory(initialLoading(), { done: 0, total: 1 }), { done: 1, total: 1 })).text,
    'Loading status history… 1 of 1 issue');
});

test('large-filter hint appears at 10,000 but not 9,999, with the full-stop rule', () => {
  const below = withApproximate(initialLoading(), 9999);
  assert.equal(view(below).text, 'Loading issues…');
  assert.equal(view(withPage(below, 3000)).text, 'Loading issues… 3,000 of about 9,999');

  const at = withApproximate(initialLoading(), 10000);
  assert.deepEqual(view(at), { text: `Loading issues… ${HINT}`, announcement: `Loading issues… ${HINT}` });
  assert.equal(view(withPage(withApproximate(initialLoading(), 14200), 3000)).text,
    `Loading issues… 3,000 of about 14,200. ${HINT}`);
  assert.equal(view(withPage(at, 12000)).text, `Loading issues… 12,000 found. ${HINT}`);
  const history = withHistory(withPage(at, 12000), { done: 0, total: 12000 });
  assert.equal(view(history).text, `Loading status history for 12,000 issues… ${HINT}`);
  assert.equal(view(withHistory(history, { done: 3000, total: 12000 })).text,
    `Loading status history… 3,000 of 12,000 issues. ${HINT}`);
});

test('a late approximate count is ignored after the search finishes', () => {
  const done = withSearchDone(withPage(initialLoading(), 500));
  assert.equal(withApproximate(done, 20000), done);
  const history = withHistory(withPage(initialLoading(), 500), { done: 0, total: 500 });
  assert.equal(withApproximate(history, 20000), history);
  assert.equal(view(withApproximate(history, 20000)).text, 'Loading status history for 500 issues…');
});

function harness() {
  const texts = [];
  const spoken = [];
  const loader = createBurndownLoader({ setText: text => texts.push(text), announce: text => spoken.push(text) });
  return { texts, spoken, loader, lastText: () => texts.at(-1) };
}

function withTimers(fn) {
  return () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try { fn(); } finally { mock.timers.reset(); }
  };
}

test('no visible text before 400 ms and no announcement before 1,000 ms', withTimers(() => {
  const { texts, spoken, loader, lastText } = harness();
  const run = loader.start();
  assert.deepEqual(texts, ['']);
  run.page(1000);
  mock.timers.tick(399);
  assert.deepEqual(texts, ['']);
  mock.timers.tick(1);
  assert.equal(lastText(), 'Loading issues… 1,000 found');
  run.page(2000);
  assert.equal(lastText(), 'Loading issues… 2,000 found');
  mock.timers.tick(599);
  assert.deepEqual(spoken, []);
  mock.timers.tick(1);
  assert.deepEqual(spoken, ['Loading the burndown.']);
}));

test('a fast load shows no loading text and announces nothing', withTimers(() => {
  const { texts, spoken, loader } = harness();
  const run = loader.start();
  run.page(10);
  run.history({ done: 0, total: 10 });
  mock.timers.tick(300);
  run.ready();
  mock.timers.tick(60000);
  assert.deepEqual(texts, ['', '']);
  assert.deepEqual(spoken, []);
}));

test('ready after the loading text but before the announcement stays silent', withTimers(() => {
  const { spoken, loader, lastText } = harness();
  const run = loader.start();
  mock.timers.tick(700);
  assert.equal(lastText(), 'Loading issues…');
  run.ready();
  assert.equal(lastText(), '');
  mock.timers.tick(60000);
  assert.deepEqual(spoken, []);
}));

test('"Burndown loaded." is announced only after the loading announcement', withTimers(() => {
  const { spoken, loader, lastText } = harness();
  const run = loader.start();
  mock.timers.tick(1000);
  run.ready();
  assert.equal(lastText(), '');
  assert.deepEqual(spoken, ['Loading the burndown.', 'Burndown loaded.']);
}));

test('progress is announced at most every 15 s, trailing and latest wins', withTimers(() => {
  const { spoken, loader } = harness();
  const run = loader.start();
  run.page(1000); // before the loading announcement: not announced
  mock.timers.tick(1000);
  assert.deepEqual(spoken, ['Loading the burndown.']);
  run.page(2000);
  mock.timers.tick(5000);
  run.page(3000);
  run.history({ done: 0, total: 3000 }); // a phase change does not force an extra announcement
  mock.timers.tick(9999);
  assert.deepEqual(spoken, ['Loading the burndown.']);
  mock.timers.tick(1); // 15 s after the loading announcement (at 16 s)
  assert.deepEqual(spoken, ['Loading the burndown.', 'Loading status history for 3,000 issues.']);
  run.history({ done: 1000, total: 3000 });
  mock.timers.tick(14999);
  assert.equal(spoken.length, 2);
  mock.timers.tick(1);
  assert.deepEqual(spoken.at(-1), 'Loading status history… 1,000 of 3,000 issues.');
  mock.timers.tick(30000); // nothing new, nothing written
  assert.equal(spoken.length, 3);
  run.history({ done: 2000, total: 3000 }); // outside a cool-down: written at once
  assert.deepEqual(spoken.at(-1), 'Loading status history… 2,000 of 3,000 issues.');
}));

test('errors and final messages replace the progress and are announced immediately', withTimers(() => {
  const { texts, spoken, loader, lastText } = harness();
  let run = loader.start();
  mock.timers.tick(200);
  run.fail(new Error('Jira request failed (500).'));
  assert.equal(lastText(), 'Jira request failed (500).');
  assert.deepEqual(spoken, ['Jira request failed (500).']);
  mock.timers.tick(60000);
  assert.equal(lastText(), 'Jira request failed (500).');
  assert.deepEqual(spoken, ['Jira request failed (500).']);

  run = loader.start();
  mock.timers.tick(1000);
  run.page(500);
  run.page(1000); // pending progress announcement
  run.fail({});
  assert.equal(lastText(), 'Could not load the burndown.');
  mock.timers.tick(60000);
  assert.deepEqual(spoken.slice(1), ['Loading the burndown.', 'Could not load the burndown.'],
    'no "Burndown loaded." and no trailing progress after an error');

  run = loader.start();
  run.message('No matching issues.');
  assert.equal(lastText(), 'No matching issues.');
  assert.equal(spoken.at(-1), 'No matching issues.');
  const count = texts.length;
  mock.timers.tick(60000);
  assert.equal(texts.length, count);
}));

test('guard messages outside a load are shown and announced at once', withTimers(() => {
  const { spoken, loader, lastText } = harness();
  loader.start();
  loader.message('Choose a filter in the Controller.');
  assert.equal(lastText(), 'Choose a filter in the Controller.');
  assert.deepEqual(spoken, ['Choose a filter in the Controller.']);
  mock.timers.tick(60000);
  assert.deepEqual(spoken, ['Choose a filter in the Controller.']);
}));

test('a stale run\'s callbacks and timers have no effect', withTimers(() => {
  const { texts, spoken, loader, lastText } = harness();
  const old = loader.start();
  mock.timers.tick(1000);
  old.page(1000); // pending trailing announcement for the old run
  const fresh = loader.start();
  assert.equal(old.active, false);
  old.page(5000);
  old.approximate(20000);
  old.history({ done: 0, total: 5000 });
  old.ready();
  old.fail(new Error('old'));
  old.message('old');
  assert.equal(lastText(), '');
  mock.timers.tick(399);
  assert.equal(lastText(), '');
  mock.timers.tick(1);
  assert.equal(lastText(), 'Loading issues…');
  mock.timers.tick(600);
  assert.deepEqual(spoken, ['Loading the burndown.', 'Loading the burndown.']);
  fresh.ready();
  assert.equal(spoken.at(-1), 'Burndown loaded.');
  assert.ok(!texts.includes('old'));

  const cancelled = loader.start();
  loader.cancel();
  cancelled.page(10);
  mock.timers.tick(60000);
  assert.equal(lastText(), '');
  assert.equal(spoken.at(-1), 'Burndown loaded.');
}));

test('a late approximate count does not change the text; an early one adds the hint', withTimers(() => {
  const { loader, lastText } = harness();
  let run = loader.start();
  mock.timers.tick(400);
  run.approximate(14200);
  assert.equal(lastText(), `Loading issues… ${HINT}`);
  run.page(3000);
  assert.equal(lastText(), `Loading issues… 3,000 of about 14,200. ${HINT}`);
  run.ready();
  assert.equal(lastText(), '', 'the hint is removed when loading ends');

  run = loader.start();
  mock.timers.tick(400);
  run.page(800);
  run.searchDone();
  run.approximate(50000);
  assert.equal(lastText(), 'Loading issues… 800 found');
}));

test('a repeated guard message is shown but announced once until a load starts', withTimers(() => {
  const cancels = [];
  const texts = [];
  const spoken = [];
  const loader = createBurndownLoader({ setText: t => texts.push(t), announce: t => spoken.push(t),
    cancelAnnounce: () => cancels.push(true) });
  loader.message('Choose a filter in the Controller.');
  loader.message('Choose a filter in the Controller.');
  assert.deepEqual(texts, ['Choose a filter in the Controller.', 'Choose a filter in the Controller.']);
  assert.deepEqual(spoken, ['Choose a filter in the Controller.']);
  assert.equal(cancels.length, 1, 'a repeat does not cancel the first announcement in the sink');
  loader.message('Set Start Date and End Date in the Controller.');
  assert.equal(spoken.at(-1), 'Set Start Date and End Date in the Controller.');
  loader.start().cancel();
  loader.message('Set Start Date and End Date in the Controller.');
  assert.equal(spoken.filter(t => t.startsWith('Set Start')).length, 2, 'start() resets the memory');
  loader.cancel();
  loader.message('Set Start Date and End Date in the Controller.');
  assert.equal(spoken.filter(t => t.startsWith('Set Start')).length, 3, 'cancel() resets the memory');
}));

test('start, cancel and a new guard message call cancelAnnounce; ending a load does not', withTimers(() => {
  let cancels = 0;
  const loader = createBurndownLoader({ setText: () => {}, announce: () => {}, cancelAnnounce: () => { cancels += 1; } });
  const run = loader.start();
  assert.equal(cancels, 1);
  run.fail(new Error('x'));
  assert.equal(cancels, 1);
  loader.message('Choose a filter in the Controller.');
  assert.equal(cancels, 2);
  loader.cancel();
  assert.equal(cancels, 3);
}));
