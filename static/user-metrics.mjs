export const USER_METRICS = [
  { id: 'tickets', label: 'Total tickets' },
  { id: 'score', label: 'Total weighted score' },
  { id: 'time', label: 'Total time remaining' },
];

const scoreFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat();
// KDG-28: time remaining is shown as days then hours. Hours per day is set in each gadget's
// Edit view (see hoursPerDay in capacity.mjs) and defaults to 7.
export const DEFAULT_USER_HOURS_PER_DAY = 7;
const SECONDS_PER_HOUR = 3600;
const dayFormat = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hourFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

// Both from raw seconds, so days are never worked out from rounded hours.
function timeParts(seconds, hoursPerDay = DEFAULT_USER_HOURS_PER_DAY) {
  return { days: dayFormat.format(seconds / (hoursPerDay * SECONDS_PER_HOUR)),
    hours: hourFormat.format(seconds / SECONDS_PER_HOUR) };
}

export function metricValue(row, metric) {
  return metric === 'score' ? row.score : metric === 'time' ? row.timeRemaining : row.total;
}

export function metricLabel(metric) {
  return USER_METRICS.find(item => item.id === metric)?.label ?? USER_METRICS[0].label;
}

export function formatMetric(value, metric, { hoursPerDay } = {}) {
  if (metric === 'time') {
    const { days, hours } = timeParts(value, hoursPerDay);
    return `${days}d\u00a0(${hours}h)`;
  }
  return metric === 'score' ? scoreFormat.format(value) : numberFormat.format(value);
}

// Screen-reader text for a time remaining value, e.g. "6.0 days, 42 hours".
export function timeRemainingSpoken(seconds, hoursPerDay) {
  const { days, hours } = timeParts(seconds, hoursPerDay);
  return `${days} ${days === '1.0' ? 'day' : 'days'}, ${hours} ${hours === '1' ? 'hour' : 'hours'}`;
}

// The shown "6.0d (42h)" hidden from screen readers, plus the spoken form for them.
export function timeRemainingNodes(seconds, hoursPerDay) {
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  shown.textContent = formatMetric(seconds, 'time', { hoursPerDay });
  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  spoken.textContent = timeRemainingSpoken(seconds, hoursPerDay);
  return [shown, spoken];
}

export function createUserMetricSelect(dashboardId, gadgetId, onChange, defaultMetric = 'tickets') {
  const storageKey = `kinetic.dashboard.user-metric.v1:${dashboardId}:${gadgetId}`;
  const label = document.createElement('label');
  label.className = 'field-label user-metric-label';
  label.textContent = 'Show total';
  const select = document.createElement('select');
  select.className = 'text-input user-metric-select';
  for (const item of USER_METRICS) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = defaultMetric;
  try {
    const saved = localStorage.getItem(storageKey);
    if (USER_METRICS.some(item => item.id === saved)) select.value = saved;
  } catch { /* Storage may be unavailable in a gadget iframe. */ }
  select.addEventListener('change', () => {
    try { localStorage.setItem(storageKey, select.value); } catch { /* Selection still works. */ }
    onChange();
  });
  label.append(select);
  return { element: label, selected: () => select.value };
}
