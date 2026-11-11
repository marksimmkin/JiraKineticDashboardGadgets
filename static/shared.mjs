export const FILTER_REQUEST = 'kinetic.dashboard.filter.request';
export const FILTER_SELECTED = 'kinetic.dashboard.filter.selected';
export const GADGET_REFRESH = 'JIRA_DASHBOARD_GADGET_REFRESH';
export const STATUS_COLORS = ['#0c66e4', '#7f5fcb', '#22a06b', '#e2b203', '#e2483d', '#42b2d7',
  '#b65c9c', '#f38a3f', '#6b778c', '#9f8fef', '#80b655', '#d96c77'];

export function validStatusColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

export function dashboardId(context) {
  return String(context?.extension?.dashboard?.id ?? '');
}

export function gadgetId(context) {
  return String(context?.extension?.gadget?.id ?? '');
}

export function statusKey(name) {
  return typeof name === 'string' ? name.trim().toLocaleLowerCase() : '';
}

// Records the Jira status category key seen for a status name key. Statuses that share a name are
// counted together, so the name counts as 'done' only while every issue seen with it is Done;
// otherwise the first non-Done category is kept. Unknown categories are ignored.
export function recordCategory(categories, key, categoryKey) {
  if (typeof categoryKey !== 'string' || !categoryKey) return;
  const category = categoryKey.toLowerCase();
  const current = categories.get(key);
  if (current === undefined || (current === 'done' && category !== 'done')) categories.set(key, category);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function optionalDate(value) {
  return validDate(value) ? value : null;
}

export function configuredFilters(context) {
  const filters = context?.extension?.gadgetConfiguration?.filters;
  if (!Array.isArray(filters)) return [];
  return filters.filter(filter =>
    filter && typeof filter.name === 'string' && typeof filter.jql === 'string' &&
    filter.name.trim() && filter.jql.trim()
  ).map(filter => ({
    name: filter.name.trim(),
    jql: filter.jql.trim(),
    startDate: optionalDate(filter.startDate),
    endDate: optionalDate(filter.endDate),
  }));
}

export function configuredStatuses(context) {
  const statuses = context?.extension?.gadgetConfiguration?.statuses;
  if (!Array.isArray(statuses)) return [];
  const unique = new Map();
  for (const status of statuses) {
    const key = statusKey(status?.name);
    if (!key || unique.has(key) || typeof status.weight !== 'number' ||
      !Number.isFinite(status.weight) || status.weight < 0 || status.weight > 1) continue;
    const entry = { name: status.name.trim(), weight: status.weight,
      color: validStatusColor(status.color) ? status.color : STATUS_COLORS[unique.size % STATUS_COLORS.length] };
    // `show` is kept only when it was explicitly saved; unset means "use the Jira status category".
    if (typeof status.show === 'boolean') entry.show = status.show;
    unique.set(key, entry);
  }
  return [...unique.values()];
}

export function validateFilters(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return 'Add at least one filter.';
  const names = new Set();
  for (const filter of filters) {
    const name = filter.name.trim();
    const jql = filter.jql.trim();
    if (!name || !jql) return 'Every filter needs a name and JQL.';
    if (names.has(name.toLocaleLowerCase())) return 'Filter names must be unique.';
    if (filter.startDate && !validDate(filter.startDate)) return 'Enter a valid Start Date.';
    if (filter.endDate && !validDate(filter.endDate)) return 'Enter a valid End Date.';
    if (filter.startDate && filter.endDate && filter.startDate > filter.endDate) {
      return 'Start Date must be on or before End Date.';
    }
    names.add(name.toLocaleLowerCase());
  }
  return '';
}

export function validateStatuses(statuses) {
  if (!Array.isArray(statuses)) return 'Invalid status list.';
  const names = new Set();
  for (const status of statuses) {
    const key = statusKey(status?.name);
    if (!key) return 'Enter or choose a Jira status for each row.';
    if (names.has(key)) return 'Each Jira status name can be added only once.';
    if (!Number.isFinite(status.weight) || status.weight < 0 || status.weight > 1) {
      return 'Each status weight must be between 0 and 1.';
    }
    if (status.color !== undefined && !validStatusColor(status.color)) return 'Choose a valid status colour.';
    if (status.show !== undefined && typeof status.show !== 'boolean') return 'Choose whether each status is shown.';
    names.add(key);
  }
  return '';
}

export function isForDashboard(payload, id) {
  return Boolean(id) && String(payload?.dashboardId ?? '') === id;
}

export function selectedFilterPayload(context, filter) {
  const statuses = configuredStatuses(context);
  return {
    dashboardId: dashboardId(context),
    controllerId: gadgetId(context),
    name: filter?.name ?? null,
    jql: filter?.jql ?? null,
    startDate: filter?.startDate ?? null,
    endDate: filter?.endDate ?? null,
    statuses,
    hiddenStatuses: statuses.filter(status => status.show === false).map(status => status.name),
    shownStatuses: statuses.filter(status => status.show === true).map(status => status.name),
  };
}

// Identifies one Controller selection. Returns null when the payload has no `revision` (an older
// Controller), which means the selection must always be handled.
export function selectionKey(payload) {
  const revision = payload?.revision;
  if (revision === null || revision === undefined) return null;
  return JSON.stringify([revision, payload.jql ?? null, payload.startDate ?? null,
    payload.endDate ?? null, payload.statuses ?? [], payload.hiddenStatuses ?? [],
    payload.shownStatuses ?? []]);
}

export const REFRESH_FALLBACK_MS = 3000;
// A dashboard refresh that arrives this soon after a new selection was accepted is treated as
// already answered: the Controller's new revision can reach a gadget before its own refresh.
export const REFRESH_ANSWERED_MS = 1000;

// Decides how a gadget handles FILTER_SELECTED and GADGET_REFRESH so that repeated events do not
// repeat Jira downloads. DOM-free; `timers` defaults to the global setTimeout/clearTimeout, and
// its optional `now()` (default Date.now) is the clock for REFRESH_ANSWERED_MS.
//
// - accept(payload): true if the selection should be handled (its key is null or differs from
//   the last accepted key). Records the key and cancels a pending fallback. Call it only for
//   payloads that already passed isForDashboard.
// - refreshAction(payload): one of
//     'none'     the event is not for this gadget, or it is a dashboard refresh that a new
//                selection accepted within the last REFRESH_ANSWERED_MS already answered
//     'request'  emit FILTER_REQUEST (no selection yet)
//     'refetch'  refetch from the held selection now
//     'rerender' re-render from the held selection, no request (only when `rerender` is true)
//     'wait'     wait for the Controller's new revision; `onFallback()` runs once after
//                `fallbackMs` unless a new selection is accepted first
// - cancel(): clears a pending fallback timer.
// - hasSelection: whether any selection has been accepted.
export function createSelectionTracker({ gadgetId = '', onFallback = () => {}, rerender = false,
  fallbackMs = REFRESH_FALLBACK_MS, timers = globalThis } = {}) {
  let hasSelection = false;
  let lastKey = null;
  let timer = null;
  let acceptedAt = null;
  const now = () => (typeof timers.now === 'function' ? timers.now() : Date.now());

  function cancel() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  return {
    get hasSelection() { return hasSelection; },
    accept(payload) {
      const key = selectionKey(payload);
      if (hasSelection && key !== null && key === lastKey) return false;
      hasSelection = true;
      lastKey = key;
      acceptedAt = key === null ? null : now();
      cancel();
      return true;
    },
    refreshAction(payload) {
      const dashboard = payload?.origin === 'dashboard';
      if (!dashboard && payload?.gadgetId !== gadgetId) return 'none';
      if (!hasSelection) return 'request';
      if (!dashboard) return rerender ? 'rerender' : 'refetch';
      if (lastKey === null) return rerender ? 'request' : 'refetch';
      // A clock that went backwards is not treated as recent; the fallback then still runs.
      const elapsed = acceptedAt === null ? Infinity : now() - acceptedAt;
      if (elapsed >= 0 && elapsed < REFRESH_ANSWERED_MS) return 'none';
      cancel();
      timer = timers.setTimeout(() => {
        timer = null;
        onFallback();
      }, fallbackMs);
      return 'wait';
    },
    cancel,
  };
}
