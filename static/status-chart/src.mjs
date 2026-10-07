import { events, requestJira, router, view } from '@forge/bridge';
import { countIssuesByStatus } from '../status-counts.mjs';
import { issueCountButton, narrowJql, statusClause, statusesClause } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, statusKey } from '../shared.mjs';

const root = document.getElementById('app');
const numberFormat = new Intl.NumberFormat();

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

    const panel = node('section', 'panel status-chart');
    const heading = node('p', 'eyebrow', 'Issues by status');
    const filterName = node('p', 'chart-filter-name');
    const bars = node('div', 'status-bars');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    panel.append(heading, filterName, bars, message);
    root.replaceChildren(panel);

    let active = null;
    let generation = 0;

    function showBars(statuses, result) {
      bars.replaceChildren();
      const counts = result.counts;
      const highest = Math.max(1, ...statuses.map(status => counts[statusKey(status.name)] ?? 0));
      for (const [index, status] of statuses.entries()) {
        const value = counts[statusKey(status.name)] ?? 0;
        const row = node('div', 'status-bar-row');
        const line = node('div', 'status-bar-line');
        const label = node('span', 'status-bar-label', status.name);
        const key = statusKey(status.name);
        const number = issueCountButton(router, numberFormat.format(value),
          narrowJql(active.jql, [statusClause(status.name, result.statusIds[key] ?? [])]),
          `Open ${value} ${status.name} issues in Jira`);
        number.classList.add('status-bar-number');
        const track = node('div', 'status-bar-track');
        const fill = node('div', `status-bar-fill tone-${index % 4}`);
        track.setAttribute('aria-hidden', 'true');
        track.append(fill);
        line.append(label, number);
        row.append(line, track);
        bars.append(row);
        requestAnimationFrame(() => { fill.style.width = `${value / highest * 100}%`; });
      }
    }

    async function refresh() {
      const current = ++generation;
      bars.replaceChildren();
      if (!active?.jql) {
        filterName.textContent = '';
        message.textContent = 'Configure a filter in the controller.';
        return;
      }
      filterName.textContent = active.name;
      if (!active.statuses.length) {
        message.textContent = 'Add statuses in the controller to see the chart.';
        return;
      }
      message.textContent = 'Counting visible issues…';
      try {
        const result = await countIssuesByStatus(requestJira, active.jql, active.statuses);
        if (current !== generation) return;
        showBars(active.statuses, result);
        const shown = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
        const configured = active.statuses.filter(status =>
          !shown || (result.counts[statusKey(status.name)] ?? 0) > 0).map(status => ({
          name: status.name, ids: result.statusIds[statusKey(status.name)] ?? [],
        }));
        message.replaceChildren(
          issueCountButton(router, numberFormat.format(shown),
            narrowJql(active.jql, [statusesClause(configured)]),
            `Open ${shown} issues in configured statuses`),
          ' of ',
          issueCountButton(router, numberFormat.format(result.total), active.jql,
            `Open all ${result.total} matching issues`),
          ' issues in configured statuses',
        );
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not count issues by status.';
      }
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      active = {
        name: payload.name,
        jql: payload.jql,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.filter(status => statusKey(status?.name))
          : [],
      };
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
    root.textContent = error.message || 'Could not load the status chart.';
  }
}

main();
