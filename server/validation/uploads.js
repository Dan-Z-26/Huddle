export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 3;

// The first bytes of each allowed type. A file's name and its claimed type are never trusted.
const SIGNATURES = [
  { mime: "application/pdf", ext: "pdf", at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  {
    mime: "image/png",
    ext: "png",
    at: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: "image/jpeg", ext: "jpg", at: 0, bytes: [0xff, 0xd8, 0xff] },
];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

const startsWith = (buffer, at, bytes) =>
  buffer.length >= at + bytes.length && bytes.every((byte, i) => buffer[at + i] === byte);

/**
 * Works out what a file really is from its first bytes. Only PDF, PNG, JPEG and WEBP pass; SVG,
 * HTML and everything else are refused, whatever the file is called.
 * @param {Buffer} buffer The file's contents.
 * @returns {{mime: string, ext: string} | null} The type, or null when it is not allowed.
 */
export function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const found = SIGNATURES.find(({ at, bytes }) => startsWith(buffer, at, bytes));
  if (found) return { mime: found.mime, ext: found.ext };
  if (startsWith(buffer, 0, RIFF) && startsWith(buffer, 8, WEBP))
    return { mime: "image/webp", ext: "webp" };
  return null;
}

/**
 * Cleans a client-supplied file name for display and for Content-Disposition: no path, no control
 * characters, a sensible length. It is never used to store the file.
 * @param {string} name The name the client sent.
 * @returns {string} A safe display name.
 */
export function safeFileName(name) {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|?*:]/g, "")
    .trim()
    .slice(0, 100);
  return base || "file";
}
