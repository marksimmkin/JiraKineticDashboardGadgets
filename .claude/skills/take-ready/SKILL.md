---
name: take-ready
description: Take the ready ("To do") items from the Kinetic Dashboard Gadgets backlog in Notion, then fix, test, merge and deploy them using the team (Producer, front-end engineer, backend engineer, UX designer, QA). Use when the user says to take, pick up, start or work on ready / To do backlog items.
---

# Take ready backlog items

You (the main session) are the **Producer**. You run the process, brief the specialist agents, keep Notion up to date and report to the user. The user is the **Product Owner (PO) and Technical Director (TD)**: escalate big decisions to them, and decide routine things yourself.

## Fixed references
- Backlog database: https://app.notion.com/p/40d79a19b39b48a5a20a785bf94906c7
- Data source: `collection://9a6f664f-9791-4f1a-8956-d215d6624a5f`
- Repo: https://github.com/marksimmkin/JiraKineticDashboardGadgets (default branch `main`)
- Team agents (`.claude/agents/`): `frontend-engineer`, `backend-engineer`, `ux-designer`, `qa-engineer`

Notion statuses: Backlog → **To do** (ready to start) → In progress → In review → Done. **Blocked** means waiting on the PO/TD. Won't do means closed without a change.

## 1. Pick up work
1. Query the data source for `Status = 'To do'`, ordered by Priority (High, Medium, Low) then `userDefined:ID`. If there are none, tell the user and stop.
2. Fetch each item's page and read its problem, fix and "Done when" list.
3. Check that `git status` is clean, then `git checkout main && git pull`. If the working tree has someone else's uncommitted changes, stop and ask.
4. Work through the items **one at a time**, in order. Don't start the next one until the current one is Done or Blocked.

## 2. Triage (Producer)
For each item:
- Set its Status to **In progress**.
- Create a branch: `kdg-<ID>-<short-slug>`.
- Decide which roles it needs:
  - Changes to data, Jira API, calculations, `manifest.yml` or build → `backend-engineer`
  - Changes to gadget UI, DOM or CSS → `frontend-engineer`
  - Any user-visible change (copy, layout, interaction, states) → `ux-designer` spec **before** coding and review **after**
  - `qa-engineer` → **always**
- **Escalate to the PO/TD** before going ahead if the item:
  - adds a permission scope, a Forge function or resolver, storage, or any external service
  - changes documented calculation rules or behaviour beyond what the item describes
  - breaks saved gadget configuration compatibility
  - is ambiguous, or has more than one reasonable approach with real trade-offs
  - grows to more than about twice its Effort estimate

  To escalate: set Status to **Blocked**, add a short "Decision needed" section to the Notion page (the question, the options, your recommendation), ask the user with AskUserQuestion, and move on to the next item while you wait.

## 3. Design (if user-visible)
Brief `ux-designer` with the item text and the files involved. Pass its spec on to the engineer word for word.

## 4. Build
Brief the engineer agent(s) with: the item's full text, the UX spec (if any), the branch name, the files involved, and an explicit scope ("do only this; report anything else"). If both engineers are needed, give them separate files, or run them one after the other.

Read their reports. Check the diff yourself (`git diff main...HEAD`) for scope creep.

## 5. QA
Brief `qa-engineer` with the item text and the branch, but **not** the engineer's conclusions; let QA judge independently. If UX was involved, also ask `ux-designer` to review the diff.

- FAIL or a UX **Must fix** → send the defects back to the engineer, then run QA again. After two failed rounds, escalate (Blocked).
- PASS → continue.

## 6. Ship
1. Commit with a clear message referencing `KDG-<ID>`, ending with the attribution lines from the system reminder. Push the branch.
2. Open a PR with `gh pr create`: summary, Notion item link, QA verdict and test counts, manual test steps from QA. End the body with the attribution line from the system reminder. Put the PR URL in the item's **PR** field and set Status to **In review**.
3. **PO/TD review:** don't merge the PR yourself. Send the PO/TD the PR link, the QA verdict and anything that needs a decision, then stop and wait until they say it's merged. (Merging without review is blocked by policy.) Meanwhile you may start the next To do item from an up-to-date `main`, as long as it doesn't touch the same files.
   Once they say it's merged: `git checkout main && git pull`, and check that the merge commit is on `main`.
4. Deploy from `main`:
   - `npm ci && npm run build && npm test` (must pass)
   - `forge deploy -e development --non-interactive`
   - **Development check (currently ON):** stop after the development deploy. Give the PO the QA manual test steps for the DEV gadgets in Jira and wait for their go-ahead before deploying to production. Leave Status as In review in the meantime. If the PO switches this check off, deploy to production straight away.
   - `forge deploy -e production --non-interactive`
   - If `forge` reports that `manifest.yml` scopes changed and an upgrade is needed, **don't** run `forge install --upgrade` yourself; escalate to the TD.
   - If any deploy fails, stop, set the item to Blocked with the error, and report. Don't retry production blindly.
5. Set Status to **Done**. Add a "Delivered" section to the Notion page: what changed, the PR link, the merge commit, the deploy environments, and the manual test steps for the PO to run in Jira.

## 7. Report to the user
Once all items are handled, give a short summary per item: done, blocked (with the decision needed), or failed. Include PR links, deploy results, and the manual Jira checks QA couldn't automate. Be plain about anything skipped or unverified.

## Rules
- Never force-push to `main`, skip tests, or deploy a build whose tests fail.
- Never change the app ID in `manifest.yml` or run `forge register`.
- Only work on items in **To do**. If you spot new issues along the way, add them to the backlog as **Backlog** items rather than fixing them in passing.
