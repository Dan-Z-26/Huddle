const base = { unitMinor: 0, units: 0, steps: [], source: "user", estimate: null, unpriced: false };

export const fixed = (id, unitMinor, extra = {}) => ({
  ...base,
  id,
  label: id,
  kind: "fixed",
  unitMinor,
  ...extra,
});

export const perGuest = (id, unitMinor, extra = {}) => ({
  ...base,
  id,
  label: id,
  kind: "perGuest",
  unitMinor,
  ...extra,
});

export const estimated = (id, kind, lowMinor, highMinor, extra = {}) => ({
  ...base,
  id,
  label: id,
  kind,
  source: "estimate",
  estimate: { lowMinor, highMinor },
  ...extra,
});

export const category = (id, drivers, extra = {}) => ({
  id,
  name: id,
  locked: false,
  tiers: [],
  drivers,
  ...extra,
});

/** The approved plan's worked example: Rs 16,00,000 fully used at 200 guests. */
export function workedExample() {
  return {
    state: {
      guestCount: 200,
      totalMinor: 160000000,
      currency: "INR",
      quotes: [],
      categories: [
        category("reveal", [fixed("reveal-fixed", 60000000)], { name: "Product reveal" }),
        category("fnb", [perGuest("plate", 200000)], { name: "Food & beverage" }),
        category("decor", [fixed("stage", 50000000)], {
          name: "Décor",
          tiers: [
            { id: "backdrop-only", label: "backdrop only", minMinor: 10000000 },
            { id: "full-stage-wrap", label: "full stage wrap", minMinor: 40000000 },
          ],
        }),
        category("gifting", [perGuest("gift", 50000)], { name: "Gifting" }),
      ],
    },
    profile: {
      priorities: ["reveal", "fnb", "decor", "gifting"],
      mustHaves: [
        {
          id: "branded-stage",
          text: "branded reveal stage",
          categoryId: "decor",
          minTierId: "full-stage-wrap",
        },
      ],
    },
  };
}

/** Collects every value of a *Minor key anywhere inside a JSON-friendly value. */
export function minorValues(value) {
  if (Array.isArray(value)) return value.flatMap(minorValues);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key.endsWith("Minor") ? [item] : minorValues(item),
  );
}
