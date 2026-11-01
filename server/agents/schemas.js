import { z } from "zod";

const short = (max) => z.string().max(max);
const confidence = z.number().min(0).max(1);

// A price as the user said it. Money stays text so code parses it; a model never converts units.
const priceFields = {
  priceKind: z.enum(["perGuest", "fixed", "perUnit"]).optional(),
  priceText: short(80).optional(),
  units: z.int().min(0).max(100000).optional(),
  estimate: z
    .object({ lowRupees: z.int().min(0).max(1e9), highRupees: z.int().min(0).max(1e9) })
    .optional(),
};

/** What the Budget model proposes. Plain union (anyOf), which every provider's JSON Schema accepts. */
export const changeProposal = z.union([
  z.object({
    type: z.literal("guest_count"),
    delta: z.int().optional(),
    to: z.int().optional(),
    confidence,
  }),
  z.object({ type: z.literal("budget_total"), amountText: short(80), confidence }),
  z.object({
    type: z.literal("category_amount"),
    category: short(60),
    amountText: short(80),
    confidence,
  }),
  z.object({
    type: z.literal("category_shift"),
    from: short(60),
    to: short(60),
    amountText: short(80),
    confidence,
  }),
  z.object({
    type: z.literal("category_adjust"),
    category: short(60),
    direction: z.enum(["increase", "decrease"]),
    amountText: short(80).optional(),
    percent: z.int().min(1).max(100).optional(),
    confidence,
  }),
  z.object({
    type: z.literal("line_item_add"),
    category: short(60),
    label: short(80),
    ...priceFields,
    confidence,
  }),
  z.object({
    type: z.literal("line_item_remove"),
    category: short(60),
    itemId: short(80),
    confidence,
  }),
  z.object({
    type: z.literal("line_item_swap"),
    category: short(60),
    remove: short(80),
    add: short(80),
    ...priceFields,
    confidence,
  }),
  z.object({ type: z.literal("quote_accepted"), quoteId: short(80), confidence }),
]);

const list = z.array(short(120)).max(10).optional();

/** Fields the Discovery model may pull out of one answer. Values are copied as the user wrote them. */
export const extraction = z.object({
  name: short(120).optional(),
  purpose: short(500).optional(),
  date: short(200).optional(),
  city: short(80).optional(),
  venueType: short(80).optional(),
  guestText: short(200).optional(),
  budgetText: short(200).optional(),
  priorities: z.array(short(60)).max(20).optional(),
  attendeeExperience: short(500).optional(),
  mustHaves: z
    .array(
      z.object({
        text: short(120),
        categoryId: short(60).nullable().optional(),
        minTierId: short(60).nullable().optional(),
      }),
    )
    .max(10)
    .optional(),
  absoluteMustHave: short(120).optional(),
  constraints: z
    .object({ deadlines: list, dietary: list, accessibility: list, brand: list, venue: list })
    .optional(),
  vendorNeeds: z.record(short(60), short(300)).optional(),
  skipped: z.boolean().optional(),
});

export const discoveryOutput = z.object({
  extracted: extraction,
  nextField: short(40).optional(),
  nextQuestion: short(300).optional(),
  options: z
    .object({
      name: list,
      purpose: list,
      venueType: list,
      attendeeExperience: list,
      mustHaves: z
        .array(z.object({ text: short(120), categoryId: short(60).nullable().optional() }))
        .max(10)
        .optional(),
      constraints: list,
    })
    .optional(),
  questions: z.record(z.string(), short(200)).optional(),
  rationale: short(300),
});

export const budgetOutput = z.object({
  proposals: z.array(changeProposal).max(8),
  explanation: short(600),
  answer: short(800).optional(),
  clarifyingQuestion: short(300).optional(),
  rationale: short(300),
});

/** The Budget model's reading of figures that code has already worked out. */
export const insightOutput = z.object({
  headline: short(200),
  insight: short(700),
  optionNotes: z.array(z.object({ categoryId: short(60), note: short(300) })).max(12),
  rationale: short(300),
});

export const rfqOutput = z.object({
  checklist: z.array(short(160)).max(12),
  rfqQuestions: z.array(short(200)).max(10),
  rationale: short(300),
});

const answerText = short(200).nullable().optional();

/** A quote as read from text or a file. Prices stay text and tax stays a copied percentage. */
export const quoteExtraction = z.object({
  extracted: z.object({
    vendorName: short(120).optional(),
    perGuestText: short(80).optional(),
    fixedText: short(80).optional(),
    taxPercent: z.number().min(0).max(100).optional(),
    includes: z.array(short(120)).max(15).optional(),
    exclusions: z.array(short(120)).max(15).optional(),
    minGuests: z.int().min(1).max(100000).optional(),
    validUntil: short(80).optional(),
    sources: z.record(short(40), short(160)).optional(),
    mustHaveIdsMet: z.array(short(60)).max(10).optional(),
    answers: z
      .object({
        staffing: answerText,
        setupHours: answerText,
        cancellationTerms: answerText,
        dietary: answerText,
      })
      .optional(),
  }),
  rationale: short(300),
});

const wording = (field, max) => z.object({ [field]: short(max), rationale: short(300) });

export const taskWordsOutput = z.object({
  tasks: z.array(z.object({ id: short(80), title: short(120) })).max(30),
  rationale: short(300),
});
export const digestOutput = wording("digestText", 400);
export const reminderOutput = wording("reminderText", 400);
export const noticeOutput = wording("wording", 400);
export const expenseAlertOutput = wording("wording", 700);
export const speechOutput = wording("wording", 500);
export const vendorAnswerOutput = wording("reply", 1500);
export const linesOutput = z.object({ lines: z.array(short(300)).max(12) });
export const directiveTaskOutput = z.object({
  title: short(120),
  ownerGroupSlug: short(60),
  rationale: short(300),
});

export const ideasOutput = z.object({
  ideas: z
    .array(
      z.object({
        title: short(100),
        whyItFits: short(300),
        categoryId: short(60),
        level: z.enum(["light", "moderate", "stretch"]),
      }),
    )
    .max(6),
  rationale: short(300),
});

export const INTENTS = [
  "budget_change",
  "vendor_help",
  "timeline",
  "ideas",
  "advice",
  "vendor_brief",
  "log_expense",
  "question",
];
export const briefOutput = z.object({
  text: short(1800),
  deliverables: z.array(short(80)).max(8),
});
export const declineOutput = z.object({ text: short(600) });

export const adviceOutput = z.object({
  items: z.array(z.object({ signalId: short(80), title: short(80), why: short(300) })).max(6),
  rationale: short(300).optional(),
});

export const plannerOutput = z.object({
  intent: z.enum(INTENTS),
  categoryId: short(60).nullable().optional(),
  expenseDescription: short(120).nullable().optional(),
  suggestDirective: z.boolean(),
  reply: short(600).optional(),
  rationale: short(300),
});
