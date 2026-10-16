import { narrowJql, statusesClause } from './drilldown.mjs';
import { statusKey } from './shared.mjs';

const STORAGE_PREFIX = 'kinetic.dashboard.hidden-statuses.v1';

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function matchingStatusIssues(issues, statuses) {
  const keys = new Set(statuses.map(status => statusKey(status.name)));
  return issues.filter(issue => keys.has(statusKey(issue?.fields?.status?.name || 'Unknown status')));
}

export function visibleIssueJql(jql, allStatuses, visibleStatuses) {
  if (!visibleStatuses.length) return null;
  return visibleStatuses.length === allStatuses.length
    ? jql : narrowJql(jql, [statusesClause(visibleStatuses)]);
}

export function createStatusFilter(dashboardId, gadgetId, onChange, remember = true) {
  const storageKey = `${STORAGE_PREFIX}:${dashboardId}:${gadgetId}`;
  const hidden = new Set();
  if (remember) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(saved)) {
        for (const name of saved) {
          const key = statusKey(name);
          if (key) hidden.add(key);
        }
      }
    } catch { /* Browser storage may be unavailable in an embedded gadget. */ }
  }

  const details = element('details', 'status-filter');
  details.hidden = true;
  const summary = element('summary', 'status-filter-summary');
  const menu = element('div', 'status-filter-menu');
  const actions = element('div', 'status-filter-actions');
  const selectAll = element('button', 'button secondary', 'All');
  const selectNone = element('button', 'button secondary', 'None');
  selectAll.type = 'button';
  selectNone.type = 'button';
  actions.append(selectAll, selectNone);
  const options = element('div', 'status-filter-options');
  menu.append(actions, options);
  details.append(summary, menu);
  let available = [];

  function updateSummary() {
    const shown = available.filter(status => !hidden.has(status.key)).length;
    summary.textContent = shown === available.length
      ? `Statuses: All (${shown})` : `Statuses: ${shown} of ${available.length}`;
  }

  function changed() {
    updateSummary();
    if (remember) {
      try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); }
      catch { /* The selection still works until the gadget reloads. */ }
    }
    onChange();
  }

  function setStatuses(statuses) {
    const seen = new Set();
    available = statuses.map(status => ({ ...status, key: statusKey(status.name) }))
      .filter(status => {
        if (!status.key || seen.has(status.key)) return false;
        seen.add(status.key);
        return true;
      });
    options.replaceChildren();
    details.hidden = available.length === 0;
    for (const status of available) {
      const label = element('label', 'status-filter-option');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !hidden.has(status.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) hidden.delete(status.key);
        else hidden.add(status.key);
        changed();
      });
      label.append(checkbox, element('span', '', status.name));
      options.append(label);
    }
    updateSummary();
  }

  function select(checked) {
    for (const status of available) {
      if (checked) hidden.delete(status.key);
      else hidden.add(status.key);
    }
    for (const checkbox of options.querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = checked;
    }
    changed();
  }
  selectAll.addEventListener('click', () => select(true));
  selectNone.addEventListener('click', () => select(false));

  return {
    element: details,
    setStatuses,
    visibleStatuses: () => available.filter(status => !hidden.has(status.key)),
  };
}
