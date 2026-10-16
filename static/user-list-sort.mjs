import { metricValue } from './user-metrics.mjs';

export function sortedUserRows(rows, sort, metric) {
  const direction = sort?.direction === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let comparison;
    if (sort?.column === 'assignee') comparison = a.name.localeCompare(b.name);
    else if (sort?.column?.startsWith('status:')) {
      const key = sort.column.slice('status:'.length);
      comparison = (a.counts[key] ?? 0) - (b.counts[key] ?? 0);
    } else comparison = metricValue(a, metric) - metricValue(b, metric);
    return direction * comparison || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id));
  });
}
