/** Group chat: history, posting with attachments, `@huddle`, and the recent activity feed. */
import { Router } from "express";
import { hideAmounts } from "../core/amount.js";
import { canPost, canView } from "../core/permissions.js";
import {
  badRequest,
  forbidden,
  ownEvent,
  ownRecord,
  requireUser,
  tooMany,
  unsupportedFile,
  validate,
} from "../http.js";
import { assertRoom, saveUpload } from "../store/files.js";
import { newId } from "../store/ids.js";
import { addMessage } from "../store/workspace.js";
import { idParam, groupMessages, postMessage } from "../validation/schemas.js";
import { detectFileType } from "../validation/uploads.js";
import { directiveView, messageView, redactForVendor } from "../views.js";
import { replyAsPlanner } from "../workflows/plannerReply.js";
import { maybeFiles } from "./multipart.js";

const HUDDLE = /@huddle\b/i;
const MAX_VENDOR_MESSAGES = 50;
const MAX_VENDOR_SCAN = 100;
const MAX_ACTIVITY = 12;

// A vendor joins at acceptance: what the team said before that stays with the team.
function vendorLens(store, user) {
  const isVendor = user.kind === "vendor";
  return {
    isVisible: ({ createdAt }) => !isVendor || createdAt >= user.joinedAt,
    show: (message) =>
      isVendor
        ? redactForVendor(messageView(store, message), user.id)
        : messageView(store, message),
  };
}

function listMessages(req, res) {
  const { store } = req.app.locals;
  const group = ownRecord(req, store.groups, "group");
  if (!canView(store.roleOf(req.user), { type: "group", group }))
    throw forbidden("You are not in this group.");
  const { before, limit } = req.valid.query;
  const page = store.messagesForGroup(group.id, { before, limit });
  const { isVisible, show } = vendorLens(store, req.user);
  const pinned = [...store.directives.values()]
    .filter(({ groupId }) => groupId === group.id)
    .filter((directive) => isVisible(store.messages.get(directive.messageId) ?? {}))
    .map((directive) => ({
      ...directiveView(store, directive),
      text: show(store.messages.get(directive.messageId) ?? { text: "" }).text ?? "",
    }));
  res.json({
    messages: page.messages.filter(isVisible).map(show),
    nextBefore: req.user.kind === "vendor" ? null : page.nextBefore,
    pinned,
  });
}

// Old messages make way for new ones, so one vendor can't push out the team's history.
function refuseVendorFlood(store, group, user) {
  if (user.kind !== "vendor") return;
  const recent = store.messagesForGroup(group.id, { limit: MAX_VENDOR_SCAN }).messages;
  if (recent.filter(({ authorId }) => authorId === user.id).length >= MAX_VENDOR_MESSAGES)
    throw tooMany("That's a lot of messages. Please ask the team to reply.");
}

// Every file is judged first, so one bad file means nothing is saved.
function saveAttachments(req, group, nowIso) {
  const { store, uploadsDir } = req.app.locals;
  const files = req.files ?? [];
  if (files.some(({ buffer }) => !detectFileType(buffer))) throw unsupportedFile();
  assertRoom(
    store,
    group.eventId,
    files.map(({ size }) => size),
  );
  return Promise.all(
    files.map((file) =>
      saveUpload(store, uploadsDir, {
        buffer: file.buffer,
        originalName: file.originalname,
        groupId: group.id,
        userId: req.user.id,
        nowIso,
      }),
    ),
  );
}

// Only an @huddle mention brings in the Planner, and its reply is posted in the same group. It runs
// after the response, tracked so tests can wait for it.
function askPlannerInBackground({ req, store, group, message, text, records }) {
  const work = replyAsPlanner({
    store,
    event: store.events.get(group.eventId),
    group,
    user: req.user,
    message,
    askedText: text,
    files: (req.files ?? []).map(({ buffer, originalname }, index) => ({
      mime: records[index].mime,
      buffer,
      name: originalname,
    })),
  }).finally(() => store.background.delete(work));
  store.background.add(work);
}

async function postToGroup(req, res) {
  const { store } = req.app.locals;
  const group = ownRecord(req, store.groups, "group");
  if (!canPost(store.roleOf(req.user), group)) throw forbidden("You can't post in this group.");
  refuseVendorFlood(store, group, req.user);
  const text = (req.valid.body.text ?? "").trim();
  if (!text && !req.files?.length) throw badRequest("Write a message or attach a file.");
  const nowIso = new Date().toISOString();
  const records = await saveAttachments(req, group, nowIso);
  const isVendor = req.user.kind === "vendor";
  const asksHuddle = HUDDLE.test(text) && !isVendor;
  const message = addMessage(store, {
    id: newId("m"),
    groupId: group.id,
    authorId: req.user.id,
    authorKind: "human",
    // Telling @huddle about money is routine, and not everyone in a room owns that budget.
    text: asksHuddle ? hideAmounts(text) : text,
    fileIds: records.map(({ id }) => id),
    createdAt: nowIso,
    rationale: null,
  });
  res.status(201).json({ message: vendorLens(store, req.user).show(message) });
  if (!isVendor) {
    const event = store.events.get(group.eventId);
    store.reactInDemo?.("message", { event, group, user: req.user, text });
  }
  if (asksHuddle) askPlannerInBackground({ req, store, group, message, text, records });
}

// The latest messages across the rooms this person is in, for the first page.
function listActivity(req, res) {
  const { store } = req.app.locals;
  const event = ownEvent(req);
  const role = store.roleOf(req.user);
  const rooms = new Set(
    [...store.groups.values()]
      .filter((group) => group.eventId === event.id && canView(role, { type: "group", group }))
      .map(({ id }) => id),
  );
  const latest = [...store.messages.values()]
    .filter(({ groupId }) => rooms.has(groupId))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_ACTIVITY);
  res.json({ messages: latest.map((message) => messageView(store, message)) });
}

/**
 * Message routes.
 * @param {{ai: import("express").RequestHandler, chat: import("express").RequestHandler}} limits
 *   The AI and chat rate limits. Only a message that calls the Planner uses the AI budget.
 * @returns {import("express").Router} The routes.
 */
export function messageRoutes({ ai, chat }) {
  const router = Router();
  const aiIfMentioned = (req, res, next) =>
    HUDDLE.test(req.body?.text ?? "") && req.user.kind !== "vendor" ? ai(req, res, next) : next();
  router.get("/groups/:id/messages", requireUser, validate(groupMessages), listMessages);
  router.post(
    "/groups/:id/messages",
    requireUser,
    chat,
    maybeFiles,
    aiIfMentioned,
    validate(postMessage),
    postToGroup,
  );
  router.get("/events/:id/activity", requireUser, validate(idParam), listActivity);
  return router;
}
