// KDG-17: every gadget request to Jira goes through requestJiraWithRetry, which waits and
// retries when Jira rate limits the viewer, as Atlassian asks apps to do:
// https://developer.atlassian.com/cloud/jira/platform/build-an-app-that-respects-rate-limits/
//
// - 429: wait for Retry-After (seconds or an HTTP date), or back off 1s, 2s, 4s (with jitter)
//   when Jira sends no usable Retry-After, then retry.
// - 503: retried only when Jira sends Retry-After; otherwise the response is returned as is.
// - Every other status (including other 4xx) is returned as is, without a retry.
// - At most RETRY_LIMIT retries. A Retry-After longer than MAX_WAIT_MS is not waited for and
//   not retried early, so the load fails straight away with the busy message.
// - When retries run out, JiraBusyError is thrown with "Jira is busy. Try again in N seconds."

export const RETRY_LIMIT = 3;
export const MAX_WAIT_MS = 30000;
export const BACKOFF_MS = 1000;

// Thrown when a load stops because `isCurrent()` reported that its result is no longer wanted.
// A superseded load never returns normally, so a partial result cannot be mistaken for a
// complete one (or cached as one). Re-exported by jira-search.mjs.
export class SupersededError extends Error {
  constructor(message = 'The Jira request was superseded.') {
    super(message);
    this.name = 'SupersededError';
  }
}

export function busyMessage(retryAfterMs) {
  const seconds = Number.isFinite(retryAfterMs) ? Math.ceil(retryAfterMs / 1000) : 0;
  if (seconds < 1) return 'Jira is busy. Try again shortly.';
  return `Jira is busy. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}

// Thrown when Jira still answers 429 (or 503 with Retry-After) after the allowed retries.
// `retryAfterMs` is the last response's Retry-After in milliseconds, or null when unknown.
export class JiraBusyError extends Error {
  constructor(retryAfterMs = null) {
    super(busyMessage(retryAfterMs));
    this.name = 'JiraBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

function header(response, name) {
  try {
    const headers = response?.headers;
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : headers[key];
  } catch {
    return null;
  }
}

// The response's Retry-After in milliseconds (never negative), or null when it is missing or
// unreadable. Accepts delay-seconds ("120") or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT").
export function retryAfterMs(response, now = Date.now) {
  const value = header(response, 'Retry-After');
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now());
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Calls requestJira(path, options) and returns its response, retrying rate-limited responses
// as described above. Errors thrown by requestJira are not retried.
// `isCurrent()`, if given, is checked before each wait and each retry; once it is false no
// further request is sent and SupersededError is thrown.
// `sleep`, `random` and `now` are injectable for tests.
export async function requestJiraWithRetry(requestJira, path, options, {
  isCurrent, sleep = defaultSleep, random = Math.random, now = Date.now,
  retries = RETRY_LIMIT, maxWaitMs = MAX_WAIT_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await requestJira(path, options);
    const status = response?.status;
    if (status !== 429 && status !== 503) return response;
    const retryAfter = retryAfterMs(response, now);
    if (status === 503 && retryAfter === null) return response;
    if (attempt >= retries || (retryAfter !== null && retryAfter > maxWaitMs)) {
      throw new JiraBusyError(retryAfter);
    }
    const wait = retryAfter ?? Math.min(maxWaitMs, BACKOFF_MS * 2 ** attempt * (0.7 + 0.6 * random()));
    if (isCurrent && !isCurrent()) throw new SupersededError();
    await sleep(wait);
    if (isCurrent && !isCurrent()) throw new SupersededError();
  }
}
