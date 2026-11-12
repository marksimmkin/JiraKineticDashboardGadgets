import { events, requestJira, router, view } from '@forge/bridge';
import { searchAllIssues, summarizeAssignees } from '../issue-data.mjs';
import { assigneeClause, issueCountButton, narrowJql, statusClause, statusesClause } from '../drilldown.mjs';
import { hiddenNote, shownIssues, statusVisibility } from '../status-visibility.mjs';
import { createHiddenNote } from '../status-note.mjs';
import { createUserMetricSelect, formatMetric, metricLabel, metricValue } from '../user-metrics.mjs';
import { sortedUserRows } from '../user-list-sort.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, createSelectionTracker, isForDashboard, statusKey } from '../shared.mjs';

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
    const panel = node('section', 'panel user-list');
    const heading = node('p', 'eyebrow', 'Issues by assignee and status');
    const filterName = node('p', 'chart-filter-name');
    const tableArea = node('div', 'dashboard-table-scroll');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    let active = null;
    let generation = 0;
    let loadedIssues = null;
    let sort = { column: 'total', direction: 'descending' };
    const note = createHiddenNote();
    const metricSelect = createUserMetricSelect(id, gadgetId(context), render);
    panel.append(heading, filterName, note.element, metricSelect.element, tableArea, message);
    root.replaceChildren(panel);

    function showTable(result, visibleJql, narrowed) {
      const scope = narrowed ? ' in shown statuses' : '';
      const metric = metricSelect.selected();
      const table = node('table', 'dashboard-table user-status-table');
      const head = node('thead');
      const header = node('tr');
      if (sort.column.startsWith('status:') &&
        !result.statuses.some(status => `status:${status.key}` === sort.column)) {
        sort = { column: 'total', direction: 'descending' };
      }
      function heading(column, label, className = '') {
        const cell = node('th', className);
        cell.scope = 'col';
        cell.setAttribute('aria-sort', sort.column === column ? sort.direction : 'none');
        const button = node('button', 'table-sort-button',
          `${label}${sort.column === column ? sort.direction === 'ascending' ? ' ↑' : ' ↓' : ''}`);
        button.type = 'button';
        button.title = `Sort ${label} ${sort.column === column && sort.direction === 'ascending' ? 'descending' : 'ascending'}`;
        button.addEventListener('click', () => {
          sort = { column, direction: sort.column === column && sort.direction === 'ascending'
            ? 'descending' : 'ascending' };
          render();
        });
        cell.append(button);
        return cell;
      }
      header.append(heading('assignee', 'Assignee'), heading('total', metricLabel(metric), 'number-cell'));
      for (const status of result.statuses) header.append(heading(`status:${status.key}`, status.name, 'number-cell'));
      head.append(header);
      const body = node('tbody');
      const rows = sortedUserRows(result.rows, sort, metric);
      for (const row of rows) {
        const tr = node('tr');
        const name = node('th', '', row.name);
        name.scope = 'row';
        const totalCell = node('td', 'number-cell');
        if (metric === 'tickets') totalCell.append(issueCountButton(router, formatMetric(row.total, metric),
          narrowJql(visibleJql, [assigneeClause(row.id)]),
          `Open ${row.total} issues assigned to ${row.name}`));
        else totalCell.textContent = formatMetric(metricValue(row, metric), metric);
        if (metric === 'time' && row.estimatedIssues < row.total) {
          totalCell.title = `Remaining estimate set on ${row.estimatedIssues} of ${row.total} issues`;
        }
        tr.append(name, totalCell);
        for (const status of result.statuses) {
          const count = row.counts[status.key] ?? 0;
          const cell = node('td', 'number-cell');
          cell.append(issueCountButton(router, numberFormat.format(count),
            narrowJql(active.jql, [assigneeClause(row.id), statusClause(status.name, status.ids)]),
            `Open ${count} ${status.name} issues assigned to ${row.name}`));
          tr.append(cell);
        }
        body.append(tr);
      }
      table.append(head, body);
      tableArea.replaceChildren(table);
      message.replaceChildren(
        issueCountButton(router, numberFormat.format(result.total), visibleJql,
          `Open ${result.total} issues${scope}`),
        ` issues${scope} across ${numberFormat.format(rows.length)} assignees, including Unassigned where applicable`,
      );
    }

    function render() {
      tableArea.replaceChildren();
      if (!loadedIssues?.length || !active) return;
      // KDG-24/KDG-25: leave out issues in statuses the Controller hides or does not list.
      const selectedIssues = shownIssues(loadedIssues, active.visibility);
      if (!selectedIssues.length) {
        message.replaceChildren(
          'No issues are in shown statuses (',
          issueCountButton(router, numberFormat.format(loadedIssues.length), active.jql,
            `Open all ${loadedIssues.length} matching issues`),
          ' matching issues).',
        );
        return;
      }
      const result = summarizeAssignees(selectedIssues, active.statuses);
      const narrowed = selectedIssues.length < loadedIssues.length;
      showTable(result, narrowed ? narrowJql(active.jql, [statusesClause(result.statuses)]) : active.jql, narrowed);
    }

    async function refresh() {
      const current = ++generation;
      loadedIssues = null;
      note.show(null);
      tableArea.replaceChildren();
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      if (!active.statuses.length) {
        message.textContent = 'Add statuses in the Controller to see the user list.';
        return;
      }
      note.show(hiddenNote(active.visibility));
      message.textContent = 'Counting issues by assignee…';
      try {
        const issues = await searchAllIssues(requestJira, active.jql, ['assignee', 'status', 'timetracking'],
          { isCurrent: () => current === generation });
        if (current !== generation) return;
        if (!issues.length) {
          message.textContent = 'No matching issues.';
          return;
        }
        loadedIssues = issues;
        note.show(hiddenNote(active.visibility,
          { discovered: summarizeAssignees(issues, active.statuses).statuses }));
        render();
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the user list.';
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
        visibility: statusVisibility(payload, { listedOnly: true }),
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
    root.textContent = error.message || 'Could not load the user list.';
  }
}

main();
