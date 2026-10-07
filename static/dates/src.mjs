import { events, view } from '@forge/bridge';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard } from '../shared.mjs';

const root = document.getElementById('app');
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateLabel(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Not set';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? 'Not set' : dateFormatter.format(date);
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');

    const panel = makeElement('section', 'panel dates-widget');
    const heading = makeElement('p', 'eyebrow', 'Selected filter dates');
    const name = makeElement('p', 'dates-filter-name');
    const grid = makeElement('div', 'dates-grid');
    const start = makeElement('div', 'date-card');
    const startTitle = makeElement('p', 'date-card-label', 'Start Date');
    const startValue = makeElement('time', 'date-card-value', '—');
    const end = makeElement('div', 'date-card');
    const endTitle = makeElement('p', 'date-card-label', 'End Date');
    const endValue = makeElement('time', 'date-card-value', '—');
    const status = makeElement('p', 'status', 'Waiting for the controller…');
    status.setAttribute('role', 'status');
    start.append(startTitle, startValue);
    end.append(endTitle, endValue);
    grid.append(start, end);
    panel.append(heading, name, grid, status);
    root.replaceChildren(panel);

    let receivedSelection = false;
    function showDate(node, value) {
      node.textContent = dateLabel(value);
      if (node.textContent === 'Not set') node.removeAttribute('datetime');
      else node.setAttribute('datetime', value);
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      receivedSelection = true;
      if (!payload.name) {
        name.textContent = '';
        startValue.textContent = '—';
        endValue.textContent = '—';
        startValue.removeAttribute('datetime');
        endValue.removeAttribute('datetime');
        status.textContent = 'Configure a filter in the controller.';
        return;
      }
      name.textContent = payload.name;
      showDate(startValue, payload.startDate);
      showDate(endValue, payload.endDate);
      status.textContent = payload.startDate || payload.endDate ? '' : 'No dates set for this filter.';
    });
    await events.on(GADGET_REFRESH, payload => {
      if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
        return events.emit(FILTER_REQUEST, { dashboardId: id });
      }
    });
    await events.emit(FILTER_REQUEST, { dashboardId: id });
    setTimeout(() => {
      if (!receivedSelection) status.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the dates gadget.';
  }
}

main();
