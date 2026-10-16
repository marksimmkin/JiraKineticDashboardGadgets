# Kinetic Jira dashboard gadgets

Ten Forge Custom UI gadgets for **classic Jira Cloud dashboards**:

- **Controller**: configure named JQL filters with optional Start Date and End Date through the gadget's Edit action, then select the active filter in view mode.
- **Simple Counter**: counts issues matching that JQL for the current Jira user. It updates when the selection changes or the dashboard refreshes.
- **Simple Dates**: shows the selected filter's Start Date and End Date. Missing dates are shown as “Not set”.
- **Status Bar Chart**: counts issues for each Jira status name selected in the Controller, including zero-count statuses. Jira statuses that share a name are grouped into one bar.
- **Weighted Progress Bar**: compares calendar time elapsed with weighted work completed for the selected JQL. It requires dates for the upper half and a weight for every matching status for the lower half.
- **Weighted Burndown**: plots daily weighted remaining work against a straight-line ideal from the start-date score to zero on the end date. It reconstructs historical status weights from Jira issue changelogs.
- **Status Pie Chart**: shows the Controller's configured statuses as slices, with counts and percentages for the issues in those statuses.
- **List**: shows matching issues in JQL order, 50 at a time. Configure and reorder up to 10 Jira field columns in this gadget's Edit view; custom fields are available from Jira's field catalogue.
- **User List**: groups matching issues by assignee and current status, including Unassigned issues.
- **User Leaderboard**: ranks assignees by the sum of their issues' remaining status weights. It includes Unassigned and requires weights for all matching statuses.

Add one Controller and any of the other gadgets to the same dashboard. The Controller sends the selected filter's JQL, optional dates, and configured Jira status names through Forge bridge events, scoped to the dashboard ID. Dates are sent as `YYYY-MM-DD` strings or `null` and do not change the JQL. Each status name has a weight from 0 to 1 for the weighted gadgets; the Status Bar and Pie Charts show issue counts and do not apply those weights. The counter uses the JQL and ignores the dates and statuses. The first saved filter is selected after a dashboard reload. Configuration is stored by Jira with the Controller gadget; saved statuses from earlier versions are merged by name, keeping the first weight when duplicates existed.

The Controller's status dropdown shows statuses in active Jira workflows. If a weighted gadget reports a status that is missing from the dropdown, use **Add missing status** and enter the name shown by the gadget with its weight. Saved missing names remain editable if a workflow changes or the Jira status list cannot load. The Weighted Progress Bar and User Leaderboard inspect current issue statuses; the Weighted Burndown also uses historical status names from issue changelogs.

The Weighted Progress Bar uses the issues currently matching the JQL as its work scope, including completed issues. Its work percentage is `1 - sum(status weights) / matching issue count`, so scope changes can change the percentage. Unmapped statuses prevent a work percentage and are listed for configuration; zero matching issues are shown as an empty state.

The Weighted Burndown uses that same current JQL scope and adds an issue's score on its creation day. It plots end-of-day historical scores and the current score for today, through today or the end date, whichever comes first. The ideal line starts at the weighted score on the start date and reaches zero on the end date. Changing the JQL scope or status weights can redraw historical values; this is a reconstructed chart, not a stored sprint snapshot. It requires weights for every status shown in the plotted period.

The Status Pie Chart uses the same configured status names as the Status Bar Chart. Percentages are calculated among issues in the selected visible statuses; the message below the chart reports how many of all JQL issues those statuses cover. The User List offers every status found in the current JQL result, regardless of Controller configuration. The leaderboard uses the Controller weights and withholds rankings when visible matching issues have unmapped statuses.

The User List, User Leaderboard, Status Bar Chart, and Status Pie Chart have a status checkbox dropdown. Unticking a status hides its issues from that gadget's displayed counts or scores; the charts still show the total JQL issue count as context. The selection is remembered separately for each gadget in the viewer's browser. Newly encountered statuses are shown by default. The progress and burndown gadgets continue to use the full JQL scope.

Issue-count numbers throughout the gadgets open Jira's standard issue navigator in a new tab. Status counts add the matching status IDs to the selected Controller JQL, and assignee counts add the relevant Jira account ID (or `assignee is EMPTY`). Weighted scores, percentages, dates, and counts of people are not issue counts and do not open issue lists.

## Setup

The source uses `@forge/bridge` for Jira and `esbuild` for the browser bundles:

1. Run `npm ci`, `npm run build`, and `npm test`.
2. For development changes, run `forge deploy -e development`. After validating a release, run `forge deploy -e production`. Both environments are installed on `kineticgames.atlassian.net` in Jira; use the production gadgets (without the DEV label) for shared dashboards.
3. Add the Controller and the other gadgets to a classic dashboard. Open the Controller's Edit action, add a named JQL filter with optional dates and Jira statuses with weights, and save.

This app is registered in **Kinetic App Developer Space**. Keep the app ID in `manifest.yml`; running `forge register` again would create a different app registration.

For colleagues who are not app contributors, set **Distribution** to **Sharing** in the Atlassian developer console. The production Controller and development Controller keep separate gadget configurations, so configure the production Controller on the shared dashboard.

The counter uses Jira's enhanced JQL search and follows all pages to return an exact count of issues visible to the current user. Very large filters may take longer to count. Jira search results can briefly lag recent issue changes.
