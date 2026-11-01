/** The shape of the Budget model's answers. Money stays text, so code parses it. */
import { z } from "zod";
import { categoryRef, rationale, short } from "./schemaParts.js";

const MAX_UNITS = 100000;
const MAX_ESTIMATE_RUPEES = 1e9;
const MAX_PROPOSALS = 8;
const confidence = z.number().min(0).max(1);
const amountText = short(80);
const itemRef = short(80);

// A price as the user said it. Money stays text so code parses it; a model never converts units.
const priceFields = {
  priceKind: z.enum(["perGuest", "fixed", "perUnit"]).optional(),
  priceText: amountText.optional(),
  units: z.int().min(0).max(MAX_UNITS).optional(),
  estimate: z
    .object({
      lowRupees: z.int().min(0).max(MAX_ESTIMATE_RUPEES),
      highRupees: z.int().min(0).max(MAX_ESTIMATE_RUPEES),
    })
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
  z.object({ type: z.literal("budget_total"), amountText, confidence }),
  z.object({ type: z.literal("category_amount"), category: categoryRef, amountText, confidence }),
  z.object({
    type: z.literal("category_shift"),
    from: categoryRef,
    to: categoryRef,
    amountText,
    confidence,
  }),
  z.object({
    type: z.literal("category_adjust"),
    category: categoryRef,
    direction: z.enum(["increase", "decrease"]),
    amountText: amountText.optional(),
    percent: z.int().min(1).max(100).optional(),
    confidence,
  }),
  z.object({
    type: z.literal("line_item_add"),
    category: categoryRef,
    label: itemRef,
    ...priceFields,
    confidence,
  }),
  z.object({
    type: z.literal("line_item_remove"),
    category: categoryRef,
    itemId: itemRef,
    confidence,
  }),
  z.object({
    type: z.literal("line_item_swap"),
    category: categoryRef,
    remove: itemRef,
    add: itemRef,
    ...priceFields,
    confidence,
  }),
  z.object({ type: z.literal("quote_accepted"), quoteId: itemRef, confidence }),
]);

/** A request read by the Budget model: proposals, or a plain answer, or one question back. */
export const budgetOutput = z.object({
  proposals: z.array(changeProposal).max(MAX_PROPOSALS),
  explanation: short(600),
  answer: short(800).optional(),
  clarifyingQuestion: short(300).optional(),
  rationale,
});

/** The Budget model's reading of figures that code has already worked out. */
export const insightOutput = z.object({
  headline: short(200),
  insight: short(700),
  optionNotes: z.array(z.object({ categoryId: categoryRef, note: short(300) })).max(12),
  rationale,
});
