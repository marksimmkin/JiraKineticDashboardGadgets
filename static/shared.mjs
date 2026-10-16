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
    unique.set(key, { name: status.name.trim(), weight: status.weight,
      color: validStatusColor(status.color) ? status.color : STATUS_COLORS[unique.size % STATUS_COLORS.length] });
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
    names.add(key);
  }
  return '';
}

export function isForDashboard(payload, id) {
  return Boolean(id) && String(payload?.dashboardId ?? '') === id;
}

export function selectedFilterPayload(context, filter) {
  return {
    dashboardId: dashboardId(context),
    controllerId: gadgetId(context),
    name: filter?.name ?? null,
    jql: filter?.jql ?? null,
    startDate: filter?.startDate ?? null,
    endDate: filter?.endDate ?? null,
    statuses: configuredStatuses(context),
  };
}
