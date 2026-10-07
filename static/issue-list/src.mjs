import { events, requestJira, router, view } from '@forge/bridge';
import { configuredColumns, formatIssueField, searchIssuePage } from '../issue-data.mjs';
import { issueCountButton } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard } from '../shared.mjs';

const root = document.getElementById('app');
const numberFormat = new Intl.NumberFormat();
const fallbackFields = [
  { id: 'key', name: 'Issue key' },
  { id: 'summary', name: 'Summary' },
  { id: 'status', name: 'Status' },
  { id: 'assignee', name: 'Assignee' },
  { id: 'priority', name: 'Priority' },
  { id: 'issuetype', name: 'Issue type' },
  { id: 'created', name: 'Created' },
  { id: 'updated', name: 'Updated' },
  { id: 'duedate', name: 'Due date' },
  { id: 'resolution', name: 'Resolution' },
];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function edit(context) {
  const columns = configuredColumns(context);
  let fields = fallbackFields;
  let loadWarning = '';
  try {
    const response = await requestJira('/rest/api/3/field', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const available = await response.json();
    if (!Array.isArray(available)) throw new Error();
    const merged = new Map(fallbackFields.map(field => [field.id, field]));
    for (const field of available) {
      if (typeof field?.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.id)) continue;
      if (field.navigable === false && !columns.includes(field.id)) continue;
      merged.set(field.id, { id: field.id, name: field.name || field.id });
    }
    fields = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    loadWarning = 'Could not load the Jira field catalogue. Standard and saved columns are still available.';
  }
  const options = new Map(fields.map(field => [field.id, field]));
  const savedLabels = context?.extension?.gadgetConfiguration?.columnLabels ?? {};
  for (const id of columns) if (!options.has(id)) {
    options.set(id, { id, name: typeof savedLabels[id] === 'string' ? savedLabels[id] : id });
  }

  const form = node('form', 'panel issue-list-edit');
  const heading = node('h2', 'config-heading', 'Issue list columns');
  const help = node('p', 'muted', 'Choose up to 10 columns and arrange their order. The list follows the selected JQL order and loads 50 issues at a time.');
  const rows = node('div', 'column-list');
  const add = node('button', 'button secondary', 'Add column');
  add.type = 'button';
  const warning = node('p', 'muted', loadWarning);
  const error = node('p', 'error');
  error.setAttribute('role', 'alert');
  const save = node('button', 'button primary', 'Save columns');
  save.type = 'submit';
  form.append(heading, help, rows, add, warning, error, save);
  root.replaceChildren(form);

  function addRow(id) {
    if (rows.children.length >= 10) return;
    const row = node('div', 'column-row');
    const select = node('select', 'text-input column-select');
    select.setAttribute('aria-label', 'Issue list column');
    for (const field of options.values()) {
      const option = node('option', '', `${field.name} (${field.id})`);
      option.value = field.id;
      select.append(option);
    }
    select.value = id;
    const up = node('button', 'button secondary', '↑');
    up.type = 'button';
    up.setAttribute('aria-label', 'Move column up');
    up.addEventListener('click', () => {
      if (row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling);
    });
    const down = node('button', 'button secondary', '↓');
    down.type = 'button';
    down.setAttribute('aria-label', 'Move column down');
    down.addEventListener('click', () => {
      if (row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row);
    });
    const remove = node('button', 'button subtle', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    row.append(select, up, down, remove);
    rows.append(row);
  }

  columns.forEach(addRow);
  add.addEventListener('click', () => {
    const selected = new Set([...rows.querySelectorAll('select')].map(select => select.value));
    const first = [...options.keys()].find(id => !selected.has(id));
    if (first) addRow(first);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const next = [...rows.querySelectorAll('select')].map(select => select.value);
    error.textContent = !next.length ? 'Choose at least one column.'
      : new Set(next).size !== next.length ? 'Choose each column only once.' : '';
    if (error.textContent) return;
    save.disabled = true;
    try {
      await view.submit({
        columns: next,
        columnLabels: Object.fromEntries(next.map(id => [id, options.get(id)?.name ?? id])),
      });
    } catch {
      error.textContent = 'Could not save the columns. Please try again.';
      save.disabled = false;
    }
  });
}

async function display(context) {
  const id = dashboardId(context);
  if (!id) throw new Error('Dashboard context is unavailable.');
  const columns = configuredColumns(context);
  const labels = new Map(fallbackFields.map(field => [field.id, field.name]));
  const savedLabels = context?.extension?.gadgetConfiguration?.columnLabels ?? {};
  for (const column of columns) {
    if (typeof savedLabels[column] === 'string') labels.set(column, savedLabels[column]);
  }
  const panel = node('section', 'panel issue-list');
  const heading = node('p', 'eyebrow', 'Matching issues');
  const filterName = node('p', 'chart-filter-name');
  const scroll = node('div', 'dashboard-table-scroll');
  const table = node('table', 'dashboard-table');
  const head = node('thead');
  const header = node('tr');
  for (const column of columns) header.append(node('th', '', labels.get(column) ?? column));
  head.append(header);
  const body = node('tbody');
  table.append(head, body);
  scroll.append(table);
  const more = node('button', 'button secondary issue-list-more', 'Load more');
  more.type = 'button';
  more.hidden = true;
  const message = node('p', 'status', 'Waiting for the controller…');
  message.setAttribute('role', 'status');
  panel.append(heading, filterName, scroll, more, message);
  root.replaceChildren(panel);

  let active = null;
  let generation = 0;
  let nextPageToken;
  let loaded = 0;
  let loading = false;
  const visited = new Set();
  const fields = columns.filter(column => column !== 'key');

  function appendIssues(issues) {
    for (const issue of issues) {
      const row = node('tr');
      for (const column of columns) {
        const value = column === 'key' ? issue.key
          : column === 'assignee' && !issue.fields?.assignee ? 'Unassigned'
            : formatIssueField(issue.fields?.[column]);
        row.append(node('td', '', value || '—'));
      }
      body.append(row);
    }
  }

  async function loadPage() {
    if (loading || !active?.jql) return;
    const current = generation;
    loading = true;
    more.disabled = true;
    message.textContent = 'Loading matching issues…';
    try {
      const page = await searchIssuePage(requestJira, active.jql, fields, nextPageToken, 50);
      if (current !== generation) return;
      appendIssues(page.issues);
      loaded += page.issues.length;
      if (page.isLast === true) nextPageToken = undefined;
      else {
        if (visited.has(page.nextPageToken)) throw new Error('Jira repeated a search page.');
        nextPageToken = page.nextPageToken;
        visited.add(nextPageToken);
      }
      more.hidden = page.isLast === true;
      if (loaded) message.replaceChildren(
        issueCountButton(router, numberFormat.format(loaded), active.jql,
          `Open the full Jira list for this filter; ${loaded} issues loaded here`),
        ` issues loaded here${more.hidden ? '' : ' · more available'} · click count for the full Jira list`,
      );
      else message.textContent = 'No matching issues.';
    } catch (error) {
      if (current !== generation) return;
      message.textContent = error.message || 'Could not load the issue list.';
    } finally {
      if (current === generation) {
        loading = false;
        more.disabled = false;
      }
    }
  }

  function refresh() {
    generation += 1;
    nextPageToken = undefined;
    loaded = 0;
    loading = false;
    visited.clear();
    body.replaceChildren();
    more.hidden = true;
    if (!active?.jql) {
      message.textContent = 'Choose a filter in the Controller.';
      return;
    }
    void loadPage();
  }

  more.addEventListener('click', () => { void loadPage(); });
  await events.on(FILTER_SELECTED, payload => {
    if (!isForDashboard(payload, id)) return;
    active = { name: payload.name, jql: payload.jql };
    filterName.textContent = active.name ?? '';
    refresh();
  });
  await events.on(GADGET_REFRESH, payload => {
    if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
      if (active) refresh();
      else void events.emit(FILTER_REQUEST, { dashboardId: id });
    }
  });
  await events.emit(FILTER_REQUEST, { dashboardId: id });
  setTimeout(() => {
    if (!active) message.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
  }, 4000);
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    if (context.extension?.entryPoint === 'edit') await edit(context);
    else await display(context);
  } catch (error) {
    root.textContent = error.message || 'Could not load the issue list.';
  }
}

main();
