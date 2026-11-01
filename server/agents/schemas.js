/** The shape of every model's answer. A reply that doesn't match is retried, then falls back. */
import { z } from "zod";
import { categoryRef, rationale, short } from "./schemaParts.js";

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
  priorities: z.array(categoryRef).max(20).optional(),
  attendeeExperience: short(500).optional(),
  mustHaves: z
    .array(
      z.object({
        text: short(120),
        categoryId: categoryRef.nullable().optional(),
        minTierId: categoryRef.nullable().optional(),
      }),
    )
    .max(10)
    .optional(),
  absoluteMustHave: short(120).optional(),
  constraints: z
    .object({ deadlines: list, dietary: list, accessibility: list, brand: list, venue: list })
    .optional(),
  vendorNeeds: z.record(categoryRef, short(300)).optional(),
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
        .array(z.object({ text: short(120), categoryId: categoryRef.nullable().optional() }))
        .max(10)
        .optional(),
      constraints: list,
    })
    .optional(),
  questions: z.record(z.string(), short(200)).optional(),
  rationale,
});

export const rfqOutput = z.object({
  checklist: z.array(short(160)).max(12),
  rfqQuestions: z.array(short(200)).max(10),
  rationale,
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
    mustHaveIdsMet: z.array(categoryRef).max(10).optional(),
    answers: z
      .object({
        staffing: answerText,
        setupHours: answerText,
        cancellationTerms: answerText,
        dietary: answerText,
      })
      .optional(),
  }),
  rationale,
});

const wording = (field, max) => z.object({ [field]: short(max), rationale });

export const taskWordsOutput = z.object({
  tasks: z.array(z.object({ id: short(80), title: short(120) })).max(30),
  rationale,
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
  ownerGroupSlug: categoryRef,
  rationale,
});

export const ideasOutput = z.object({
  ideas: z
    .array(
      z.object({
        title: short(100),
        whyItFits: short(300),
        categoryId: categoryRef,
        level: z.enum(["light", "moderate", "stretch"]),
      }),
    )
    .max(6),
  rationale,
});

const INTENTS = [
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
  about: short(400),
  scope: short(500),
  dates: short(200),
  mustHaves: z.array(short(120)).max(10),
  howWeChoose: short(300),
  deliverables: z.array(short(80)).max(8),
});
export const declineOutput = z.object({ text: short(600) });

export const adviceOutput = z.object({
  items: z.array(z.object({ signalId: short(80), title: short(80), why: short(300) })).max(6),
  rationale: rationale.optional(),
});

export const plannerOutput = z.object({
  intent: z.enum(INTENTS),
  categoryId: categoryRef.nullable().optional(),
  expenseDescription: short(120).nullable().optional(),
  suggestDirective: z.boolean(),
  reply: short(600).optional(),
  rationale,
});
