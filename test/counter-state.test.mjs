import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { ANNOUNCE_APPROXIMATE_DELAY, counterView, createAnnouncer, initialCount,
  withApproximate, withExact, withExactError } from '../static/counter-state.mjs';

const format = new Intl.NumberFormat('en-US');
const view = state => counterView(state, format);

test('counting state shows an ellipsis and no button', () => {
  const shown = view(initialCount());
  assert.equal(shown.phase, 'counting');
  assert.equal(shown.placeholder, '…');
  assert.equal(shown.number, null);
  assert.equal(shown.qualifier, false);
  assert.equal(shown.status, 'Counting visible issues…');
  assert.equal(shown.announcement, 'Counting visible issues…');
  assert.equal(shown.announceDelay, 0);
});

test('approximate state is marked about, formatted, and its announcement is debounced', () => {
  const shown = view(withApproximate(initialCount(), 1240));
  assert.equal(shown.phase, 'approximate');
  assert.equal(shown.number, '1,240');
  assert.equal(shown.qualifier, true);
  assert.equal(shown.label, 'Open about 1,240 matching issues in Jira');
  assert.equal(shown.status, 'issues · counting exactly…');
  assert.equal(shown.announcement, 'About 1,240 issues. Counting exactly.');
  assert.equal(shown.announceDelay, ANNOUNCE_APPROXIMATE_DELAY);
  assert.equal(ANNOUNCE_APPROXIMATE_DELAY, 1000);
});

test('approximate singular and zero wording', () => {
  const one = view(withApproximate(initialCount(), 1));
  assert.equal(one.label, 'Open about 1 matching issue in Jira');
  assert.equal(one.status, 'issue · counting exactly…');
  assert.equal(one.announcement, 'About 1 issue. Counting exactly.');
  const zero = view(withApproximate(initialCount(), 0));
  assert.equal(zero.number, '0');
  assert.equal(zero.qualifier, true);
  assert.equal(zero.label, 'Open about 0 matching issues in Jira');
});

test('exact state removes the qualifier and uses formatted wording', () => {
  const shown = view(withExact(withApproximate(initialCount(), 1200), 1240));
  assert.equal(shown.phase, 'exact');
  assert.equal(shown.number, '1,240');
  assert.equal(shown.qualifier, false);
  assert.equal(shown.label, 'Open 1,240 matching issues in Jira');
  assert.equal(shown.status, 'issues');
  assert.equal(shown.announcement, 'Exactly 1,240 issues.');
  assert.equal(shown.announceDelay, 0);
  const one = view(withExact(initialCount(), 1));
  assert.equal(one.label, 'Open 1 matching issue in Jira');
  assert.equal(one.status, 'issue');
  assert.equal(one.announcement, 'Exactly 1 issue.');
});

test('approximate equal to exact still moves to the exact state', () => {
  const shown = view(withExact(withApproximate(initialCount(), 7), 7));
  assert.equal(shown.phase, 'exact');
  assert.equal(shown.qualifier, false);
  assert.equal(shown.announcement, 'Exactly 7 issues.');
});

test('an approximate count arriving after the exact one is ignored', () => {
  const exact = withExact(initialCount(), 5);
  assert.equal(withApproximate(exact, 9), exact);
  assert.equal(view(withApproximate(exact, 9)).number, '5');
  const failed = withExactError(initialCount(), new Error('Nope.'));
  assert.equal(withApproximate(failed, 9), failed);
  assert.equal(view(withApproximate(failed, 9)).phase, 'error');
});

test('exact failure after approximate keeps the approximate count with a message', () => {
  const shown = view(withExactError(withApproximate(initialCount(), 1240), new Error('Jira is down.')));
  assert.equal(shown.phase, 'approximate-only');
  assert.equal(shown.number, '1,240');
  assert.equal(shown.qualifier, true);
  assert.equal(shown.label, 'Open about 1,240 matching issues in Jira');
  assert.equal(shown.status, 'Exact count unavailable. Jira is down.');
  assert.equal(shown.announcement, 'Exact count unavailable. Jira is down.');
  assert.equal(shown.announceDelay, 0);
  const fallback = view(withExactError(withApproximate(initialCount(), 3), new Error('')));
  assert.equal(fallback.status, 'Exact count unavailable. Could not count issues.');
});

test('exact failure without an approximate count shows the error state', () => {
  const shown = view(withExactError(initialCount(), new Error('You cannot view issues for this filter.')));
  assert.equal(shown.phase, 'error');
  assert.equal(shown.placeholder, '—');
  assert.equal(shown.number, null);
  assert.equal(shown.status, 'You cannot view issues for this filter.');
  assert.equal(shown.announcement, 'You cannot view issues for this filter.');
  assert.equal(view(withExactError(initialCount(), {})).status, 'Could not count issues.');
});

test('announcer debounces the approximate count and an exact count cancels it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const written = [];
    const announcer = createAnnouncer(text => written.push(text));
    announcer.announce('Counting visible issues…');
    announcer.announce('About 5 issues. Counting exactly.', 1000);
    mock.timers.tick(999);
    assert.deepEqual(written, ['Counting visible issues…']);
    announcer.announce('Exactly 5 issues.');
    mock.timers.tick(5000);
    assert.deepEqual(written, ['Counting visible issues…', 'Exactly 5 issues.']);
  } finally {
    mock.timers.reset();
  }
});

test('announcer announces the approximate count after 1000 ms and cancel clears it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const written = [];
    const announcer = createAnnouncer(text => written.push(text));
    announcer.announce('About 5 issues. Counting exactly.', 1000);
    mock.timers.tick(1000);
    assert.deepEqual(written, ['About 5 issues. Counting exactly.']);
    announcer.announce('About 6 issues. Counting exactly.', 1000);
    announcer.cancel();
    mock.timers.tick(5000);
    assert.deepEqual(written, ['About 5 issues. Counting exactly.']);
  } finally {
    mock.timers.reset();
  }
});
