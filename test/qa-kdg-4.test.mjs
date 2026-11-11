// QA regression tests for KDG-4 (Simple Counter: approximate count first, then exact).
// They bundle static/counter/src.mjs with a mocked @forge/bridge and run main() against a tiny
// fake DOM, so the races between the two requests and the live-region debounce are covered.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// --- minimal DOM --------------------------------------------------------------------------
class FakeNode {
  constructor() { this.parent = null; }
  get nextSibling() {
    if (!this.parent) return null;
    const kids = this.parent.childNodes;
    return kids[kids.indexOf(this) + 1] ?? null;
  }
  remove() {
    if (!this.parent) return;
    const kids = this.parent.childNodes;
    kids.splice(kids.indexOf(this), 1);
    this.parent = null;
  }
  before(...nodes) {
    const parent = this.parent;
    for (const item of nodes) {
      const node = typeof item === 'string' ? new FakeText(item) : item;
      node.remove();
      node.parent = parent;
      parent.childNodes.splice(parent.childNodes.indexOf(this), 0, node);
    }
  }
}
class FakeText extends FakeNode {
  constructor(text) { super(); this.data = text; }
  get textContent() { return this.data; }
  get outerHTML() { return this.data; }
}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.childNodes = []; this.attrs = {}; this.listeners = []; }
  get className() { return this.attrs.class ?? ''; }
  set className(value) { this.attrs.class = value; }
  set title(value) { this.attrs.title = value; }
  set type(value) { this.attrs.type = value; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, listener) { if (type === 'click') this.listeners.push(listener); }
  click() { this.listeners.forEach(listener => listener()); }
  appendChild(node) { node.remove(); node.parent = this; this.childNodes.push(node); return node; }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.remove();
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(...(String(value) ? [String(value)] : [])); }
  get outerHTML() {
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tag}${attrs}>${this.childNodes.map(child => child.outerHTML).join('')}</${this.tag}>`;
  }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
      if (m[4] !== undefined) stack.at(-1).appendChild(new FakeText(m[4]));
      else if (m[1]) stack.pop();
      else {
        const element = new FakeElement(m[2]);
        for (const a of m[3].matchAll(/([a-z-]+)="([^"]*)"/g)) element.attrs[a[1]] = a[2];
        stack.at(-1).appendChild(element);
        stack.push(element);
      }
    }
  }
  *all() { for (const c of this.childNodes) if (c instanceof FakeElement) { yield c; yield* c.all(); } }
  querySelector(selector) {
    return [...this.all()].find(e => e.className.split(' ').includes(selector.slice(1))) ?? null;
  }
}

// --- bundle the gadget with a mocked bridge ------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'qa-kdg-4-'));
after(() => rm(dir, { recursive: true, force: true }));
const bundle = join(dir, 'counter.mjs');
await build({
  entryPoints: ['static/counter/src.mjs'], bundle: true, format: 'esm', platform: 'neutral',
  outfile: bundle, logLevel: 'silent',
  plugins: [{ name: 'bridge', setup(b) {
    b.onResolve({ filter: /^@forge\/bridge$/ }, () => ({ path: 'bridge', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      const b = () => globalThis.__kdg4Bridge;
      export const events = { on: (...a) => b().events.on(...a), emit: (...a) => b().events.emit(...a) };
      export const requestJira = (...a) => b().requestJira(...a);
      export const router = { open: (...a) => b().router.open(...a) };
      export const view = { theme: { enable: async () => {} }, getContext: () => b().getContext() };` }));
  } }],
});

const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise(r => setImmediate(r)); };
let instance = 0;

async function boot() {
  const app = new FakeElement('main');
  let clock = 0;
  let timers = [];
  let nextId = 0;
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    warn: console.warn, document: globalThis.document };
  globalThis.setTimeout = (fn, ms) => { timers.push({ id: ++nextId, at: clock + ms, fn }); return nextId; };
  globalThis.clearTimeout = id => { timers = timers.filter(t => t.id !== id); };
  globalThis.document = { getElementById: () => app, createElement: tag => new FakeElement(tag) };
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const handlers = {};
  const pending = [];
  const opened = [];
  globalThis.__kdg4Bridge = {
    events: { on: async (name, fn) => { handlers[name] = fn; }, emit: async () => {} },
    requestJira: (path, options) => new Promise((resolve, reject) => {
      pending.push({ path, body: JSON.parse(options.body), resolve, reject });
    }),
    router: { open: async url => { opened.push(url); } },
    getContext: async () => ({ extension: { dashboard: { id: 'D1' }, gadget: { id: 'G1' } } }),
  };
  await import(`${pathToFileURL(bundle).href}?${++instance}`);
  await flush();
  const q = selector => app.querySelector(selector);
  const respond = async (request, json, status = 200) => {
    pending.splice(pending.indexOf(request), 1);
    request.resolve({ ok: status < 300, status, json: async () => json });
    await flush();
  };
  const find = kind => pending.findLast(p => p.path.endsWith(kind === 'approx' ? '/approximate-count' : '/search/jql'));
  return {
    app, pending, opened, warnings, flush,
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      console.warn = real.warn;
      globalThis.document = real.document;
    },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers[0] || timers[0].at > end) break;
        const timer = timers.shift();
        clock = timer.at;
        timer.fn();
        await flush();
      }
      clock = end;
      await flush();
    },
    async select(name, jql) {
      handlers['kinetic.dashboard.filter.selected']({ dashboardId: 'D1', name, jql });
      await flush();
      return { approx: find('approx'), exact: find('exact') };
    },
    async refresh() {
      handlers.JIRA_DASHBOARD_GADGET_REFRESH({ origin: 'dashboard' });
      await flush();
      return { approx: find('approx'), exact: find('exact') };
    },
    respond,
    count: () => q('.count').outerHTML,
    status: () => q('.status').textContent,
    live: () => q('.visually-hidden').textContent,
    button: () => q('.issue-count-link'),
    filterName: () => q('.filter-name').textContent,
  };
}

const page = n => ({ issues: Array.from({ length: n }, () => ({})), isLast: true });

async function withGadget(fn) {
  const gadget = await boot();
  try { await fn(gadget); } finally { gadget.restore(); }
}

test('KDG-4: only one live region; .count and .status are no longer live', () => withGadget(async g => {
  const html = g.app.outerHTML;
  assert.equal(html.match(/role="status"/g).length, 1);
  assert.ok(!html.includes('aria-live'));
  assert.match(html, /<p class="status">Waiting for the controller…<\/p><p class="visually-hidden" role="status">/);
  await g.advance(4000);
  assert.equal(g.status(), 'Add a Kinetic Dashboard Controller to this dashboard.');
  assert.equal(g.live(), 'Add a Kinetic Dashboard Controller to this dashboard.');
}));

test('KDG-4: approximate then exact updates the same button in place and debounces', () => withGadget(async g => {
  const { approx, exact } = await g.select('Big', 'project = GAME ORDER BY rank');
  assert.equal(g.count(), '<div class="count">…</div>');
  assert.equal(g.live(), 'Counting visible issues…');
  // KDG-24: both counts use the JQL narrowed to shown statuses (Done hidden by default).
  assert.deepEqual(approx.body, { jql: '(project = GAME) AND (statusCategory != Done)' });
  assert.equal(exact.body.jql, '(project = GAME) AND (statusCategory != Done) ORDER BY rank');
  await g.respond(approx, { count: 1240 });
  const button = g.button();
  assert.equal(g.count(), '<div class="count"><span class="count-qualifier">about</span> <button type="button" class="issue-count-link" aria-label="Open about 1,240 matching issues in shown statuses in Jira" title="Open matching issues in Jira">1,240</button></div>');
  assert.equal(g.status(), 'issues · counting exactly…');
  await g.advance(999);
  assert.equal(g.live(), 'Counting visible issues…');
  await g.respond(exact, page(1241));
  assert.equal(g.button(), button, 'button node is kept so focus survives');
  assert.equal(g.count(), '<div class="count"><button type="button" class="issue-count-link" aria-label="Open 1,241 matching issues in shown statuses in Jira" title="Open matching issues in Jira">1,241</button></div>');
  assert.equal(g.status(), 'issues');
  assert.equal(g.live(), 'Exactly 1,241 issues.');
  await g.advance(5000);
  assert.equal(g.live(), 'Exactly 1,241 issues.', 'cancelled approximate announcement never fires');
  button.click();
  await g.flush();
  assert.deepEqual(g.opened, [`/issues/?jql=${encodeURIComponent('(project = GAME) AND (statusCategory != Done) ORDER BY rank')}`]);
}));

test('KDG-4: the approximate announcement fires after 1000 ms (singular wording)', () => withGadget(async g => {
  const { approx, exact } = await g.select('One', 'key = GAME-1');
  await g.respond(approx, { count: 1 });
  await g.advance(1000);
  assert.equal(g.live(), 'About 1 issue. Counting exactly.');
  assert.equal(g.status(), 'issue · counting exactly…');
  await g.respond(exact, page(1));
  assert.equal(g.live(), 'Exactly 1 issue.');
  assert.equal(g.status(), 'issue');
}));

test('KDG-4: a late approximate count never replaces the exact count', () => withGadget(async g => {
  const { approx, exact } = await g.select('S', 'project = GAME');
  await g.respond(exact, page(3));
  await g.respond(approx, { count: 900 });
  await g.advance(2000);
  assert.match(g.count(), />3<\/button><\/div>$/);
  assert.ok(!g.count().includes('about'));
  assert.equal(g.live(), 'Exactly 3 issues.');
}));

test('KDG-4: approximate failure is silent; exact failure keeps the approximate count', () => withGadget(async g => {
  let r = await g.select('S', 'project = GAME');
  await g.respond(r.approx, {}, 400);
  assert.equal(g.status(), 'Counting visible issues…');
  assert.equal(g.warnings.length, 1);
  await g.respond(r.exact, page(0));
  assert.equal(g.live(), 'No issues in shown statuses.'); // KDG-24

  r = await g.refresh();
  await g.respond(r.approx, { count: 0 });
  await g.respond(r.exact, {}, 403);
  assert.match(g.count(), /<span class="count-qualifier">about<\/span> <button[^>]*aria-label="Open about 0 matching issues in shown statuses in Jira"[^>]*>0<\/button>/);
  assert.equal(g.status(), 'Exact count unavailable. You cannot view issues for this filter.');
  assert.equal(g.live(), 'Exact count unavailable. You cannot view issues for this filter.');
  await g.advance(2000);
  assert.equal(g.live(), 'Exact count unavailable. You cannot view issues for this filter.');

  r = await g.refresh();
  await g.respond(r.exact, {}, 500);
  await g.respond(r.approx, { count: 4 });
  assert.equal(g.count(), '<div class="count">—</div>');
  assert.equal(g.status(), 'Jira search failed (500).');
}));

test('KDG-4: results for an older filter never overwrite a newer one', () => withGadget(async g => {
  const a = await g.select('A', 'project = A');
  await g.respond(a.approx, { count: 50 });
  await g.advance(500);
  const b = await g.select('B', 'project = B');
  await g.advance(2000);
  assert.equal(g.live(), 'Counting visible issues…', 'debounced About 50 was cancelled');
  await g.respond(a.exact, page(50));
  assert.equal(g.count(), '<div class="count">…</div>');
  assert.equal(g.filterName(), 'B');
  await g.respond(b.approx, { count: 22 });
  await g.respond(b.exact, page(20));
  assert.match(g.count(), /aria-label="Open 20 matching issues in shown statuses in Jira"[^>]*>20</);
  assert.equal(g.live(), 'Exactly 20 issues.');
}));

// KDG-24: the shown-status clause gives an order-only filter a JQL filter, so the approximate
// count is now requested for it (before KDG-24 it was skipped).
test('KDG-4: an order-only filter gets an approximate count of shown statuses', () => withGadget(async g => {
  const { approx, exact } = await g.select('Order', 'ORDER BY rank');
  assert.deepEqual(approx.body, { jql: '(statusCategory != Done)' });
  assert.equal(exact.body.jql, '(statusCategory != Done) ORDER BY rank');
  await g.respond(exact, page(7));
  assert.equal(g.live(), 'Exactly 7 issues.');
}));

test('KDG-4: clearing the filter after a refresh cancels the pending announcement', () => withGadget(async g => {
  const r = await g.select('A', 'project = A');
  await g.respond(r.approx, { count: 50 });
  await g.select('Empty', '');
  await g.advance(5000);
  assert.equal(g.count(), '<div class="count">—</div>');
  assert.equal(g.status(), 'Configure a filter in the controller.');
  assert.equal(g.live(), 'Configure a filter in the controller.');
}));
