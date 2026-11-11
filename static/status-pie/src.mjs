import { events, requestJira, router, view } from '@forge/bridge';
import { countIssuesByStatus } from '../status-counts.mjs';
import { issueCountButton, narrowJql, statusClause, statusesClause } from '../drilldown.mjs';
import { chartStatuses, emptyChartMessage } from '../chart-statuses.mjs';
import { hiddenNote, statusVisibility } from '../status-visibility.mjs';
import { createHiddenNote } from '../status-note.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, createSelectionTracker, isForDashboard, STATUS_COLORS, statusKey, validStatusColor } from '../shared.mjs';

const root = document.getElementById('app');
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
    let active = null;
    let generation = 0;
    let cachedResult = null;
    const note = createHiddenNote();
    panel.append(heading, filterName, note.element, content, message);
    root.replaceChildren(panel);

    function showPie(result, statuses) {
      const slices = statuses.map((status, index) => ({
        name: status.name,
        count: result.counts[statusKey(status.name)] ?? 0,
        ids: result.statusIds[statusKey(status.name)] ?? [],
        color: validStatusColor(status.color) ? status.color : STATUS_COLORS[index % STATUS_COLORS.length],
      }));
      const shown = slices.reduce((sum, slice) => sum + slice.count, 0);
      if (!shown) {
        emptyChartMessage(message, { allHidden: false, total: result.total, jql: active.jql, router,
          format: numberFormat });
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
        `Open ${shown} issues in shown statuses`);
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
          `Open ${shown} issues in shown statuses`),
        ...(shown === result.total ? [' matching issues'] : [
          ' of ',
          issueCountButton(router, numberFormat.format(result.total), active.jql,
            `Open all ${result.total} matching issues`),
          ' matching issues in shown statuses',
        ]),
      );
    }

    function render() {
      content.replaceChildren();
      if (!cachedResult || !active) return;
      const { visible, note: noteModel, allHidden } = chartStatuses(active.statuses, cachedResult,
        active.visibility);
      note.show(noteModel);
      if (allHidden) {
        emptyChartMessage(message, { allHidden, total: cachedResult.total, jql: active.jql, router,
          format: numberFormat });
        return;
      }
      showPie(cachedResult, visible);
    }

    async function refresh() {
      const current = ++generation;
      cachedResult = null;
      content.replaceChildren();
      note.show(null);
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      if (!active.statuses.length) {
        message.textContent = 'Add statuses in the Controller to see the pie chart.';
        return;
      }
      note.show(hiddenNote(active.visibility));
      message.textContent = 'Counting matching issues…';
      try {
        const result = await countIssuesByStatus(requestJira, active.jql, active.statuses,
          { isCurrent: () => current === generation, visibility: active.visibility });
        if (current !== generation) return;
        cachedResult = result;
        render();
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the pie chart.';
      }
    }

    const selection = createSelectionTracker({ gadgetId: gadgetId(context), onFallback: () => void refresh() });
    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id) || !selection.accept(payload)) return;
      active = {
        name: payload.name,
        jql: payload.jql,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.filter(status => statusKey(status?.name)) : [],
        visibility: statusVisibility(payload),
      };
      filterName.textContent = active.name ?? '';
      void refresh();
    });
    await events.on(GADGET_REFRESH, payload => {
      const action = selection.refreshAction(payload);
      if (action === 'refetch') void refresh();
      else if (action === 'request') void events.emit(FILTER_REQUEST, { dashboardId: id });
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
