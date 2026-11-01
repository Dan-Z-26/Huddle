/** Adding a vendor quote: saving its file, reading it, and telling the people it concerns. */
import { extractQuote, quoteFromExtracted } from "../agents/vendorQuotes.js";
import { mentionsMoney } from "../core/amount.js";
import { canPost } from "../core/permissions.js";
import { categoryName } from "../core/templates.js";
import { forbidden, unsupportedFile } from "../http.js";
import { assertRoom, saveUpload } from "../store/files.js";
import { CORE_TEAM, groupIdFor, newId } from "../store/ids.js";
import { hasVendor } from "../views.js";
import { postSpoken } from "./agentPost.js";
import { categoryGroup, eventQuotes, fromFields } from "./vendors.js";

/**
 * Saves a quote's file in the category's room, so only someone who can post there may add one.
 * @param {import("express").Request} req The request, which may hold a file.
 * @param {{id: string}} event The event.
 * @param {object | undefined} group The category's room.
 * @returns {Promise<object | null>} The file for the Vendor agent to read, or null when none came.
 * @throws {Error} 403 for someone who can't post there, 400 for a file type that isn't allowed.
 */
export async function saveQuoteFile(req, event, group) {
  if (!req.file) return null;
  const { store, uploadsDir } = req.app.locals;
  if (!group || !canPost(store.roleOf(req.user), group))
    throw forbidden("You can't add files to this category's group.");
  assertRoom(store, event.id, [req.file.size]);
  const record = await saveUpload(store, uploadsDir, {
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    groupId: group.id,
    userId: req.user.id,
  });
  if (!record) throw unsupportedFile();
  return { id: record.id, mime: record.mime, buffer: req.file.buffer, name: record.originalName };
}

// A person typed these themselves, so there is nothing to confirm. Unless part of it couldn't be
// read, when they need to see what was understood.
function readTyped(event, body) {
  const { quote, warnings } = quoteFromExtracted(fromFields(body), {
    categoryId: body.categoryId,
    profile: event,
    fileId: null,
  });
  const status = warnings.length === 0 ? "confirmed" : quote.status;
  return { quote: { ...quote, status }, warnings, rationale: "", offline: false };
}

/**
 * Reads a quote: fields a person typed are parsed in code; pasted text and files go to the Vendor
 * agent. A file that was saved but can't be read is removed, since no quote would refer to it.
 * @param {{store: object, event: object, template: object, body: object, file: object | null,
 *   typed: boolean}} input The event, the request body, its saved file, and whether it holds typed
 *   details.
 * @returns {Promise<{quote: object, warnings: string[], rationale: string, offline: boolean}>} What
 *   was understood.
 */
export async function readQuote({ store, event, template, body, file, typed }) {
  if (typed && !file) return readTyped(event, body);
  try {
    const { extractedQuote, ...read } = await extractQuote({
      profile: event,
      categoryId: body.categoryId,
      template,
      text: body.text ?? "",
      file,
    });
    return { quote: extractedQuote, ...read };
  } catch (err) {
    if (file) {
      const record = store.files.get(file.id);
      store.files.delete(file.id);
      if (record) store.discardFiles([record]);
    }
    throw err;
  }
}

/**
 * Tells the category's room, and so the event manager, that a quote has been added and is ready to
 * compare. The Vendor agent words it from facts code supplies; it never carries an amount, so
 * anyone in the room may read it.
 * @param {{store: object, event: object, template: object, quote: object, user: object}} input The
 *   confirmed quote, who added it, and where it belongs.
 */
export function announceQuote({ store, event, template, quote, user }) {
  store.nudge(event.id, "quotes.updated", "attention.updated");
  const own = categoryGroup(store, event, template, quote.categoryId);
  if (!own) return;
  // A booked vendor reads their category's room, and must not learn a rival's name.
  const room = hasVendor(store, own) ? store.groups.get(groupIdFor(event.id, CORE_TEAM)) : own;
  if (!room) return;
  const vendor = mentionsMoney(quote.vendorName) ? "a vendor" : quote.vendorName;
  const waiting = eventQuotes(store, event.id).filter(
    (item) => item.categoryId === quote.categoryId && item.status === "confirmed",
  ).length;
  const source = quote.sourceFileId ? ", read from an uploaded file and checked by them" : "";
  postSpoken(store, {
    groupId: room.id,
    eventId: event.id,
    agent: "vendor",
    situation: "A team member has just added a vendor quote and the event manager needs to know.",
    facts: [
      `${user.name} added a quote from ${vendor} for ${categoryName(template, quote.categoryId)}${source}.`,
      waiting > 1
        ? `There are now ${waiting} quotes to compare.`
        : "It is the first quote for this category.",
      "The event manager can compare them under Vendors and quotes.",
    ],
    nowIso: new Date().toISOString(),
  });
}

/**
 * Stores a newly read quote and tells people about it, once it is ready to compare.
 * @param {{store: object, event: object, template: object, quote: object, user: object}} input The
 *   quote as read, and where it belongs.
 * @returns {object} The stored quote.
 */
export function storeNewQuote({ store, event, template, quote, user }) {
  const saved = { ...quote, id: newId("q"), eventId: event.id };
  store.quotes.set(saved.id, saved);
  if (saved.status === "confirmed") announceQuote({ store, event, template, quote: saved, user });
  else store.nudge(event.id, "quotes.updated");
  return saved;
}
