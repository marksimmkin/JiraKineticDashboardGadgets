// KDG-24: which Controller statuses the Status Bar and Status Pie charts draw, and their shared
// empty states. The charts show only statuses listed in the Controller.
import { issueCountButton } from './drilldown.mjs';
import { statusKey } from './shared.mjs';
import { hiddenNote, isStatusShown } from './status-visibility.mjs';

export const ALL_HIDDEN_TEXT = 'All Controller statuses are hidden. Tick Show for a status in the Controller.';

// statuses: the Controller's listed statuses; result: countIssuesByStatus(); visibility:
// statusVisibility(payload). Returns
// - visible: the listed statuses to draw, in Controller order;
// - allHidden: true when every listed status is hidden;
// - note: the "Hiding:" note model (hidden listed statuses, in Controller order) or null.
// A listed status whose category is unknown (for example one with no issues) counts as shown,
// so a zero-count status keeps its zero bar and legend row.
export function chartStatuses(statuses, result, visibility) {
  const listed = statuses.map(status => {
    const key = statusKey(status.name);
    return { status, category: result.categories?.[key] ?? null };
  });
  const hidden = listed.filter(entry => !isStatusShown(entry.status.name, entry.category, visibility));
  const visible = listed.filter(entry => !hidden.includes(entry)).map(entry => entry.status);
  return {
    visible,
    allHidden: listed.length > 0 && hidden.length === listed.length,
    note: hiddenNote({ hiddenNames: hidden.map(entry => entry.status.name) }),
  };
}

// Writes the chart's empty state into `message`.
export function emptyChartMessage(message, { allHidden, total, jql, router, format }) {
  if (allHidden) message.textContent = ALL_HIDDEN_TEXT;
  else if (total) {
    message.replaceChildren(
      'No issues are in shown statuses (',
      issueCountButton(router, format.format(total), jql, `Open all ${total} matching issues`),
      ' matching issues).',
    );
  } else message.textContent = 'No matching issues.';
}
