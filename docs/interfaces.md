# Huddle shared interfaces

The contract between builders. If this file disagrees with a subagent brief, this file wins. Change it before changing a shape another folder depends on.

All code is ES modules. All money is integer paise (`*Minor`). All dates are ISO 8601 strings in UTC.

## Decisions that override the briefs

- **View as uses a cookie, not `X-Demo-User`.** `POST /api/view-as` sets `huddle_user` (HttpOnly, `SameSite=Lax`, `Path=/`). `EventSource`, `<img>` and download links can't send custom headers. A missing or unknown cookie returns 401, and so does an AI member's id, because the cookie is client-controlled and agents may post anywhere. `POST /api/view-as` must refuse agent ids too.
- **Vendors are not workspace members.** They have no login, groups or view, so there is no vendor role, no vendor-visible group and no redaction. The manager and core team collect quotes and enter or upload them. (Decision 2026-10-31.)
- **Agents act with the asker's permissions.** A core member's `@huddle` must not reach the total budget or another area's budget: tools are filtered by `canSeeBudget`/`canView`.
- **Two-stage model calls.** Tool turns without a schema (max 4 tool calls), then one final turn with the schema and no tools.
- **Nobody commits.** The developer runs all git commits and pushes.

## Backend shape (keep it simple)

Every route handler reads top to bottom: get user → validate → check permission → call core/agent → update store → broadcast → respond.

No service layers, classes, dependency injection, generic frameworks or event buses.

```
server/
  app.js          createApp({ store }) returns the Express app, without listening
  index.js        entry: load .env, clean data/uploads/, seed, listen, start reminder timer
  http.js         requireUser, validate(schema), HttpError, error handler
  sse.js          Set of clients, broadcast(event), heartbeat
  reminders.js    runReminders(store, nowIso), called by the timer and tests
  routes/         session, events, budget, timeline, groups, messages, vendors, stream
  store/          index.js (createStore), seed.js
  validation/     schemas.js (requests), uploads.js (signature check)
```

`app.js` is separate from `index.js` so tests can start the app on port 0 without side effects.

`http.js` details: `HttpError(status, code, message)` is a plain function returning an `Error`, and its message is sent to the client. `validate(schema)` parses `{ body, params, query }`, sets `req.valid`, and reports only the field path. The store is at `req.app.locals.store`. `createAiLimiter({ windowMs, max })` gives each call its own counters.

API tests run in demo mode with provider keys removed from `process.env`, so they need no LLM mock wiring.

## Core data

```jsonc
// EventProfile
{ "id": "", "eventType": "corporate_launch|wedding|birthday|community",
  "name": "", "purpose": "", "date": "ISO", "city": "", "venueType": "",
  "guests": { "min": 0, "max": 0, "suggested": 0, "confirmed": null },
  "budget": { "totalMinor": 0, "currency": "INR" },
  "priorities": ["categoryId"],
  "attendeeExperience": "",
  "mustHaves": [{ "id": "", "text": "", "categoryId": null, "minTierId": null }],
  "absoluteMustHaveId": null,
  "constraints": { "deadlines": [], "dietary": [], "accessibility": [], "brand": [], "venue": [] },
  "vendorNeeds": { "categoryId": "" },
  "skippedFields": [],
  "intakeStatus": "in_progress|confirmed" }

// Category
{ "id": "", "name": "", "locked": false,
  "tiers": [{ "id": "", "label": "", "minMinor": 0 }],
  "drivers": [Driver] }

// Driver. Exactly one pricing form applies, by kind.
{ "id": "", "label": "",
  "kind": "perGuest|fixed|perUnit|stepped",
  "unitMinor": 0, "units": 0,
  "steps": [{ "upToGuests": 0, "amountMinor": 0 }],
  "source": "quote|user|estimate",
  "estimate": { "lowMinor": 0, "highMinor": 0 },
  "unpriced": false }

// BudgetState
{ "guestCount": 0, "totalMinor": 0, "currency": "INR",
  "categories": [Category], "quotes": [Quote] }

// Quote
{ "id": "", "eventId": "", "categoryId": "", "vendorName": "",
  "status": "extracted|confirmed|accepted",
  "perGuestMinor": 0, "fixedMinor": 0, "taxBps": 0,
  "includes": [], "mustHaveIdsMet": [],
  "answers": { "staffing": null, "setupHours": null, "cancellationTerms": null, "dietary": null },
  "sourceFileId": null }

// Task
{ "id": "", "title": "", "ownerGroupId": "", "ownerUserId": null,
  "dueDate": "ISO", "status": "todo|done", "atRisk": false,
  "source": "milestone|directive|user", "daysBefore": null }

// Group. Rename changes name only; id and slug stay stable so the map keeps working.
{ "id": "", "eventId": "", "slug": "", "name": "",
  "kind": "announcements|core|category",
  "memberRoleIds": [], "categoryIds": [] }

// User. AI members have kind "agent".
{ "id": "", "eventId": "", "name": "", "roleId": "",
  "kind": "manager|core|agent", "categoryIds": [] }

// Message. authorKind "system" is used for notices.
{ "id": "", "groupId": "", "authorId": "", "authorKind": "human|agent|system",
  "text": "", "fileIds": [], "createdAt": "ISO", "rationale": null }

// Directive
{ "id": "", "messageId": "", "groupId": "", "addressedUserIds": [],
  "acks": [{ "userId": "", "at": "ISO" }], "createdAt": "ISO", "remindedAt": null, "taskId": null }

// FileRecord. storedName is never sent to clients.
{ "id": "", "groupId": "", "originalName": "", "mime": "", "size": 0,
  "storedName": "", "uploadedBy": "", "createdAt": "ISO" }
```

### Change events

Every event also has `confidence` (0 to 1). Below 0.7, the Budget agent asks the user instead of applying it.

```jsonc
{ "type": "guest_count", "delta": 50 }                // or "to": 250
{ "type": "line_item_add", "category": "", "item": Driver }
{ "type": "line_item_remove", "category": "", "itemId": "" }
{ "type": "line_item_swap", "category": "", "remove": "", "add": "", "price": DriverPricing }
{ "type": "category_amount", "category": "", "amountMinor": 0 }
{ "type": "quote_accepted", "quoteId": "" }
{ "type": "budget_total", "toMinor": 0 }
```

`price` is optional. Without it, the new driver is a fixed estimate of 0–0 with `unpriced: true`, and the UI shows "price unknown".

## `server/core/` functions

All are pure, with JSDoc. `role` is `{ kind, roleId, eventId, categoryIds, groupIds }`. Permission checks deny any group whose `eventId` differs from the role's, managers and agents included.

```js
// money.js
formatMoney(minor, currency) // string, en-IN grouping for INR

// guestCount.js
parseGuestCount(text) // { min, max, suggested, needsConfirmation } | null
// "200" -> 200/200/200/false; "around 200" -> 200/200/210/true
// "200-250" -> 200/250/263/true; "300 if partners come" -> 300/300/315/true
// suggested = ceil(max * 1.05), integer maths

// profile.js
missingProfileFields(profile) // string[] in question order; unconfirmed guests is always missing
buildBudgetState(profile, template) // BudgetState

// priorities.js
normalisePriorities(ranking, categoryIds) // known ids only, no duplicates
rankOf(priorities, categoryId) // 1-based number | null

// budgetEngine.js
allocate(totalMinor, priorities) // { [categoryId]: minor }; weight n-rank+1, largest remainder, exact sum
driverCost(driver, guestCount) // { committedMinor, lowMinor, highMinor }
categoryCost(category, guestCount) // same shape, summed
computeBudget(state)
// { categories: [{ id, name, committedMinor, lowMinor, highMinor }],
//   committedMinor, lowMinor, highMinor, totalMinor, remainingMinor }
// lowMinor/highMinor = committed + estimates at that end

// changeEvents.js
applyChangeEvents(state, events) // { state, rejected: [{ event, reason }] }; never mutates input

// consequences.js
computeConsequences(state, events, profile)
resolutionEvents(result, { cuts, raise }) // { events, remainingMinor }; cuts apply in order, each only as far as the gap needs
// { after: BudgetState, deltas: [{ categoryId, beforeMinor, afterMinor }],
//   rejected, shortfall: { lowMinor, highMinor }, surplusMinor,
//   options: [{ categoryId, rank,
//     atLow: CutOption | null, atHigh: CutOption | null }],
//   increaseBudget: { lowMinor, highMinor } | null }
// CutOption: { cutMinor, newTotalMinor, pctDrop, tierBefore, tierAfter,
//   removedEntirely, coversShortfall, mustHaveConflicts: [mustHaveId] }
// Options follow priority order and skip locked categories.
// There is no "recommended" field, by design.

// timelinePlanner.js
planTimeline(eventDateIso, milestones, nowIso, groupIdBySlug) // Task[]; past dates clamp to today with atRisk true
flagAtRisk(tasks, nowIso) // Task[]
replanTimeline(tasks, newEventDateIso, nowIso) // Task[]; keeps status and non-milestone tasks
taskFromDirective(directive, { title, ownerGroupId, dueDate }) // Task

// quoteScoring.js
normaliseQuote(quote, guestCount) // { totalMinor, missing: [field] }
scoreQuotes(quotes, { guestCount, priorities, mustHaves, categoryId })
// [{ quoteId, vendorName, totalMinor, mustHaveFit, score, missing, riskFlags }]
// score 0-100: fit weight 80% for rank 1 down to 40% for last rank; the rest is cost
// (cheapest = 100). An unmet absolute must-have is always a risk flag.

// permissions.js
canView(role, resource)
// resource: { type: "group"|"file", group } | { type: "quotes"|"comparison" }
canPost(role, group)
canSeeBudget(role, scope) // scope: "total" | { categoryId }
canMarkDirective(role)
canManageGroups(role)

// directives.js
ackStatus(directive, members) // { acked: [userId], pending: [userId], label: "3 of 4 acknowledged" }
overdue(directive, nowIso, slaMinutes) // { isOverdue, pendingUserIds, shouldRemind }
attentionFor(userId, directives, tasks) // { directives, tasks }

// templates.js
getTemplate(eventType) // { eventType, categories, roles, groups, categoryGroupMap, milestones, seedUsers }
listEventTypes() // [{ eventType, label }]
groupsForCategory(categoryGroupMap, categoryId) // [groupSlug]; falls back to ["core-team"]
```

### Rules the signatures don't show

Core functions are pure, so anything that needs an id derives it deterministically (`task-<milestoneId>`, `task-<directiveId>`, a slug of the label plus a counter for new drivers).

**Pricing.** `driverCost` by kind:

| Kind | Cost | Estimate range |
|---|---|---|
| `fixed` | `unitMinor` | `estimate` is the total |
| `perGuest` | `unitMinor × guestCount` | `estimate` is per guest, multiplied by `guestCount` |
| `perUnit` | `unitMinor × units` | `estimate` is per unit, multiplied by `units` |
| `stepped` | amount of the first step with `guestCount <= upToGuests`; above the last step, the last amount | `estimate` is the total |

A driver with source `estimate` adds 0 to `committedMinor`, and its range adds to `lowMinor` and `highMinor`. Any other driver adds its cost to all three.

**Building a budget.** `buildBudgetState` throws if `guests.confirmed` is null. It reads template categories, whose drivers and tiers hold shares rather than money, so one template fits any budget:
- A template driver has `shareBps` (its part of the category; a category's drivers sum to 10000). A stepped driver also has `steps: [{ upToGuests, shareBps }]`, relative to the step that contains the confirmed count.
- A template tier has `minBps` of the category allocation, resolved to `minMinor`.
- Unranked categories get an allocation of 0.
- Resulting drivers have source `user`, because they come from the user's own total and ranking.
- `perGuest` uses `floor(part / guests)`, and any leftover goes to the category's first `fixed` driver if it has one. Otherwise it stays in `remainingMinor`.

**Tiers.** A category's tier is the highest one with `minMinor <= cost`, or null if none qualifies.

**Change events.**
- `guest_count` is rejected if the result isn't an integer of at least 1. `budget_total` and `category_amount` are rejected unless they are non-negative integers.
- `category_amount` replaces the category's drivers with one `fixed` driver of source `user`.
- `line_item_swap.remove` matches a driver by id or case-insensitive label. An unknown category, driver, quote or event type goes to `rejected` with a reason.
- `quote_accepted` requires status `confirmed` or `accepted`, otherwise it is rejected. It replaces the category's drivers with `perGuest` and `fixed` drivers of source `quote`, marks the quote `accepted`, and returns any other accepted quote in that category to `confirmed`.
- `locked` only removes a category from the cut options. Locked categories still accept changes, and their costs still follow the guest count.
- `confidence` is ignored here; the Budget agent acts on it before calling core.

**Tax.** Tax is applied to each price component with `round(minor × taxBps / 10000)`, half up. So `normaliseQuote` total = `perGuestWithTax × guestCount + fixedWithTax`, and accepting a quote gives exactly the same total.

**Consequences.** The worked example in the approved plan (₹16,00,000, 200 → 250 guests, ₹1,25,000 over) must be a test.
- `shortfall.lowMinor` = `max(0, lowMinor − totalMinor)`, and likewise for high. `surplusMinor` = `max(0, totalMinor − highMinor)`.
- `deltas` lists only categories whose committed cost changed.
- `atLow` and `atHigh` use that end's shortfall and category cost. Each is null when that end has no shortfall or the category costs 0, and a category with both null is omitted.
- `cutMinor` = `min(shortfall, cost)`. `coversShortfall` = `cost >= shortfall`. `removedEntirely` = new total of 0. `pctDrop` is a rounded integer.
- `mustHaveConflicts` lists must-haves in that category whose `minTierId` is above the new tier, or any must-have in it if the category is removed entirely.
- Ranked categories come first in rank order, then unranked ones with `rank: null`.
- `increaseBudget` is null when `shortfall.highMinor` is 0.

**Profile.** `missingProfileFields` order: `name, purpose, date, city, venueType, guests, budget, priorities, attendeeExperience, mustHaves, absoluteMustHave, constraints, vendorNeeds`. A field counts as answered if it has a value. `skippedFields` also counts, but only for `mustHaves`, `absoluteMustHave`, `constraints` and `vendorNeeds`, where "none" is a valid answer.

**Permissions.**
- `canView` a group or file: the group must belong to the role's event; then manager always, otherwise `role.groupIds` includes the group id. Quotes and comparison: manager and core only.
- `canPost`: the group must belong to the role's event. Manager and agent can post in any such group. Others need membership, and never in `announcements`. Core post in category groups only if `group.categoryIds` overlaps `role.categoryIds`.
- `canSeeBudget`: `"total"` is manager only; `{ categoryId }` is manager, or core with that id in `role.categoryIds`. Agents are always false, because agents are checked with the asker's role.
- `canMarkDirective` and `canManageGroups`: manager only.

**Limits.** Change events reject guest counts above 100,000 and money above 5e10 paise (₹50 crore; MAX_MINOR in changeEvents.js), so sums stay safe integers. Request schemas must also cap label and id lengths (80 characters).

**Route rule.** Every event-scoped route first checks `req.user.eventId` equals the event in the path (otherwise 404), because `canSeeBudget` takes no event.

**Timeline.** A milestone is `{ id, title, daysBefore, ownerGroupSlug }`. Tasks keep `daysBefore`, and `replanTimeline` uses it. `flagAtRisk`: done is false, a due date before today is true, otherwise the task keeps its current value, so clamped tasks stay flagged. Comparisons use whole UTC days.

**Directives.** `ackStatus` counts addressed users who are in `members` (user objects). `overdue`: `isOverdue` when someone is pending and `slaMinutes` have passed since `createdAt`; `shouldRemind` when also `remindedAt` is null. `attentionFor` returns unacknowledged directives addressed to the user and the user's `todo` tasks.

**Quote scoring.** Fit is the share of the category's must-haves met, or 100 if it has none. The fit weight runs linearly from 80% at rank 1 to 40% at last rank; a sole ranked category gets 80% and an unranked one 40%. Cost score is `cheapest / total × 100`. `missing` lists null `answers` keys, plus `price` if both prices are 0.

**Templates.** A role is `{ id, name, kind, categoryIds }`. A group is `{ slug, name, kind, memberRoleIds, categoryIds }`. `seedUsers` includes the four AI members (Planner, Budget, Vendor, Timeline) with kind `agent`. The category list and order come from the plan's template table and are for display only: the user does the ranking.

## `server/llm/`

```js
generate({ agent, system, messages, schema, tools, files })
// -> { data, toolCalls: [{ name, args, result }], provider, model, demo }
// messages: [{ role: "user"|"assistant", content }]
// tools: [{ name, description, parameters: zodSchema, handler }]
// files: [{ mime, buffer, name }]
// Invalid output -> one retry -> throws LlmError; the agent then uses its safe fallback.

wrapUntrusted(label, text) // wraps user or document text in delimiters
```

Environment variables:
- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`
- `LLM_PROVIDER` (default `gemini`), `FALLBACK_PROVIDER`
- `<AGENT>_PROVIDER`, `<AGENT>_MODEL`, where `<AGENT>` is `PLANNER`, `DISCOVERY`, `BUDGET`, `VENDOR`, `TIMELINE`, `NOTICES` or `IDEAS`

## `server/agents/`

An agent with no second provider set falls back to its provider's other model tier on a 429, 5xx, timeout or invalid output. `generateOrDemo` reports `offline` when no model answered, and the UI says so.

Every result includes a user-facing `rationale`. `actor` is the asking user's `role`. No agent changes the store: routes apply results. Each agent takes `(input, { generate })` so tests can replace the model call; routes use the default.

**Money, dates and counts are text in model output.** The model copies what the user wrote (`amountText: "18 lakh"`, `date: "12 March 2027"`); code parses it (`core/amount.js`, `core/dateText.js`, `core/guestCount.js`). The only numbers a model produces are estimate ranges in whole rupees, which code converts, labels `estimate` and keeps out of committed totals.

```js
planner.handleMention({ profile, state, template, actor, text, files, tasks, quotes, directives, members, nowIso })
// { reply, intent, delegateTo, suggestDirective, rationale, result? }. intent: budget_change | vendor_help |
// timeline | ideas | question. Code dispatches to the right agent; result is that agent's raw output
// (for example the change events a route stores until the manager accepts them).
planner.taskFromDirective({ directiveText, template, nowIso }) // { title, ownerGroupSlug, dueDate, rationale }
// dueDate is read from the directive in code (weekday, date, "in 3 days"), else two days out.

discovery.nextStep({ profile, template, answer, nowIso })
// { nextQuestion, field, extracted, rejected, complete, rationale, profile }   (omit answer for the first question)
// Code decides the next field, confirms the guest count and parses all values; one model call per
// turn at most (none for guest counts and "none/skip" answers). `profile` is the updated copy to store.

budget.interpretChange({ profile, state, actor, text, template })
// { allowed, changeEvents, estimates, answer, insight, offline, clarifyingQuestion, consequences, consequenceText, explanation, rationale }
// consequenceText is generated by code. explanation is the model's, dropped if it cites a number no tool returned.

vendor.buildRfq({ profile, categoryId, template })
// { checklist, rfqQuestions, rationale }. Standard questions and the user's own requirements come
// from code; the model adds category items, dropped if they quote a number nobody supplied.
// Cached per category until the relevant profile fields change.
vendor.extractQuote({ profile, categoryId, template, text, file })   // file: { id, mime, buffer, name }
// { extractedQuote, warnings, rationale }. extractedQuote has status "extracted" (a person confirms
// it) and no id/eventId (the route assigns them). Prices and tax are parsed in code. Quote text and
// file contents are untrusted data. Cached by file id, or by text content.
timeline.wordTasks({ profile, tasks }) // { tasks, rationale }; only titles change
timeline.digest({ profile, tasks, directives, members, nowIso }) // { digestText, rationale }; facts from code
timeline.reminder({ directiveText, pendingNames }) // { reminderText, rationale }; every pending person is @-mentioned by code
notices.noticeTargets({ deltas, categoryGroupMap }) // [{ slug, categoryIds }]; code only
notices.noticeFacts({ guests, deltas, categoryIds, groupSlug, template, currency }) // string[]; never the total budget; amounts only if every core member of the group owns the categories
notices.word({ facts, groupName }) // { wording, rationale }; falls back to the plain facts
ideas.generateIdeas({ profile, state, template, files }) // { ideas: [{ title, whyItFits, categoryId, level, costShare }], rationale }; manager only
```

Tools registered in `server/agents/tools.js` (`buildTools(context)`), filtered by the asker's permissions: `parse_guest_count`, `missing_profile_fields`, `plan_timeline`, `flag_at_risk`, `groups_for_category`, `ack_status`, `overdue_acks` for everyone; `allocate_budget`, `apply_change_events`, `compute_consequences` only when `canSeeBudget(actor, "total")`; `score_quotes`, `normalise_quote` only when `canView(actor, { type: "quotes" })`. Budget tools take `proposals` (the `changeProposal` schema), which `agents/changeProposals.js` converts to core change events, turning anything unsure or unreadable into a question.

## REST endpoints

All are under `/api`. Errors are `{ error: { code, message } }`, with codes `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_FILE`, `RATE_LIMITED` and `INTERNAL`.

| Route file | Method and path | Body | Response |
|---|---|---|---|
| session | `POST /view-as` | `{ userId }` | `{ user }`, sets cookie |
| session | `GET /me` | | `{ user, permissions, attention }`; `user.categoryIds` for core members |
| session | `GET /users` | | `{ users: [{ id, name, roleId, roleName, kind }] }`: the humans of the caller's event, or of the demo event with no cookie (public, for the switcher) |
| events | `POST /events` | `{ eventType }` | `{ event }` |
| events | `GET /event-types` | | `{ eventTypes: [{ eventType, label }] }` (public) |
| events | `GET /events/:id` | | `{ event, template: { label, categories }, groups, members }`; `event.budget` and `event.priorities` only for the manager. Others get only their own categories' `vendorNeeds` and must-haves, with amounts typed into shared text masked |
| events | `PATCH /events/:id/profile` | `name, purpose, city, venueType, attendeeExperience` only (manager) | `{ event }` |
| events | `POST /events/:id/intake` * | `{ answer }` | `{ nextQuestion, feedback, field, profile, complete, rationale }` |
| events | `POST /events/:id/intake/confirm` | | `{ event, groups }`; creates the workspace |
| events | `POST /events/:id/ideas` * | | `{ ideas, rationale, offline }` |
| budget | `GET /events/:id/budget` | | `computeBudget` output plus `guestCount`, `currency` and per-category `tierLabel`, `locked`, and for the manager `rank`; core members get only their categories, with no totals and no rank |
| budget | `POST /events/:id/changes` * | `{ text }` | `{ changeId, answer, insight, offline, consequences, consequenceText, estimates, explanation, clarifyingQuestion, rationale }`. `answer` replies to a plain question; `insight` is `{ headline, insight, points, optionNotes }`; `offline` says no model was reached; `changeId` is null unless the change applies cleanly |
| budget | `POST /events/:id/changes/:changeId/accept` * | `{ cuts?: [categoryId], raise?: boolean }`: how to close the gap | `{ budget, tasks, noticesPosted }`; re-applied in code, refused if the budget changed since |
| timeline | `GET /events/:id/timeline` | | `{ tasks }` by date, each with `ownerGroupName` |
| timeline | `POST /events/:id/reschedule` | `{ date }` as text (manager) | `{ event: { id, date }, tasks }` |
| timeline | `PATCH /tasks/:id` | `{ status }` (members of the owner group) | `{ tasks }` |
| timeline | `POST /events/:id/digest` * | | `{ message }` |
| groups | `POST /events/:id/groups` | `{ name, memberRoleIds }` (manager) | `{ group }`; a `category` room with no budget category of its own. The manager and AI members are always in |
| groups | `PATCH /groups/:id` | `{ name?, memberRoleIds? }` (manager) | `{ group }`; the id and slug never change. #announcements keeps everyone |
| groups | `DELETE /groups/:id` | (manager) | 204; removes its messages, directives and files, moves its tasks to #core-team. #announcements and #core-team can't be removed |
| messages | `GET /groups/:id/messages?before=&limit=` | | `{ messages, nextBefore, pinned }`; each message has `files` and, if pinned, `directive` with `status`; `pinned` lists the group's directives with their text |
| messages | `POST /groups/:id/messages` * | JSON `{ text }`, or multipart `text` and up to 3 `files` | `{ message }` (201). `*` applies only when the text contains `@huddle`; the Planner's reply is posted in the same group afterwards |
| messages | `GET /files/:id` | | file bytes: members of the file's group only, `Content-Type` from the stored type, `nosniff`, `attachment` disposition and a sandbox CSP |
| messages | `POST /messages/:id/directive` * | `{ addressedUserIds? }` (manager; a person's message; people in the group other than the manager) | `{ directive, task }` (201); the Planner words the task, code reads its due date |
| messages | `POST /directives/:id/ack` | | `{ directive, status }`; only people the directive names |
| vendors | `POST /events/:id/rfq` * | `{ categoryId }` (manager, or a core member who owns it) | `{ checklist, rfqQuestions, rationale, offline, message }`; `message` is the RFQ posted in the category's group, once per category, else null |
| vendors | `GET /events/:id/quotes?categoryId=` | | `{ quotes }`, each with `totalMinor` and `missing` |
| vendors | `POST /events/:id/quotes` * | JSON `{ categoryId, text }` or typed `{ categoryId, vendorName, perGuestText, fixedText, taxPercent, includes }`; or multipart with the same fields plus one `file` | `{ quote, warnings, rationale, offline }`. Text and files give status `extracted`; typed details with a price give `confirmed` |
| vendors | `POST /quotes/:id/confirm` | `{ vendorName, perGuestText?, fixedText?, taxPercent?, includes?, mustHaveIdsMet?, answers? }`, prices as text | `{ quote, warnings }` with status `confirmed`; needs a price; an accepted quote can't be edited |
| vendors | `POST /quotes/:id/accept` * | (manager) | The same shape as `POST /events/:id/changes`: the consequences, with a `changeId` to apply through `changes/:changeId/accept`. Nothing changes until then |
| vendors | `GET /events/:id/comparison?categoryId=` | | `{ rows }` of `{ quoteId, vendorName, totalMinor, mustHaveFit, score, missing, riskFlags, status, includes, answers }`, best first; confirmed and accepted quotes only |
| stream | `GET /stream` | | SSE; 5 connections per person, 200 in all |

`*` means rate limited, because the route can call a model. `POST /groups/:id/messages` calls a model only when the text mentions `@huddle`.

Message attachments arrive with the message (Phase 6). A quote file arrives with the quote and is stored against the category's group. Uploads: PDF, PNG, JPEG or WEBP only, judged by the file's first bytes; at most 5 MB; stored under a random name outside `public/`.

Ids: the demo event is `demo`; users are `<seedId>@<eventId>` (for example `user-manager@demo`) and groups are `g-<eventId>-<slug>`. `POST /events` creates the event with its people and sets the cookie to its manager; groups, budget and timeline are created by `intake/confirm`. At most 50 events are kept in memory: the oldest non-demo event is replaced at the cap, and each client can create 20 an hour.

## SSE events

One connection per client, sent as named events with a JSON payload:

```jsonc
{ "type": "message.created|notice.created|message.updated", "eventId": "", "groupId": "", "message": MessageView }
{ "type": "directive.updated", "eventId": "", "groupId": "", "directive": DirectiveView }
{ "type": "budget.updated|timeline.updated|attention.updated|groups.updated", "eventId": "" }
```

Group events go only to members of that group, decided at send time from the store. The last four types carry **no data**: they only tell the client to refetch, so budget figures always come from routes that filter by role. `budget.updated` goes to the manager and core members. The heartbeat is an SSE comment every 25 seconds, and clients are removed on disconnect. `store.publish(event)` sends an event; `createApp` points it at the hub.

Each group keeps its latest 300 messages. `server/reminders.js` runs every minute: a directive unacknowledged after `DIRECTIVE_SLA_MINUTES` (default 120) gets one reminder from the Timeline agent, mentioning only the people still pending.

## Store

`createStore()` returns a plain object of Maps and small functions, with no ORM or classes. A new store per test keeps tests isolated.

```js
const store = createStore();
store.events, store.users, store.groups, store.messages, store.directives,
store.files, store.quotes, store.tasks, store.budgets, store.pendingChanges // Maps
store.messagesForGroup(groupId, { before, limit })
store.groupsForUser(user)
store.roleOf(user) // { kind, roleId, categoryIds, groupIds } for core permissions
store.tasksForEvent(eventId), store.directivesForEvent(eventId)
```

`messagesForGroup` returns `{ messages, nextBefore }`. `before` is a message id, `limit` defaults to 50 and is capped at 100, messages are oldest first within the page, and `nextBefore` is null on the last page. An unknown `before` gives an empty page. `groupsForUser` never crosses events: managers and agents get every group of their own event; others get that event's groups whose `memberRoleIds` include their `roleId`.

## Frontend rules that depend on the API

- `public/js/api.js` is the only module that calls `fetch` or opens `EventSource`.
- Download links and image previews use `/api/files/:id` directly, since the cookie is sent automatically.
- Set colours through CSS classes or the CSSOM, and use SVG `fill` attributes for the pie. The CSP blocks inline `style` attributes.
