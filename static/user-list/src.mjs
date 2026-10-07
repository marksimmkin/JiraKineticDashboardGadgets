import { events, requestJira, router, view } from '@forge/bridge';
import { searchAllIssues, summarizeAssignees } from '../issue-data.mjs';
import { assigneeClause, issueCountButton, narrowJql, statusClause } from '../drilldown.mjs';
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
    const panel = node('section', 'panel user-list');
    const heading = node('p', 'eyebrow', 'Issues by assignee and status');
    const filterName = node('p', 'chart-filter-name');
    const tableArea = node('div', 'dashboard-table-scroll');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    panel.append(heading, filterName, tableArea, message);
    root.replaceChildren(panel);
    let active = null;
    let generation = 0;

    function showTable(result) {
      const table = node('table', 'dashboard-table user-status-table');
      const head = node('thead');
      const header = node('tr');
      header.append(node('th', '', 'Assignee'), node('th', 'number-cell', 'Total'));
      for (const status of result.statuses) header.append(node('th', 'number-cell', status.name));
      head.append(header);
      const body = node('tbody');
      const rows = result.rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      for (const row of rows) {
        const tr = node('tr');
        const name = node('th', '', row.name);
        name.scope = 'row';
        const totalCell = node('td', 'number-cell');
        totalCell.append(issueCountButton(router, numberFormat.format(row.total),
          narrowJql(active.jql, [assigneeClause(row.id)]),
          `Open ${row.total} issues assigned to ${row.name}`));
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
        issueCountButton(router, numberFormat.format(result.total), active.jql,
          `Open all ${result.total} matching issues`),
        ` issues across ${numberFormat.format(rows.length)} assignees, including Unassigned where applicable`,
      );
    }

    async function refresh() {
      const current = ++generation;
      tableArea.replaceChildren();
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      message.textContent = 'Counting issues by assignee…';
      try {
        const issues = await searchAllIssues(requestJira, active.jql, ['assignee', 'status']);
        if (current !== generation) return;
        if (!issues.length) {
          message.textContent = 'No matching issues.';
          return;
        }
        showTable(summarizeAssignees(issues, active.statuses));
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the user list.';
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
    root.textContent = error.message || 'Could not load the user list.';
  }
}

main();
