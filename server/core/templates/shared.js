/** Builds an event type's template from its data, so groups and maps can't disagree with its roles. */
const AGENT_NAMES = ["Planner", "Budget", "Vendor", "Timeline"];
const CITIES = ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Chennai", "Pune", "Kolkata"];
const agentRole = (name) => ({
  id: `agent-${name.toLowerCase()}`,
  name: `${name} agent`,
  kind: "agent",
  categoryIds: [],
});
const seedUser = (id, name, role) => ({
  id,
  name,
  roleId: role.id,
  kind: role.kind,
  categoryIds: [...role.categoryIds],
});

const BASE_MILESTONES = [
  ["brief-signed-off", "Brief signed off", 90, "core-team"],
  ["venue-booked", "Venue booked", 75, "core-team"],
  ["rfqs-sent", "Quote requests sent to vendors", 60, "core-team"],
  ["vendors-selected", "Vendors selected", 45, "core-team"],
  ["contracts-signed", "Contracts signed", 30, "core-team"],
  ["final-guest-count", "Final guest count confirmed", 14, "core-team"],
  ["run-of-show", "Run-of-show finalised", 7, "core-team"],
  ["final-vendor-confirmations", "Vendors reconfirmed", 2, "core-team"],
  ["event-day", "Event day", 0, "announcements"],
];

/**
 * Builds a template driver holding a share of its category.
 * @param {string} id Driver id.
 * @param {string} label Display label.
 * @param {string} kind perGuest, fixed, perUnit or stepped.
 * @param {number} shareBps Share of the category; a category's drivers sum to 10000.
 * @param {object} [extra] units for perUnit, steps for stepped.
 * @returns {object} Template driver.
 */
export function driver(id, label, kind, shareBps, extra = {}) {
  return { id, label, kind, shareBps, ...extra };
}

/**
 * Builds a venue-style stepped driver whose price jumps with capacity.
 * @param {string} id Driver id.
 * @param {string} label Display label.
 * @param {number} shareBps Share of the category.
 * @returns {object} Template driver with capacity steps; shares are relative to the booked step.
 */
export function capacityDriver(id, label, shareBps) {
  return driver(id, label, "stepped", shareBps, {
    steps: [
      { upToGuests: 100, shareBps: 6000 },
      { upToGuests: 300, shareBps: 10000 },
      { upToGuests: 750, shareBps: 15000 },
    ],
  });
}

/**
 * Builds a template category with two quote tiers.
 * @param {string} id Category id.
 * @param {string} name Display name.
 * @param {[string, string]} tierLabels Lower and upper tier labels.
 * @param {object[]} drivers Template drivers.
 * @param {number} typicalBps The category's usual share of this event type's budget, a rough guide.
 * @returns {object} Template category.
 */
export function category(id, name, [lowerTier, upperTier], drivers, typicalBps) {
  const tierId = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id,
    name,
    typicalBps,
    tiers: [
      { id: tierId(lowerTier), label: lowerTier, minBps: 2000 },
      { id: tierId(upperTier), label: upperTier, minBps: 8000 },
    ],
    drivers,
  };
}

/**
 * Scales the standard milestones to an event type's usual lead time.
 * @param {number} percent Percentage of the 90-day base plan.
 * @returns {Array<{id: string, title: string, daysBefore: number, ownerGroupSlug: string}>}
 *   Milestones, latest lead time first.
 */
export function scaledMilestones(percent) {
  return BASE_MILESTONES.map(([id, title, days, ownerGroupSlug]) => ({
    id,
    title,
    daysBefore: Math.ceil((days * percent) / 100),
    ownerGroupSlug,
  }));
}

function buildGroups(categories, roles, agentRoleIds, categoryGroups) {
  const roleIds = (kind) => roles.filter((role) => role.kind === kind).map((role) => role.id);
  const coreRoles = roles.filter((role) => role.kind === "core");
  const mapped = new Set(categoryGroups.flatMap((group) => group.categoryIds));
  // A category group is a working room for the core roles that own those categories.
  const categoryGroup = ({ slug, name, categoryIds }) => ({
    slug,
    name,
    kind: "category",
    memberRoleIds: [
      ...roleIds("manager"),
      ...coreRoles
        .filter((role) => role.categoryIds.some((id) => categoryIds.includes(id)))
        .map((role) => role.id),
      ...agentRoleIds,
    ],
    categoryIds,
  });
  return [
    {
      slug: "announcements",
      name: "Announcements",
      kind: "announcements",
      memberRoleIds: [...roles.map((role) => role.id), ...agentRoleIds],
      categoryIds: [],
    },
    {
      slug: "core-team",
      name: "Core team",
      kind: "core",
      memberRoleIds: [...roleIds("manager"), ...roleIds("core"), ...agentRoleIds],
      categoryIds: categories.map(({ id }) => id).filter((id) => !mapped.has(id)),
    },
    ...categoryGroups.map(categoryGroup),
  ];
}

function buildCategoryGroupMap(categories, groups) {
  return Object.fromEntries(
    categories.map(({ id }) => [
      id,
      groups.filter((group) => group.categoryIds.includes(id)).map((group) => group.slug),
    ]),
  );
}

/**
 * Assembles a full template from an event type's data, deriving group membership and the
 * category-to-group map so the two can never disagree with the roles.
 * @param {{eventType: string, label: string, categories: object[], roles: object[],
 *   people: Record<string, string>, categoryGroups: object[], milestones: object[],
 *   intakeOptions: object}} definition Event type data; people maps a role id to its seeded
 *   person's name, and intakeOptions holds the setup's answer buttons.
 * @returns {object} The template returned by getTemplate.
 */
export function defineTemplate({
  eventType,
  label,
  categories,
  roles,
  people,
  categoryGroups,
  milestones,
  intakeOptions,
}) {
  const agentRoles = AGENT_NAMES.map(agentRole);
  const groups = buildGroups(
    categories,
    roles,
    agentRoles.map((role) => role.id),
    categoryGroups,
  );
  return {
    eventType,
    label,
    categories,
    roles: [...roles, ...agentRoles],
    groups,
    categoryGroupMap: buildCategoryGroupMap(categories, groups),
    milestones,
    intakeOptions: { city: CITIES, ...intakeOptions },
    seedUsers: [
      ...roles.map((role) => seedUser(`user-${role.id}`, people[role.id], role)),
      ...agentRoles.map((role, index) => seedUser(role.id, AGENT_NAMES[index], role)),
    ],
  };
}
