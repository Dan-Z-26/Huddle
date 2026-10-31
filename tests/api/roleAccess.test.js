import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canPost, canSeeBudget, canView } from "../../server/core/permissions.js";
import { getTemplate, listEventTypes } from "../../server/core/templates.js";
import { createStore } from "../../server/store/index.js";

// Real template -> store -> permissions: the unit tests only cover hand-written role objects.
function workspace(eventType) {
  const template = getTemplate(eventType);
  const store = createStore();
  for (const group of template.groups) {
    store.groups.set(group.slug, { ...group, id: group.slug, eventId: "e1" });
  }
  const users = template.seedUsers.map((user) => ({ ...user, eventId: "e1" }));
  return { template, store, users, groups: [...store.groups.values()] };
}

const ofKind = (users, kind) => users.filter((user) => user.kind === kind);
const slugs = (groups) => groups.map((group) => group.slug).sort();

for (const { eventType } of listEventTypes()) {
  describe(`role access: ${eventType}`, () => {
    const { template, store, users, groups } = workspace(eventType);
    const visibleTo = (role) => groups.filter((group) => canView(role, { type: "group", group }));
    const postableBy = (role) => groups.filter((group) => canPost(role, group));

    it("has no vendor users: vendors are not workspace members", () => {
      assert.equal(ofKind(users, "vendor").length, 0);
      assert.ok(groups.every(({ kind }) => kind !== "vendor"));
    });

    it("shows core members Announcements, Core team and only the category groups they own", () => {
      for (const member of ofKind(users, "core")) {
        const visible = visibleTo(store.roleOf(member));
        const slugList = visible.map((group) => group.slug);
        assert.ok(slugList.includes("announcements") && slugList.includes("core-team"));
        for (const group of visible.filter(({ kind }) => kind === "category")) {
          assert.ok(
            group.categoryIds.some((id) => member.categoryIds.includes(id)),
            group.slug,
          );
        }
        for (const group of groups.filter(({ kind }) => kind === "category")) {
          const owns = group.categoryIds.some((id) => member.categoryIds.includes(id));
          assert.equal(slugList.includes(group.slug), owns, `${member.name} / ${group.slug}`);
        }
      }
    });

    it("only lets managers and core members see quotes and the comparison", () => {
      for (const user of users) {
        const role = store.roleOf(user);
        const allowed = user.kind === "manager" || user.kind === "core";
        assert.equal(canView(role, { type: "quotes" }), allowed, user.name);
        assert.equal(canView(role, { type: "comparison" }), allowed, user.name);
      }
    });

    it("gives core members their own areas' budget only, never the total", () => {
      const coreUsers = ofKind(users, "core");
      assert.ok(coreUsers.length > 0);
      for (const member of coreUsers) {
        const role = store.roleOf(member);
        assert.equal(canSeeBudget(role, "total"), false);
        for (const { id } of template.categories) {
          assert.equal(canSeeBudget(role, { categoryId: id }), member.categoryIds.includes(id), id);
        }
      }
    });

    it("lets core members post in every joined group except Announcements", () => {
      for (const member of ofKind(users, "core")) {
        const role = store.roleOf(member);
        const expected = visibleTo(role).filter(({ kind }) => kind !== "announcements");
        assert.ok(expected.some(({ kind }) => kind === "core"));
        assert.deepEqual(slugs(postableBy(role)), slugs(expected), member.name);
      }
    });

    it("gives the manager everything, and agents no budget", () => {
      const [manager] = ofKind(users, "manager");
      const role = store.roleOf(manager);
      assert.deepEqual(slugs(postableBy(role)), slugs(groups));
      assert.equal(canSeeBudget(role, "total"), true);
      for (const agent of ofKind(users, "agent")) {
        assert.equal(canSeeBudget(store.roleOf(agent), "total"), false);
        assert.deepEqual(slugs(postableBy(store.roleOf(agent))), slugs(groups));
      }
    });
  });
}
