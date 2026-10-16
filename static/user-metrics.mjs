export const USER_METRICS = [
  { id: 'tickets', label: 'Total tickets' },
  { id: 'score', label: 'Total weighted score' },
  { id: 'time', label: 'Total time remaining' },
];

const scoreFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat();
const timeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function metricValue(row, metric) {
  return metric === 'score' ? row.score : metric === 'time' ? row.timeRemaining : row.total;
}

export function metricLabel(metric) {
  return USER_METRICS.find(item => item.id === metric)?.label ?? USER_METRICS[0].label;
}

export function formatMetric(value, metric) {
  if (metric === 'time') return `${timeFormat.format(value / 3600)}h`;
  return metric === 'score' ? scoreFormat.format(value) : numberFormat.format(value);
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
