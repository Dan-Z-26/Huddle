import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../http.js";
import { detectFileType, safeFileName } from "../validation/uploads.js";
import { newId } from "./ids.js";

const MAX_EVENT_BYTES = 50 * 1024 * 1024;
const MAX_EVENT_FILES = 40;

/**
 * Stores an uploaded file under a random name outside `public/`, and records it against the group
 * it was posted in. Who may read it follows from that group.
 * @param {object} store The store.
 * @param {string} uploadsDir Directory for uploads.
 * @param {{buffer: Buffer, originalName: string, groupId: string, userId: string,
 *   nowIso?: string}} upload The file and who posted it where.
 * @returns {Promise<object | null>} The FileRecord, or null when the contents are not an allowed
 *   type (nothing is written then).
 */
export async function saveUpload(
  store,
  uploadsDir,
  { buffer, originalName, groupId, userId, nowIso = new Date().toISOString() },
) {
  const type = detectFileType(buffer);
  if (!type) return null;
  const storedName = `${randomUUID()}.${type.ext}`;
  // Named for what the bytes are: a download keeps this name, and "quote.html" would open as a page.
  const base = safeFileName(originalName).replace(/\.[^.]*$/, "") || "file";
  const record = {
    id: newId("f"),
    groupId,
    originalName: `${base}.${type.ext}`,
    mime: type.mime,
    size: buffer.length,
    storedName,
    uploadedBy: userId,
    createdAt: nowIso,
  };
  // Counted before the first wait, so uploads running side by side can't all pass assertRoom.
  store.files.set(record.id, record);
  try {
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, storedName), buffer, { flag: "wx" });
  } catch (err) {
    store.files.delete(record.id);
    throw err;
  }
  return record;
}

/**
 * Reads a stored file. The name comes from our own record, never from a request.
 * @param {string} uploadsDir Directory for uploads.
 * @param {{storedName: string}} record The FileRecord.
 * @returns {Promise<Buffer>} The contents.
 */
export const readUpload = (uploadsDir, record) => readFile(join(uploadsDir, record.storedName));

/**
 * Refuses an upload that would take an event past its share of disk, so uploads can't fill it.
 * @param {object} store The store.
 * @param {string} eventId The event.
 * @param {number[]} sizes Byte sizes of the files about to be saved.
 * @throws {Error} 413 when the event has used up its allowance.
 */
export function assertRoom(store, eventId, sizes) {
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  let count = sizes.length;
  for (const { groupId, size } of store.files.values()) {
    if (store.groups.get(groupId)?.eventId !== eventId) continue;
    bytes += size;
    count += 1;
  }
  if (bytes > MAX_EVENT_BYTES || count > MAX_EVENT_FILES)
    throw HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "This event has used all the file space the demo allows.",
    );
}

/**
 * Removes stored files from disk. Failures are ignored: a file that is already gone is fine.
 * @param {string} uploadsDir Directory for uploads.
 * @param {Array<{storedName: string}>} records The FileRecords.
 * @returns {Promise<void>} Resolves when done.
 */
export async function removeUploads(uploadsDir, records) {
  await Promise.all(
    records.map(({ storedName }) => rm(join(uploadsDir, storedName), { force: true })),
  );
}
