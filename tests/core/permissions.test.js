import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canManageGroups,
  canMarkDirective,
  canPost,
  canSeeBudget,
  canView,
} from "../../server/core/permissions.js";

const announcements = { id: "g-ann", eventId: "e1", kind: "announcements", categoryIds: [] };
const coreTeam = { id: "g-core", eventId: "e1", kind: "core", categoryIds: ["gifting"] };
const food = { id: "g-food", eventId: "e1", kind: "category", categoryIds: ["fnb"] };
const decor = { id: "g-decor", eventId: "e1", kind: "category", categoryIds: ["decor"] };

const roles = {
  manager: { kind: "manager", roleId: "m", eventId: "e1", categoryIds: [], groupIds: [] },
  core: {
    kind: "core",
    roleId: "c",
    eventId: "e1",
    categoryIds: ["decor"],
    groupIds: ["g-ann", "g-core", "g-decor"],
  },
  agent: {
    kind: "agent",
    roleId: "a",
    eventId: "e1",
    categoryIds: [],
    groupIds: ["g-ann", "g-core"],
  },
};
const KINDS = Object.keys(roles);

// Each row: expected result for [manager, core, agent].
function assertMatrix(check, expected) {
  KINDS.forEach((kind, index) => {
    assert.equal(check(roles[kind]), expected[index], kind);
  });
}

describe("canView matrix", () => {
  const rows = [
    ["group announcements", { type: "group", group: announcements }, [true, true, true]],
    ["group core-team", { type: "group", group: coreTeam }, [true, true, true]],
    ["group of another area", { type: "group", group: food }, [true, false, false]],
    ["group of own area", { type: "group", group: decor }, [true, true, false]],
    ["file in core-team", { type: "file", group: coreTeam }, [true, true, true]],
    ["file in another area's group", { type: "file", group: food }, [true, false, false]],
    ["file in own area's group", { type: "file", group: decor }, [true, true, false]],
    ["quotes", { type: "quotes" }, [true, true, false]],
    ["comparison", { type: "comparison" }, [true, true, false]],
    ["unknown resource", { type: "secret" }, [false, false, false]],
  ];
  for (const [name, resource, expected] of rows) {
    it(name, () => assertMatrix((role) => canView(role, resource), expected));
  }

  it("denies missing roles, resources and groups", () => {
    assert.equal(canView(null, { type: "quotes" }), false);
    assert.equal(canView(roles.core, null), false);
    assert.equal(canView(roles.core, { type: "group" }), false);
  });
});

describe("canPost matrix", () => {
  const rows = [
    ["announcements", announcements, [true, false, true]],
    ["core-team", coreTeam, [true, true, true]],
    ["another area's group", food, [true, false, true]],
    ["own area's group", decor, [true, true, true]],
  ];
  for (const [name, group, expected] of rows) {
    it(name, () => assertMatrix((role) => canPost(role, group), expected));
  }

  it("stops a core member posting in their own area's group without membership", () => {
    const outsider = { ...roles.core, groupIds: [] };
    assert.equal(canPost(outsider, decor), false);
  });

  it("stops a core member posting in a joined group of an area they don't own", () => {
    const joinedFood = { ...roles.core, groupIds: [...roles.core.groupIds, "g-food"] };
    assert.equal(canPost(joinedFood, food), false);
  });

  it("denies a missing role and an unknown kind", () => {
    assert.equal(canPost(null, coreTeam), false);
    assert.equal(canPost({ kind: "guest", eventId: "e1", groupIds: ["g-core"] }, coreTeam), false);
  });
});

describe("canSeeBudget matrix", () => {
  const rows = [
    ["total", "total", [true, false, false]],
    ["own area", { categoryId: "decor" }, [true, true, false]],
    ["another area", { categoryId: "fnb" }, [true, false, false]],
    ["no scope", undefined, [false, false, false]],
    ["unknown scope", "everything", [false, false, false]],
  ];
  for (const [name, scope, expected] of rows) {
    it(name, () => assertMatrix((role) => canSeeBudget(role, scope), expected));
  }

  it("denies a missing role", () => {
    assert.equal(canSeeBudget(undefined, "total"), false);
  });
});

describe("manager-only actions", () => {
  it("canMarkDirective", () => assertMatrix(canMarkDirective, [true, false, false]));
  it("canManageGroups", () => assertMatrix(canManageGroups, [true, false, false]));
  it("denies a missing role", () => {
    assert.equal(canMarkDirective(null), false);
    assert.equal(canManageGroups(undefined), false);
  });
});

describe("canPost: a category group with no categories", () => {
  it("denies a core member, since no area overlaps", () => {
    const bare = { id: "g-bare", eventId: "e1", kind: "category" };
    assert.equal(canPost({ ...roles.core, groupIds: ["g-bare"] }, bare), false);
  });
});

describe("events stay apart", () => {
  const otherEventGroup = { id: "g-ann", eventId: "e2", kind: "core", categoryIds: [] };
  for (const kind of KINDS) {
    it(`${kind} of another event cannot view or post`, () => {
      const role = { ...roles[kind], groupIds: ["g-ann"] };
      assert.equal(canView(role, { type: "group", group: otherEventGroup }), false);
      assert.equal(canView(role, { type: "file", group: otherEventGroup }), false);
      assert.equal(canPost(role, otherEventGroup), false);
    });
  }

  it("a role without an event id is denied everywhere", () => {
    const noEvent = { ...roles.manager, eventId: undefined };
    assert.equal(canView(noEvent, { type: "group", group: coreTeam }), false);
    assert.equal(canPost(noEvent, coreTeam), false);
  });
});

describe("loosely shaped roles fail closed", () => {
  const group = { id: "g1", eventId: "e1", kind: "core", categoryIds: [] };
  const base = { kind: "core", eventId: "e1", categoryIds: [] };

  it("rejects a string where a list of group ids is expected", () => {
    const role = { ...base, groupIds: "g1-and-more" };
    assert.equal(canView(role, { type: "group", group }), false);
    assert.equal(canPost(role, group), false);
  });

  it("rejects an object that merely claims to have includes()", () => {
    const role = { ...base, groupIds: { includes: () => true } };
    assert.equal(canView(role, { type: "group", group }), false);
  });

  it("does not match a missing id against a missing id", () => {
    const role = { ...base, groupIds: [undefined] };
    const noId = { eventId: "e1", kind: "core", categoryIds: [] };
    assert.equal(canView(role, { type: "group", group: noId }), false);
  });

  it("rejects category ids that are not a list", () => {
    assert.equal(
      canSeeBudget({ kind: "core", categoryIds: "decor" }, { categoryId: "dec" }),
      false,
    );
  });
});
