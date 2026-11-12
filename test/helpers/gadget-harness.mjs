// Test harness for gadget entry points (static/<gadget>/src.mjs).
//
// Each gadget is bundled with esbuild (a devDependency) with @forge/bridge swapped for a fake,
// then evaluated as a fresh module instance against a minimal fake DOM. Several gadgets can
// share one fake event bus, so the Controller and a gadget can talk to each other as they do
// on a real dashboard. Use node:test mock timers for setTimeout/setInterval/Date; the harness
// itself only uses microtasks and setImmediate, which are not mocked.
//
// The fake DOM implements only what the gadgets use. If a gadget starts using a new DOM API,
// add it here (or switch to jsdom if this grows unreasonably).
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Lets every pending promise chain and fake event delivery settle. Uses setImmediate, which
// mock.timers leaves real unless a test enables it explicitly.
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

export const ok = body => ({ ok: true, status: 200, json: async () => body });
export const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });

// ---------------------------------------------------------------------------------------------
// Bundling

const bundles = new Map();

export async function bundleGadget(name) {
  if (bundles.has(name)) return bundles.get(name);
  const entry = fileURLToPath(new URL(`../../static/${name}/src.mjs`, import.meta.url));
  const pending = build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    logLevel: 'silent',
    plugins: [{
      name: 'fake-bridge',
      setup(b) {
        b.onResolve({ filter: /^@forge\/bridge$/ }, () => ({ path: 'bridge', namespace: 'qa' }));
        b.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({
          loader: 'js',
          contents: 'const b = globalThis.__qaEnv.bridge; export const events = b.events, ' +
            'requestJira = (...a) => b.requestJira(...a), router = b.router, view = b.view;',
        }));
      },
    }],
  }).then(result => result.outputFiles[0].text);
  bundles.set(name, pending);
  return pending;
}

// ---------------------------------------------------------------------------------------------
// Fake DOM

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
}

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; }
  get siblings() { return this.parentNode ? this.parentNode.childNodes : [this]; }
  get nextSibling() { const s = this.siblings; return s[s.indexOf(this) + 1] ?? null; }
  get previousSibling() { const s = this.siblings; return s[s.indexOf(this) - 1] ?? null; }
  get nextElementSibling() {
    const s = this.siblings;
    return s.slice(s.indexOf(this) + 1).find(n => n instanceof FakeElement) ?? null;
  }
  get previousElementSibling() {
    const s = this.siblings;
    return s.slice(0, s.indexOf(this)).reverse().find(n => n instanceof FakeElement) ?? null;
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
  before(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(parent.toNode(n), this);
  }
  after(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this.nextSibling;
    for (const n of nodes) parent.insertBefore(parent.toNode(n), next);
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.value = '';
  }

  // Elements only, as in the real DOM.
  get children() { return this.childNodes.filter(n => n instanceof FakeElement); }

  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: c => list().includes(c),
      add: (...cs) => { el.className = [...new Set([...list(), ...cs])].join(' '); },
      remove: (...cs) => { el.className = list().filter(c => !cs.includes(c)).join(' '); },
      toggle: (c, force) => {
        const on = force ?? !list().includes(c);
        if (on) el.classList.add(c); else el.classList.remove(c);
        return on;
      },
    };
  }

  toNode(n) {
    if (n instanceof FakeNode) { n.remove(); return n; }
    return new FakeText(this.ownerDocument, n);
  }

  adopt(n) { const node = this.toNode(n); node.parentNode = this; return node; }

  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) {
    this.clear();
    const text = String(value);
    if (text) this.append(text);
    this.ownerDocument.recordText(this, text);
  }

  clear() { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; }
  append(...nodes) { for (const n of nodes) this.childNodes.push(this.adopt(n)); }
  prepend(...nodes) { this.childNodes.unshift(...nodes.map(n => this.adopt(n))); }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.clear(); this.append(...nodes); }
  insertBefore(n, ref) {
    const node = this.adopt(n);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    return node;
  }

  setAttribute(k, v) { if (k === 'class') this.className = String(v); else this.attributes[k] = String(v); }
  getAttribute(k) { return k === 'class' ? this.className || null : this.attributes[k] ?? null; }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { if (k === 'class') this.className = ''; else delete this.attributes[k]; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const fn of this.listeners[event.type] ?? []) fn.call(this, event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(new FakeEvent('click')); }
  focus() { this.ownerDocument.activeElement = this; }

  set innerHTML(html) {
    this.clear();
    parseHtml(this.ownerDocument, String(html), this);
  }

  // Selectors: `tag`, `.class`, `#id`, `[attr="v"]` and simple compounds such as
  // `input[type="checkbox"]` or `button.is-active`. Descendant combinators are not supported.
  matches(selector) {
    const parts = selector.match(/^([a-z0-9-]*)((?:[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
    if (!parts) throw new Error(`Fake DOM does not support the selector "${selector}"`);
    if (parts[1] && parts[1].toUpperCase() !== this.tagName) return false;
    for (const [, kind, name, , value] of parts[2].matchAll(/([.#]|\[)([\w-]+)(="([^"]*)")?\]?/g)) {
      if (kind === '.' && !this.classList.contains(name)) return false;
      if (kind === '#' && this.attributes.id !== name && this.id !== name) return false;
      if (kind === '[') {
        const actual = name in this.attributes ? this.attributes[name] : this[name];
        if (value === undefined ? actual === undefined || actual === null : String(actual) !== value) return false;
      }
    }
    return true;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = el => {
      for (const c of el.children) { if (c.matches(selector)) found.push(c); walk(c); }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  // Test helpers (not DOM APIs).
  find(className) { return this.classList.contains(className) ? this : this.querySelector(`.${className}`); }
  findAll(className) { return this.querySelectorAll(`.${className}`); }
}

function decode(text) {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

// Parses the fixed templates gadgets assign to innerHTML (no Jira data goes through it).
function parseHtml(doc, html, parent) {
  const stack = [parent];
  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    const top = stack.at(-1);
    if (text !== undefined) { top.append(decode(text)); continue; }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const el = doc.createElement(tag);
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(k, decode(v));
    top.append(el);
    if (!VOID_TAGS.has(tag.toLowerCase()) && !attrs.trim().endsWith('/')) stack.push(el);
  }
}

// `logClasses`: textContent writes to elements with one of these classes are recorded in
// `doc.log` as { el: className, text, at: Date.now() }, so tests can check the sequence of
// messages shown or announced, not just the final one.
export function createDocument({ logClasses = ['status', 'visually-hidden'] } = {}) {
  const log = [];
  const doc = {
    log,
    recordText(el, text) {
      const match = logClasses.find(c => el.classList.contains(c));
      if (match) log.push({ el: match, text, at: Date.now() });
    },
    createElement: tag => new FakeElement(doc, tag),
    createElementNS: (ns, tag) => new FakeElement(doc, tag),
    createTextNode: text => new FakeText(doc, text),
    getElementById: id => (id === 'app' ? doc.root : null),
  };
  doc.root = new FakeElement(doc, 'main');
  doc.root.setAttribute('id', 'app');
  return doc;
}

export function createStorage({ blocked = false } = {}) {
  const data = new Map();
  const guard = () => { if (blocked) throw new Error('SecurityError: storage is blocked'); };
  return {
    data,
    getItem: k => { guard(); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { guard(); data.set(k, String(v)); },
    removeItem: k => { guard(); data.delete(k); },
    clear: () => { guard(); data.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------
// Fake @forge/bridge event bus, shared by every gadget on one fake dashboard.
//
// Delivery is asynchronous (a microtask after emit), like the real bridge. An emitted event
// reaches every subscriber except the gadget that emitted it. `bus.log` records every emit as
// { from, name, payload }. `bus.send` delivers an event from Jira itself (for example
// JIRA_DASHBOARD_GADGET_REFRESH) to every subscriber. emit/send resolve once the event is
// handed to the subscribers, without waiting for their handlers (which may await a pending
// Jira request); call flush() to let handlers run. Handler errors are collected in
// `bus.errors`.
export function createBus() {
  const subscribers = [];
  const log = [];
  const errors = [];
  async function deliver(name, payload, from) {
    await Promise.resolve();
    const targets = subscribers.filter(s => s.name === name && s.owner !== from);
    for (const s of targets) {
      Promise.resolve().then(() => s.fn(structuredClone(payload))).catch(error => errors.push(error));
    }
  }
  return {
    log,
    errors,
    subscribers,
    on(owner, name, fn) {
      const entry = { owner, name, fn };
      subscribers.push(entry);
      return { unsubscribe: () => subscribers.splice(subscribers.indexOf(entry), 1) };
    },
    emit(owner, name, payload) {
      log.push({ from: owner, name, payload: structuredClone(payload) });
      return deliver(name, payload, owner);
    },
    send(name, payload) { return deliver(name, payload, null); },
    emitted(name, from) { return log.filter(e => e.name === name && (from === undefined || e.from === from)); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------------------------
// Starting a gadget

let instanceCount = 0;

// Starts a fresh instance of static/<name>/src.mjs and waits for it to finish loading.
//
// Options:
//   bus            shared event bus (default: a new one)
//   dashboardId    context dashboard ID (default 'd1'; '' for none)
//   gadgetId       context gadget ID (default: `<name>-<n>`)
//   entryPoint     context entry point, e.g. 'edit'
//   configuration  context gadgetConfiguration
//   timezone       context timezone (default 'UTC')
//   storage        fake localStorage (default: an empty working one)
//   jira           optional (path, body) => response; when it returns a value the request is
//                  answered at once, otherwise it stays pending until the test answers it
//
// Returns { name, gadgetId, bus, bridge, root, panel(), requests, pending(part), answer(req, res),
//   emitted(name), opened, submitted, log, texts(className), find(className) }.
export async function startGadget(name, options = {}) {
  instanceCount += 1;
  const {
    bus = createBus(), dashboardId = 'd1', gadgetId = `${name}-${instanceCount}`, entryPoint,
    configuration, timezone = 'UTC', storage = createStorage(), jira,
  } = options;
  const doc = createDocument();
  const requests = [];
  const opened = [];
  const submitted = [];
  const context = {
    timezone,
    siteUrl: 'https://example.atlassian.net',
    extension: {
      ...(entryPoint ? { entryPoint } : {}),
      ...(dashboardId ? { dashboard: { id: dashboardId } } : {}),
      gadget: { id: gadgetId },
      ...(configuration ? { gadgetConfiguration: structuredClone(configuration) } : {}),
    },
  };
  const bridge = {
    view: {
      theme: { enable: async () => {} },
      getContext: async () => structuredClone(context),
      submit: async payload => { submitted.push(payload); },
    },
    events: {
      on: async (event, fn) => bus.on(gadgetId, event, fn),
      emit: async (event, payload) => { await bus.emit(gadgetId, event, payload); },
    },
    router: { open: async url => { opened.push(url); } },
    requestJira: (path, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const gate = deferred();
      const request = { path, body, init, done: false, promise: gate.promise };
      request.resolve = response => { request.done = true; gate.resolve(response); };
      request.reject = error => { request.done = true; gate.reject(error); };
      requests.push(request);
      const auto = jira?.(path, body);
      if (auto !== undefined) request.resolve(auto);
      return gate.promise;
    },
  };
  const env = {
    bridge, document: doc, localStorage: storage,
    requestAnimationFrame: cb => { queueMicrotask(() => cb(0)); return 0; },
  };

  const code = await bundleGadget(name);
  // The bundle reads these identifiers as module-scoped constants, so several gadget instances
  // can run side by side without sharing a document.
  const source = 'const __env = globalThis.__qaEnv; const { document, localStorage, ' +
    `requestAnimationFrame } = __env;\n${code}\n// instance ${instanceCount}`;
  globalThis.__qaEnv = env;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  } finally {
    delete globalThis.__qaEnv;
  }
  await flush();

  return {
    name, gadgetId, bus, bridge, context, doc, root: doc.root, requests, opened, submitted,
    log: doc.log,
    panel: () => doc.root.children[0],
    find: className => doc.root.find(className),
    findAll: className => doc.root.findAll(className),
    pending: part => requests.filter(r => !r.done && r.path.includes(part)),
    answer: (request, response) => request.resolve(response),
    emitted: event => bus.emitted(event, gadgetId),
    texts: className => doc.log.filter(e => e.el === className).map(e => e.text),
  };
}

// KDG-24: the Counter and List send the Controller's JQL narrowed to shown statuses, as
// `(<filter>) AND (...) ORDER BY ...`. True when a request's JQL is `jql`'s filter, plain or
// narrowed that way (any ORDER BY on either side is ignored).
export function sameFilter(actual, jql) {
  if (typeof actual !== 'string') return false;
  const base = jql.replace(/ ORDER BY.*$/, '');
  return actual.replace(/ ORDER BY.*$/, '') === base || actual.startsWith(`(${base}) AND (`);
}

// A FILTER_SELECTED payload as the Controller sends it (see selectedFilterPayload).
export function selection(overrides = {}) {
  return {
    dashboardId: 'd1', controllerId: 'controller-x', name: 'Filter A', jql: 'project = A',
    startDate: '2026-01-01', endDate: '2026-12-31',
    statuses: [{ name: 'To Do', weight: 1, color: '#0c66e4' }, { name: 'Done', weight: 0, color: '#22a06b' }],
    ...overrides,
  };
}
