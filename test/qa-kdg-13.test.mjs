// QA KDG-13: end-to-end wiring of the Weighted Burndown loading progress. Bundles
// static/burndown/src.mjs with a fake @forge/bridge and drives refresh() against a minimal fake
// DOM with mocked timers, so the gadget entry point is checked, not only burndown-state.mjs.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createAnnouncer } from '../static/counter-state.mjs';
import { createBurndownLoader, loadingView, initialLoading, withPage, withApproximate,
  withHistory } from '../static/burndown-state.mjs';

const SRC = fileURLToPath(new URL('../static/burndown/src.mjs', import.meta.url));
const HINT = 'Large filters can take a minute or more.';
const ok = body => ({ ok: true, status: 200, json: async () => body });
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(r => setImmediate(r)); };

let bundled = null;
async function bundle() {
  if (bundled) return bundled;
  const result = await build({
    entryPoints: [SRC], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{
      name: 'fake-bridge',
      setup(b) {
        b.onResolve({ filter: /^@forge\/bridge$/ }, () => ({ path: 'bridge', namespace: 'qa' }));
        b.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({
          loader: 'js',
          contents: 'const b = globalThis.__qaBridge; export const events = b.events, ' +
            'requestJira = (...a) => b.requestJira(...a), router = b.router, view = b.view;',
        }));
      },
    }],
  });
  bundled = result.outputFiles[0].text;
  return bundled;
}

class El {
  constructor(tag, log) {
    this.tagName = tag; this.children = []; this.attributes = {}; this._text = '';
    this.className = ''; this.hidden = false; this.log = log;
  }
  get textContent() {
    return this.children.length
      ? this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('') : this._text;
  }
  set textContent(value) {
    this.children = []; this._text = String(value);
    if (this.className === 'status' || this.className === 'visually-hidden') {
      this.log.push({ el: this.className, text: this._text, at: Date.now() });
    }
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener() {}
  find(className) {
    if (this.className === className) return this;
    for (const c of this.children) if (c instanceof El) { const f = c.find(className); if (f) return f; }
    return null;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

// Starts a fresh gadget instance. Returns handles for events, requests and the DOM log.
async function startGadget() {
  const log = [];
  const root = new El('main', log);
  globalThis.document = {
    getElementById: () => root,
    createElement: tag => new El(tag, log),
    createElementNS: (ns, tag) => new El(tag, log),
  };
  const handlers = new Map();
  const requests = [];
  const bridge = {
    view: { theme: { enable: async () => {} },
      getContext: async () => ({ timezone: 'UTC', extension: { dashboard: { id: 'd1' }, gadget: { id: 'g1' } } }) },
    events: { on: async (name, fn) => { handlers.set(name, fn); }, emit: async () => {} },
    router: { open: async () => {} },
    requestJira: (path, options) => {
      const gate = deferred();
      requests.push({ path, body: JSON.parse(options.body), gate, resolve: r => gate.resolve(r) });
      return gate.promise;
    },
  };
  globalThis.__qaBridge = bridge;
  const code = await bundle();
  await import(`data:text/javascript;base64,${Buffer.from(`${code}\n//${Math.random()}`).toString('base64')}`);
  await flush();
  const panel = root.children[0];
  return {
    log, requests, panel,
    status: () => panel.find('status'),
    live: () => panel.find('visually-hidden'),
    select: payload => [...handlers.values()][0](
      { dashboardId: 'd1', name: 'F', startDate: '2026-01-01', endDate: '2026-12-31',
        statuses: [{ name: 'To Do', weight: 1 }, { name: 'Done', weight: 0 }], ...payload }),
    refreshEvent: () => [...handlers.values()][1]({ origin: 'dashboard' }),
    pendingTo: part => requests.filter(r => r.path.includes(part) && !r.done),
    statusTexts: () => log.filter(e => e.el === 'status').map(e => e.text),
    liveTexts: () => log.filter(e => e.el === 'visually-hidden').map(e => e.text),
  };
}

const issue = id => ({ id: String(id), fields: { created: '2026-01-02T00:00:00Z', updated: '2026-01-02T00:00:00Z', status: { name: 'To Do' } } });
const issues = (from, n) => Array.from({ length: n }, (_, i) => issue(from + i));
const changelogs = ids => ({ issueChangeLogs: ids.map(id => ({ issueId: id, changeHistories: [] })) });
function answer(req, response) { req.done = true; req.resolve(response); }

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-06-01T12:00:00Z') });
    const warn = mock.method(console, 'warn', () => {});
    try { await fn({ warn }); } finally { warn.mock.restore(); mock.timers.reset(); }
  };
}

test('QA KDG-13 e2e: role="status" moved off the visible message to a hidden live region', withTimers(async () => {
  const g = await startGadget();
  assert.equal(g.status().getAttribute('role'), undefined);
  assert.equal(g.live().getAttribute('role'), 'status');
  assert.equal(g.live().textContent, '');
}));

test('QA KDG-13 e2e: slow load shows the full progress sequence and announces sensibly', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = A ORDER BY rank' });
  await flush();
  assert.equal(g.status().textContent, '', 'message cleared at start');
  const approx = g.pendingTo('approximate-count');
  assert.equal(approx.length, 1, 'one approximate-count request, started with the search');
  assert.deepEqual(approx[0].body, { jql: 'project = A' });
  assert.equal(g.pendingTo('search/jql').length, 1);
  mock.timers.tick(399); await flush();
  assert.equal(g.status().textContent, '');
  mock.timers.tick(1); await flush();
  assert.equal(g.status().textContent, 'Loading issues…');
  answer(approx[0], ok({ count: 12000 }));
  await flush();
  assert.equal(g.status().textContent, `Loading issues… ${HINT}`);
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 1000), nextPageToken: 't1', isLast: false }));
  await flush();
  assert.equal(g.status().textContent, `Loading issues… 1,000 of about 12,000. ${HINT}`);
  mock.timers.tick(600); await flush(); // 1,000 ms
  assert.deepEqual(g.liveTexts(), ['Loading the burndown.']);
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1001, 1500), isLast: true }));
  await flush();
  assert.equal(g.status().textContent, `Loading status history for 2,500 issues… ${HINT}`);
  const batches = g.pendingTo('bulkfetch');
  assert.deepEqual(batches.map(b => b.body.issueIdsOrKeys.length), [1000, 1000, 500]);
  answer(batches[2], ok(changelogs(batches[2].body.issueIdsOrKeys)));
  await flush();
  assert.equal(g.status().textContent, `Loading status history… 500 of 2,500 issues. ${HINT}`);
  mock.timers.tick(14999); await flush();
  assert.deepEqual(g.liveTexts(), ['Loading the burndown.']);
  mock.timers.tick(1); await flush(); // 16 s
  assert.deepEqual(g.liveTexts(), ['Loading the burndown.', `Loading status history… 500 of 2,500 issues. ${HINT}`]);
  answer(batches[0], ok(changelogs(batches[0].body.issueIdsOrKeys)));
  answer(batches[1], ok(changelogs(batches[1].body.issueIdsOrKeys)));
  await flush();
  assert.equal(g.status().textContent, '', 'progress removed on ready');
  assert.equal(g.panel.find('burndown-summary').children.length > 0, true, 'chart summary rendered');
  assert.equal(g.liveTexts().at(-1), 'Burndown loaded.');
  const seen = g.liveTexts().length;
  mock.timers.tick(60000); await flush();
  assert.equal(g.liveTexts().length, seen, 'no trailing progress after "Burndown loaded."');
  assert.ok(!g.statusTexts().some(t => /of about/.test(t) && /status history/.test(t)));

  // Second refresh: every history is cached, search is quick -> nothing shown or announced.
  const logBefore = g.log.length;
  g.refreshEvent();
  await flush();
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 2500), isLast: true }));
  await flush();
  assert.equal(g.pendingTo('bulkfetch').length, 0, 'phase 2 makes no requests when all cached');
  mock.timers.tick(60000); await flush();
  const after = g.log.slice(logBefore);
  assert.ok(after.every(e => e.text === ''), `nothing but clears: ${JSON.stringify(after)}`);
  assert.ok(!after.some(e => e.el === 'visually-hidden'));
}));

test('QA KDG-13 e2e: all cached but slow search shows no phase 2 text', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = B' });
  await flush();
  answer(g.pendingTo('approximate-count')[0], ok({ count: 3 }));
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 3), isLast: true }));
  await flush();
  const b = g.pendingTo('bulkfetch')[0];
  answer(b, ok(changelogs(b.body.issueIdsOrKeys)));
  await flush();
  g.refreshEvent();
  await flush();
  mock.timers.tick(500); await flush();
  answer(g.pendingTo('approximate-count')[0], ok({ count: 3 }));
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 3), isLast: true }));
  await flush();
  assert.equal(g.status().textContent, '');
  assert.ok(!g.statusTexts().some(t => t.includes('status history')), JSON.stringify(g.statusTexts()));
  assert.ok(g.statusTexts().includes('Loading issues…'));
}));

test('QA KDG-13 e2e: a filter change mid-load makes the old load and its timers inert', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = OLD' });
  await flush();
  mock.timers.tick(900); await flush();
  const oldApprox = g.pendingTo('approximate-count')[0];
  const oldSearch = g.pendingTo('search/jql')[0];
  g.select({ jql: 'project = NEW', name: 'New' });
  await flush();
  assert.equal(g.status().textContent, '', 'new run clears the message');
  mock.timers.tick(300); await flush(); // old 1,000 ms announcement would be due now
  assert.deepEqual(g.liveTexts(), []);
  answer(oldApprox, ok({ count: 99999 }));
  answer(oldSearch, ok({ issues: issues(1, 7000), isLast: true }));
  await flush();
  assert.ok(!g.statusTexts().some(t => t.includes('7,000') || t.includes('99,999')));
  assert.equal(g.pendingTo('bulkfetch').length, 0, 'stale search does not start phase 2');
  const newReqs = g.requests.filter(r => !r.done);
  assert.equal(newReqs.length, 2);
  answer(newReqs.find(r => r.path.includes('approximate')), { ok: false, status: 500, json: async () => ({}) });
  await flush();
  answer(newReqs.find(r => r.path.includes('search/jql')), ok({ issues: [], isLast: true }));
  await flush();
  assert.equal(g.status().textContent, 'No matching issues.');
  assert.equal(g.liveTexts().at(-1), 'No matching issues.');
}));

test('QA KDG-13 e2e: approximate failure is silent; errors replace progress immediately', withTimers(async ({ warn }) => {
  const g = await startGadget();
  g.select({ jql: 'project = C' });
  await flush();
  answer(g.pendingTo('approximate-count')[0], { ok: false, status: 500, json: async () => ({}) });
  await flush();
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(g.status().textContent, '');
  answer(g.pendingTo('search/jql')[0], { ok: false, status: 403, json: async () => ({}) });
  await flush();
  const text = 'You cannot view these issues or their status history.';
  assert.equal(g.status().textContent, text, 'error shown before 400 ms');
  assert.deepEqual(g.liveTexts(), [text]);
  mock.timers.tick(60000); await flush();
  assert.equal(g.status().textContent, text);
  assert.deepEqual(g.liveTexts(), [text]);

  // Same error again: the live region is cleared and rewritten after 100 ms.
  g.refreshEvent();
  await flush();
  answer(g.pendingTo('approximate-count')[0], ok({ count: 5 }));
  answer(g.pendingTo('search/jql')[0], { ok: false, status: 403, json: async () => ({}) });
  await flush();
  assert.deepEqual(g.liveTexts(), [text, '']);
  mock.timers.tick(99); await flush();
  assert.equal(g.live().textContent, '');
  mock.timers.tick(1); await flush();
  assert.deepEqual(g.liveTexts(), [text, '', text]);
}));

test('QA KDG-13 e2e: a batch failure in phase 2 replaces the counts, no "Burndown loaded."', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = D' });
  await flush();
  mock.timers.tick(1000); await flush();
  answer(g.pendingTo('approximate-count')[0], ok({ count: 2000 }));
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 2000), isLast: true }));
  await flush();
  const [b0, b1] = g.pendingTo('bulkfetch');
  answer(b0, ok(changelogs(b0.body.issueIdsOrKeys)));
  await flush();
  assert.equal(g.status().textContent, 'Loading status history… 1,000 of 2,000 issues');
  answer(b1, { ok: false, status: 500, json: async () => ({}) });
  await flush();
  assert.equal(g.status().textContent, 'Jira request failed (500).');
  mock.timers.tick(60000); await flush();
  assert.deepEqual(g.liveTexts(), ['Loading the burndown.', 'Jira request failed (500).']);
}));

test('QA KDG-13 e2e: a late approximate count is ignored after the search finishes', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = E' });
  await flush();
  mock.timers.tick(400); await flush();
  answer(g.pendingTo('search/jql')[0], ok({ issues: issues(1, 800), isLast: true }));
  await flush();
  answer(g.pendingTo('approximate-count')[0], ok({ count: 50000 }));
  await flush();
  assert.equal(g.status().textContent, 'Loading status history for 800 issues…');
  assert.ok(!g.statusTexts().some(t => t.includes(HINT)));
}));

test('QA KDG-13 e2e: guard messages are shown and announced and start no request', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: '' });
  await flush();
  assert.equal(g.status().textContent, 'Choose a filter in the Controller.');
  g.select({ jql: 'project = F', startDate: '' });
  await flush();
  assert.equal(g.status().textContent, 'Set Start Date and End Date in the Controller.');
  g.select({ jql: 'project = F', startDate: '2026-09-01', endDate: '2026-12-31' });
  await flush();
  const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date('2026-09-01T00:00:00Z'));
  assert.equal(g.status().textContent, `The period starts on ${when}.`);
  assert.equal(g.requests.length, 0, 'no approximate-count or search request for guard states');
  assert.deepEqual(g.liveTexts(), ['Choose a filter in the Controller.',
    'Set Start Date and End Date in the Controller.', g.status().textContent]);
}));

test('QA KDG-13 e2e: "Add a Kinetic Dashboard Controller" after 4 s with no filter', withTimers(async () => {
  const g = await startGadget();
  mock.timers.tick(4000); await flush();
  assert.equal(g.status().textContent, 'Add a Kinetic Dashboard Controller to this dashboard.');
  assert.equal(g.live().textContent, 'Add a Kinetic Dashboard Controller to this dashboard.');
}));

test('QA KDG-13: "of about" never shows a total below the loaded count (sweep)', () => {
  for (const approx of [0, 1, 999, 1000, 1001, 5400, 9999, 10000, 123456]) {
    for (const loaded of [0, 1, 999, 1000, 1001, 5400, 6000, 10000, 200000]) {
      const { text } = loadingView(withPage(withApproximate(initialLoading(), approx), loaded));
      const m = text.match(/([\d,]+) of about ([\d,]+)/);
      if (m) assert.ok(Number(m[1].replaceAll(',', '')) < Number(m[2].replaceAll(',', '')), text);
      else assert.match(text, / found/);
    }
  }
});

test('QA KDG-13: announcements never contain a trailing ellipsis; history done at total', () => {
  const s = withHistory(withHistory(initialLoading(), { done: 0, total: 2 }), { done: 2, total: 2 });
  assert.equal(loadingView(s).text, 'Loading status history… 2 of 2 issues');
  for (const st of [initialLoading(), withHistory(initialLoading(), { done: 0, total: 5 }),
    withApproximate(initialLoading(), 10000)]) {
    assert.ok(!loadingView(st).announcement.endsWith('…'));
  }
});

test('QA KDG-13: Counter createAnnouncer without options behaves exactly as before', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const out = [];
    const a = createAnnouncer(t => out.push(t));
    a.announce('approx', 1000);
    mock.timers.tick(500);
    a.announce('exact');
    mock.timers.tick(5000);
    assert.deepEqual(out, ['exact'], 'a later announce replaces the delayed one');
    a.announce('x', 1000);
    a.cancel();
    mock.timers.tick(5000);
    a.announce('y'); a.announce('z');
    assert.deepEqual(out, ['exact', 'y', 'z'], 'no rate limit by default');
  } finally { mock.timers.reset(); }
});

test('QA KDG-13: a message() during a load cancels a pending trailing progress announcement', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const spoken = [];
    const loader = createBurndownLoader({ setText: () => {}, announce: t => spoken.push(t) });
    const run = loader.start();
    mock.timers.tick(1000);
    run.page(10);
    loader.message('Choose a filter in the Controller.');
    run.page(20);
    mock.timers.tick(60000);
    assert.deepEqual(spoken, ['Loading the burndown.', 'Choose a filter in the Controller.']);
  } finally { mock.timers.reset(); }
});

// D1 (fixed): writeLive's 100 ms identical-text rewrite timer in static/burndown/src.mjs is
// cancelled when a new refresh starts, so the previous run's final message is not spoken
// ~100 ms into the new load.
test('QA KDG-13 e2e: a new refresh cancels a pending identical-text live rewrite',
  withTimers(async () => {
    const g = await startGadget();
    const fail = () => ({ ok: false, status: 403, json: async () => ({}) });
    for (let i = 0; i < 2; i += 1) {
      if (i) g.refreshEvent(); else g.select({ jql: 'project = G' });
      await flush();
      answer(g.pendingTo('approximate-count')[0], ok({ count: 5 }));
      answer(g.pendingTo('search/jql')[0], fail());
      await flush();
    }
    assert.equal(g.live().textContent, '', 'identical error: cleared, rewrite pending');
    g.refreshEvent(); // new load starts before the 100 ms rewrite
    await flush();
    mock.timers.tick(100); await flush();
    assert.equal(g.live().textContent, '', 'stale error must not be announced during the new load');
  }));

test('QA KDG-13 e2e: an ORDER BY-only JQL makes no approximate-count request', withTimers(async ({ warn }) => {
  const g = await startGadget();
  g.select({ jql: 'ORDER BY rank' });
  await flush();
  assert.equal(g.pendingTo('approximate-count').length, 0);
  assert.equal(g.pendingTo('search/jql').length, 1, 'the search still runs');
  assert.equal(warn.mock.callCount(), 0);
}));

test('QA KDG-13 recheck e2e: guard dedupe only suppresses an unchanged guard with no load since', withTimers(async () => {
  const g = await startGadget();
  const choose = 'Choose a filter in the Controller.';
  const dates = 'Set Start Date and End Date in the Controller.';
  g.select({ jql: '' }); await flush();
  g.select({ jql: '' }); await flush(); // Controller re-broadcast
  mock.timers.tick(1000); await flush();
  assert.deepEqual(g.liveTexts(), [choose], 'identical guard not re-announced');
  assert.equal(g.status().textContent, choose, 'still shown');
  g.select({ jql: 'project = H', startDate: '' }); await flush();
  assert.deepEqual(g.liveTexts(), [choose, dates], 'changed guard announced');
  g.select({ jql: '' }); await flush();
  assert.deepEqual(g.liveTexts(), [choose, dates, choose], 'A -> B -> A announces A again');
  // A load in between resets the dedupe.
  g.select({ jql: 'project = H' }); await flush();
  g.select({ jql: '' }); await flush();
  mock.timers.tick(200); await flush();
  assert.deepEqual(g.liveTexts().filter(Boolean), [choose, dates, choose, choose]);
  assert.equal(g.live().textContent, choose);
  assert.equal(g.requests.filter(r => r.path.includes('approximate')).length, 1, 'guards start no request');
}));

test('QA KDG-13 recheck e2e: final load messages still re-announce after each refresh', withTimers(async () => {
  const g = await startGadget();
  g.select({ jql: 'project = I' }); await flush();
  for (let i = 0; i < 3; i += 1) {
    if (i) { g.refreshEvent(); await flush(); }
    answer(g.pendingTo('approximate-count')[0], ok({ count: 0 }));
    answer(g.pendingTo('search/jql')[0], ok({ issues: [], isLast: true }));
    await flush();
    mock.timers.tick(100); await flush();
    assert.equal(g.live().textContent, 'No matching issues.');
  }
  assert.deepEqual(g.liveTexts(), ['No matching issues.', '', 'No matching issues.', '', 'No matching issues.']);
  // Errors too, including after a different message.
  g.refreshEvent(); await flush();
  answer(g.pendingTo('search/jql')[0], { ok: false, status: 500, json: async () => ({}) });
  await flush();
  assert.equal(g.live().textContent, 'Jira request failed (500).');
  g.refreshEvent(); await flush();
  answer(g.pendingTo('search/jql')[0], { ok: false, status: 500, json: async () => ({}) });
  await flush();
  mock.timers.tick(100); await flush();
  assert.deepEqual(g.liveTexts().slice(-3), ['Jira request failed (500).', '', 'Jira request failed (500).']);
}));

test('QA KDG-13 recheck: spoken progress lines end in a full stop; visible text unchanged', () => {
  const v = loadingView(withPage(initialLoading(), 3000));
  assert.deepEqual(v, { text: 'Loading issues… 3,000 found', announcement: 'Loading issues… 3,000 found.' });
  const h = loadingView(withHistory(withHistory(initialLoading(), { done: 0, total: 1 }), { done: 1, total: 1 }));
  assert.deepEqual(h, { text: 'Loading status history… 1 of 1 issue', announcement: 'Loading status history… 1 of 1 issue.' });
  const hint = loadingView(withPage(withApproximate(initialLoading(), 14200), 3000));
  assert.equal(hint.announcement, `Loading issues… 3,000 of about 14,200. ${HINT}`, 'no double full stop');
  assert.equal(loadingView(initialLoading()).announcement, 'Loading issues.');
});
