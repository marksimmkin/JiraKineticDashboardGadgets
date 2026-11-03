This is a variant of the classic burn down chart that uses the start and end dates from the [[Kinetic Dashboard Controller]] and the weighting and scoring system developed for the [[Kinetic Dashboard Weighted Progress Bar]].

## Chart behaviour

- Use the selected Controller JQL as the current issue scope, including completed issues. This is the same scope choice as the Weighted Progress Bar, not a frozen sprint snapshot.
- Start with the remaining-work score at the beginning of Start Date, then plot each calendar day's end-of-day score at that day's end on the horizontal axis, so End Date's score sits on the right edge, with today's point showing the current score. Status changes and newly created issues on Start Date must appear in the actual line. Stop at today or End Date, whichever comes first. Use the viewer's Jira timezone for day boundaries.
- Reconstruct each issue's historical status from Jira's status changelog. An issue contributes from its creation day; adding issues after the start date can raise the actual line.
- Show a solid actual line and a dashed ideal line from the weighted score at the beginning of Start Date to zero at the end of End Date. The horizontal axis runs from the start of Start Date to the end of End Date. Show dates on the horizontal axis and weighted remaining score on the vertical axis.
- Require a configured weight for every status used in the plotted period. If one is missing, list the statuses instead of drawing a misleading chart. Show clear states for missing dates, a future period, and no matching issues.
- While loading, the gadget shows how many issues and status histories have loaded.

This reconstruction uses issues matching the JQL *now*. Issues removed from that scope cannot be shown retroactively, and editing the JQL or status weights can change past chart values. Keep completed issues in the JQL for the chart to reflect finished work.
