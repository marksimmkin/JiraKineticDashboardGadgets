import { events, requestJira, router, view } from '@forge/bridge';
import { buildBurndown, fetchBurndownIssues, fetchStatusChanges } from '../burndown.mjs';
import { todayInTimezone } from '../progress.mjs';
import { issueCountButton } from '../drilldown.mjs';
import { dashboardId, gadgetId, FILTER_REQUEST, FILTER_SELECTED,
  GADGET_REFRESH, isForDashboard, statusKey } from '../shared.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const root = document.getElementById('app');
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const scoreFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const countFormatter = new Intl.NumberFormat('en-GB');

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svgNode(tag, attributes, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(value) {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function chartFor(data) {
  const { actual, baseline, startDate, endDate } = data;
  const svg = svgNode('svg', {
    class: 'burndown-chart', viewBox: '0 0 760 300', role: 'img',
    'aria-label': `Weighted remaining work from ${formatDate(startDate)} to ${formatDate(endDate)}. ` +
      `Starts at ${scoreFormatter.format(baseline)} and is ${scoreFormatter.format(data.remaining)} at the latest point.`,
  });
  svg.append(svgNode('title', {}, 'Weighted burndown chart'));
  const left = 52;
  const right = 737;
  const top = 18;
  const bottom = 257;
  const startDay = Date.parse(`${startDate}T00:00:00Z`) / 86400000;
  const endDay = Date.parse(`${endDate}T00:00:00Z`) / 86400000;
  const span = Math.max(1, endDay - startDay);
  const maxScore = actual.reduce((maximum, point) => Math.max(maximum, point.remaining), Math.max(1, baseline));
  const x = date => left + (Date.parse(`${date}T00:00:00Z`) / 86400000 - startDay) / span * (right - left);
  const y = score => bottom - score / maxScore * (bottom - top);

  for (const fraction of [0, 0.5, 1]) {
    const value = maxScore * fraction;
    const position = y(value);
    svg.append(svgNode('line', { class: 'burndown-grid', x1: left, y1: position, x2: right, y2: position }));
    svg.append(svgNode('text', { class: 'burndown-tick', x: left - 8, y: position + 4, 'text-anchor': 'end' },
      scoreFormatter.format(value)));
  }
  svg.append(svgNode('text', { class: 'burndown-date', x: left, y: 285, 'text-anchor': 'start' }, formatDate(startDate)));
  svg.append(svgNode('text', { class: 'burndown-date', x: right, y: 285, 'text-anchor': 'end' }, formatDate(endDate)));
  svg.append(svgNode('line', {
    class: 'burndown-ideal', x1: left, y1: y(baseline),
    x2: endDay === startDay ? right : x(endDate), y2: y(0),
  }));

  let path = `M ${x(actual[0].date)} ${y(actual[0].remaining)}`;
  for (const point of actual.slice(1)) path += ` H ${x(point.date)} V ${y(point.remaining)}`;
  svg.append(svgNode('path', { class: 'burndown-actual', d: path }));
  for (const point of actual) {
    const circle = svgNode('circle', {
      class: 'burndown-point', cx: x(point.date), cy: y(point.remaining), r: 3.5,
    });
    circle.append(svgNode('title', {}, `${formatDate(point.date)}: ${scoreFormatter.format(point.remaining)} remaining`));
    svg.append(circle);
  }
  return svg;
}

async function main() {
  try {
    await view.theme.enable();
    const context = await view.getContext();
    const id = dashboardId(context);
    if (!id) throw new Error('Dashboard context is unavailable.');
    const panel = node('section', 'panel burndown');
    const heading = node('p', 'eyebrow', 'Release progress');
    const filterName = node('p', 'burndown-filter-name');
    const title = node('h2', 'burndown-title', 'Weighted burndown');
    const chartArea = node('div', 'burndown-graphic');
    const legend = node('div', 'burndown-legend');
    legend.append(node('span', 'burndown-legend-actual', 'Actual remaining'),
      node('span', 'burndown-legend-ideal', 'Ideal to zero'));
    const summary = node('p', 'burndown-summary');
    const message = node('p', 'status', 'Waiting for the controller…');
    message.setAttribute('role', 'status');
    panel.append(heading, filterName, title, chartArea, legend, summary, message);
    root.replaceChildren(panel);

    let active = null;
    let generation = 0;
    let observedDate = todayInTimezone(context.timezone);
    async function refresh() {
      const current = ++generation;
      chartArea.replaceChildren();
      legend.hidden = true;
      summary.textContent = '';
      if (!active?.jql) {
        message.textContent = 'Choose a filter in the Controller.';
        return;
      }
      if (!active.startDate || !active.endDate) {
        message.textContent = 'Set Start Date and End Date in the Controller.';
        return;
      }
      const today = todayInTimezone(context.timezone);
      if (today < active.startDate) {
        message.textContent = `The period starts on ${formatDate(active.startDate)}.`;
        return;
      }
      message.textContent = 'Loading issues and status history…';
      try {
        const issues = await fetchBurndownIssues(requestJira, active.jql);
        if (current !== generation) return;
        const changes = await fetchStatusChanges(requestJira, issues);
        if (current !== generation) return;
        const result = buildBurndown(issues, changes, active.statuses,
          active.startDate, active.endDate, today, context.timezone);
        if (result.kind === 'unmapped') {
          message.textContent = `In the Controller, use Add missing status to set weights for: ${result.statuses.join(', ')}.`;
        } else if (result.kind === 'empty') {
          message.textContent = 'No matching issues.';
        } else if (result.kind === 'ready') {
          chartArea.replaceChildren(chartFor(result));
          legend.hidden = false;
          summary.replaceChildren(
            `${scoreFormatter.format(result.remaining)} remaining from ${scoreFormatter.format(result.baseline)} at start · `,
            issueCountButton(router, countFormatter.format(result.total), active.jql,
              `Open all ${result.total} matching issues`),
            ' issues in the current JQL scope',
          );
          message.textContent = '';
        } else {
          message.textContent = result.kind === 'invalid'
            ? 'End Date is before Start Date.' : 'Set valid dates in the Controller.';
        }
      } catch (error) {
        if (current !== generation) return;
        message.textContent = error.message || 'Could not load the burndown.';
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
      void refresh();
    });
    await events.on(GADGET_REFRESH, payload => {
      if (payload?.origin === 'dashboard' || payload?.gadgetId === gadgetId(context)) {
        if (active) void refresh();
        else void events.emit(FILTER_REQUEST, { dashboardId: id });
      }
    });
    await events.emit(FILTER_REQUEST, { dashboardId: id });
    setInterval(() => {
      const today = todayInTimezone(context.timezone);
      if (today !== observedDate) {
        observedDate = today;
        if (active) refresh();
      }
    }, 60000);
    setTimeout(() => {
      if (!active) message.textContent = 'Add a Kinetic Dashboard Controller to this dashboard.';
    }, 4000);
  } catch (error) {
    root.textContent = error.message || 'Could not load the burndown.';
  }
}

main();
