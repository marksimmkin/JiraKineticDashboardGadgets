import { events, requestJira, router, view } from '@forge/bridge';
import { calendarProgress, todayInTimezone, weightedProgress } from '../progress.mjs';
import { countIssuesByStatus } from '../status-counts.mjs';
import { issueCountButton, narrowJql, statusClause } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, statusKey } from '../shared.mjs';

const root = document.getElementById('app');
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const percentFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const scoreFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const countFormatter = new Intl.NumberFormat('en-GB');

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? 'Invalid date' : dateFormatter.format(date);
}

function showProgress(track, fill, percentNode, fraction) {
  const percent = fraction * 100;
  fill.style.width = `${percent}%`;
  track.classList.remove('unavailable');
  track.setAttribute('aria-valuenow', String(Math.round(percent)));
  track.removeAttribute('aria-valuetext');
  percentNode.textContent = `${percentFormatter.format(percent)}%`;
  return percent;
}

function showUnavailable(track, fill, percentNode, reason) {
  fill.style.width = '0%';
  track.classList.add('unavailable');
  track.removeAttribute('aria-valuenow');
  track.setAttribute('aria-valuetext', reason);
  percentNode.textContent = '—';
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');

    const panel = node('section', 'panel weighted-progress');
    const heading = node('p', 'eyebrow', 'Release progress');
    const filterName = node('p', 'progress-filter-name');

    const timeHalf = node('section', 'progress-half');
    const timeHeader = node('div', 'progress-header');
    const timeTitle = node('h2', 'progress-title', 'Time elapsed');
    const timePercent = node('strong', 'progress-percent', '—');
    timeHeader.append(timeTitle, timePercent);
    const timeGraphic = node('div', 'time-graphic');
    const todayLabel = node('span', 'today-label');
    const todayLine = node('span', 'today-line');
    const timeTrack = node('div', 'split-track unavailable');
    const timeFill = node('div', 'split-fill');
    timeTrack.setAttribute('role', 'progressbar');
    timeTrack.setAttribute('aria-label', 'Calendar time elapsed');
    timeTrack.setAttribute('aria-valuemin', '0');
    timeTrack.setAttribute('aria-valuemax', '100');
    timeTrack.append(timeFill);
    timeGraphic.append(todayLabel, todayLine, timeTrack);
    const endpoints = node('div', 'time-endpoints');
    const startLabel = node('span', '', 'Start Date');
    const endLabel = node('span', '', 'End Date');
    endpoints.append(startLabel, endLabel);
    const timeMessage = node('p', 'status');
    timeHalf.append(timeHeader, endpoints, timeGraphic);

    const workHalf = node('section', 'progress-half');
    const workHeader = node('div', 'progress-header progress-work-header');
    const workTitle = node('h2', 'progress-title', 'Weighted work completed');
    const workPercent = node('strong', 'progress-percent', '—');
    workHeader.append(workTitle, workPercent);
    const workTrack = node('div', 'split-track unavailable');
    const workFill = node('div', 'split-fill');
    workTrack.setAttribute('role', 'progressbar');
    workTrack.setAttribute('aria-label', 'Weighted work completed');
    workTrack.setAttribute('aria-valuemin', '0');
    workTrack.setAttribute('aria-valuemax', '100');
    workTrack.append(workFill);
    const workMessage = node('p', 'status', 'Waiting for the controller…');
    workMessage.setAttribute('role', 'status');
    workHalf.append(workTrack, workHeader);
    panel.append(heading, filterName, timeHalf, workHalf, timeMessage, workMessage);
    root.replaceChildren(panel);

    let active = null;
    let generation = 0;

    function updateTime() {
      const today = todayInTimezone(context.timezone);
      const state = calendarProgress(active?.startDate, active?.endDate, today);
      if (state.kind !== 'ready') {
        todayLabel.hidden = true;
        todayLine.hidden = true;
        startLabel.textContent = active?.startDate ? formatDate(active.startDate) : 'Start Date';
        endLabel.textContent = active?.endDate ? formatDate(active.endDate) : 'End Date';
        const reason = state.kind === 'invalid' ? 'End Date is before Start Date.' : 'Set Start Date and End Date in the Controller.';
        showUnavailable(timeTrack, timeFill, timePercent, reason);
        timeMessage.textContent = reason;
        return;
      }
      const percent = showProgress(timeTrack, timeFill, timePercent, state.fraction);
      startLabel.textContent = formatDate(active.startDate);
      endLabel.textContent = formatDate(active.endDate);
      todayLabel.textContent = `Today · ${formatDate(today)}`;
      todayLabel.style.left = `clamp(52px, ${percent}%, calc(100% - 52px))`;
      todayLine.style.left = `${percent}%`;
      todayLabel.hidden = false;
      todayLine.hidden = false;
      timeMessage.textContent = '';
    }

    async function refreshWork() {
      const current = ++generation;
      if (!active?.jql) {
        showUnavailable(workTrack, workFill, workPercent, 'Choose a filter in the Controller.');
        workMessage.textContent = 'Choose a filter in the Controller.';
        return;
      }
      showUnavailable(workTrack, workFill, workPercent, 'Counting matching issues.');
      workMessage.textContent = 'Counting matching issues…';
      try {
        const result = await countIssuesByStatus(requestJira, active.jql, active.statuses);
        if (current !== generation) return;
        const progress = weightedProgress(result, active.statuses);
        if (progress.kind === 'empty') {
          showUnavailable(workTrack, workFill, workPercent, 'No matching issues.');
          workMessage.textContent = 'No matching issues.';
        } else if (progress.kind === 'unmapped') {
          showUnavailable(workTrack, workFill, workPercent, 'Status weights are missing.');
          const parts = ['Set weights in the Controller for: '];
          for (const [index, status] of progress.statuses
            .sort((a, b) => a.name.localeCompare(b.name)).entries()) {
            if (index) parts.push(', ');
            parts.push(`${status.name} (`, issueCountButton(router,
              countFormatter.format(status.count),
              narrowJql(active.jql, [statusClause(status.name,
                result.statusIds[statusKey(status.name)] ?? [])]),
              `Open ${status.count} ${status.name} issues`), ')');
          }
          parts.push('.');
          workMessage.replaceChildren(...parts);
        } else {
          showProgress(workTrack, workFill, workPercent, progress.fraction);
          workMessage.replaceChildren(
            `Remaining score ${scoreFormatter.format(progress.remaining)} across `,
            issueCountButton(router, countFormatter.format(progress.total), active.jql,
              `Open all ${progress.total} matching issues`),
            ' issues',
          );
        }
      } catch (error) {
        if (current !== generation) return;
        showUnavailable(workTrack, workFill, workPercent, 'Could not load work progress.');
        workMessage.textContent = error.message || 'Could not load work progress.';
      }
    }

    await events.on(FILTER_SELECTED, payload => {
      if (!isForDashboard(payload, id)) return;
      active = {
        name: payload.name,
        jql: payload.jql,
        startDate: payload.startDate,
        endDate: payload.endDate,
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.filter(status => statusKey(status?.name) &&
            Number.isFinite(status?.weight) && status.weight >= 0 && status.weight <= 1)
          : [],
      };
      filterName.textContent = active.name ?? '';
      updateTime();
      return refreshWork();
    });
    await events.on(GADGET_REFRESH, payload => {
      if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
        if (active) {
          updateTime();
          return refreshWork();
        }
        return events.emit(FILTER_REQUEST, { dashboardId: id });
      }
    });
    updateTime();
    await events.emit(FILTER_REQUEST, { dashboardId: id });
    setInterval(() => { if (active) updateTime(); }, 60000);
    setTimeout(() => {
      if (!active) workMessage.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the progress bar.';
  }
}

main();
