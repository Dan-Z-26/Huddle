/** Small pieces the model-answer schemas share. */
import { z } from "zod";

/**
 * Text of at most this many characters.
 * @param {number} max The limit.
 * @returns {import("zod").ZodString} The schema.
 */
export const short = (max) => z.string().max(max);

/** A category, group or tier named by its id. */
export const categoryRef = short(60);

/** The short user-facing reason every model answer gives. */
export const rationale = short(300);
