import { events, requestJira, view } from '@forge/bridge';
import { configuredFilters, configuredStatuses, dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, selectedFilterPayload, STATUS_COLORS, statusKey, validateFilters, validateStatuses } from '../shared.mjs';

const root = document.getElementById('app');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function edit(context) {
  const savedStatuses = configuredStatuses(context);
  let jiraStatuses = [];
  let statusLoadError = '';
  try {
    const response = await requestJira('/rest/api/3/status', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const results = await response.json();
    if (!Array.isArray(results)) throw new Error();
    jiraStatuses = results.filter(status => statusKey(status?.name))
      .map(status => ({ name: String(status.name).trim() }));
  } catch {
    statusLoadError = 'Could not load Jira statuses. Saved statuses and missing names can still be edited.';
  }
  const statusOptions = new Map(jiraStatuses.map(status => [statusKey(status.name), status]));
  const sortedOptions = [...statusOptions.values()].sort((a, b) =>
    a.name.localeCompare(b.name));

  const form = element('form', 'panel');
  const intro = element('p', 'muted', 'Name each filter and enter its JQL. Optional dates are shared with other Kinetic gadgets; they do not change the JQL count.');
  const filtersHeading = element('h2', 'config-heading', 'Filters');
  const rows = element('div', 'filter-list');
  const statusesHeading = element('h2', 'config-heading', 'Statuses');
  const statusHelp = element('p', 'muted', 'Choose Jira statuses or enter a missing status name exactly as a gadget shows it. Statuses with the same name are counted together. Weights are used by the progress, burndown, and leaderboard gadgets. Colours are used by the pie chart.');
  const statusRows = element('div', 'status-list');
  const statusWarning = element('p', 'muted', statusLoadError);
  const error = element('p', 'error');
  error.setAttribute('role', 'alert');
  const add = element('button', 'button secondary', 'Add filter');
  add.type = 'button';
  const addStatus = element('button', 'button secondary', 'Add status');
  addStatus.type = 'button';
  addStatus.disabled = jiraStatuses.length === 0;
  const addMissingStatus = element('button', 'button secondary', 'Add missing status');
  addMissingStatus.type = 'button';
  const statusActions = element('div', 'status-actions');
  statusActions.append(addStatus, addMissingStatus);
  const save = element('button', 'button primary', 'Save filters and statuses');
  save.type = 'submit';
  const actions = element('div', 'actions');
  actions.append(save);
  form.append(intro, filtersHeading, rows, add, statusesHeading, statusHelp,
    statusRows, statusActions, statusWarning, error, actions);
  root.replaceChildren(form);

  function orderButtons(row, container, label) {
    const controls = element('div', 'order-actions');
    const up = element('button', 'button secondary', '↑');
    up.type = 'button';
    up.setAttribute('aria-label', `Move ${label} up`);
    up.addEventListener('click', () => {
      if (row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
    });
    const down = element('button', 'button secondary', '↓');
    down.type = 'button';
    down.setAttribute('aria-label', `Move ${label} down`);
    down.addEventListener('click', () => {
      if (row.nextElementSibling) container.insertBefore(row.nextElementSibling, row);
    });
    controls.append(up, down);
    return controls;
  }

  function addRow(filter = { name: '', jql: '', startDate: null, endDate: null }) {
    const row = element('div', 'filter-row');
    const nameLabel = element('label', 'field-label', 'Filter name');
    const name = element('input', 'text-input filter-name-input');
    name.type = 'text';
    name.required = true;
    name.maxLength = 100;
    name.value = filter.name;
    nameLabel.append(name);
    const jqlLabel = element('label', 'field-label', 'JQL');
    const jql = element('textarea', 'text-input filter-jql-input');
    jql.required = true;
    jql.rows = 2;
    jql.value = filter.jql;
    jqlLabel.append(jql);
    const dates = element('div', 'date-fields');
    const startLabel = element('label', 'field-label', 'Start Date');
    const startDate = element('input', 'text-input filter-start-date-input');
    startDate.type = 'date';
    startDate.value = filter.startDate ?? '';
    startLabel.append(startDate);
    const endLabel = element('label', 'field-label', 'End Date');
    const endDate = element('input', 'text-input filter-end-date-input');
    endDate.type = 'date';
    endDate.value = filter.endDate ?? '';
    endLabel.append(endDate);
    dates.append(startLabel, endLabel);
    const remove = element('button', 'button subtle', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    const actions = element('div', 'row-actions');
    actions.append(orderButtons(row, rows, 'filter'), remove);
    row.append(nameLabel, jqlLabel, dates, actions);
    rows.append(row);
  }

  const filters = configuredFilters(context);
  (filters.length ? filters : [{ name: '', jql: '' }]).forEach(addRow);
  add.addEventListener('click', () => addRow());

  function addStatusRow(status = { name: '', weight: 1 }, manual = false) {
    const row = element('div', 'status-row');
    const statusLabel = element('label', 'field-label', manual ? 'Missing status name' : 'Jira status');
    if (manual) {
      const name = element('input', 'text-input status-name-input');
      name.type = 'text';
      name.required = true;
      name.maxLength = 255;
      name.placeholder = 'Exact name shown by the gadget';
      name.value = status.name;
      statusLabel.append(name);
    } else {
      const select = element('select', 'text-input status-select');
      const placeholder = element('option', '', 'Choose a status');
      placeholder.value = '';
      select.append(placeholder);
      for (const optionStatus of sortedOptions) {
        const option = element('option', '', optionStatus.name);
        option.value = statusKey(optionStatus.name);
        select.append(option);
      }
      select.value = statusKey(status.name);
      select.required = true;
      statusLabel.append(select);
    }
    const weightLabel = element('label', 'field-label', 'Weight (0–1)');
    const weight = element('input', 'text-input status-weight');
    weight.type = 'number';
    weight.min = '0';
    weight.max = '1';
    weight.step = 'any';
    weight.required = true;
    weight.value = Number.isFinite(status.weight) ? String(status.weight) : '';
    weightLabel.append(weight);
    const colorLabel = element('label', 'field-label', 'Pie colour');
    const color = element('input', 'status-color');
    color.type = 'color';
    color.value = status.color ?? STATUS_COLORS[statusRows.children.length % STATUS_COLORS.length];
    colorLabel.append(color);
    const remove = element('button', 'button subtle', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    const actions = element('div', 'row-actions');
    actions.append(orderButtons(row, statusRows, 'status'), remove);
    row.append(statusLabel, weightLabel, colorLabel, actions);
    statusRows.append(row);
  }
  savedStatuses.forEach(status => addStatusRow(status, !statusOptions.has(statusKey(status.name))));
  addStatus.addEventListener('click', () => addStatusRow());
  addMissingStatus.addEventListener('click', () => addStatusRow({ name: '', weight: null }, true));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const next = [...rows.children].map(row => ({
      name: row.querySelector('.filter-name-input').value.trim(),
      jql: row.querySelector('.filter-jql-input').value.trim(),
      startDate: row.querySelector('.filter-start-date-input').value || null,
      endDate: row.querySelector('.filter-end-date-input').value || null,
    }));
    const nextStatuses = [...statusRows.children].map(row => {
      const key = row.querySelector('.status-select')?.value;
      return {
        name: row.querySelector('.status-name-input')?.value.trim() ?? statusOptions.get(key)?.name ?? '',
        weight: Number.parseFloat(row.querySelector('.status-weight').value),
        color: row.querySelector('.status-color').value,
      };
    });
    error.textContent = validateFilters(next) || validateStatuses(nextStatuses);
    if (error.textContent) return;
    save.disabled = true;
    try {
      await view.submit({ filters: next, statuses: nextStatuses });
    } catch {
      error.textContent = 'Could not save the filters. Please try again.';
      save.disabled = false;
    }
  });
}

async function display(context) {
  const id = dashboardId(context);
  const filters = configuredFilters(context);
  const panel = element('section', 'panel controller');
  const choices = element('div', 'controller-filter-buttons');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Active filter');
  const status = element('p', 'status');
  panel.append(choices, status);
  root.replaceChildren(panel);

  if (!id) {
    status.textContent = 'Dashboard context is unavailable.';
    return;
  }
  if (!filters.length) {
    status.textContent = 'Use the gadget menu to configure a filter.';
  } else {
    filters.forEach((filter, index) => {
      const button = element('button', 'button secondary controller-filter-button', filter.name);
      button.type = 'button';
      button.addEventListener('click', () => {
        selectedIndex = index;
        announce().catch(() => { status.textContent = 'Could not update the other gadgets.'; });
      });
      choices.append(button);
    });
  }

  let selectedIndex = 0;
  async function announce() {
    const filter = filters[selectedIndex] ?? null;
    [...choices.children].forEach((button, index) => {
      button.classList.toggle('is-active', index === selectedIndex);
      button.setAttribute('aria-pressed', String(index === selectedIndex));
    });
    await events.emit(FILTER_SELECTED, selectedFilterPayload(context, filter));
  }
  await events.on(FILTER_REQUEST, payload => {
    if (isForDashboard(payload, id)) return announce();
  });
  await events.on(GADGET_REFRESH, payload => {
    if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) return announce();
  });
  await announce();
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    if (context.extension?.entryPoint === 'edit') await edit(context);
    else await display(context);
  } catch {
    root.textContent = 'Could not load the controller. Refresh the dashboard and try again.';
  }
}

main();
