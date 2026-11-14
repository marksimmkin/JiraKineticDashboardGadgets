import assert from 'node:assert/strict';
import test from 'node:test';
import { approximateCount } from '../static/count.mjs';
import { narrowJql, splitOrderBy } from '../static/drilldown.mjs';
import { orderedJql } from '../static/issue-data.mjs';

const done = 'status = "Done"';
const ok = json => ({ ok: true, status: 200, json: async () => json });

test('QA KDG-8: the reported orderedJql case no longer doubles ORDER BY', () => {
  assert.equal(orderedJql('project="A"ORDER BY x', 'key', 'ASC'), 'project="A" ORDER BY key ASC');
  assert.equal(orderedJql("project='A'ORDER BY x", 'key', 'DESC'), "project='A' ORDER BY key DESC");
  assert.equal(orderedJql('project in (A, B)ORDER BY x', 'customfield_10010', 'DESC'),
    'project in (A, B) ORDER BY cf[10010] DESC');
});

test('QA KDG-8: narrowJql keeps ORDER BY at the end after a closing ) or quote', () => {
  assert.equal(narrowJql('project="A"ORDER BY x', [done]),
    '(project="A") AND (status = "Done") ORDER BY x');
  assert.equal(narrowJql('issueFunction in foo("x")ORDER BY y', ['assignee is EMPTY']),
    '(issueFunction in foo("x")) AND (assignee is EMPTY) ORDER BY y');
});

test('QA KDG-8: approximateCount drops ORDER BY glued to a closing quote', async () => {
  const bodies = [];
  const request = async (path, options) => { bodies.push(JSON.parse(options.body)); return ok({ count: 4 }); };
  assert.equal(await approximateCount(request, 'project="A"ORDER BY x'), 4);
  assert.deepEqual(bodies, [{ jql: 'project="A"' }]);
});

test('QA KDG-8: boundary edge cases split or stay as filter text', () => {
  const cases = [
    // Split: closing quote/bracket followed by ORDER BY, any case or whitespace.
    ['summary ~ "x"order\nby x', 'summary ~ "x"', 'order\nby x'],
    ['summary ~ "x"ORDER\tBY x', 'summary ~ "x"', 'ORDER\tBY x'],
    ['a="x"ORDER BY', 'a="x"', 'ORDER BY'],
    ["summary ~ 'it\\'s'ORDER BY x", "summary ~ 'it\\'s'", 'ORDER BY x'],
    ['labels in ("a)", \'b(\')ORDER BY c', 'labels in ("a)", \'b(\')', 'ORDER BY c'],
    ['issueFunction in linkedIssuesOf("project = A ORDER BY rank")ORDER BY y',
      'issueFunction in linkedIssuesOf("project = A ORDER BY rank")', 'ORDER BY y'],
    ['x = "a"""ORDER BY c', 'x = "a"""', 'ORDER BY c'],
    // Not split: unclosed quote, not ORDER BY, word before ORDER, quote opening a string.
    ['"ORDER BY x', '"ORDER BY x', ''],
    ['summary ~ "x"ORDER', 'summary ~ "x"ORDER', ''],
    ['summary ~ "x"ORDERBY x', 'summary ~ "x"ORDERBY x', ''],
    ['summary ~ "x"ORDER BYx', 'summary ~ "x"ORDER BYx', ''],
    ['x = "y"REORDER BY z', 'x = "y"REORDER BY z', ''],
    ['summary ~ "a"\'ORDER BY x\'', 'summary ~ "a"\'ORDER BY x\'', ''],
    ['summary ~ "\\\\\\"ORDER BY x"', 'summary ~ "\\\\\\"ORDER BY x"', ''],
  ];
  for (const [jql, filter, order] of cases) {
    assert.deepEqual(splitOrderBy(jql), { filter, order }, jql);
  }
});

test('QA KDG-8: very long JQL with a glued ORDER BY splits quickly', () => {
  // KDG-21: measures this process's CPU time, not wall-clock time, so other load on the
  // machine does not count (same approach as KDG-12). A linear split of this ~550k-character
  // JQL uses tens of ms of CPU; a quadratic one uses far more than the limit.
  const jql = `project = A${' AND c = "d"'.repeat(50000)}ORDER BY z`;
  const start = process.cpuUsage();
  assert.equal(splitOrderBy(jql).order, 'ORDER BY z');
  const used = process.cpuUsage(start);
  const cpuMs = (used.user + used.system) / 1000;
  assert.ok(cpuMs < 1000, `splitOrderBy used ${cpuMs.toFixed(0)} ms of CPU`);
});
