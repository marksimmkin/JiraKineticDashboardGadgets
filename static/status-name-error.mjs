// KDG-24: the Counter and List add the Controller's explicit Show names to their JQL. Jira
// answers 400 when one of those names is not a Jira status (for example a mistyped missing
// status), so that case gets its own message instead of "the JQL is invalid".

export const STATUS_NAME_ERROR = "Jira didn't accept a status name set in the Controller. " +
  "Check the status names in the Controller's Edit settings.";

export function hasExplicitStatuses(visibility) {
  return Boolean(visibility?.hiddenNames?.length || visibility?.shownNames?.length);
}

// Wraps requestJira for one load and remembers whether any response was a 400.
export function trackBadRequest(requestJira) {
  const tracker = {
    badRequest: false,
    requestJira: async (...args) => {
      const response = await requestJira(...args);
      if (response?.status === 400) tracker.badRequest = true;
      return response;
    },
  };
  return tracker;
}

// The error to show for a failed load: STATUS_NAME_ERROR when Jira answered 400 and the JQL
// carried explicit Controller names, otherwise the original error.
export function statusNameError(error, tracker, visibility) {
  return tracker.badRequest && hasExplicitStatuses(visibility) ? new Error(STATUS_NAME_ERROR) : error;
}
