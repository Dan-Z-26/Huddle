# Huddle

A GenAI planning assistant and team workspace for weddings, birthdays, community events and corporate launches. It turns a sentence about your event into a concrete plan: budget, timeline, vendor checklists and ideas that fit you, not default luxury.

Built for PromptWars Virtual, Challenge 5.

## Chosen vertical

**Event planning and coordination.** The problem statement asks for "a GenAI-powered planning assistant that helps users organize weddings, birthdays, and community events with budgets, timelines, vendor checklists, and personalized ideas."

| Problem statement | Where it is in Huddle |
|---|---|
| GenAI-powered assistant | Planner, Discovery, Budget, Vendor and Timeline agents, all using tool calling and checked structured output |
| Weddings, birthdays, community events | All are templates, plus corporate launches. Same engine, different configuration |
| Budgets | Smart split, live chart, consequences of every change, a contingency buffer and expense tracking |
| Timelines | Planned back from the event date, shown on every page, replanned when the date moves |
| Vendor checklists | Briefs, questions to ask every vendor, quote reading and comparison, hiring checklist |
| Personalized ideas | Ideas and next steps built from your purpose, priorities and must-haves, each saying why it fits |

## Run it

Node 20.19 or newer.

```bash
npm install
npm start        # http://localhost:3000
npm test         # runs offline, no key needed
npm run lint
```

**No API key is needed.** Without one, every agent falls back to plain rules and the sample quotes have stored readings, so the whole demo works. To turn on real AI, copy `.env.example` to `.env` and add a `GEMINI_API_KEY`.

## Try the demo (5 minutes)

Open the app and choose a person. Each person sees what their role allows.

1. **Dev Sharma, PR head:** open PR & media and send `@huddle we need a PR vendor, please draft a brief`. Open Vendors and quotes and send the brief to Core team.
2. **Asha Menon, Event manager** (Switch person): approve the brief under Vendors and quotes.
3. **Dev Sharma:** press the three "Use sample" buttons and confirm each reading. Compare the warnings: one is silent on tax, one is over plan and one has a minimum guest count.
4. **Asha Menon:** accept Northstar Media, read the consequences, choose how to close the gap and apply.
5. Northstar Media is now in the PR & media group only, the budget and timeline have changed, and the sign-in list includes them. Sign in as them to see how little an outside vendor sees.

Also try **Start a new event**: describe it in a sentence, then tap through what's left.

## Approach and logic

**The model understands; code calculates.** This is the rule everything follows:

- Models read language, decide which tools to call, and explain results. They never produce or change a committed amount, date or count.
- All money, counts and dates come from pure functions in `server/core/`. Money is integer paise.
- Every model reply is checked against a schema. Wording that cites a figure nobody supplied is thrown away.
- If a model fails or no key is set, plain rules take over and the screen says so.

**A good event fits the people in it.** Huddle listens first. The user ranks what matters, and changes are stated as consequences rather than pushed as choices. Next-step advice can only point at something code actually found, such as an overspend or a late task.

### Agents

| Agent | The model does | Code does |
|---|---|---|
| Planner (`@huddle`) | Reads intent, delegates, advises on next steps | Dispatch, finding what needs attention |
| Discovery | Reads your description, writes answer buttons for this event | Which fields are missing, parsing dates, money and guests |
| Budget | Turns language into change events, explains what they mean | All the maths and consequences |
| Vendor | Writes briefs and declines, reads quotes from text, PDF or images | Normalising, scoring, warnings |
| Timeline | Words tasks, digests and reminders | Dates, risk flags, overdue checks |

These live in `server/agents/` and run inside the app.

## How it works

- **Setup:** one sentence, then only what's missing. Tapped answers skip the model, so they're instant.
- **Budget:** each category starts from its usual share for the event type, adjusted by your ranking, after 10% is set aside as a contingency buffer. Any change shows its consequences before anything moves.
- **Expenses:** log what you actually spend, compare it with the plan, and cover an overspend from the buffer.
- **Timeline:** the whole flow is visible at the top of every page, with no sideways scrolling.
- **Team workspace:** humans and AI members share groups. Human messages stay in their group, and only `@huddle` brings in the Planner. Pinned directives ask named people to tap "Got it", with reminders.
- **Vendor hiring:** brief, approval, quotes, comparison, accept. A vendor becomes a user only when accepted, and only in that category's group.

**Vendors are not users until accepted.** After acceptance they see their own group, from that moment on, with amounts hidden. They can post, tick off deliverables and acknowledge changes, and they only see files they attached themselves. They can't see the budget, the timeline, rival quotes or other groups. The team can create one expiring, revocable invite link for them.

## Security

- Sign-in is a server-side session; the httpOnly, SameSite cookie holds only a random id. The role is worked out on the server on every route.
- Budget visibility: the manager sees everything, a lead sees their own categories, a vendor sees none.
- Everything sent to a vendor passes redaction, including live updates. Briefs never contain money.
- Uploads are checked by their bytes, limited to PDF, PNG, JPG and WEBP up to 5 MB, stored under random names outside `public/`, and downloaded only through a route that checks membership.
- User and document text is treated as untrusted data in prompts. Helmet with a strict Content-Security-Policy, rate limits on AI routes, and text rendered with `textContent` only.

## Assumptions

- **Demo sign-in has no passwords.** Anyone can choose any seeded person in the event they're in, or in the demo event. This is what lets judges see the roles quickly, and it means the vendor limits are only real with `DEMO_SIGNIN=off`, which closes it. Invite-link sessions can't use it while they last.
- **In-memory storage.** Restarting the server resets everything to the demo event. Uploads go to a gitignored folder.
- **Usual category shares are estimates.** They are reasoned starting points chosen for this project, not industry research. Real quotes replace them.
- **Rupees by default.** Other currencies can be typed, but one event uses one currency.
- **Free-tier AI limits.** On Gemini's free tier a busy moment may fall back to plain rules, and the screen says when it does.
- **White and pink, light theme only** is a design decision for this version.
- **The hiring checklist's steps are fixed;** the AI writes the brief, the vendor's deliverables and the decline note.

## Future work

A full vendor portal, payments, real authentication and invitations, direct messages, push notifications, a dark theme, a database.

## Project layout

```
server/core/       pure logic: budget, consequences, timeline, scoring, hiring, permissions
server/agents/     runtime AI agents and their offline fallbacks
server/llm/        provider adapter: Gemini by default, Anthropic optional
server/routes/     Express routes
server/store/      in-memory store and demo seed
public/            plain HTML, CSS and ES modules, no framework
tests/             node:test suites, offline
docs/interfaces.md the shared data shapes and API
```
