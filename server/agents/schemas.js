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
  rationale: short(300),
});

export const budgetOutput = z.object({
  proposals: z.array(changeProposal).max(8),
  explanation: short(600),
  clarifyingQuestion: short(300).optional(),
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
