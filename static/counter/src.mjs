import { events, requestJira, router, view } from '@forge/bridge';
import { approximateCount, countIssues } from '../count.mjs';
import { counterView, createAnnouncer, initialCount, withApproximate, withExact,
  withExactError } from '../counter-state.mjs';
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

    root.innerHTML = '<section class="panel counter"><p class="eyebrow">Issues in filter</p><div class="count">—</div><p class="filter-name"></p><p class="status">Waiting for the controller…</p><p class="visually-hidden" role="status"></p></section>';
    const count = root.querySelector('.count');
    const filterName = root.querySelector('.filter-name');
    const status = root.querySelector('.status');
    const live = root.querySelector('.visually-hidden');
    const announcer = createAnnouncer(text => { live.textContent = text; });
    let active = null;
    let generation = 0;
    let button = null;
    let qualifier = null;

    function showMessage(text) {
      status.textContent = text;
      announcer.announce(text);
    }

    function showPlaceholder(text) {
      count.textContent = text;
      button = null;
      qualifier = null;
    }

    // Updates the existing button in place where possible so keyboard focus is kept.
    function render(state, jql) {
      const shown = counterView(state);
      if (shown.number === null) {
        showPlaceholder(shown.placeholder);
      } else if (button) {
        button.textContent = shown.number;
        button.setAttribute('aria-label', shown.label);
      } else {
        button = issueCountButton(router, shown.number, jql, shown.label);
        count.replaceChildren(button);
      }
      if (shown.qualifier && !qualifier) {
        qualifier = document.createElement('span');
        qualifier.className = 'count-qualifier';
        qualifier.textContent = 'about';
        button.before(qualifier, ' ');
      } else if (!shown.qualifier && qualifier) {
        qualifier.nextSibling?.remove();
        qualifier.remove();
        qualifier = null;
      }
      status.textContent = shown.status;
      announcer.announce(shown.announcement, shown.announceDelay);
    }

    async function refresh() {
      const current = ++generation;
      announcer.cancel();
      showPlaceholder('—');
      if (!active?.jql) {
        filterName.textContent = '';
        showMessage('Configure a filter in the controller.');
        return;
      }
      const { jql } = active;
      filterName.textContent = active.name;
      let state = initialCount();
      render(state, jql);
      void approximateCount(requestJira, jql).then(result => {
        if (current !== generation) return;
        const next = withApproximate(state, result);
        if (next === state) return;
        state = next;
        render(state, jql);
      }, error => {
        // The exact count follows, so an approximate failure is not shown.
        console.warn('Approximate issue count failed.', error);
      });
      try {
        const result = await countIssues(requestJira, jql);
        if (current !== generation) return;
        state = withExact(state, result);
      } catch (error) {
        if (current !== generation) return;
        state = withExactError(state, error);
      }
      render(state, jql);
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
      if (!active) showMessage('Add a Kinetic Dashboard Controller to this dashboard.');
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the counter.';
  }
}

main();
