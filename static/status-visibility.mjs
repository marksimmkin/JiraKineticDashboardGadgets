import { narrowJql, quoteJql } from './drilldown.mjs';
import { statusKey } from './shared.mjs';

// KDG-24: which statuses the in-scope gadgets show. A status is shown unless
//   (a) the Controller saved `show: false` for it, or
//   (b) it has no explicit flag and its Jira status category is Done.
// DOM-free.

function uniqueNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of Array.isArray(names) ? names : []) {
    const key = statusKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(name.trim());
  }
  return result;
}

// Reads the explicit flags from a FILTER_SELECTED payload. Payloads from an older Controller
// have no `hiddenStatuses` / `shownStatuses` and so have nothing explicit (rule (b) only).
// A name in both lists is treated as hidden.
export function statusVisibility(payload) {
  const hiddenNames = uniqueNames(payload?.hiddenStatuses);
  const hidden = new Set(hiddenNames.map(statusKey));
  const shownNames = uniqueNames(payload?.shownStatuses).filter(name => !hidden.has(statusKey(name)));
  return { hidden, shown: new Set(shownNames.map(statusKey)), hiddenNames, shownNames };
}

export function isStatusShown(name, categoryKey, visibility) {
  const key = statusKey(name);
  if (visibility?.hidden?.has(key)) return false;
  if (visibility?.shown?.has(key)) return true;
  return String(categoryKey ?? '').toLowerCase() !== 'done';
}

// Issues from a search that requested the `status` field, kept per issue by the rule above.
export function shownIssues(issues, visibility) {
  return issues.filter(issue => isStatusShown(issue?.fields?.status?.name || 'Unknown status',
    issue?.fields?.status?.statusCategory?.key, visibility));
}

// (<jql>) AND (status not in (<hidden>)) AND (statusCategory != Done OR status in (<shown>)),
// leaving out the empty parts and keeping any ORDER BY at the end.
export function visibilityJql(jql, visibility) {
  const hiddenNames = visibility?.hiddenNames ?? [];
  const shownNames = visibility?.shownNames ?? [];
  const list = names => names.map(quoteJql).join(', ');
  return narrowJql(typeof jql === 'string' ? jql : '', [
    hiddenNames.length ? `status not in (${list(hiddenNames)})` : '',
    shownNames.length ? `statusCategory != Done OR status in (${list(shownNames)})` : 'statusCategory != Done',
  ]);
}

export const UNLISTED_DONE_CLAUSE = 'unlisted Done statuses';
const NOTE_LIMIT = 3;

// The model for the read-only "Hiding:" note, or null when nothing is hidden.
// - visibility: from statusVisibility; its hiddenNames come first, in Controller order.
// - discovered: statuses found in the loaded issues as { name, category } (User List and
//   Leaderboard). Those hidden by their Done category, and not already explicitly hidden, follow,
//   sorted A-Z.
// - includeUnlistedDoneClause: Counter and List; ends the list with "unlisted Done statuses".
// Returns { text, fullText, fullList, truncated }: `text` is the visible line, `fullText` the
// screen-reader sentence and `fullList` the untruncated list (for the title).
export function hiddenNote(visibility, { discovered = [], includeUnlistedDoneClause = false } = {}) {
  const names = [...(visibility?.hiddenNames ?? [])];
  const seen = new Set(names.map(statusKey));
  const extra = [];
  for (const status of discovered) {
    const key = statusKey(status?.name);
    if (!key || seen.has(key) || isStatusShown(status.name, status.category, visibility)) continue;
    seen.add(key);
    extra.push(status.name.trim());
  }
  extra.sort((a, b) => a.localeCompare(b));
  names.push(...extra);
  if (!names.length && !includeUnlistedDoneClause) return null;

  const withClause = parts => {
    if (!includeUnlistedDoneClause) return parts.join(', ');
    return parts.length ? `${parts.join(', ')} and ${UNLISTED_DONE_CLAUSE}` : UNLISTED_DONE_CLAUSE;
  };
  const truncated = names.length > NOTE_LIMIT;
  const fullList = withClause(names);
  let visible = fullList;
  if (truncated) {
    const shown = names.slice(0, NOTE_LIMIT).join(', ');
    const more = `${names.length - NOTE_LIMIT} more`;
    visible = includeUnlistedDoneClause
      ? `${shown}, ${more} and ${UNLISTED_DONE_CLAUSE}` : `${shown} and ${more}`;
  }
  return {
    text: `Hiding: ${visible}`,
    fullText: `Hiding issues in these statuses: ${fullList}`,
    fullList,
    truncated,
  };
}
