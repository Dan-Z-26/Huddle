import { Router } from "express";
import { draftDecline } from "../agents/hiring.js";
import { SAMPLE_QUOTES } from "../agents/sampleQuotes.js";
import { mentionsMoney } from "../core/amount.js";
import { managerChecklist, PIPELINE, pipelineStage } from "../core/hiring.js";
import { categoryName, getTemplate } from "../core/templates.js";
import { HttpError, ownEvent, requireUser, requireBudget, validate } from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import * as schemas from "../validation/schemas.js";
import { postSpoken } from "./agentPost.js";
import {
  sendBrief,
  briefOf,
  deliverablesOf,
  saveDraftBrief,
  startHiring,
  vendorsOf,
} from "./hiringSupport.js";
import {
  categoryGroup,
  eventQuotes,
  findQuote,
  mayWorkOn,
  requireCategory,
} from "./vendorSupport.js";

const hireTasks = (store, eventId, categoryId) =>
  store
    .tasksForEvent(eventId)
    .filter(({ id }) => id.startsWith(`${eventId}-task-hire-${categoryId}-`));

function vendorSummary(store, vendor) {
  const invite = [...store.invites.values()].find((item) => item.vendorUserId === vendor.id);
  return {
    id: vendor.id,
    name: vendor.name,
    quoteId: vendor.quoteId,
    deliverables: deliverablesOf(store, vendor.id),
    inviteExpiresAt:
      invite && invite.expiresAt > Date.now() ? new Date(invite.expiresAt).toISOString() : null,
  };
}

function boardRow(store, event, category) {
  const brief = briefOf(store, event.id, category.id);
  const quotes = eventQuotes(store, event.id).filter(
    ({ categoryId }) => categoryId === category.id,
  );
  const tasks = hireTasks(store, event.id, category.id);
  const vendor = vendorsOf(store, event.id, category.id)[0];
  const deliverables = vendor ? deliverablesOf(store, vendor.id) : [];
  return {
    categoryId: category.id,
    name: category.name,
    stage: pipelineStage({ brief, quotes, tasks, deliverables }),
    brief: brief ?? null,
    checklist: managerChecklist({ brief, quotes, tasks }),
    vendor: vendor ? vendorSummary(store, vendor) : null,
    samples:
      event.id === DEMO_EVENT_ID
        ? SAMPLE_QUOTES.filter(({ categoryId }) => categoryId === category.id).map(
            ({ file, extracted }) => ({ file, vendorName: extracted.vendorName }),
          )
        : [],
  };
}

function findBrief(req) {
  const { store } = req.app.locals;
  const brief = store.briefs.get(req.valid.params.id);
  if (!brief || brief.eventId !== req.user.eventId)
    throw HttpError(404, "NOT_FOUND", "No such brief.");
  const event = store.events.get(brief.eventId);
  requireCategory(req, getTemplate(event.eventType), brief.categoryId);
  return { brief, event };
}

/** Vendor hiring: briefs, approval, the board, and declining or re-asking vendors. */
export function hiringRoutes({ ai }) {
  const router = Router();

  router.get("/events/:id/hiring", requireUser, validate(schemas.eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    requireBudget(store, event);
    const role = store.roleOf(req.user);
    const categories = getTemplate(event.eventType).categories.filter(({ id }) =>
      mayWorkOn(role, id),
    );
    res.json({
      stages: PIPELINE.map(([id, label]) => ({ id, label })),
      rows: categories.map((category) => boardRow(store, event, category)),
    });
  });

  router.post(
    "/events/:id/briefs",
    requireUser,
    ai,
    validate(schemas.createBrief),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = ownEvent(req);
      requireBudget(store, event);
      const template = getTemplate(event.eventType);
      const { categoryId, answers } = req.valid.body;
      requireCategory(req, template, categoryId);
      if (Object.values(answers ?? {}).some(mentionsMoney))
        throw HttpError(400, "BAD_REQUEST", "A brief goes outside the team, so leave amounts out.");
      const brief = await saveDraftBrief({
        store,
        event,
        template,
        categoryId,
        user: req.user,
        answers,
      });
      res.status(201).json({ brief });
    },
  );

  router.post("/briefs/:id/send", requireUser, ai, validate(schemas.briefParam), (req, res) => {
    const { store } = req.app.locals;
    const { brief, event } = findBrief(req);
    if (brief.status === "approved" || brief.status === "pending")
      throw HttpError(400, "BAD_REQUEST", "This brief has already been sent.");
    sendBrief({ store, event, brief, user: req.user });
    res.json({ brief });
  });

  router.post(
    "/briefs/:id/decision",
    requireUser,
    ai,
    validate(schemas.briefDecision),
    (req, res) => {
      const { store } = req.app.locals;
      const { brief, event } = findBrief(req);
      if (req.user.kind !== "manager")
        throw HttpError(403, "FORBIDDEN", "Only the event manager can approve a brief.");
      if (brief.status !== "pending")
        throw HttpError(400, "BAD_REQUEST", "This brief isn't waiting for approval.");
      const { approve, note } = req.valid.body;
      const template = getTemplate(event.eventType);
      const nowIso = new Date().toISOString();
      const name = categoryName(template, brief.categoryId);
      brief.status = approve ? "approved" : "changes";
      brief.note = approve ? null : (note ?? null);
      if (approve) startHiring({ store, event, template, categoryId: brief.categoryId, nowIso });
      const group = categoryGroup(store, event, template, brief.categoryId);
      const outcome = approve
        ? `The ${name} brief is approved. You can send it out and add quotes.`
        : `The ${name} brief needs changes${note && !mentionsMoney(note) ? `: ${note}` : "."}`;
      if (group)
        postSpoken(store, {
          groupId: group.id,
          eventId: event.id,
          agent: "vendor",
          situation: `${req.user.name} has just decided on a vendor brief.`,
          facts: [outcome],
          fallback: outcome,
          nowIso,
        });
      store.publish({ type: "attention.updated", eventId: event.id });
      store.reactInDemo?.("brief", { event, categoryId: brief.categoryId, approved: approve });
      res.json({ brief });
    },
  );

  router.get("/briefs/:id/export", requireUser, validate(schemas.briefParam), (req, res) => {
    const { brief } = findBrief(req);
    res.type("text/plain").attachment(`brief-${brief.categoryId}.txt`).send(brief.text);
  });

  router.post(
    "/quotes/:id/decline-draft",
    requireUser,
    ai,
    validate(schemas.quoteParam),
    async (req, res) => {
      const { quote, event } = findQuote(req);
      if (quote.status === "accepted")
        throw HttpError(400, "BAD_REQUEST", "This is the vendor you accepted.");
      const category = getTemplate(event.eventType).categories.find(
        ({ id }) => id === quote.categoryId,
      );
      quote.declineText ??= await draftDecline({
        vendorName: quote.vendorName,
        categoryName: category.name,
        eventName: event.name,
      });
      res.json({ text: quote.declineText });
    },
  );

  router.post(
    "/quotes/:id/request-revision",
    requireUser,
    ai,
    validate(schemas.quoteParam),
    async (req, res) => {
      const { store } = req.app.locals;
      const { quote, event } = findQuote(req);
      if (quote.status !== "accepted")
        throw HttpError(
          400,
          "BAD_REQUEST",
          "Only a booked vendor can be asked for a revised quote.",
        );
      const group = categoryGroup(store, event, getTemplate(event.eventType), quote.categoryId);
      if (!group) throw HttpError(400, "BAD_REQUEST", "This category has no group.");
      const { guestCount } = requireBudget(store, event);
      const ask = `${req.user.name} asks ${quote.vendorName} for a revised quote for ${guestCount} guests, please.`;
      const message = await postSpoken(store, {
        groupId: group.id,
        eventId: event.id,
        agent: "vendor",
        situation: "You are asking the booked vendor in this room for a revised quote.",
        facts: [ask],
        fallback: ask,
        nowIso: new Date().toISOString(),
      });
      res.status(201).json({ message });
    },
  );

  return router;
}
