// KDG-23: Time Logging gadget. Each person's average time logged per working day (Mon-Fri) on
// the Controller JQL's issues, from the Start Date to today, or to the End Date once passed.
import { events, requestJira, router, view } from '@forge/bridge';
import { fetchTimeLogging, formatTimeSpent, loggingPeriod, summarizeTimeLogged } from '../time-logging.mjs';
import { issueCountButton, narrowJql, splitOrderBy, worklogAuthorClause } from '../drilldown.mjs';
import { approximateCount } from '../count.mjs';
import { createBurndownLoader } from '../burndown-state.mjs';
import { dateOrdinal, todayInTimezone } from '../progress.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, createSelectionTracker, isForDashboard } from '../shared.mjs';

const root = document.getElementById('app');
const NBSP = ' ';
const ERROR_TEXT = 'Could not load time logged.';
const LOADER_COPY = Object.freeze({
  history: 'worklogs', loading: 'Loading time logged.', loaded: 'Time logged loaded.', error: ERROR_TEXT,
});
const numberFormat = new Intl.NumberFormat('en-GB');
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
  return dateFormatter.format(new Date(`${value}T00:00:00Z`)).replaceAll(' ', NBSP);
}

function workingDays(count) {
  return `${numberFormat.format(count)} working ${count === 1 ? 'day' : 'days'}`;
}

// "6h 30m a day"; time logged that averages under 30 seconds reads "under 1m a day", not "0m".
function perDay(averageSeconds, loggedSeconds) {
  const text = loggedSeconds > 0 && Math.round(averageSeconds / 60) === 0
    ? `under${NBSP}1m` : formatTimeSpent(averageSeconds);
  return `${text}${NBSP}a${NBSP}day`;
}

// The range line parts, joined by " · ". Null when the range is hidden.
function rangeParts(period, endDate) {
  if (!['not-started', 'ready', 'no-working-days'].includes(period.kind)) return null;
  const start = formatDate(period.startDate);
  // An unreadable End Date counts as none, as in loggingPeriod.
  const end = dateOrdinal(endDate) !== null ? endDate : null;
  if (period.kind === 'not-started') {
    return [end ? `${start} – ${formatDate(end)}` : `From ${start}`];
  }
  // A weekend-only period that has not ended has no working day to come: show the whole period.
  if (period.kind === 'no-working-days' && !period.ended && !period.firstWorkingDay && end) {
    return [`${start} – ${formatDate(end)}`, workingDays(0)];
  }
  if (period.ended) {
    return [`${start} – ${formatDate(period.lastDay)}`, 'Ended', workingDays(period.workingDays)];
  }
  return [`${start} – today`, `${workingDays(period.workingDays)} so far`];
}

// Each part stays on one line; a narrow gadget wraps only at " · ".
function joinParts(element, parts) {
  element.replaceChildren();
  parts.forEach((part, index) => {
    if (index) element.append(' · ');
    const span = node('span', 'capacity-part');
    span.append(...(Array.isArray(part) ? part : [part]));
    element.append(span);
  });
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');
    const panel = node('section', 'panel time-logging');
    const heading = node('p', 'eyebrow', 'Time logged per person');
    const filterName = node('p', 'chart-filter-name');
    const range = node('p', 'muted capacity-range');
    range.hidden = true;
    const rowsArea = node('div', 'leaderboard-rows time-logging-rows');
    const legend = node('p', 'muted capacity-legend', "Weekend work isn't counted.");
    legend.hidden = true;
    const footer = node('div', 'time-logging-footer');
    footer.hidden = true;
    const average = node('p', 'status time-logging-average');
    const total = node('p', 'status time-logging-total');
    footer.append(average, total);
    const message = node('p', 'status time-logging-message', 'Waiting for the controller…');
    const live = node('p', 'visually-hidden');
    live.setAttribute('role', 'status');
    panel.append(heading, filterName, range, rowsArea, legend, footer, message, live);
    root.replaceChildren(panel);

    // As the Burndown: screen readers may not re-read identical text, so a repeat is cleared
    // first and written on the next tick. A newer write cancels a pending repeat.
    let liveTimer = null;
    function writeLive(text) {
      if (liveTimer !== null) clearTimeout(liveTimer);
      liveTimer = null;
      if (live.textContent !== text) {
        live.textContent = text;
        return;
      }
      live.textContent = '';
      liveTimer = setTimeout(() => {
        liveTimer = null;
        live.textContent = text;
      }, 100);
    }
    const loader = createBurndownLoader({
      setText: text => { message.textContent = text; },
      announce: writeLive,
      cancelAnnounce: () => {
        if (liveTimer !== null) clearTimeout(liveTimer);
        liveTimer = null;
      },
      format: numberFormat,
      copy: LOADER_COPY,
    });

    let active = null;
    let generation = 0;
    let observedDate = todayInTimezone(context.timezone);

    function clearResults() {
      rowsArea.replaceChildren();
      legend.hidden = true;
      footer.hidden = true;
      average.replaceChildren();
      total.replaceChildren();
    }

    function showRange(period) {
      const parts = period ? rangeParts(period, active.endDate) : null;
      range.hidden = !parts;
      if (parts) joinParts(range, parts);
      else range.replaceChildren();
    }

    function meter(person, maxSeconds, period) {
      const track = node('div', 'leaderboard-track time-logging-track');
      const fill = node('div', 'leaderboard-fill time-logging-fill');
      // Scaled to the highest unrounded average; all 0 leaves every fill empty.
      fill.style.width = `${maxSeconds > 0 ? person.averageSeconds / maxSeconds * 100 : 0}%`;
      track.setAttribute('role', 'meter');
      track.setAttribute('aria-label', `${person.displayName} average time logged a day`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(Math.max(1, Math.round(maxSeconds / 60))));
      track.setAttribute('aria-valuenow', String(Math.round(person.averageSeconds / 60)));
      track.setAttribute('aria-valuetext', `${perDay(person.averageSeconds, person.loggedSeconds)}, ` +
        `${formatTimeSpent(person.loggedSeconds)} logged over ${workingDays(period.workingDays)}`);
      track.append(fill);
      return track;
    }

    function showRows(summary, period) {
      const { jql } = active;
      const maxSeconds = summary.people.reduce((max, person) => Math.max(max, person.averageSeconds), 0);
      for (const person of summary.people) {
        const item = node('div', 'leaderboard-row time-logging-row');
        const line = node('div', 'leaderboard-line');
        line.append(node('span', 'leaderboard-name', person.displayName),
          node('span', 'leaderboard-detail', perDay(person.averageSeconds, person.loggedSeconds)));
        const meta = node('p', 'leaderboard-detail capacity-meta');
        const parts = [`${formatTimeSpent(person.loggedSeconds)} logged`];
        if (person.issueCount > 0) {
          // The count is issues with any worklog by the person in the period, weekends included,
          // to match this JQL. PO to confirm in DEV that Jira's worklogDate uses the viewer's
          // time zone at day edges, as the gadget does.
          const personJql = narrowJql(jql, [worklogAuthorClause(person.accountId),
            `worklogDate >= "${period.startDate}"`, `worklogDate <= "${period.lastDay}"`]);
          const noun = person.issueCount === 1 ? 'issue' : 'issues';
          parts.push([issueCountButton(router, numberFormat.format(person.issueCount), personJql,
            `Open ${person.issueCount} ${noun} ${person.displayName} logged work on from ` +
            `${formatDate(period.startDate)} to ${formatDate(period.lastDay)}, including weekends`),
          ` ${noun}`]);
        }
        joinParts(meta, parts);
        item.append(line, meter(person, maxSeconds, period), meta);
        rowsArea.append(item);
      }
      legend.hidden = false;
      const count = summary.people.length;
      if (summary.totalSeconds > 0) {
        // Team average: everyone's time over (people x working days), 0m people included.
        const teamAverage = summary.totalSeconds / (count * period.workingDays);
        average.textContent = `Average across ${numberFormat.format(count)} ${count === 1 ? 'person' : 'people'}: ` +
          perDay(teamAverage, summary.totalSeconds);
      } else {
        average.textContent = period.ended
          ? 'No work logged on working days in this period.' : 'No work logged on working days so far.';
      }
      total.append(issueCountButton(router, numberFormat.format(summary.totalIssues), jql,
        `Open all ${summary.totalIssues} matching issues`), ' issues in the current JQL scope');
      footer.hidden = false;
    }

    async function refresh() {
      const current = ++generation;
      clearResults();
      if (!active?.jql) {
        showRange(null);
        loader.message('Choose a filter in the Controller.');
        return;
      }
      let period;
      try {
        period = loggingPeriod({ today: todayInTimezone(context.timezone),
          startDate: active.startDate, endDate: active.endDate });
        showRange(period);
      } catch {
        showRange(null);
        loader.message(ERROR_TEXT);
        return;
      }
      if (period.kind === 'no-start') {
        loader.message('Set a Start Date for this filter in the Controller to see time logged.');
        return;
      }
      if (period.kind === 'invalid') {
        loader.message('End Date is before Start Date.');
        return;
      }
      if (period.kind === 'not-started') {
        loader.message(`The period starts on ${formatDate(period.startDate)}.`);
        return;
      }
      if (period.kind === 'no-working-days') {
        loader.message(!period.ended && period.firstWorkingDay
          ? `No working days so far. Averages start on ${formatDate(period.firstWorkingDay)}.`
          : 'This period has no working days.');
        return;
      }
      const { jql } = active;
      const run = loader.start();
      // An ORDER BY-only JQL has no filter to estimate, so skip the request (as the Burndown does).
      if (splitOrderBy(jql).filter) {
        approximateCount(requestJira, jql).then(run.approximate, error => console.warn(error));
      }
      try {
        const isCurrent = () => current === generation;
        const { issues, worklogsByIssue } = await fetchTimeLogging(requestJira, jql, period, {
          onPage: run.page, onSearchDone: run.searchDone, onProgress: run.history, isCurrent,
        });
        if (current !== generation) return;
        const summary = summarizeTimeLogged(issues, worklogsByIssue, period, context.timezone);
        if (!summary.totalIssues) {
          run.message('No matching issues.');
        } else if (!summary.people.length) {
          const n = summary.totalIssues;
          const noun = n === 1 ? 'issue' : 'issues';
          run.message(`No one is assigned to or has logged work on the ${numberFormat.format(n)} matching ${noun}.`);
          message.replaceChildren('No one is assigned to or has logged work on the ',
            issueCountButton(router, numberFormat.format(n), jql,
              n === 1 ? 'Open the 1 matching issue' : `Open all ${n} matching issues`),
            ` matching ${noun}.`);
        } else {
          showRows(summary, period);
          run.ready();
        }
      } catch (error) {
        if (current !== generation) return;
        run.fail(error);
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
    // As the Burndown: "today" moves at midnight in the Jira time zone, so check once a minute.
    setInterval(() => {
      const today = todayInTimezone(context.timezone);
      if (today !== observedDate) {
        observedDate = today;
        if (active) void refresh();
      }
    }, 60000);
    setTimeout(() => {
      if (!active) loader.message('Add a Kinetic Dashboard Controller to this dashboard.');
    }, 4000);
  } catch (error) {
    root.textContent = error.message || ERROR_TEXT;
  }
}

main();
