import multer from "multer";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildRfq, extractQuote, quoteFromExtracted } from "../agents/vendor.js";
import { describeChange } from "../agents/budget.js";
import { computeBudget } from "../core/budgetEngine.js";
import { quoteWarnings, scoreReasons } from "../core/hiring.js";
import { wholeMoney } from "../core/money.js";
import { scoreQuotes } from "../core/quoteScoring.js";
import { canPost } from "../core/permissions.js";
import { getTemplate } from "../core/templates.js";
import { HttpError, ownEvent, requireBudget, requireUser, validate } from "../http.js";
import { assertRoom, saveUpload } from "../store/files.js";
import { postAgentMessage } from "../store/workspace.js";
import { MAX_FILE_BYTES } from "../validation/uploads.js";
import * as schemas from "../validation/schemas.js";
import { storePending } from "./budget.js";
import { briefOf } from "./hiringSupport.js";
import {
  categoryGroup,
  eventQuotes,
  findQuote,
  fromFields,
  quoteView,
  requireCategory,
} from "./vendorSupport.js";

const MAX_QUOTES_PER_EVENT = 30;
const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers send file names as UTF-8; the default would read them as Latin-1.
  defParamCharset: "utf8",
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, fieldSize: 20_000, parts: 12 },
}).single("file");

// Multipart only when a file is sent; plain JSON goes straight through.
const maybeUpload = (req, res, next) =>
  req.is("multipart/form-data") ? upload(req, res, next) : next();

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
      const name = template.categories.find(({ id }) => id === categoryId).name;
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
    maybeUpload,
    validate(schemas.createQuote),
    async (req, res) => {
      const { store, uploadsDir } = req.app.locals;
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
      let file = null;
      if (req.file) {
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
        file = {
          id: record.id,
          mime: record.mime,
          buffer: req.file.buffer,
          name: record.originalName,
        };
      }

      const typed = body.vendorName || body.perGuestText || body.fixedText;
      if (!typed && !body.text?.trim() && !file)
        throw HttpError(400, "BAD_REQUEST", "Add the quote as text, a file or details.");
      let read;
      try {
        read =
          typed && !file
            ? {
                ...quoteFromExtracted(fromFields(body), {
                  categoryId: body.categoryId,
                  profile: event,
                  fileId: null,
                }),
                rationale: "",
                offline: false,
              }
            : await extractQuote({
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
      const quote = read.quote ?? read.extractedQuote;
      // A person typed these themselves, so there is nothing to confirm.
      if (typed && !file && (quote.perGuestMinor || quote.fixedMinor)) quote.status = "confirmed";
      const saved = { ...quote, id: `q-${randomUUID().slice(0, 8)}`, eventId: event.id };
      store.quotes.set(saved.id, saved);
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
    if (!quote.perGuestMinor && !quote.fixedMinor)
      throw HttpError(400, "BAD_REQUEST", warnings.at(-1) ?? "Please enter a price.");
    const saved = {
      ...quote,
      id: existing.id,
      eventId: existing.eventId,
      status: "confirmed",
      sources: existing.sources ?? {},
    };
    store.quotes.set(saved.id, saved);
    res.json({ quote: saved, warnings });
  });

  router.get("/events/:id/comparison", requireUser, validate(schemas.quoteList), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const state = requireBudget(store, event);
    const { categoryId } = req.valid.query;
    requireCategory(req, getTemplate(event.eventType), categoryId);
    const quotes = eventQuotes(store, event.id);
    const scored = scoreQuotes(quotes, {
      guestCount: state.guestCount,
      // Only the manager's score reflects the ranking: rank plus amount would reveal the total.
      priorities: req.user.kind === "manager" ? event.priorities : [],
      mustHaves: event.mustHaves,
      categoryId,
      absoluteMustHaveId: event.absoluteMustHaveId,
    });
    const byId = new Map(quotes.map((quote) => [quote.id, quote]));
    const planMinor = computeBudget(state).categories.find(
      ({ id }) => id === categoryId,
    ).committedMinor;
    const money = (minor) => wholeMoney(minor, state.currency);
    const cheapest = Math.min(...scored.map(({ totalMinor }) => totalMinor));
    const rows = scored
      .map((row) => {
        const quote = byId.get(row.quoteId);
        const { status, includes, answers, mustHaveIdsMet } = quote;
        return {
          ...row,
          status,
          includes,
          answers,
          mustHaveIdsMet,
          reasons: scoreReasons(row, {
            cheapestMinor: cheapest,
            mustHaveCount: event.mustHaves.filter((item) => item.categoryId === categoryId).length,
            taxStated: quote.taxStated,
          }),
          warnings: quoteWarnings(quote, {
            guestCount: state.guestCount,
            totalMinor: row.totalMinor,
            planMinor,
            money,
          }),
        };
      })
      .sort((a, b) => b.score - a.score);
    res.json({ rows });
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
