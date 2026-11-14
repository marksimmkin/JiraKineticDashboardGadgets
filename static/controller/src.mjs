import { events, requestJira, view } from '@forge/bridge';
import { requestJiraWithRetry } from '../jira-request.mjs';
import { configuredFilters, configuredStatuses, dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, selectedFilterPayload, STATUS_COLORS, statusKey, validateFilters, validateStatuses } from '../shared.mjs';

const root = document.getElementById('app');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function categoryKey(status) {
  const key = status?.statusCategory?.key;
  return typeof key === 'string' && key ? key.toLowerCase() : null;
}

// 'done' + 'done' stays 'done'; Done with anything else is not Done ('other' when that is known).
function mergeCategory(a, b) {
  if (a === 'done' && b === 'done') return 'done';
  if ((a && a !== 'done') || (b && b !== 'done')) return 'other';
  return null;
}

async function edit(context) {
  const savedStatuses = configuredStatuses(context);
  let jiraStatuses = [];
  let statusLoadError = '';
  try {
    const response = await requestJiraWithRetry(requestJira, '/rest/api/3/status',
      { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const results = await response.json();
    if (!Array.isArray(results)) throw new Error();
    jiraStatuses = results.filter(status => statusKey(status?.name))
      .map(status => ({ name: String(status.name).trim(), category: categoryKey(status) }));
  } catch {
    statusLoadError = 'Could not load Jira statuses. Saved statuses and missing names can still be edited.';
  }
  // Statuses with the same name are counted together. KDG-24: a name is 'done' only when every
  // Jira status with it is Done; it is unknown (null) when that can't be told from the response.
  const statusOptions = new Map();
  for (const status of jiraStatuses) {
    const key = statusKey(status.name);
    const option = statusOptions.get(key);
    if (!option) statusOptions.set(key, { ...status });
    else option.category = mergeCategory(option.category, status.category);
  }
  const sortedOptions = [...statusOptions.values()].sort((a, b) =>
    a.name.localeCompare(b.name));

  const form = element('form', 'panel');
  const intro = element('p', 'muted', 'Name each filter and enter its JQL. Optional dates are shared with other Kinetic gadgets. The period includes the End Date. Dates do not change the JQL count.');
  const filtersHeading = element('h2', 'config-heading', 'Filters');
  const rows = element('div', 'filter-list');
  const statusesHeading = element('h2', 'config-heading', 'Statuses');
  const statusHelp = element('p', 'muted', 'Choose Jira statuses or enter a missing status name exactly as a gadget shows it. Statuses with the same name are counted together. Untick Show to hide a status from the counter, list, charts, and user gadgets for everyone. Done statuses start unticked, and Done statuses not listed here are also hidden. The charts and user gadgets show only statuses listed here. Weights are used by the progress, burndown, and leaderboard gadgets. Colours are used by the pie chart. The progress and burndown gadgets always include every status.');
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
    const statusLabel = element('label', 'field-label');
    const statusLabelText = element('span', 'status-label-text', manual ? 'Missing status name' : 'Jira status');
    statusLabel.append(statusLabelText);
    let control;
    if (manual) {
      control = element('input', 'text-input status-name-input');
      control.type = 'text';
      control.required = true;
      control.maxLength = 255;
      control.placeholder = 'Exact name shown by the gadget';
      control.value = status.name;
    } else {
      control = element('select', 'text-input status-select');
      const placeholder = element('option', '', 'Choose a status');
      placeholder.value = '';
      control.append(placeholder);
      for (const optionStatus of sortedOptions) {
        const option = element('option', '', optionStatus.name);
        option.value = statusKey(optionStatus.name);
        control.append(option);
      }
      control.value = statusKey(status.name);
      control.required = true;
    }
    statusLabel.append(control);
    const currentName = () => manual ? control.value.trim() : statusOptions.get(control.value)?.name ?? '';
    // 'done', another category, or null when unknown (a manual row, or statuses did not load).
    const currentCategory = () => manual ? null : statusOptions.get(control.value)?.category ?? null;

    // KDG-24: the Show box. A saved explicit flag wins; otherwise an unflagged Done-category Jira
    // status starts unticked and every other row ticked. `touched` is set once the user changes
    // it; until then, choosing another status resets it to that status's default (or to the
    // saved flag when the saved status is chosen again).
    const showLabel = element('label', 'status-show');
    const show = element('input', 'status-show-input');
    show.type = 'checkbox';
    showLabel.append(show, 'Show');
    const savedShow = typeof status.show === 'boolean' ? status.show : undefined;
    const savedKey = statusKey(status.name);
    let touched = false;
    show.addEventListener('change', () => { touched = true; });
    show.checked = savedShow ?? currentCategory() !== 'done';
    function updateShowLabel() {
      const name = currentName();
      show.setAttribute('aria-label', name ? `Show ${name} in gadgets` : 'Show this status in gadgets');
    }
    updateShowLabel();
    if (manual) control.addEventListener('input', updateShowLabel);
    else {
      const done = element('span', 'issue-status-lozenge is-done status-done-marker', 'Done');
      done.hidden = currentCategory() !== 'done';
      statusLabelText.append(' ', done);
      control.addEventListener('change', () => {
        done.hidden = currentCategory() !== 'done';
        // Back on the saved status, its saved flag applies again; any other status gets its default.
        if (!touched) show.checked = control.value === savedKey && savedShow !== undefined
          ? savedShow : currentCategory() !== 'done';
        updateShowLabel();
      });
    }
    // What to save: an explicit boolean, or undefined to leave `show` unset.
    row.showValue = () => {
      if (manual) {
        // A box the user changed is always written. Untouched, a mistyped missing name in
        // `status in (...)` would make Jira reject the JQL, so only an unticked box, or a saved
        // `show: true` for the same name, is written.
        if (touched) return show.checked;
        if (!show.checked) return false;
        return savedShow === true && statusKey(currentName()) === savedKey ? true : undefined;
      }
      // Written when the category is known or the user chose; a saved flag is kept while the
      // row still has its saved status.
      const keepSaved = savedShow !== undefined && control.value === savedKey;
      return touched || keepSaved || currentCategory() !== null ? show.checked : undefined;
    };
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
    row.append(statusLabel, weightLabel, colorLabel, showLabel, actions);
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
      const entry = {
        name: row.querySelector('.status-name-input')?.value.trim() ?? statusOptions.get(key)?.name ?? '',
        weight: Number.parseFloat(row.querySelector('.status-weight').value),
        color: row.querySelector('.status-color').value,
      };
      const show = row.showValue();
      if (show !== undefined) entry.show = show;
      return entry;
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
        revisionCount += 1;
        announce().catch(() => { status.textContent = 'Could not update the other gadgets.'; });
      });
      choices.append(button);
    });
  }

  let selectedIndex = 0;
  // Each selection carries `${loadNonce}:${n}` so gadgets can ignore a repeat of one they have
  // already loaded. n goes up on every filter click (even of the active filter) and on every
  // dashboard or Controller refresh; a reply to filter.request repeats the current revision.
  const loadNonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  let revisionCount = 0;
  async function announce() {
    const filter = filters[selectedIndex] ?? null;
    [...choices.children].forEach((button, index) => {
      button.classList.toggle('is-active', index === selectedIndex);
      button.setAttribute('aria-pressed', String(index === selectedIndex));
    });
    await events.emit(FILTER_SELECTED,
      { ...selectedFilterPayload(context, filter), revision: `${loadNonce}:${revisionCount}` });
  }
  await events.on(FILTER_REQUEST, payload => {
    if (isForDashboard(payload, id)) return announce();
  });
  await events.on(GADGET_REFRESH, payload => {
    if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
      revisionCount += 1;
      return announce();
    }
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
