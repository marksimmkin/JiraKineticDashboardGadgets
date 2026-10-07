import { events, requestJira, router, view } from '@forge/bridge';
import { countIssuesByStatus } from '../status-counts.mjs';
import { issueCountButton, narrowJql, statusClause, statusesClause } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, statusKey } from '../shared.mjs';

const root = document.getElementById('app');
const colors = ['#0c66e4', '#7f5fcb', '#22a06b', '#e2b203', '#e2483d', '#42b2d7',
  '#b65c9c', '#f38a3f', '#6b778c', '#9f8fef', '#80b655', '#d96c77'];
const numberFormat = new Intl.NumberFormat();
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');
    const panel = node('section', 'panel status-pie');
    const heading = node('p', 'eyebrow', 'Issues by status');
    const filterName = node('p', 'chart-filter-name');
    const content = node('div', 'pie-content');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    panel.append(heading, filterName, content, message);
    root.replaceChildren(panel);
    let active = null;
    let generation = 0;

    function showPie(result) {
      const slices = active.statuses.map((status, index) => ({
        name: status.name,
        count: result.counts[statusKey(status.name)] ?? 0,
        ids: result.statusIds[statusKey(status.name)] ?? [],
        color: colors[index % colors.length],
      }));
      const shown = slices.reduce((sum, slice) => sum + slice.count, 0);
      if (!shown) {
        if (result.total) message.replaceChildren(
          'No issues are in configured statuses (',
          issueCountButton(router, numberFormat.format(result.total), active.jql,
            `Open all ${result.total} matching issues`),
          ' matching issues).',
        );
        else message.textContent = 'No matching issues.';
        return;
      }
      let offset = 0;
      const stops = [];
      for (const slice of slices) {
        if (!slice.count) continue;
        const end = offset + slice.count / shown * 100;
        stops.push(`${slice.color} ${offset}% ${end}%`);
        offset = end;
      }
      const graphic = node('div', 'pie-donut');
      graphic.style.background = `conic-gradient(${stops.join(', ')})`;
      graphic.setAttribute('role', 'group');
      graphic.setAttribute('aria-label', slices.filter(slice => slice.count)
        .map(slice => `${slice.name}: ${slice.count}`).join(', '));
      const center = issueCountButton(router, numberFormat.format(shown),
        narrowJql(active.jql, [statusesClause(slices.filter(slice => slice.count))]),
        `Open ${shown} issues in configured statuses`);
      center.classList.add('pie-center');
      graphic.append(center);
      const legend = node('div', 'pie-legend');
      for (const slice of slices) {
        const item = node('div', 'pie-legend-row');
        const swatch = node('span', 'pie-swatch');
        swatch.style.background = slice.color;
        const value = node('strong', 'pie-legend-value');
        value.append(issueCountButton(router, numberFormat.format(slice.count),
          narrowJql(active.jql, [statusClause(slice.name, slice.ids)]),
          `Open ${slice.count} ${slice.name} issues`),
        ` · ${percentFormat.format(slice.count / shown * 100)}%`);
        item.append(swatch, node('span', 'pie-legend-name', slice.name), value);
        legend.append(item);
      }
      content.replaceChildren(graphic, legend);
      message.replaceChildren(
        issueCountButton(router, numberFormat.format(shown),
          narrowJql(active.jql, [statusesClause(slices.filter(slice => slice.count))]),
          `Open ${shown} issues in configured statuses`),
        ...(shown === result.total ? [' matching issues'] : [
          ' of ',
          issueCountButton(router, numberFormat.format(result.total), active.jql,
            `Open all ${result.total} matching issues`),
          ' matching issues in configured statuses',
        ]),
      );
    }

    async function refresh() {
      const current = ++generation;
      content.replaceChildren();
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      if (!active.statuses.length) {
        message.textContent = 'Add statuses in the Controller to see the pie chart.';
        return;
      }
      message.textContent = 'Counting matching issues…';
      try {
        const result = await countIssuesByStatus(requestJira, active.jql, active.statuses);
        if (current !== generation) return;
        showPie(result);
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the pie chart.';
      }
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      active = {
        name: payload.name,
        jql: payload.jql,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.filter(status => statusKey(status?.name)) : [],
      };
      filterName.textContent = active.name ?? '';
      void refresh();
    });
    await events.on(GADGET_REFRESH, payload => {
      if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
        if (active) void refresh();
        else void events.emit(FILTER_REQUEST, { dashboardId: id });
      }
    });
    await events.emit(FILTER_REQUEST, { dashboardId: id });
    setTimeout(() => {
      if (!active) message.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the pie chart.';
  }
}

main();
