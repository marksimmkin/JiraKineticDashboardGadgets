// Pure loading state for the Weighted Burndown: the progress copy and the timing rules for the
// visible message and the screen-reader live region. The gadget entry point only wires the DOM.
import { createAnnouncer } from './counter-state.mjs';

export const LOADING_TEXT_DELAY = 400;
export const LOADING_ANNOUNCE_DELAY = 1000;
export const PROGRESS_ANNOUNCE_INTERVAL = 15000;
export const LARGE_FILTER_THRESHOLD = 10000;
export const LARGE_FILTER_HINT = 'Large filters can take a minute or more.';
export const LOADING_ANNOUNCEMENT = 'Loading the burndown.';
export const LOADED_ANNOUNCEMENT = 'Burndown loaded.';
export const LOAD_ERROR_TEXT = 'Could not load the burndown.';

// The gadget-specific words. `history` names what phase 2 loads per issue. The Burndown uses
// these defaults; the Time Logging gadget passes its own (KDG-23).
export const BURNDOWN_COPY = Object.freeze({
  history: 'status history', loading: LOADING_ANNOUNCEMENT, loaded: LOADED_ANNOUNCEMENT,
  error: LOAD_ERROR_TEXT,
});

const defaultFormat = new Intl.NumberFormat('en-GB');

// phase: 'issues' (search) or 'history' (status changes). loaded: issues found so far, or null
// before the first page. approximate: Jira's estimate, or null. searchDone: the search has
// finished, so a late approximate count is ignored. total/done: phase 2 counts; done is null
// until the first batch finishes.
export function initialLoading() {
  return { phase: 'issues', loaded: null, approximate: null, searchDone: false, total: null, done: null };
}

export function withPage(state, loaded) {
  return state.phase === 'issues' && !state.searchDone ? { ...state, loaded } : state;
}

export function withApproximate(state, approximate) {
  return state.searchDone ? state : { ...state, approximate };
}

export function withSearchDone(state) {
  return state.searchDone ? state : { ...state, searchDone: true };
}

// The first call starts phase 2; later calls report finished batches.
export function withHistory(state, { done, total }) {
  if (state.phase !== 'history') {
    return { ...state, phase: 'history', searchDone: true, total, done: null };
  }
  return { ...state, total, done };
}

function progressText(state, format, copy) {
  const { phase, loaded, approximate, total, done } = state;
  if (phase === 'history') {
    const noun = total === 1 ? 'issue' : 'issues';
    return done === null
      ? `Loading ${copy.history} for ${format.format(total)} ${noun}…`
      : `Loading ${copy.history}… ${format.format(done)} of ${format.format(total)} ${noun}`;
  }
  if (loaded === null) return 'Loading issues…';
  return approximate !== null && loaded < approximate
    ? `Loading issues… ${format.format(loaded)} of about ${format.format(approximate)}`
    : `Loading issues… ${format.format(loaded)} found`;
}

// Returns the visible text and its screen-reader sentence (a trailing "…" becomes ".", and a
// full stop is added when the line has none).
export function loadingView(state, format = defaultFormat, copy = BURNDOWN_COPY) {
  let text = progressText(state, format, copy);
  if (state.approximate !== null && state.approximate >= LARGE_FILTER_THRESHOLD) {
    text = `${text}${text.endsWith('…') ? '' : '.'} ${LARGE_FILTER_HINT}`;
  }
  let announcement = text.endsWith('…') ? `${text.slice(0, -1)}.` : text;
  if (!announcement.endsWith('.')) announcement = `${announcement}.`;
  return { text, announcement };
}

// Drives the visible status text (`setText`) and the live region (`announce`, a raw write).
// `start()` begins a load and returns a run; starting another run, `message()` or `cancel()`
// supersedes it, after which every method of the old run does nothing.
// `cancelAnnounce`, if given, is called whenever pending live-region writes must be dropped
// (start, cancel, and a new guard message), so the sink can cancel its own delayed writes.
// `copy` (see BURNDOWN_COPY) sets the phase 2 noun, the announcements and the fallback error.
export function createBurndownLoader({ setText, announce, cancelAnnounce,
  format = defaultFormat, timers = globalThis, copy: copyOverrides }) {
  const copy = { ...BURNDOWN_COPY, ...copyOverrides };
  const announcer = createAnnouncer(announce, timers, { minInterval: PROGRESS_ANNOUNCE_INTERVAL });
  let current = null;
  // The last guard message announced since the last start(). The Controller re-broadcasts
  // its selection for each gadget, so the same guard message would otherwise repeat.
  let lastGuard = null;

  function stopCurrent() {
    if (current) current.cancel();
    current = null;
    announcer.cancel();
    cancelAnnounce?.();
  }

  function start() {
    stopCurrent();
    lastGuard = null;
    let state = initialLoading();
    let active = true;
    let visible = false;
    let spoken = false;
    let showTimer = null;
    let speakTimer = null;

    function stop() {
      active = false;
      if (showTimer !== null) timers.clearTimeout(showTimer);
      if (speakTimer !== null) timers.clearTimeout(speakTimer);
      showTimer = null;
      speakTimer = null;
    }

    function update(next) {
      if (!active || next === state) return;
      const before = loadingView(state, format, copy);
      state = next;
      const after = loadingView(state, format, copy);
      if (visible && after.text !== before.text) setText(after.text);
      if (spoken && after.announcement !== before.announcement) announcer.announceLatest(after.announcement);
    }

    function cancel() {
      if (!active) return;
      stop();
      if (current === run) current = null;
      announcer.cancel();
    }

    function end(text, announcement) {
      if (!active) return;
      cancel();
      setText(text);
      if (announcement) announcer.announce(announcement);
    }

    const run = {
      cancel,
      get active() { return active; },
      page: loaded => update(withPage(state, loaded)),
      approximate: count => update(withApproximate(state, count)),
      searchDone: () => update(withSearchDone(state)),
      history: progress => update(withHistory(state, progress)),
      ready: () => end('', spoken ? copy.loaded : null),
      message: text => end(text, text),
      fail: error => {
        const text = error?.message || copy.error;
        end(text, text);
      },
    };

    setText('');
    showTimer = timers.setTimeout(() => {
      showTimer = null;
      visible = true;
      setText(loadingView(state, format, copy).text);
    }, LOADING_TEXT_DELAY);
    speakTimer = timers.setTimeout(() => {
      speakTimer = null;
      spoken = true;
      announcer.announce(copy.loading);
    }, LOADING_ANNOUNCE_DELAY);
    current = run;
    return run;
  }

  // A final message outside a load (the Controller guard messages): shown and announced at once.
  // A repeat of the last guard message with no load since is shown but not announced again; it
  // also leaves the sink alone, so the first announcement is not cancelled.
  function message(text) {
    if (text === lastGuard) {
      setText(text);
      return;
    }
    stopCurrent();
    setText(text);
    lastGuard = text;
    announcer.announce(text);
  }

  function cancel() {
    stopCurrent();
    lastGuard = null;
  }

  return { start, message, cancel };
}
