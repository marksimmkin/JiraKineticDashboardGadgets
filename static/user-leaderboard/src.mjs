import { events, requestJira, router, view } from '@forge/bridge';
import { searchAllIssues, summarizeAssignees } from '../issue-data.mjs';
import { assigneeClause, issueCountButton, narrowJql } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, statusKey } from '../shared.mjs';

const root = document.getElementById('app');
const scoreFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
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
    panel.append(heading, filterName, rows, message);
    root.replaceChildren(panel);
    let active = null;
    let generation = 0;

    function showLeaderboard(result) {
      const ranked = result.rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const maximum = ranked.reduce((highest, row) => Math.max(highest, row.score), 1);
      for (const row of ranked) {
        const item = node('div', 'leaderboard-row');
        const line = node('div', 'leaderboard-line');
        const name = node('span', 'leaderboard-name', row.name);
        const detail = node('span', 'leaderboard-detail');
        detail.append(`${scoreFormat.format(row.score)} remaining · `,
          issueCountButton(router, numberFormat.format(row.total),
            narrowJql(active.jql, [assigneeClause(row.id)]),
            `Open ${row.total} issues assigned to ${row.name}`),
          ' issues');
        const track = node('div', 'leaderboard-track');
        const fill = node('div', 'leaderboard-fill');
        fill.style.width = `${row.score / maximum * 100}%`;
        track.setAttribute('role', 'meter');
        track.setAttribute('aria-label', `${row.name} weighted remaining score`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(maximum));
        track.setAttribute('aria-valuenow', String(row.score));
        track.append(fill);
        line.append(name, detail);
        item.append(line, track);
        rows.append(item);
      }
      message.replaceChildren(
        issueCountButton(router, numberFormat.format(result.total), active.jql,
          `Open all ${result.total} matching issues`),
        ` issues across ${numberFormat.format(ranked.length)} assignees, including Unassigned where applicable`,
      );
    }

    async function refresh() {
      const current = ++generation;
      rows.replaceChildren();
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      message.textContent = 'Calculating weighted scores…';
      try {
        const issues = await searchAllIssues(requestJira, active.jql, ['assignee', 'status']);
        if (current !== generation) return;
        if (!issues.length) {
          message.textContent = 'No matching issues.';
          return;
        }
        const result = summarizeAssignees(issues, active.statuses);
        if (result.unmapped.length) {
          message.textContent = `In the Controller, use Add missing status to set weights for: ${result.unmapped.join(', ')}.`;
          return;
        }
        showLeaderboard(result);
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
