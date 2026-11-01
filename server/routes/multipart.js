import multer from "multer";
import { HttpError } from "../http.js";
import { MAX_FILE_BYTES, MAX_FILES } from "../validation/uploads.js";

// Uploads are held in memory until they end, and a slow one can be made to last for minutes.
const MAX_ACTIVE_UPLOADS = 8;
let activeUploads = 0;

const parser = ({ files, fields }) =>
  multer({
    storage: multer.memoryStorage(),
    // Browsers send file names as UTF-8; the default would read them as Latin-1.
    defParamCharset: "utf8",
    limits: { fileSize: MAX_FILE_BYTES, files, fields, fieldSize: 20_000, parts: 12 },
  });

// Multipart only when a file is sent; plain JSON goes straight through.
// shortcut: one client can hold every slot until Node's 5-minute request timeout, which delays
// uploads but can't crash the server; give each address its own slots if that ever matters.
const whenMultipart = (parse) => (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  if (activeUploads >= MAX_ACTIVE_UPLOADS)
    return next(HttpError(429, "RATE_LIMITED", "Too many uploads at once. Please try again."));
  activeUploads += 1;
  res.once("close", () => {
    activeUploads -= 1;
  });
  return parse(req, res, next);
};

/** Reads one optional file from the `file` field, for a quote. */
export const maybeOneFile = whenMultipart(parser({ files: 1, fields: 10 }).single("file"));

/** Reads optional attachments from the `files` field, for a chat message. */
export const maybeFiles = whenMultipart(
  parser({ files: MAX_FILES, fields: 5 }).array("files", MAX_FILES),
);
