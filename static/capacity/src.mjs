import { events, requestJira, router, view } from '@forge/bridge';
import { searchAllIssues, summarizeAssignees } from '../issue-data.mjs';
import { assigneeClause, issueCountButton, narrowJql, statusesClause } from '../drilldown.mjs';
import { hiddenNote, shownIssues, statusVisibility } from '../status-visibility.mjs';
import { createHiddenNote } from '../status-note.mjs';
import { capacityRows, hoursPerDay, workingDaysLeft } from '../capacity.mjs';
import { showHoursEditForm } from '../hours-edit.mjs';
import { dateOrdinal, todayInTimezone } from '../progress.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, createSelectionTracker, isForDashboard, statusKey } from '../shared.mjs';

const root = document.getElementById('app');
const numberFormat = new Intl.NumberFormat('en-GB');
const daysFormat = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hoursFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Non-breaking spaces keep "3 Nov 2026" on one line.
function formatDate(value) {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`)).replaceAll(' ', '\u00a0');
}

// "15.5 days", "1.0 day"
function days(value) {
  return `${daysFormat.format(value)} ${value === 1 ? 'day' : 'days'}`;
}

function workingDays(count) {
  return `${numberFormat.format(count)} working ${count === 1 ? 'day' : 'days'}`;
}

function issues(count) {
  return count === 1 ? ' issue' : ' issues';
}

function hoursText(hours) {
  return `A day is ${hoursFormat.format(hours)} ${hours === 1 ? 'hour' : 'hours'}.`;
}

// The range line for a phase with dates: 'running', 'not-started' or 'ended'.
function rangeText(payload, left) {
  const span = dateOrdinal(payload.startDate) !== null
    ? `${formatDate(payload.startDate)} – ${formatDate(payload.endDate)}`
    : `Until ${formatDate(payload.endDate)}`;
  if (left.phase === 'ended') return `${span} · Ended · 0 working days left`;
  if (left.phase === 'not-started') {
    return `${span} · Starts ${formatDate(payload.startDate)} · ${workingDays(left.days)}`;
  }
  return `${span} · ${workingDays(left.days)} left`;
}

function edit(context) {
  showHoursEditForm(root, {
    submit: payload => view.submit(payload),
    idPrefix: 'capacity',
    className: 'capacity-edit',
    heading: 'Capacity settings',
    help: 'Turns Remaining Estimate into days. Applies to everyone. Default 8.',
    value: hoursPerDay(context?.extension?.gadgetConfiguration),
  });
}

async function display(context) {
  const id = dashboardId(context);
  if (!id) throw new Error('Dashboard context is unavailable.');
  const hours = hoursPerDay(context?.extension?.gadgetConfiguration);
  const panel = node('section', 'panel capacity');
  const heading = node('p', 'eyebrow', 'Capacity by assignee');
  const filterName = node('p', 'chart-filter-name');
  const range = node('p', 'muted capacity-range');
  range.hidden = true;
  const rowsArea = node('div', 'leaderboard-rows capacity-rows');
  const legend = node('p', 'muted capacity-legend');
  legend.hidden = true;
  const message = node('p', 'status', 'Waiting for the controller…');
  message.setAttribute('role', 'status');
  let active = null;
  let generation = 0;
  let loadedIssues = null;
  let left = null;
  const note = createHiddenNote();
  panel.append(heading, filterName, range, note.element, rowsArea, legend, message);
  root.replaceChildren(panel);

  function clearRows() {
    rowsArea.replaceChildren();
    legend.hidden = true;
    legend.replaceChildren();
  }

  function meter(row, scale) {
    const track = node('div', 'leaderboard-track capacity-track');
    const fill = node('div', `capacity-fill is-${row.state}`);
    const shown = Math.min(row.allocation, scale);
    fill.style.width = `${shown / scale * 100}%`;
    if (row.allocation > scale) track.classList.add('is-capped');
    const marker = node('div', 'capacity-marker');
    marker.setAttribute('aria-hidden', 'true');
    marker.style.left = `${100 / scale * 100}%`;
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-label', `${row.name} capacity`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round(scale * 10) / 10));
    track.setAttribute('aria-valuenow', String(Math.round(shown * 10) / 10));
    const of = `${daysFormat.format(row.workDays)} of ${workingDays(left.days)}, ${row.percent}%`;
    track.setAttribute('aria-valuetext',
      row.state === 'no-estimates'
        ? `No remaining estimates, ${row.withoutEstimate}${issues(row.withoutEstimate)} without estimate`
        : row.state === 'over' ? `${of}, overallocated by ${days(row.overDays)}`
          : row.state === 'under' ? `${of}, underallocated, ${days(row.spareDays)} spare`
            : `${of}, ${days(row.spareDays)} spare`);
    track.append(fill, marker);
    return track;
  }

  function showRows(summary, visibleJql, narrowed) {
    const scope = narrowed ? ' in shown statuses' : '';
    const { rows, scale } = capacityRows(summary, { hoursPerDay: hours, daysLeft: left.days });
    let meters = 0;
    for (const row of rows) {
      const judged = row.state !== 'none';
      const item = node('div', 'leaderboard-row capacity-row');
      const line = node('div', 'leaderboard-line');
      const name = node('span', 'leaderboard-name', row.name);
      const of = `${daysFormat.format(row.workDays)} of ${numberFormat.format(left.days)} ${left.days === 1 ? 'day' : 'days'}`;
      const detail = node('span', 'leaderboard-detail', !judged ? `${days(row.workDays)} of work`
        : row.state === 'no-estimates' ? of : `${of} · ${row.percent}%`);
      line.append(name, detail);
      item.append(line);
      if (judged) {
        item.append(meter(row, scale));
        meters += 1;
      }
      const meta = node('p', 'leaderboard-detail capacity-meta');
      const lozenge = { over: ['is-over', 'Overallocated'], under: ['is-under', 'Underallocated'],
        'no-estimates': ['is-none', 'No estimates'] }[row.state];
      if (lozenge) meta.append(node('span', `issue-status-lozenge capacity-lozenge ${lozenge[0]}`, lozenge[1]), ' ');
      const parts = [];
      if (row.state === 'over') parts.push([node('span', 'capacity-over-days', `${days(row.overDays)} over`)]);
      else if (row.state === 'under' || row.state === 'normal') parts.push([`${days(row.spareDays)} spare`]);
      const who = row.unassigned ? 'unassigned issues' : `issues assigned to ${row.name}`;
      const personJql = narrowJql(visibleJql, [assigneeClause(row.id)]);
      parts.push([issueCountButton(router, numberFormat.format(row.total), personJql,
        `Open ${row.total} ${who}`), issues(row.total)]);
      if (row.withoutEstimate > 0) {
        // Should equal total - estimatedIssues from summarizeAssignees (no Remaining Estimate
        // field value). PO to confirm in DEV that Jira's `remainingEstimate is EMPTY` matches.
        parts.push([issueCountButton(router, numberFormat.format(row.withoutEstimate),
          narrowJql(visibleJql, [assigneeClause(row.id), 'remainingEstimate is EMPTY']),
          `Open ${row.withoutEstimate} ${who} without a remaining estimate`), ' without estimate']);
      }
      // Each part stays on one line; a narrow gadget wraps the meta line at " · ".
      parts.forEach((part, index) => {
        if (index) meta.append(' · ');
        const span = node('span', 'capacity-part');
        span.append(...part);
        meta.append(span);
      });
      item.append(meta);
      rowsArea.append(item);
    }
    legend.textContent = meters ? `The line marks full capacity. ${hoursText(hours)}` : hoursText(hours);
    legend.hidden = false;
    message.replaceChildren(
      issueCountButton(router, numberFormat.format(summary.total), visibleJql,
        `Open ${summary.total} issues${scope}`),
      ` issues${scope} across ${numberFormat.format(rows.length)} assignees, including Unassigned where applicable`,
    );
  }

  function render() {
    clearRows();
    if (!loadedIssues?.length || !active) return;
    // KDG-25: leave out issues in statuses the Controller hides or does not list.
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
    const summary = summarizeAssignees(selectedIssues, active.statuses);
    const narrowed = selectedIssues.length < loadedIssues.length;
    showRows(summary, narrowed ? narrowJql(active.jql, [statusesClause(summary.statuses)]) : active.jql, narrowed);
  }

  function showRange() {
    left = active ? workingDaysLeft({ today: todayInTimezone(context.timezone),
      startDate: active.startDate, endDate: active.endDate }) : null;
    const dated = left && left.phase !== 'no-end' && left.phase !== 'invalid';
    range.hidden = !dated;
    range.textContent = dated ? rangeText(active, left) : '';
  }

  async function refresh() {
    const current = ++generation;
    loadedIssues = null;
    note.show(null);
    clearRows();
    try {
      showRange();
    } catch {
      range.hidden = true;
      message.textContent = 'Could not load capacity.';
      return;
    }
    if (!active?.jql) {
      message.textContent = 'Choose a filter in the Controller.';
      return;
    }
    if (!active.statuses.length) {
      message.textContent = 'Add statuses in the Controller to see capacity.';
      return;
    }
    if (left.phase === 'no-end') {
      message.textContent = 'Set an End Date for this filter in the Controller to see capacity.';
      return;
    }
    if (left.phase === 'invalid') {
      message.textContent = 'End Date is before Start Date.';
      return;
    }
    note.show(hiddenNote(active.visibility));
    message.textContent = 'Adding up remaining estimates…';
    try {
      const found = await searchAllIssues(requestJira, active.jql, ['assignee', 'status', 'timetracking'],
        { isCurrent: () => current === generation });
      if (current !== generation) return;
      if (!found.length) {
        message.textContent = 'No matching issues.';
        return;
      }
      loadedIssues = found;
      note.show(hiddenNote(active.visibility,
        { discovered: summarizeAssignees(found, active.statuses).statuses }));
      render();
    } catch (error) {
      if (current !== generation) return;
      message.textContent = error.message || 'Could not load capacity.';
    }
  }

  const selection = createSelectionTracker({ gadgetId: gadgetId(context), onFallback: () => void refresh() });
  await events.on(FILTER_SELECTED, payload => {
    if (!isForDashboard(payload, id) || !selection.accept(payload)) return;
    active = {
      name: payload.name,
      jql: payload.jql,
      startDate: payload.startDate ?? null,
      endDate: payload.endDate ?? null,
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
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    if (context.extension?.entryPoint === 'edit') await edit(context);
    else await display(context);
  } catch (error) {
    root.textContent = error.message || 'Could not load capacity.';
  }
}

main();
