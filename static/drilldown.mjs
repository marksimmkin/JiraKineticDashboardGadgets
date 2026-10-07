function splitOrderBy(jql) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  let orderAt = -1;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && /^ORDER\s+BY\b/i.test(jql.slice(index, index + 16)) &&
      (index === 0 || /\s/.test(jql[index - 1]))) orderAt = index;
  }
  return orderAt < 0
    ? { filter: jql.trim(), order: '' }
    : { filter: jql.slice(0, orderAt).trim(), order: jql.slice(orderAt).trim() };
}

function quoteJql(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function narrowJql(base, clauses) {
  const { filter, order } = splitOrderBy(base);
  const filters = [filter, ...clauses.filter(Boolean)].filter(Boolean).map(part => `(${part})`);
  return `${filters.join(' AND ')}${order ? ` ${order}` : ''}`;
}

export function statusClause(name, ids = []) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
  return uniqueIds.length
    ? `status in (${uniqueIds.map(quoteJql).join(', ')})`
    : `status = ${quoteJql(name)}`;
}

export function statusesClause(statuses) {
  const clauses = statuses.filter(status => status.name || status.ids?.length)
    .map(status => statusClause(status.name, status.ids));
  return clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0] ?? '';
}

export function assigneeClause(accountId) {
  return accountId === '__unassigned__' ? 'assignee is EMPTY' : `assignee = ${quoteJql(accountId)}`;
}

export function issueSearchUrl(jql) {
  return `/issues/?jql=${encodeURIComponent(jql)}`;
}

export function issueCountButton(router, text, jql, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'issue-count-link';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = 'Open matching issues in Jira';
  button.addEventListener('click', () => {
    void router.open(issueSearchUrl(jql)).catch(() => {
      button.title = 'Could not open the Jira issue search';
    });
  });
  return button;
}
