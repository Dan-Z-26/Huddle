import { Router } from "express";
import { hideAmounts } from "../core/amount.js";
import { canPost, canView } from "../core/permissions.js";
import { HttpError, ownEvent, requireUser, validate } from "../http.js";
import { assertRoom, saveUpload } from "../store/files.js";
import { addMessage } from "../store/workspace.js";
import { detectFileType } from "../validation/uploads.js";
import { eventParam, groupMessages, postMessage } from "../validation/schemas.js";
import { maybeFiles } from "./multipart.js";
import { replyAsPlanner } from "./plannerReply.js";
import { directiveView, messageView, redactForVendor } from "../views.js";
import { newId } from "../store/ids.js";

const HUDDLE = /@huddle\b/i;
const MAX_VENDOR_MESSAGES = 50;
const MAX_VENDOR_SCAN = 100;
const MAX_ACTIVITY = 12;
// Other events' groups look the same as missing ones.
function groupOf(req, id) {
  const group = req.app.locals.store.groups.get(id);
  if (!group || group.eventId !== req.user.eventId)
    throw HttpError(404, "NOT_FOUND", "No such group.");
  return group;
}

// Old messages make way for new ones, so one vendor can't push out the team's history.
function refuseVendorFlood(store, group, user) {
  if (user.kind !== "vendor") return;
  const recent = store.messagesForGroup(group.id, { limit: MAX_VENDOR_SCAN }).messages;
  if (recent.filter(({ authorId }) => authorId === user.id).length >= MAX_VENDOR_MESSAGES)
    throw HttpError(429, "RATE_LIMITED", "That's a lot of messages. Please ask the team to reply.");
}

// Every file is judged first, so one bad file means nothing is saved.
function saveAttachments(req, group, nowIso) {
  const { store, uploadsDir } = req.app.locals;
  const files = req.files ?? [];
  if (files.some(({ buffer }) => !detectFileType(buffer)))
    throw HttpError(400, "UNSUPPORTED_FILE", "Only PDF, PNG, JPG or WEBP files are allowed.");
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
    files: (req.files ?? []).map(({ buffer, originalname }, i) => ({
      mime: records[i].mime,
      buffer,
      name: originalname,
    })),
  }).finally(() => store.background.delete(work));
  store.background.add(work);
}

/** Group history, posting with attachments, `@huddle`, and the recent activity feed. */
export function messageRoutes({ ai, chat }) {
  const router = Router();
  // Only a message that calls the Planner uses the AI budget.
  const aiIfMentioned = (req, res, next) =>
    HUDDLE.test(req.body?.text ?? "") && req.user.kind !== "vendor" ? ai(req, res, next) : next();

  router.get("/groups/:id/messages", requireUser, validate(groupMessages), (req, res) => {
    const { store } = req.app.locals;
    const group = groupOf(req, req.valid.params.id);
    if (!canView(store.roleOf(req.user), { type: "group", group }))
      throw HttpError(403, "FORBIDDEN", "You are not in this group.");
    const { before, limit } = req.valid.query;
    const page = store.messagesForGroup(group.id, { before, limit });
    // A vendor joins at acceptance: what the team said before that stays with the team.
    const isVendor = req.user.kind === "vendor";
    const visible = ({ createdAt }) => !isVendor || createdAt >= req.user.joinedAt;
    const shown = (message) =>
      isVendor
        ? redactForVendor(messageView(store, message), req.user.id)
        : messageView(store, message);
    const pinned = [...store.directives.values()]
      .filter(({ groupId }) => groupId === group.id)
      .filter((directive) => visible(store.messages.get(directive.messageId) ?? {}))
      .map((directive) => ({
        ...directiveView(store, directive),
        text: shown(store.messages.get(directive.messageId) ?? { text: "" }).text ?? "",
      }));
    res.json({
      messages: page.messages.filter(visible).map(shown),
      nextBefore: isVendor ? null : page.nextBefore,
      pinned,
    });
  });

  router.post(
    "/groups/:id/messages",
    requireUser,
    chat,
    maybeFiles,
    aiIfMentioned,
    validate(postMessage),
    async (req, res) => {
      const { store } = req.app.locals;
      const group = groupOf(req, req.valid.params.id);
      if (!canPost(store.roleOf(req.user), group))
        throw HttpError(403, "FORBIDDEN", "You can't post in this group.");
      refuseVendorFlood(store, group, req.user);
      const text = (req.valid.body.text ?? "").trim();
      if (!text && !req.files?.length)
        throw HttpError(400, "BAD_REQUEST", "Write a message or attach a file.");
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
      res.status(201).json({
        message: isVendor
          ? redactForVendor(messageView(store, message), req.user.id)
          : messageView(store, message),
      });
      if (!isVendor)
        store.reactInDemo?.("message", {
          event: store.events.get(group.eventId),
          group,
          user: req.user,
          text,
        });
      if (asksHuddle) askPlannerInBackground({ req, store, group, message, text, records });
    },
  );

  // The latest messages across the rooms this person is in, for the first page.
  router.get("/events/:id/activity", requireUser, validate(eventParam), (req, res) => {
    const { store } = req.app.locals;
    const event = ownEvent(req);
    const role = store.roleOf(req.user);
    const rooms = new Map(
      [...store.groups.values()]
        .filter((group) => group.eventId === event.id && canView(role, { type: "group", group }))
        .map((group) => [group.id, group]),
    );
    const latest = [...store.messages.values()]
      .filter(({ groupId }) => rooms.has(groupId))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_ACTIVITY);
    res.json({ messages: latest.map((message) => messageView(store, message)) });
  });

  return router;
}
