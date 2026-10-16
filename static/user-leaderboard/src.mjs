import { events, requestJira, router, view } from '@forge/bridge';
import { searchAllIssues, summarizeAssignees } from '../issue-data.mjs';
import { assigneeClause, issueCountButton, narrowJql } from '../drilldown.mjs';
import { createStatusFilter, matchingStatusIssues, visibleIssueJql } from '../status-filter.mjs';
import { createUserMetricSelect, formatMetric, metricLabel, metricValue } from '../user-metrics.mjs';
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
    const panel = node('section', 'panel user-leaderboard');
    const heading = node('p', 'eyebrow', 'Weighted work by assignee');
    const filterName = node('p', 'chart-filter-name');
    const rows = node('div', 'leaderboard-rows');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    let active = null;
    let generation = 0;
    let loadedIssues = null;
    let allStatuses = [];
    const statusFilter = createStatusFilter(id, gadgetId(context), render);
    const metricSelect = createUserMetricSelect(id, gadgetId(context), render, 'score');
    panel.append(heading, filterName, statusFilter.element, metricSelect.element, rows, message);
    root.replaceChildren(panel);

    function showLeaderboard(result, visibleJql) {
      const metric = metricSelect.selected();
      const ranked = result.rows.sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || a.name.localeCompare(b.name));
      const maximum = ranked.reduce((highest, row) => Math.max(highest, metricValue(row, metric)), 1);
      for (const row of ranked) {
        const item = node('div', 'leaderboard-row');
        const line = node('div', 'leaderboard-line');
        const name = node('span', 'leaderboard-name', row.name);
        const detail = node('span', 'leaderboard-detail');
        if (metric === 'tickets') detail.append(issueCountButton(router, formatMetric(row.total, metric),
          narrowJql(visibleJql, [assigneeClause(row.id)]),
          `Open ${row.total} issues assigned to ${row.name}`), ' tickets');
        else {
          detail.append(`${formatMetric(metricValue(row, metric), metric)} ${metric === 'time' ? 'remaining' : 'weighted score'} · `,
            issueCountButton(router, numberFormat.format(row.total),
              narrowJql(visibleJql, [assigneeClause(row.id)]),
              `Open ${row.total} issues assigned to ${row.name}`),
            ' tickets');
        }
        if (metric === 'time' && row.estimatedIssues < row.total) {
          detail.title = `Remaining estimate set on ${row.estimatedIssues} of ${row.total} issues`;
        }
        const track = node('div', 'leaderboard-track');
        const fill = node('div', 'leaderboard-fill');
        fill.style.width = `${metricValue(row, metric) / maximum * 100}%`;
        track.setAttribute('role', 'meter');
        track.setAttribute('aria-label', `${row.name} ${metricLabel(metric)}`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(maximum));
        track.setAttribute('aria-valuenow', String(metricValue(row, metric)));
        track.append(fill);
        line.append(name, detail);
        item.append(line, track);
        rows.append(item);
      }
      message.replaceChildren(
        issueCountButton(router, numberFormat.format(result.total), visibleJql,
          `Open ${result.total} issues in selected statuses`),
        ` issues in selected statuses across ${numberFormat.format(ranked.length)} assignees, including Unassigned where applicable`,
      );
    }

    function render() {
      rows.replaceChildren();
      if (!loadedIssues?.length || !active) return;
      const visible = statusFilter.visibleStatuses();
      if (!visible.length) {
        message.textContent = 'Select at least one status.';
        return;
      }
      const selectedIssues = matchingStatusIssues(loadedIssues, visible);
      if (!selectedIssues.length) {
        message.textContent = 'No issues are in the selected statuses.';
        return;
      }
      const result = summarizeAssignees(selectedIssues, active.statuses);
      if (metricSelect.selected() === 'score' && result.unmapped.length) {
        message.textContent = `In the Controller, use Add missing status to set weights for: ${result.unmapped.join(', ')}.`;
        return;
      }
      showLeaderboard(result, visibleIssueJql(active.jql, allStatuses, visible));
    }

    async function refresh() {
      const current = ++generation;
      loadedIssues = null;
      allStatuses = [];
      statusFilter.setStatuses([]);
      rows.replaceChildren();
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      message.textContent = 'Calculating totals…';
      try {
        const issues = await searchAllIssues(requestJira, active.jql, ['assignee', 'status', 'timetracking']);
        if (current !== generation) return;
        if (!issues.length) {
          message.textContent = 'No matching issues.';
          return;
        }
        loadedIssues = issues;
        allStatuses = summarizeAssignees(issues, active.statuses).statuses;
        statusFilter.setStatuses(allStatuses);
        render();
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the leaderboard.';
      }
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      active = {
        name: payload.name,
        jql: payload.jql,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.filter(status => statusKey(status?.name) &&
            Number.isFinite(status?.weight) && status.weight >= 0 && status.weight <= 1)
          : [],
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
    root.textContent = error.message || 'Could not load the leaderboard.';
  }
}

main();
