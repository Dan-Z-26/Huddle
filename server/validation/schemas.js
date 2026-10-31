import { z } from "zod";
import { listEventTypes } from "../core/templates.js";

const id = z.string().min(1).max(80);
const eventTypes = listEventTypes().map(({ eventType }) => eventType);

export const viewAs = z.object({ body: z.object({ userId: id }) });
export const createEvent = z.object({ body: z.object({ eventType: z.enum(eventTypes) }) });
export const eventParam = z.object({ params: z.object({ id }) });
export const intake = z.object({
  params: z.object({ id }),
  body: z.object({ answer: z.string().max(2000).optional() }).default({}),
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
export const acceptChange = z.object({
  params: z.object({ id, changeId: id }),
  body: z
    .object({ cuts: z.array(id).max(20).optional(), raise: z.boolean().optional() })
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
