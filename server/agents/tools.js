/** The tools an agent's model may call. They are the pure functions in core/, bound to one request. */
import { z } from "zod";
import { allocate, computeBudget } from "../core/budgetEngine.js";
import { applyChangeEvents } from "../core/changeEvents.js";
import { computeConsequences } from "../core/consequences.js";
import { ackStatus, overdue } from "../core/directives.js";
import { parseGuestCount } from "../core/guestCount.js";
import { canSeeBudget, canView } from "../core/permissions.js";
import { missingProfileFields } from "../core/profile.js";
import { normaliseQuote, scoreQuotes } from "../core/quoteScoring.js";
import { groupsForCategory } from "../core/templates.js";
import { flagAtRisk, planTimeline } from "../core/timelinePlanner.js";
import { changeProposal } from "./budgetSchemas.js";
import { toChangeEvents } from "./changeProposals.js";

const MAX_PROPOSALS = 8;
const proposals = z.array(changeProposal).min(1).max(MAX_PROPOSALS);
const NONE = z.object({});

function proposalSummary(state, input) {
  const categoryIds = state.categories.map(({ id }) => id);
  return toChangeEvents(input, { categoryIds, state });
}

function budgetTools({ state, profile }) {
  return [
    {
      name: "allocate_budget",
      description:
        "Split a total across this event's categories by their usual shares and the user's " +
        "ranking. Amounts are minor units.",
      parameters: z.object({ totalMinor: z.int().min(0), priorities: z.array(z.string()).max(20) }),
      handler: ({ totalMinor, priorities }) => allocate(totalMinor, state.categories, priorities),
    },
    {
      name: "apply_change_events",
      description: "Apply proposed budget changes and return the resulting budget. Does not save.",
      parameters: z.object({ proposals }),
      handler: ({ proposals: input }) => {
        const { events, questions } = proposalSummary(state, input);
        const { state: after, rejected } = applyChangeEvents(state, events);
        return {
          guestCount: after.guestCount,
          budget: computeBudget(after),
          rejected,
          needsClarification: questions,
        };
      },
    },
    {
      name: "compute_consequences",
      description:
        "State what proposed changes do to the budget: shortfall, per-category cut options in the user's priority order, must-have conflicts. Never recommends.",
      parameters: z.object({ proposals }),
      handler: ({ proposals: input }) => {
        const { events, questions } = proposalSummary(state, input);
        const { after, ...consequences } = computeConsequences(state, events, profile);
        return {
          ...consequences,
          budgetAfter: computeBudget(after),
          needsClarification: questions,
        };
      },
    },
  ];
}

function quoteTools({ state, profile, quotes }) {
  const find = (quoteId) => quotes.find(({ id }) => id === quoteId);
  return [
    {
      name: "score_quotes",
      description: "Score the confirmed quotes for one category on must-have fit and cost.",
      parameters: z.object({ categoryId: z.string().max(60) }),
      handler: ({ categoryId }) =>
        scoreQuotes(quotes, {
          guestCount: state?.guestCount ?? profile.guests.confirmed,
          priorities: profile.priorities,
          mustHaves: profile.mustHaves,
          categoryId,
          absoluteMustHaveId: profile.absoluteMustHaveId,
        }),
    },
    {
      name: "normalise_quote",
      description:
        "Tax-inclusive total of one quote at the confirmed guest count, and missing fields.",
      parameters: z.object({ quoteId: z.string().max(80) }),
      handler: ({ quoteId }) => {
        const quote = find(quoteId);
        return quote
          ? normaliseQuote(quote, state?.guestCount ?? profile.guests.confirmed)
          : { error: "unknown quote" };
      },
    },
  ];
}

function intakeTools({ profile }) {
  return [
    {
      name: "parse_guest_count",
      description: "Turn a fuzzy guest-count answer into a range and a suggested planning number.",
      parameters: z.object({ text: z.string().max(200) }),
      handler: ({ text }) => parseGuestCount(text) ?? { error: "no guest count found" },
    },
    {
      name: "missing_profile_fields",
      description: "List the intake fields still unanswered, in the order to ask them.",
      parameters: NONE,
      handler: () => ({ missing: missingProfileFields(profile) }),
    },
  ];
}

function timelineTools({ template, nowIso, tasks, groupIdBySlug }) {
  return [
    {
      name: "plan_timeline",
      description: "Plan the milestone tasks backward from an event date.",
      parameters: z.object({ eventDateIso: z.string().max(40) }),
      handler: ({ eventDateIso }) =>
        planTimeline(eventDateIso, template.milestones, nowIso, groupIdBySlug),
    },
    {
      name: "flag_at_risk",
      description: "Refresh which timeline tasks are at risk today.",
      parameters: NONE,
      handler: () => flagAtRisk(tasks, nowIso),
    },
    {
      name: "groups_for_category",
      description: "Which groups hear about a change to a category.",
      parameters: z.object({ categoryId: z.string().max(60) }),
      handler: ({ categoryId }) => groupsForCategory(template.categoryGroupMap, categoryId),
    },
  ];
}

function directiveTools({ nowIso, directives, members }) {
  const directiveById = (id) => directives.find((directive) => directive.id === id);
  return [
    {
      name: "ack_status",
      description: "Who has acknowledged a directive, such as '3 of 4 acknowledged'.",
      parameters: z.object({ directiveId: z.string().max(80) }),
      handler: ({ directiveId }) => {
        const directive = directiveById(directiveId);
        return directive ? ackStatus(directive, members) : { error: "unknown directive" };
      },
    },
    {
      name: "overdue_acks",
      description: "Whether a directive has waited past its limit and a reminder is due.",
      parameters: z.object({
        directiveId: z.string().max(80),
        slaMinutes: z.int().min(1).max(100000),
      }),
      handler: ({ directiveId, slaMinutes }) => {
        const directive = directiveById(directiveId);
        return directive ? overdue(directive, nowIso, slaMinutes) : { error: "unknown directive" };
      },
    },
  ];
}

/**
 * Builds the tools an agent may call, bound to one request's data. Agents act with the asker's
 * permissions: budget tools exist only for a role that can see the total budget, and quote tools
 * only for roles that can see quotes.
 * @param {{actor: object, profile: object, template: object, nowIso: string, state?: object,
 *   quotes?: object[], tasks?: object[], directives?: object[], members?: object[],
 *   groupIdBySlug?: Record<string, string>}} context The request's data.
 * @returns {Array<{name: string, description: string, parameters: import("zod").ZodType,
 *   handler: Function}>} Tools for `generate`.
 */
export function buildTools(context) {
  const { actor, state } = context;
  const data = {
    quotes: [],
    tasks: [],
    directives: [],
    members: [],
    groupIdBySlug: {},
    ...context,
  };
  return [
    ...intakeTools(data),
    ...timelineTools(data),
    ...directiveTools(data),
    ...(state && canSeeBudget(actor, "total") ? budgetTools(data) : []),
    ...(canView(actor, { type: "quotes" }) ? quoteTools(data) : []),
  ];
}
