/** Vendor checklists and RFQs, quotes from text, files or fields, comparison, and accepting one. */
import { Router } from "express";
import { buildRfq } from "../agents/vendor.js";
import { quoteFromExtracted } from "../agents/vendorQuotes.js";
import { categoryName, getTemplate } from "../core/templates.js";
import { badRequest, forbidden, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { agentIdFor } from "../store/ids.js";
import { postAgentMessage } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { briefOf } from "../workflows/briefs.js";
import { proposeInCode } from "../workflows/budgetChange.js";
import { announceQuote, readQuote, saveQuoteFile, storeNewQuote } from "../workflows/quotes.js";
import {
  categoryGroup,
  comparisonRows,
  eventQuotes,
  findQuote,
  fromFields,
  quoteView,
  requireCategory,
} from "../workflows/vendors.js";
import { maybeOneFile } from "./multipart.js";

const MAX_QUOTES_PER_EVENT = 30;

// The event and budget a request about one category needs, once it may work on that category.
function categoryContext(req, categoryId) {
  const { store } = req.app.locals;
  const event = ownEvent(req);
  const state = requireBudget(store, event);
  const template = getTemplate(event.eventType);
  requireCategory(req, template, categoryId);
  return { store, event, state, template };
}

// The questions are posted in the category's room once, so everyone asks vendors the same things.
function postRfqOnce({ store, event, template, categoryId, rfq }) {
  const group = categoryGroup(store, event, template, categoryId);
  const key = `${event.id}:${categoryId}`;
  if (!group || store.rfqPosted.has(key)) return null;
  store.rfqPosted.add(key);
  const questions = rfq.rfqQuestions.map((question) => `- ${question}`).join("\n");
  return postAgentMessage(store, {
    groupId: group.id,
    authorId: agentIdFor("vendor", event.id),
    text: `${categoryName(template, categoryId)}: what to ask every vendor\n${questions}`,
    rationale: rfq.rationale || null,
    nowIso: new Date().toISOString(),
  });
}

async function getRfq(req, res) {
  const { categoryId } = req.valid.body;
  const { store, event, template } = categoryContext(req, categoryId);
  const rfq = await buildRfq({ profile: event, categoryId, template });
  res.json({ ...rfq, message: postRfqOnce({ store, event, template, categoryId, rfq }) });
}

function listQuotes(req, res) {
  const { categoryId } = req.valid.query;
  const { store, event, state } = categoryContext(req, categoryId);
  const quotes = eventQuotes(store, event.id).filter((quote) => quote.categoryId === categoryId);
  res.json({ quotes: quotes.map((quote) => quoteView(quote, state.guestCount)) });
}

function refuseNewQuote(store, event, categoryId) {
  if (briefOf(store, event.id, categoryId)?.status !== "approved")
    throw badRequest("Get this category's brief approved first.");
  if (eventQuotes(store, event.id).length >= MAX_QUOTES_PER_EVENT)
    throw badRequest("This event has as many quotes as the demo allows.");
}

async function addQuote(req, res) {
  const { body } = req.valid;
  const { store, event, template } = categoryContext(req, body.categoryId);
  refuseNewQuote(store, event, body.categoryId);
  const group = categoryGroup(store, event, template, body.categoryId);
  const file = await saveQuoteFile(req, event, group);
  const typed = Boolean(body.vendorName || body.perGuestText || body.fixedText);
  if (!typed && !body.text?.trim() && !file)
    throw badRequest("Add the quote as text, a file or details.");
  const { quote, warnings, rationale, offline } = await readQuote({
    store,
    event,
    template,
    body,
    file,
    typed,
  });
  const saved = storeNewQuote({ store, event, template, quote, user: req.user });
  res.status(201).json({ quote: saved, warnings, rationale, offline });
}

function confirmQuote(req, res) {
  const { store } = req.app.locals;
  const { quote: existing, event } = findQuote(req);
  if (existing.status === "accepted") throw badRequest("An accepted quote can't be edited.");
  const { quote, warnings } = quoteFromExtracted(fromFields(req.valid.body), {
    categoryId: existing.categoryId,
    profile: event,
    fileId: existing.sourceFileId,
  });
  if (warnings.length) throw badRequest(`${warnings[0]}. Please check it.`);
  const saved = {
    ...quote,
    id: existing.id,
    eventId: existing.eventId,
    status: "confirmed",
    sources: existing.sources ?? {},
  };
  store.quotes.set(saved.id, saved);
  // Told once, when it first becomes usable; later edits to a confirmed quote are quiet.
  if (existing.status === "confirmed") store.nudge(event.id, "quotes.updated");
  else {
    const template = getTemplate(event.eventType);
    announceQuote({ store, event, template, quote: saved, user: req.user });
  }
  res.json({ quote: saved, warnings });
}

function compareQuotes(req, res) {
  const { categoryId } = req.valid.query;
  const { store, event, state } = categoryContext(req, categoryId);
  const viewerIsManager = req.user.kind === "manager";
  res.json({ rows: comparisonRows({ store, event, state, categoryId, viewerIsManager }) });
}

// Accepting a quote changes committed money, so it is shown like any other change first: the
// manager sees the consequences, then applies it through the same route as a typed change.
async function proposeAccepting(req, res) {
  const { store } = req.app.locals;
  if (req.user.kind !== "manager") throw forbidden("Only the event manager can accept a quote.");
  const { quote, event } = findQuote(req);
  const state = requireBudget(store, event);
  if (quote.status === "extracted")
    throw badRequest("Please confirm what was read from this quote first.");
  if (quote.status === "accepted") throw badRequest("This quote has already been accepted.");
  const { id: quoteId, perGuestMinor, fixedMinor, taxBps } = quote;
  const proposal = await proposeInCode(store, {
    event,
    state,
    seenState: { ...state, quotes: eventQuotes(store, event.id) },
    events: [{ type: "quote_accepted", quoteId, confidence: 1 }],
    text: `Accept the ${quote.vendorName} quote`,
    quoteGuard: { quoteId, perGuestMinor, fixedMinor, taxBps },
  });
  res.json(proposal);
}

/**
 * Vendor and quote routes.
 * @param {{ai: import("express").RequestHandler}} limits The AI rate limit.
 * @returns {import("express").Router} The routes.
 */
export function vendorRoutes({ ai }) {
  const router = Router();
  router.post("/events/:id/rfq", requireUser, ai, validate(schemas.rfq), getRfq);
  router.get("/events/:id/quotes", requireUser, validate(schemas.quoteList), listQuotes);
  router.post(
    "/events/:id/quotes",
    requireUser,
    ai,
    maybeOneFile,
    validate(schemas.createQuote),
    addQuote,
  );
  router.post("/quotes/:id/confirm", requireUser, validate(schemas.confirmQuote), confirmQuote);
  router.get("/events/:id/comparison", requireUser, validate(schemas.quoteList), compareQuotes);
  router.post("/quotes/:id/accept", requireUser, ai, validate(schemas.idParam), proposeAccepting);
  return router;
}
