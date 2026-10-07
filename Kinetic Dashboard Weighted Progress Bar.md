# Kinetic Dashboard Weighted Progress Bar

A Jira dashboard gadget with one graphical progress bar split into two stacked halves. Both halves use the filter selected in the [[Kinetic Dashboard Controller]].

Keep the two tracks directly adjacent for comparison. Place the time label, percentage, dates, and today's marker above the top track; place the work label, percentage, and remaining score below the bottom track.

## Time progress (top half)

- Use the selected filter's Start Date and End Date.
- Fill elapsed calendar time in green and remaining time in red. Start Date is 0% and End Date is 100%; clamp dates outside the range.
- Show Start Date at the left end, End Date at the right end, and today's date above the point where green meets red.
- Use the viewer's Jira timezone to determine today's date. If either date is missing, ask for dates in the Controller while allowing the work half to operate.

## Weighted work progress (bottom half)

- Include every issue currently matching the selected JQL, including completed issues.
- Each Controller status has a remaining-work weight from 1.0 (not started) to 0.0 (complete). Status names are matched without regard to case, so Jira statuses with the same name share a weight.
- Remaining score = the sum of all matching issues' status weights. Completed fraction = `1 - remaining score / matching issue count`. Show the completed fraction in green and the remaining fraction in red, with a percentage and remaining score.
- If any issue's status has no configured weight, list the unmapped statuses and withhold the work percentage until they are configured.
- If no issues match, show "No matching issues" instead of 100%.

The current JQL result defines the scope. Adding or removing tickets can move the work percentage backward or forward; no sprint or start-date snapshot is captured. A filter must continue to include completed tickets for the percentage to reflect completed work.
