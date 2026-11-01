import { Router } from "express";
import { buildRfq } from "../agents/vendor.js";
import { extractQuote, quoteFromExtracted } from "../agents/vendorQuotes.js";
import { describeChange } from "../agents/budget.js";
import { canPost } from "../core/permissions.js";
import { categoryName, getTemplate } from "../core/templates.js";
import { HttpError, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { assertRoom, saveUpload } from "../store/files.js";
import { postAgentMessage } from "../store/workspace.js";
import * as schemas from "../validation/schemas.js";
import { storePending } from "./budget.js";
import { briefOf } from "./hiringSupport.js";
import { maybeOneFile } from "./multipart.js";
import { announceQuote } from "./quoteNotice.js";
import {
  categoryGroup,
  comparisonRows,
  eventQuotes,
  findQuote,
  fromFields,
  quoteView,
  requireCategory,
} from "./vendorSupport.js";
import { newId } from "../store/ids.js";

const MAX_QUOTES_PER_EVENT = 30;

// A quote file is posted in the category's group, so only someone who can post there may add one.
async function saveQuoteFile(req, event, group) {
  if (!req.file) return null;
  const { store, uploadsDir } = req.app.locals;
  if (!group || !canPost(store.roleOf(req.user), group))
    throw HttpError(403, "FORBIDDEN", "You can't add files to this category's group.");
  assertRoom(store, event.id, [req.file.size]);
  const record = await saveUpload(store, uploadsDir, {
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    groupId: group.id,
    userId: req.user.id,
  });
  if (!record)
    throw HttpError(400, "UNSUPPORTED_FILE", "Only PDF, PNG, JPG or WEBP files are allowed.");
  return { id: record.id, mime: record.mime, buffer: req.file.buffer, name: record.originalName };
}

// Fields a person typed are parsed in code; pasted text and files go to the Vendor agent.
async function readQuote({ store, event, template, body, file, typedOnly }) {
  try {
    if (typedOnly)
      return {
        ...quoteFromExtracted(fromFields(body), {
          categoryId: body.categoryId,
          profile: event,
          fileId: null,
        }),
        rationale: "",
        offline: false,
      };
    return await extractQuote({
      profile: event,
      categoryId: body.categoryId,
      template,
      text: body.text ?? "",
      file,
    });
  } catch (err) {
    // The file was saved before it was read; without a quote nothing refers to it.
    if (file) {
      const record = store.files.get(file.id);
      store.files.delete(file.id);
      if (record) store.discardFiles([record]);
    }
    throw err;
  }
}

/** Vendor checklists and RFQs, quotes from text, files or fields, comparison, and accepting one. */
export function vendorRoutes({ ai }) {
  const router = Router();

  router.post("/events/:id/rfq", requireUser, ai, validate(schemas.rfq), async (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    requireBudget(store, event);
    const template = getTemplate(event.eventType);
    const { categoryId } = req.valid.body;
    requireCategory(req, template, categoryId);
    const rfq = await buildRfq({ profile: event, categoryId, template });
    const group = categoryGroup(store, event, template, categoryId);
    const key = `${event.id}:${categoryId}`;
    let message = null;
    if (group && !store.rfqPosted.has(key)) {
      store.rfqPosted.add(key);
      const name = categoryName(template, categoryId);
      message = postAgentMessage(store, {
        groupId: group.id,
        authorId: `agent-vendor@${event.id}`,
        text: `${name}: what to ask every vendor\n${rfq.rfqQuestions.map((q) => `- ${q}`).join("\n")}`,
        rationale: rfq.rationale || null,
        nowIso: new Date().toISOString(),
      });
    }
    res.json({ ...rfq, message });
  });

  router.get("/events/:id/quotes", requireUser, validate(schemas.quoteList), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const state = requireBudget(store, event);
    const { categoryId } = req.valid.query;
    requireCategory(req, getTemplate(event.eventType), categoryId);
    const quotes = eventQuotes(store, event.id).filter((quote) => quote.categoryId === categoryId);
    res.json({ quotes: quotes.map((quote) => quoteView(quote, state.guestCount)) });
  });

  router.post(
    "/events/:id/quotes",
    requireUser,
    ai,
    maybeOneFile,
    validate(schemas.createQuote),
    async (req, res) => {
      const { store } = req.app.locals;
      const event = ownEvent(req);
      requireBudget(store, event);
      const template = getTemplate(event.eventType);
      const body = req.valid.body;
      requireCategory(req, template, body.categoryId);
      if (briefOf(store, event.id, body.categoryId)?.status !== "approved")
        throw HttpError(400, "BAD_REQUEST", "Get this category's brief approved first.");
      if (eventQuotes(store, event.id).length >= MAX_QUOTES_PER_EVENT)
        throw HttpError(400, "BAD_REQUEST", "This event has as many quotes as the demo allows.");

      const group = categoryGroup(store, event, template, body.categoryId);
      const file = await saveQuoteFile(req, event, group);
      const typed = body.vendorName || body.perGuestText || body.fixedText;
      if (!typed && !body.text?.trim() && !file)
        throw HttpError(400, "BAD_REQUEST", "Add the quote as text, a file or details.");
      const typedOnly = typed && !file;
      const read = await readQuote({ store, event, template, body, file, typedOnly });
      const quote = read.quote ?? read.extractedQuote;
      // A person typed these themselves, so there is nothing to confirm.
      // Unless part of it couldn't be read, when they need to see what was understood.
      if (typedOnly && read.warnings.length === 0) quote.status = "confirmed";
      const saved = { ...quote, id: newId("q"), eventId: event.id };
      store.quotes.set(saved.id, saved);
      if (saved.status === "confirmed")
        announceQuote({ store, event, template, quote: saved, user: req.user });
      else store.publish({ type: "quotes.updated", eventId: event.id });
      const { warnings, rationale, offline } = read;
      res.status(201).json({ quote: saved, warnings, rationale, offline });
    },
  );

  router.post("/quotes/:id/confirm", requireUser, validate(schemas.confirmQuote), (req, res) => {
    const { store } = req.app.locals;
    const { quote: existing, event } = findQuote(req);
    if (existing.status === "accepted")
      throw HttpError(400, "BAD_REQUEST", "An accepted quote can't be edited.");
    const { quote, warnings } = quoteFromExtracted(fromFields(req.valid.body), {
      categoryId: existing.categoryId,
      profile: event,
      fileId: existing.sourceFileId,
    });
    if (warnings.length) throw HttpError(400, "BAD_REQUEST", `${warnings[0]}. Please check it.`);
    const saved = {
      ...quote,
      id: existing.id,
      eventId: existing.eventId,
      status: "confirmed",
      sources: existing.sources ?? {},
    };
    store.quotes.set(saved.id, saved);
    // Told once, when it first becomes usable; later edits to a confirmed quote are quiet.
    if (existing.status === "confirmed")
      store.publish({ type: "quotes.updated", eventId: event.id });
    else
      announceQuote({
        store,
        event,
        template: getTemplate(event.eventType),
        quote: saved,
        user: req.user,
      });
    res.json({ quote: saved, warnings });
  });

  router.get("/events/:id/comparison", requireUser, validate(schemas.quoteList), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const state = requireBudget(store, event);
    const { categoryId } = req.valid.query;
    requireCategory(req, getTemplate(event.eventType), categoryId);
    const viewerIsManager = req.user.kind === "manager";
    res.json({ rows: comparisonRows({ store, event, state, categoryId, viewerIsManager }) });
  });

  // Accepting a quote changes committed money, so it is shown like any other change first: the
  // manager sees the consequences, then applies it through the same route as a typed change.
  router.post(
    "/quotes/:id/accept",
    requireUser,
    ai,
    validate(schemas.quoteParam),
    async (req, res) => {
      const { store } = req.app.locals;
      if (req.user.kind !== "manager")
        throw HttpError(403, "FORBIDDEN", "Only the event manager can accept a quote.");
      const { quote, event } = findQuote(req);
      const state = requireBudget(store, event);
      if (quote.status === "extracted")
        throw HttpError(400, "BAD_REQUEST", "Please confirm what was read from this quote first.");
      if (quote.status === "accepted")
        throw HttpError(400, "BAD_REQUEST", "This quote has already been accepted.");
      const template = getTemplate(event.eventType);
      const events = [{ type: "quote_accepted", quoteId: quote.id, confidence: 1 }];
      const withQuotes = { ...state, quotes: eventQuotes(store, event.id) };
      const text = `Accept the ${quote.vendorName} quote`;
      const described = await describeChange({
        profile: event,
        state: withQuotes,
        events,
        template,
        text,
      });
      const changeId =
        described.consequences.rejected.length === 0
          ? storePending(store, event, state, events, {
              quoteId: quote.id,
              perGuestMinor: quote.perGuestMinor,
              fixedMinor: quote.fixedMinor,
              taxBps: quote.taxBps,
            })
          : null;
      res.json({
        changeId,
        answer: "",
        estimates: [],
        rationale: "",
        ...described,
      });
    },
  );

  return router;
}
