// Pure state for the Simple Counter: Jira's approximate count is shown first, marked
// "about", then replaced by the exact count. The gadget entry point only wires the DOM.

export const COUNTING_TEXT = 'Counting visible issues…';
export const ANNOUNCE_APPROXIMATE_DELAY = 1000;

// approximate: number | null; exact: number | null; exactError: Error | null.
export function initialCount() {
  return { approximate: null, exact: null, exactError: null };
}

function exactSettled(state) {
  return state.exact !== null || state.exactError !== null;
}

// An approximate count that arrives after the exact request settled is ignored.
export function withApproximate(state, approximate) {
  return exactSettled(state) ? state : { ...state, approximate };
}

export function withExact(state, exact) {
  return { ...state, exact, exactError: null };
}

export function withExactError(state, exactError) {
  return { ...state, exactError };
}

function errorText(error) {
  return error?.message || 'Could not count issues.';
}

// Returns what to render. `number` is null when a placeholder is shown instead of the button.
// `announceDelay` is how long to wait before announcing (the approximate count is debounced).
export function counterView(state, format = new Intl.NumberFormat()) {
  const { approximate, exact, exactError } = state;
  if (exact !== null) {
    const n = format.format(exact);
    const noun = exact === 1 ? 'issue' : 'issues';
    return {
      phase: 'exact', placeholder: null, number: n, qualifier: false,
      label: `Open ${n} matching ${noun} in Jira`,
      status: noun,
      announcement: `Exactly ${n} ${noun}.`, announceDelay: 0,
    };
  }
  if (approximate !== null) {
    const n = format.format(approximate);
    const noun = approximate === 1 ? 'issue' : 'issues';
    const base = { number: n, placeholder: null, qualifier: true,
      label: `Open about ${n} matching ${noun} in Jira` };
    if (exactError) {
      const message = `Exact count unavailable. ${errorText(exactError)}`;
      return { ...base, phase: 'approximate-only', status: message,
        announcement: message, announceDelay: 0 };
    }
    return { ...base, phase: 'approximate', status: `${noun} · counting exactly…`,
      announcement: `About ${n} ${noun}. Counting exactly.`,
      announceDelay: ANNOUNCE_APPROXIMATE_DELAY };
  }
  if (exactError) {
    const message = errorText(exactError);
    return { phase: 'error', placeholder: '—', number: null, qualifier: false, label: null,
      status: message, announcement: message, announceDelay: 0 };
  }
  return { phase: 'counting', placeholder: '…', number: null, qualifier: false, label: null,
    status: COUNTING_TEXT, announcement: COUNTING_TEXT, announceDelay: 0 };
}

// Writes to the single live region. A delayed announcement is replaced or cancelled by any
// later one, so a quick exact count is announced alone.
export function createAnnouncer(write, timers = globalThis) {
  let timer = null;
  function cancel() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }
  function announce(text, delay = 0) {
    cancel();
    if (delay > 0) {
      timer = timers.setTimeout(() => { timer = null; write(text); }, delay);
    } else {
      write(text);
    }
  }
  return { announce, cancel };
}
