import { randomUUID } from "node:crypto";
import multer from "multer";
import { Router } from "express";
import { hideAmounts } from "../core/amount.js";
import { canPost, canView } from "../core/permissions.js";
import { HttpError, ownEvent, requireUser, validate } from "../http.js";
import { assertRoom, readUpload, saveUpload } from "../store/files.js";
import { addMessage } from "../store/workspace.js";
import { detectFileType, MAX_FILE_BYTES, MAX_FILES } from "../validation/uploads.js";
import { eventParam, fileParam, groupMessages, postMessage } from "../validation/schemas.js";
import { replyAsPlanner } from "./plannerReply.js";
import { directiveView, messageView, redactForVendor } from "./views.js";

const HUDDLE = /@huddle\b/i;
const MAX_VENDOR_MESSAGES = 50;
const MAX_VENDOR_SCAN = 100;
const MAX_ACTIVITY = 12;
const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers send file names as UTF-8; the default would read them as Latin-1.
  defParamCharset: "utf8",
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 5, fieldSize: 20_000, parts: 12 },
}).array("files", MAX_FILES);
const maybeUpload = (req, res, next) =>
  req.is("multipart/form-data") ? upload(req, res, next) : next();

// Other events' groups look the same as missing ones.
function groupOf(req, id) {
  const group = req.app.locals.store.groups.get(id);
  if (!group || group.eventId !== req.user.eventId)
    throw HttpError(404, "NOT_FOUND", "No such group.");
  return group;
}

/** Group history, posting with attachments, `@huddle`, and downloading files. */
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
    maybeUpload,
    aiIfMentioned,
    validate(postMessage),
    async (req, res) => {
      const { store, uploadsDir } = req.app.locals;
      const group = groupOf(req, req.valid.params.id);
      if (!canPost(store.roleOf(req.user), group))
        throw HttpError(403, "FORBIDDEN", "You can't post in this group.");
      // Old messages make way for new ones, so one vendor can't push out the team's history.
      if (
        req.user.kind === "vendor" &&
        store
          .messagesForGroup(group.id, { limit: MAX_VENDOR_SCAN })
          .messages.filter(({ authorId }) => authorId === req.user.id).length >= MAX_VENDOR_MESSAGES
      )
        throw HttpError(
          429,
          "RATE_LIMITED",
          "That's a lot of messages. Please ask the team to reply.",
        );
      const text = (req.valid.body.text ?? "").trim();
      const files = req.files ?? [];
      if (!text && files.length === 0)
        throw HttpError(400, "BAD_REQUEST", "Write a message or attach a file.");
      // Every file is judged first, so one bad file means nothing is saved.
      if (files.some(({ buffer }) => !detectFileType(buffer)))
        throw HttpError(400, "UNSUPPORTED_FILE", "Only PDF, PNG, JPG or WEBP files are allowed.");
      assertRoom(
        store,
        group.eventId,
        files.map(({ size }) => size),
      );
      const nowIso = new Date().toISOString();
      const records = [];
      for (const file of files) {
        records.push(
          await saveUpload(store, uploadsDir, {
            buffer: file.buffer,
            originalName: file.originalname,
            groupId: group.id,
            userId: req.user.id,
            nowIso,
          }),
        );
      }
      const asksHuddle = HUDDLE.test(text) && req.user.kind !== "vendor";
      const message = addMessage(store, {
        id: `m-${randomUUID().slice(0, 8)}`,
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
        message:
          req.user.kind === "vendor"
            ? redactForVendor(messageView(store, message), req.user.id)
            : messageView(store, message),
      });
      if (req.user.kind !== "vendor")
        store.reactInDemo?.("message", {
          event: store.events.get(group.eventId),
          group,
          user: req.user,
          text,
        });
      // Human messages go only to the group they were posted in. Only an @huddle mention brings
      // in the Planner, and its reply is posted in the same group.
      if (asksHuddle) {
        const work = replyAsPlanner({
          store,
          event: store.events.get(group.eventId),
          group,
          user: req.user,
          message,
          askedText: text,
          files: files.map(({ buffer, originalname }, i) => ({
            mime: records[i].mime,
            buffer,
            name: originalname,
          })),
        }).finally(() => store.background.delete(work));
        store.background.add(work);
      }
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

  // A file is visible only to members of the group it was posted in.
  router.get("/files/:id", requireUser, validate(fileParam), async (req, res) => {
    const { store, uploadsDir } = req.app.locals;
    const record = store.files.get(req.valid.params.id);
    const group = record && store.groups.get(record.groupId);
    if (!group || group.eventId !== req.user.eventId)
      throw HttpError(404, "NOT_FOUND", "No such file.");
    if (!canView(store.roleOf(req.user), { type: "file", group }))
      throw HttpError(403, "FORBIDDEN", "You are not in the group this file was posted in.");
    // Rival quotes and budgets can live in this group's files, so a vendor gets only their own.
    if (req.user.kind === "vendor" && record.uploadedBy !== req.user.id)
      throw HttpError(403, "FORBIDDEN", "This file is for the event team.");
    const bytes = await readUpload(uploadsDir, record).catch(() => {
      throw HttpError(404, "NOT_FOUND", "No such file.");
    });
    // Header values must be plain ASCII: a readable fallback, and the real name in filename*.
    const ascii = record.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    res.set({
      "Content-Type": record.mime,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(record.originalName)}`,
      // The type was checked from the file's own bytes when it was saved; browsers must not guess.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    res.send(bytes);
  });

  return router;
}
