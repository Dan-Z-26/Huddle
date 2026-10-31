import { z } from "zod";
import { listEventTypes } from "../core/templates.js";

const id = z.string().min(1).max(80);
const eventTypes = listEventTypes().map(({ eventType }) => eventType);

export const signIn = z.object({ body: z.object({ userId: id }) });
export const createEvent = z.object({ body: z.object({ eventType: z.enum(eventTypes) }) });
export const eventParam = z.object({ params: z.object({ id }) });
export const intake = z.object({
  params: z.object({ id }),
  body: z
    .object({
      answer: z.string().max(2000).optional(),
      mode: z.enum(["opening", "direct"]).optional(),
    })
    .default({}),
});
export const patchProfile = z.object({
  params: z.object({ id }),
  body: z
    .object({
      name: z.string().trim().min(1).max(120),
      purpose: z.string().trim().min(1).max(500),
      city: z.string().trim().min(1).max(80),
      venueType: z.string().trim().min(1).max(80),
      attendeeExperience: z.string().trim().min(1).max(500),
    })
    .partial()
    .strict(),
});
export const groupMessages = z.object({
  params: z.object({ id }),
  query: z.object({
    before: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});
export const proposeChange = z.object({
  params: z.object({ id }),
  body: z.object({ text: z.string().trim().min(1).max(1000) }),
});
const briefAnswer = z.string().trim().max(500).optional();
export const createBrief = z.object({
  params: z.object({ id }),
  body: z
    .object({
      categoryId: id,
      answers: z
        .object({
          scope: briefAnswer,
          deliverables: briefAnswer,
          dates: briefAnswer,
          mustHaves: briefAnswer,
          judging: briefAnswer,
        })
        .strict()
        .optional(),
    })
    .strict(),
});
export const briefParam = z.object({ params: z.object({ id }) });
export const briefDecision = z.object({
  params: z.object({ id }),
  body: z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).strict(),
});
export const vendorParam = z.object({ params: z.object({ id }) });
export const patchDeliverable = z.object({
  params: z.object({ id }),
  body: z.object({ done: z.boolean() }).strict(),
});
export const createExpense = z.object({
  params: z.object({ id }),
  body: z
    .object({
      description: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(80),
      categoryId: id.optional(),
      fromBuffer: z.boolean().optional(),
    })
    .strict(),
});
export const expenseParam = z.object({ params: z.object({ id }) });
export const coverFromBuffer = z.object({
  params: z.object({ id }),
  body: z.object({ categoryId: id }).strict(),
});
export const setBuffer = z.object({
  params: z.object({ id }),
  body: z.object({ percent: z.int().min(0).max(30) }).strict(),
});
export const acceptChange = z.object({
  params: z.object({ id, changeId: id }),
  body: z
    .object({
      cuts: z.array(id).max(20).optional(),
      raise: z.boolean().optional(),
      useBuffer: z.boolean().optional(),
    })
    .strict()
    .default({}),
});
export const reschedule = z.object({
  params: z.object({ id }),
  body: z.object({ date: z.string().trim().min(1).max(200) }),
});
export const taskStatus = z.object({
  params: z.object({ id }),
  body: z.object({ status: z.enum(["todo", "done"]) }),
});

const amountText = z.string().trim().max(80);
const answerText = z.string().trim().max(200).nullable().optional();
export const rfq = z.object({ params: z.object({ id }), body: z.object({ categoryId: id }) });
export const quoteList = z.object({
  params: z.object({ id }),
  query: z.object({ categoryId: id }),
});
// Typed fields, or pasted text. A file arrives as multipart and is handled before this runs.
export const createQuote = z.object({
  params: z.object({ id }),
  body: z.object({
    categoryId: id,
    text: z.string().max(8000).optional(),
    vendorName: z.string().trim().max(120).optional(),
    perGuestText: amountText.optional(),
    fixedText: amountText.optional(),
    taxPercent: z.coerce.number().min(0).max(100).optional(),
    includes: z.string().max(600).optional(),
  }),
});
export const confirmQuote = z.object({
  params: z.object({ id }),
  body: z.object({
    vendorName: z.string().trim().min(1).max(120),
    perGuestText: amountText.optional(),
    fixedText: amountText.optional(),
    taxPercent: z.number().min(0).max(100).optional(),
    includes: z.array(z.string().trim().max(120)).max(15).optional(),
    exclusions: z.array(z.string().trim().max(120)).max(15).optional(),
    minGuests: z.int().min(1).max(100000).optional(),
    validUntil: z.string().trim().max(80).optional(),
    mustHaveIdsMet: z.array(id).max(10).optional(),
    answers: z
      .object({
        staffing: answerText,
        setupHours: answerText,
        cancellationTerms: answerText,
        dietary: answerText,
      })
      .optional(),
  }),
});
export const quoteParam = z.object({ params: z.object({ id }) });
export const fileParam = z.object({ params: z.object({ id }) });
export const postMessage = z.object({
  params: z.object({ id }),
  body: z.object({ text: z.string().max(4000).optional() }).default({}),
});
export const pinDirective = z.object({
  params: z.object({ id }),
  body: z.object({ addressedUserIds: z.array(id).max(30).optional() }).default({}),
});
const roleIds = z.array(id).max(20);
// Shown to people and quoted in AI prompts, so plain words only.
const groupName = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} &'’/-]*$/u, "Please use letters, numbers, spaces, & or -.");
export const createGroup = z.object({
  params: z.object({ id }),
  body: z.object({ name: groupName, memberRoleIds: roleIds }),
});
export const patchGroup = z.object({
  params: z.object({ id }),
  body: z.object({ name: groupName, memberRoleIds: roleIds }).partial().strict(),
});
