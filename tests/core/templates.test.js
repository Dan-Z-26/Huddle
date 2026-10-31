import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount } from "../../server/core/amount.js";
import { parseGuestCount } from "../../server/core/guestCount.js";
import { allocate, computeBudget, DEFAULT_BUFFER_BPS } from "../../server/core/budgetEngine.js";
import { shareOfBps } from "../../server/core/money.js";
import { buildBudgetState } from "../../server/core/profile.js";
import { planTimeline } from "../../server/core/timelinePlanner.js";
import { getTemplate, groupsForCategory, listEventTypes } from "../../server/core/templates.js";
import { minorValues } from "./fixtures.js";

const EVENT_TYPES = ["corporate_launch", "wedding", "birthday", "community"];

const sumShares = (items) => items.reduce((sum, { shareBps }) => sum + shareBps, 0);
const profileFor = (template, confirmed, totalMinor) => ({
  guests: { confirmed },
  budget: { totalMinor, currency: "INR" },
  priorities: template.categories.map(({ id }) => id),
});

describe("listEventTypes", () => {
  it("lists all four with labels", () => {
    const types = listEventTypes();
    assert.deepEqual(
      types.map(({ eventType }) => eventType),
      EVENT_TYPES,
    );
    assert.ok(types.every(({ label }) => label.length > 0));
  });
});

describe("getTemplate", () => {
  it("throws on an unknown event type", () => {
    assert.throws(() => getTemplate("funeral"), RangeError);
    assert.throws(() => getTemplate("constructor"), RangeError);
  });

  it("returns a private copy, so callers cannot change the template", () => {
    const first = getTemplate("wedding");
    first.categories.length = 0;
    first.groups[0].memberRoleIds.push("intruder");
    const second = getTemplate("wedding");
    assert.ok(second.categories.length > 0);
    assert.ok(!second.groups[0].memberRoleIds.includes("intruder"));
  });
});

for (const eventType of EVENT_TYPES) {
  describe(`template: ${eventType}`, () => {
    const template = getTemplate(eventType);
    const roleIds = new Set(template.roles.map(({ id }) => id));
    const slugs = new Set(template.groups.map(({ slug }) => slug));
    const drivers = template.categories.flatMap((category) => category.drivers);

    it("has the standard groups", () => {
      const announcements = template.groups.find(({ slug }) => slug === "announcements");
      const coreTeam = template.groups.find(({ slug }) => slug === "core-team");
      assert.equal(announcements.kind, "announcements");
      assert.equal(coreTeam.kind, "core");
    });

    it("maps every category to groups that exist and include it", () => {
      for (const { id } of template.categories) {
        const mapped = groupsForCategory(template.categoryGroupMap, id);
        assert.ok(mapped.length > 0, id);
        for (const slug of mapped) {
          assert.ok(slugs.has(slug), `${id} -> ${slug}`);
          const group = template.groups.find((candidate) => candidate.slug === slug);
          assert.ok(group.categoryIds.includes(id), `${slug} includes ${id}`);
        }
      }
    });

    it("only has groups whose memberRoleIds exist", () => {
      for (const group of template.groups) {
        assert.ok(group.memberRoleIds.length > 0, group.slug);
        for (const roleId of group.memberRoleIds) assert.ok(roleIds.has(roleId), roleId);
      }
    });

    it("has no vendor roles or groups: vendors are not members of the workspace", () => {
      assert.ok(template.roles.every(({ kind }) => kind !== "vendor"));
      assert.ok(template.groups.every(({ kind }) => kind !== "vendor"));
    });

    it("offers usable answer buttons for setup", () => {
      const { intakeOptions: options, categories } = template;
      for (const field of ["purpose", "city", "venueType", "attendeeExperience", "constraints"])
        assert.ok(options[field].length >= 3, field);
      for (const text of options.guests)
        assert.equal(parseGuestCount(text).needsConfirmation, false);
      for (const text of options.budget) assert.ok(parseAmount(text).minor > 0, text);
      const ids = categories.map(({ id }) => id);
      for (const { categoryId } of options.mustHaves)
        assert.ok(ids.includes(categoryId), categoryId);
    });

    it("gives every group a readable name, with no # or slug showing", () => {
      for (const { name } of template.groups) assert.match(name, /^[A-Z][^#]*$/);
      assert.ok(template.groups.every(({ name, slug }) => name !== slug));
    });

    it("puts every role in Announcements", () => {
      const announcements = template.groups.find(({ slug }) => slug === "announcements");
      for (const { id } of template.roles) assert.ok(announcements.memberRoleIds.includes(id), id);
    });

    it("lets a core role into a category group only if it owns one of its categories", () => {
      const categoryGroups = template.groups.filter(({ kind }) => kind === "category");
      assert.ok(categoryGroups.length > 0);
      for (const group of categoryGroups) {
        for (const roleId of group.memberRoleIds) {
          const role = template.roles.find(({ id }) => id === roleId);
          if (role.kind !== "core") continue;
          const owns = role.categoryIds.some((id) => group.categoryIds.includes(id));
          assert.ok(owns, `${roleId} in ${group.slug}`);
        }
      }
    });

    it("has driver shares that sum to 10000 per category", () => {
      for (const category of template.categories) {
        assert.equal(sumShares(category.drivers), 10000, category.id);
      }
    });

    it("has a perGuest, a fixed and a stepped driver", () => {
      for (const kind of ["perGuest", "fixed", "stepped"]) {
        assert.ok(
          drivers.some((driver) => driver.kind === kind),
          kind,
        );
      }
    });

    it("gives every perUnit driver units, and every stepped driver ascending steps", () => {
      for (const driver of drivers) {
        if (driver.kind === "perUnit") assert.ok(driver.units > 0, driver.id);
        if (driver.kind === "stepped") {
          const limits = driver.steps.map(({ upToGuests }) => upToGuests);
          assert.deepEqual(
            limits,
            limits.toSorted((a, b) => a - b),
            driver.id,
          );
          assert.ok(
            driver.steps.every(({ shareBps }) => shareBps > 0),
            driver.id,
          );
        }
      }
    });

    it("gives each category tiers, ascending in share", () => {
      for (const { id, tiers } of template.categories) {
        assert.ok(tiers.length >= 2, id);
        assert.ok(tiers[0].minBps < tiers[1].minBps, id);
        assert.notEqual(tiers[0].id, tiers[1].id);
      }
    });

    it("seeds a user for every role, including the four AI members", () => {
      assert.deepEqual(new Set(template.seedUsers.map(({ roleId }) => roleId)), roleIds);
      const agents = template.seedUsers.filter(({ kind }) => kind === "agent");
      assert.deepEqual(
        agents.map(({ name }) => name),
        ["Planner", "Budget", "Vendor", "Timeline"],
      );
      assert.ok(template.seedUsers.every(({ name }) => typeof name === "string" && name));
      assert.equal(new Set(template.seedUsers.map(({ id }) => id)).size, template.seedUsers.length);
    });

    it("has one manager role", () => {
      assert.equal(template.roles.filter(({ kind }) => kind === "manager").length, 1);
    });

    it("plans milestones for groups that exist, ending on event day", () => {
      const days = template.milestones.map(({ daysBefore }) => daysBefore);
      assert.deepEqual(
        days,
        days.toSorted((a, b) => b - a),
      );
      assert.equal(new Set(days).size, days.length);
      assert.equal(days.at(-1), 0);
      assert.ok(template.milestones.every(({ ownerGroupSlug }) => slugs.has(ownerGroupSlug)));
      const groupIdBySlug = Object.fromEntries([...slugs].map((slug) => [slug, `g-${slug}`]));
      const tasks = planTimeline("2030-01-01", template.milestones, "2020-01-01", groupIdBySlug);
      assert.ok(tasks.every(({ ownerGroupId, atRisk }) => ownerGroupId && !atRisk));
    });

    for (const [guests, total] of [
      [1, 100],
      [7, 1000],
      [100, 160000000],
      [101, 160000001],
      [300, 333333333],
      [5000, 99999999],
    ]) {
      it(`builds a budget within ${total} paise for ${guests} guests`, () => {
        const state = buildBudgetState(profileFor(template, guests, total), template);
        const budget = computeBudget(state);
        assert.ok(budget.committedMinor <= total, `${budget.committedMinor} > ${total}`);
        assert.ok(budget.remainingMinor >= 0);
        assert.equal(budget.lowMinor, budget.committedMinor);
        assert.equal(budget.highMinor, budget.committedMinor);
        assert.ok(minorValues(state).every(Number.isSafeInteger));
        assert.ok(minorValues(budget).every(Number.isSafeInteger));
      });
    }

    it("spends nearly the whole budget, so the first plan is useful", () => {
      const state = buildBudgetState(profileFor(template, 200, 160000000), template);
      const { remainingMinor } = computeBudget(state);
      assert.ok(remainingMinor >= 0 && remainingMinor < 10000, String(remainingMinor));
    });
  });
}

describe("corporate launch specifics", () => {
  const template = getTemplate("corporate_launch");

  it("maps categories as the plan says", () => {
    const map = template.categoryGroupMap;
    assert.deepEqual(groupsForCategory(map, "reveal"), ["stage-decor", "music-av"]);
    assert.deepEqual(groupsForCategory(map, "food-beverage"), ["food-beverage"]);
    assert.deepEqual(groupsForCategory(map, "av"), ["music-av"]);
    assert.deepEqual(groupsForCategory(map, "music"), ["music-av"]);
    assert.deepEqual(groupsForCategory(map, "decor"), ["stage-decor"]);
    assert.deepEqual(groupsForCategory(map, "pr"), ["pr-media"]);
    assert.deepEqual(groupsForCategory(map, "photo-video"), ["photo-video"]);
    assert.deepEqual(groupsForCategory(map, "gifting"), ["core-team"]);
  });

  it("offers the plan's Décor tiers", () => {
    const decor = template.categories.find(({ id }) => id === "decor");
    assert.deepEqual(
      decor.tiers.map(({ label }) => label),
      ["Backdrop only", "Full stage wrap"],
    );
  });
});

describe("venue-style stepped drivers", () => {
  for (const [eventType, categoryId] of [
    ["wedding", "venue"],
    ["birthday", "venue"],
    ["community", "venue-permits"],
  ]) {
    it(`${eventType} prices ${categoryId} by capacity`, () => {
      const venue = getTemplate(eventType).categories.find(({ id }) => id === categoryId);
      assert.ok(venue.drivers.some(({ kind }) => kind === "stepped"));
    });
  }
});

describe("groupsForCategory", () => {
  it("falls back to core-team for unknown or empty mappings", () => {
    assert.deepEqual(groupsForCategory({}, "x"), ["core-team"]);
    assert.deepEqual(groupsForCategory({ x: [] }, "x"), ["core-team"]);
    assert.deepEqual(groupsForCategory({}, "constructor"), ["core-team"]);
  });

  it("returns a copy of the mapping", () => {
    const map = { x: ["a"] };
    groupsForCategory(map, "x").push("b");
    assert.deepEqual(map.x, ["a"]);
  });
});

describe("usual shares", () => {
  for (const eventType of EVENT_TYPES) {
    it(`${eventType} adds up to the whole budget`, () => {
      const shares = getTemplate(eventType).categories.map(({ typicalBps }) => typicalBps);
      assert.equal(
        shares.reduce((sum, share) => sum + share, 0),
        10000,
      );
    });
  }
});

describe("opening budget follows the user's ranking", () => {
  for (const eventType of EVENT_TYPES) {
    it(`${eventType} spends each category's allocation, in either ranking order`, () => {
      const template = getTemplate(eventType);
      const total = 160000000;
      const ids = template.categories.map(({ id }) => id);
      for (const priorities of [ids, ids.toReversed()]) {
        const profile = { ...profileFor(template, 200, total), priorities };
        const planned = total - shareOfBps(total, DEFAULT_BUFFER_BPS);
        const allocation = allocate(planned, template.categories, priorities);
        for (const row of computeBudget(buildBudgetState(profile, template)).categories) {
          const unspent = allocation[row.id] - row.committedMinor;
          assert.ok(unspent >= 0 && unspent < 10000, `${row.id} unspent ${unspent}`);
        }
      }
    });
  }
});
