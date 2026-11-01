/** Vendor hiring: the board, briefs and their approval, declining and re-asking vendors. */
import { Router } from "express";
import { draftDecline } from "../agents/hiring.js";
import { SAMPLE_QUOTES } from "../agents/sampleQuotes.js";
import { mentionsMoney } from "../core/amount.js";
import { managerChecklist, PIPELINE, pipelineStage } from "../core/hiring.js";
import { categoryName, getTemplate } from "../core/templates.js";
import {
  badRequest,
  forbidden,
  ownEvent,
  ownRecord,
  requireBudget,
  requireUser,
  validate,
} from "../http.js";
import { DEMO_EVENT_ID } from "../store/seed.js";
import * as schemas from "../validation/schemas.js";
import { postSpoken } from "../workflows/agentPost.js";
import { deliverablesOf, vendorsOf } from "../workflows/booking.js";
import { briefOf, decideBrief, saveDraftBrief, sendBrief } from "../workflows/briefs.js";
import {
  categoryGroup,
  eventQuotes,
  findQuote,
  mayWorkOn,
  requireCategory,
} from "../workflows/vendors.js";

const hireTasks = (store, eventId, categoryId) =>
  store
    .tasksForEvent(eventId)
    .filter(({ id }) => id.startsWith(`${eventId}-task-hire-${categoryId}-`));

function vendorSummary(store, vendor) {
  const invite = [...store.invites.values()].find((item) => item.vendorUserId === vendor.id);
  const isLive = invite && invite.expiresAt > Date.now();
  return {
    id: vendor.id,
    name: vendor.name,
    quoteId: vendor.quoteId,
    deliverables: deliverablesOf(store, vendor.id),
    inviteExpiresAt: isLive ? new Date(invite.expiresAt).toISOString() : null,
  };
}

// Only the demo event offers its stored sample quotes.
const samplesFor = (event, categoryId) =>
  event.id === DEMO_EVENT_ID
    ? SAMPLE_QUOTES.filter((sample) => sample.categoryId === categoryId).map(
        ({ file, extracted }) => ({ file, vendorName: extracted.vendorName }),
      )
    : [];

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
    samples: samplesFor(event, category.id),
  };
}

function findBrief(req) {
  const { store } = req.app.locals;
  const brief = ownRecord(req, store.briefs, "brief");
  const event = store.events.get(brief.eventId);
  requireCategory(req, getTemplate(event.eventType), brief.categoryId);
  return { brief, event };
}

function getBoard(req, res) {
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
}

async function draftBriefFor(req, res) {
  const { store } = req.app.locals;
  const event = ownEvent(req);
  requireBudget(store, event);
  const template = getTemplate(event.eventType);
  const { categoryId, answers } = req.valid.body;
  requireCategory(req, template, categoryId);
  if (Object.values(answers ?? {}).some(mentionsMoney))
    throw badRequest("A brief goes outside the team, so leave amounts out.");
  const user = req.user;
  const brief = await saveDraftBrief({ store, event, template, categoryId, user, answers });
  res.status(201).json({ brief });
}

function sendForApproval(req, res) {
  const { store } = req.app.locals;
  const { brief, event } = findBrief(req);
  if (brief.status === "approved" || brief.status === "pending")
    throw badRequest("This brief has already been sent.");
  sendBrief({ store, event, brief, user: req.user });
  res.json({ brief });
}

function decideOnBrief(req, res) {
  const { store } = req.app.locals;
  const { brief, event } = findBrief(req);
  if (req.user.kind !== "manager") throw forbidden("Only the event manager can approve a brief.");
  if (brief.status !== "pending") throw badRequest("This brief isn't waiting for approval.");
  const { approve, note } = req.valid.body;
  decideBrief({ store, event, brief, user: req.user, approve, note });
  res.json({ brief });
}

function exportBrief(req, res) {
  const { brief } = findBrief(req);
  res.type("text/plain").attachment(`brief-${brief.categoryId}.txt`).send(brief.text);
}

async function draftDeclineFor(req, res) {
  const { quote, event } = findQuote(req);
  if (quote.status === "accepted") throw badRequest("This is the vendor you accepted.");
  quote.declineText ??= await draftDecline({
    vendorName: quote.vendorName,
    categoryName: categoryName(getTemplate(event.eventType), quote.categoryId),
    eventName: event.name,
  });
  res.json({ text: quote.declineText });
}

async function requestRevision(req, res) {
  const { store } = req.app.locals;
  const { quote, event } = findQuote(req);
  if (quote.status !== "accepted")
    throw badRequest("Only a booked vendor can be asked for a revised quote.");
  const group = categoryGroup(store, event, getTemplate(event.eventType), quote.categoryId);
  if (!group) throw badRequest("This category has no group.");
  const { guestCount } = requireBudget(store, event);
  const message = await postSpoken(store, {
    groupId: group.id,
    eventId: event.id,
    agent: "vendor",
    situation: "You are asking the booked vendor in this room for a revised quote.",
    facts: [
      `${req.user.name} asks ${quote.vendorName} for a revised quote for ${guestCount} guests, please.`,
    ],
    nowIso: new Date().toISOString(),
  });
  res.status(201).json({ message });
}

/**
 * Hiring routes.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function hiringRoutes({ ai }) {
  const router = Router();
  const quoteAction = [requireUser, ai, validate(schemas.idParam)];
  router.get("/events/:id/hiring", requireUser, validate(schemas.idParam), getBoard);
  router.post("/events/:id/briefs", requireUser, ai, validate(schemas.createBrief), draftBriefFor);
  router.post("/briefs/:id/send", requireUser, ai, validate(schemas.idParam), sendForApproval);
  router.post(
    "/briefs/:id/decision",
    requireUser,
    ai,
    validate(schemas.briefDecision),
    decideOnBrief,
  );
  router.get("/briefs/:id/export", requireUser, validate(schemas.idParam), exportBrief);
  router.post("/quotes/:id/decline-draft", ...quoteAction, draftDeclineFor);
  router.post("/quotes/:id/request-revision", ...quoteAction, requestRevision);
  return router;
}
