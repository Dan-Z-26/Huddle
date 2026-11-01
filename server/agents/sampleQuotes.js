/** The demo's sample vendor quotes, and their stored readings for when no model is available. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const DIR = new URL("../../public/samples/", import.meta.url);

const answers = (staffing, setupHours, cancellationTerms) => ({
  staffing,
  setupHours,
  cancellationTerms,
  dietary: null,
});
const sources = (priced, tax) => ({
  price: priced,
  ...(tax ? { tax } : {}),
});

/**
 * The demo's sample quotes: one cheaper but silent on taxes, one premium, and one with a minimum
 * guest count. `scripts/make-samples.mjs` writes each PDF from these lines, and the same fields are
 * the seeded reading, so the demo works end to end with no AI key.
 */
export const SAMPLE_QUOTES = [
  {
    file: "pr-brightline.pdf",
    categoryId: "pr",
    extracted: {
      vendorName: "Brightline PR",
      fixedText: "₹90,000",
      includes: ["Press release", "Media list"],
      exclusions: ["Press kit printing"],
      answers: answers("Two account staff", "1 day", "50% refund up to 14 days before"),
      validUntil: "31 January 2027",
      sources: sources("Campaign fee: Rs 90,000"),
    },
  },
  {
    file: "pr-northstar.pdf",
    categoryId: "pr",
    extracted: {
      vendorName: "Northstar Media",
      fixedText: "₹1,00,000",
      taxPercent: 18,
      includes: ["Press release", "Media list", "Press kits", "On-site press desk"],
      answers: answers("Four account staff", "1 day", "Full refund up to 21 days before"),
      validUntil: "28 February 2027",
      sources: sources("Campaign fee: Rs 1,00,000", "GST at 18%"),
    },
  },
  {
    file: "pr-signal.pdf",
    categoryId: "pr",
    extracted: {
      vendorName: "Signal House",
      perGuestText: "₹450",
      fixedText: "₹20,000",
      taxPercent: 18,
      minGuests: 300,
      includes: ["Press release", "Guest press packs"],
      answers: answers("Three account staff", "1 day", "No refund after 30 days before"),
      validUntil: "15 February 2027",
      sources: sources("Rs 450 per guest plus Rs 20,000 setup", "GST at 18%"),
    },
  },
  {
    file: "food-spice-route.pdf",
    categoryId: "food-beverage",
    extracted: {
      vendorName: "Spice Route Catering",
      perGuestText: "₹1,200",
      includes: ["Buffet", "Service staff"],
      exclusions: ["Crockery hire"],
      answers: answers("One server per 25 guests", "4 hours", "50% refund up to 14 days before"),
      validUntil: "31 January 2027",
      sources: sources("Rs 1,200 per guest"),
    },
  },
  {
    file: "food-saffron.pdf",
    categoryId: "food-beverage",
    extracted: {
      vendorName: "Saffron Table",
      mustHaveIdsMet: ["mh-2"],
      perGuestText: "₹1,600",
      fixedText: "₹25,000",
      taxPercent: 5,
      includes: ["Sit-down menu", "Vegetarian options", "Crockery", "Service staff"],
      answers: answers("One server per 15 guests", "6 hours", "Full refund up to 21 days before"),
      validUntil: "28 February 2027",
      sources: sources("Rs 1,600 per guest plus Rs 25,000 kitchen setup", "GST at 5%"),
    },
  },
  {
    file: "food-harvest.pdf",
    categoryId: "food-beverage",
    extracted: {
      vendorName: "Harvest Kitchen",
      mustHaveIdsMet: ["mh-2"],
      perGuestText: "₹1,350",
      taxPercent: 5,
      minGuests: 250,
      includes: ["Buffet", "Vegetarian options", "Service staff"],
      answers: answers("One server per 20 guests", "5 hours", "75% refund up to 14 days before"),
      validUntil: "15 February 2027",
      sources: sources("Rs 1,350 per guest", "GST at 5%"),
    },
  },
  {
    file: "av-soundworks.pdf",
    categoryId: "av",
    extracted: {
      vendorName: "Soundworks Rental",
      fixedText: "₹1,70,000",
      includes: ["Sound system", "Two screens"],
      exclusions: ["Lighting operator"],
      answers: answers("Two technicians", "8 hours", "50% refund up to 14 days before"),
      validUntil: "31 January 2027",
      sources: sources("Package price: Rs 1,70,000"),
    },
  },
  {
    file: "av-stagecraft.pdf",
    categoryId: "av",
    extracted: {
      vendorName: "Stagecraft Live",
      fixedText: "₹2,10,000",
      taxPercent: 18,
      includes: ["Sound system", "LED wall", "Lighting rig", "Show caller"],
      answers: answers("Six technicians", "12 hours", "Full refund up to 21 days before"),
      validUntil: "28 February 2027",
      sources: sources("Package price: Rs 2,10,000", "GST at 18%"),
    },
  },
  {
    file: "av-pulse.pdf",
    categoryId: "av",
    extracted: {
      vendorName: "Pulse Productions",
      perGuestText: "₹600",
      fixedText: "₹60,000",
      taxPercent: 18,
      minGuests: 300,
      includes: ["Sound system", "Two screens", "Lighting rig"],
      answers: answers("Four technicians", "10 hours", "No refund after 30 days before"),
      validUntil: "15 February 2027",
      sources: sources("Rs 600 per guest plus Rs 60,000 rig fee", "GST at 18%"),
    },
  },
];

let byHash = null;

/**
 * The seeded reading of a sample file, recognised by its exact bytes.
 * @param {Buffer} buffer An uploaded file.
 * @returns {object | null} Fields in the shape of the quote extraction schema, or null.
 */
export function seededReading(buffer) {
  byHash ??= new Map(
    SAMPLE_QUOTES.map(({ file, extracted }) => [hash(readFileSync(new URL(file, DIR))), extracted]),
  );
  return structuredClone(byHash.get(hash(buffer)) ?? null);
}
