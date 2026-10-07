import { events, requestJira, router, view } from '@forge/bridge';
import { countIssues } from '../count.mjs';
import { issueCountButton } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard } from '../shared.mjs';

const root = document.getElementById('app');

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');

    root.innerHTML = '<section class="panel counter"><p class="eyebrow">Issues in filter</p><div class="count" aria-live="polite">—</div><p class="filter-name"></p><p class="status" role="status">Waiting for the controller…</p></section>';
    const count = root.querySelector('.count');
    const filterName = root.querySelector('.filter-name');
    const status = root.querySelector('.status');
    let active = null;
    let generation = 0;

    async function refresh() {
      const current = ++generation;
      if (!active?.jql) {
        count.textContent = '—';
        filterName.textContent = '';
        status.textContent = 'Configure a filter in the controller.';
        return;
      }
      count.textContent = '…';
      filterName.textContent = active.name;
      status.textContent = 'Counting visible issues…';
      try {
        const result = await countIssues(requestJira, active.jql);
        if (current !== generation) return;
        count.replaceChildren(issueCountButton(router, new Intl.NumberFormat().format(result),
          active.jql, `Open ${result} matching issues in Jira`));
        status.textContent = result === 1 ? 'issue' : 'issues';
      } catch (error) {
        if (current !== generation) return;
        count.textContent = '—';
        status.textContent = error.message || 'Could not count issues.';
      }
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      active = { name: payload.name, jql: payload.jql };
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
      if (!active) status.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the counter.';
  }
}

main();
