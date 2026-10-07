A Jira dashboard widget that allows the user to edit the following information that will be used to determine which issues are evaluated by the other Kinetic Dashboard Gadgets:

- A configure button when in Edit Mode with:
	- A list of 'Filters', each fliter having:
		- Name
		- JQL
		- Start Date (optional)
		- End Date (optional)
		- Start Date
		- End Date
	- A list of 'Statuses' with each status having a:
		- Weight = Value between 0.0 - 1.0
- When in View Mode:
	- A dropdown showing the list of filter names were the user can select each one
	- Once the drop down is changed, the other gadgets in the dashboard update based on the new JQL filter
	- The selected filter's Start Date and End Date are also passed to the other gadgets for optional use. They do not alter the JQL.
