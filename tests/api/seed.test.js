import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget } from "../../server/core/budgetEngine.js";
import { buildBudgetState } from "../../server/core/profile.js";
import { getTemplate, listEventTypes } from "../../server/core/templates.js";
import { createStore } from "../../server/store/index.js";
import { DEMO_EVENT_ID as ID, seedDemo } from "../../server/store/seed.js";
import { createEvent, createWorkspace, postAgentMessage } from "../../server/store/workspace.js";
import { addEvent } from "./helpers.js";

const NOW = "2026-10-31T09:00:00.000Z";

function seeded() {
  const store = createStore();
  seedDemo(store, NOW);
  return store;
}

describe("demo seed", () => {
  it("is a finished event dated 75 days ahead", () => {
    const event = seeded().events.get(ID);
    assert.equal(event.intakeStatus, "confirmed");
    assert.equal(event.date, "2027-01-14T00:00:00.000Z");
  });

  it("ranks every template category and points must-haves at real categories and tiers", () => {
    const store = seeded();
    const event = store.events.get(ID);
    const state = store.budgets.get(ID);
    const ids = state.categories.map(({ id }) => id);
    assert.deepEqual([...event.priorities].sort(), [...ids].sort());
    for (const { categoryId, minTierId, text } of event.mustHaves) {
      const category = state.categories.find(({ id }) => id === categoryId);
      assert.ok(category, text);
      if (minTierId)
        assert.ok(
          category.tiers.some(({ id }) => id === minTierId),
          text,
        );
    }
    assert.ok(event.mustHaves.some(({ id }) => id === event.absoluteMustHaveId));
  });

  it("stays inside its own budget, so the demo opens with no shortfall", () => {
    const store = seeded();
    const state = store.budgets.get(ID);
    assert.equal(state.guestCount, store.events.get(ID).guests.confirmed);
    assert.equal(state.totalMinor, store.events.get(ID).budget.totalMinor);
    assert.ok(computeBudget(state).remainingMinor >= 0);
  });

  it("gives every message an existing group and an AI author from this event", () => {
    const store = seeded();
    assert.ok(store.messages.size >= 4);
    for (const { groupId, authorId, authorKind } of store.messages.values()) {
      assert.ok(store.groups.has(groupId), groupId);
      assert.equal(store.users.get(authorId).kind, "agent");
      assert.equal(authorKind, "agent");
    }
  });
});

for (const { eventType } of listEventTypes()) {
  describe(`workspace: ${eventType}`, () => {
    const template = getTemplate(eventType);
    const build = (store, id) =>
      addEvent(store, {
        id,
        eventType,
        priorities: [template.categories[0].id],
        mustHaves: [],
        absoluteMustHaveId: null,
      });

    it("creates groups, an owned timeline and a budget from the template", () => {
      const store = seeded();
      const event = build(store, "e1");
      const groups = [...store.groups.values()].filter(({ eventId }) => eventId === "e1");
      assert.deepEqual(
        groups.map(({ slug }) => slug),
        template.groups.map(({ slug }) => slug),
      );
      assert.ok(groups.every(({ id, slug }) => id === `g-e1-${slug}`));

      const tasks = [...store.tasks.values()].filter(({ eventId }) => eventId === "e1");
      assert.equal(tasks.length, template.milestones.length);
      for (const task of tasks) assert.ok(store.groups.has(task.ownerGroupId), task.title);

      assert.equal(event.intakeStatus, "confirmed");
      assert.equal(store.budgets.get("e1").guestCount, event.guests.confirmed);
    });

    it("gives everyone a room to see and welcomes them there", () => {
      const store = seeded();
      build(store, "e1");
      const [welcome] = store.messagesForGroup("g-e1-announcements").messages;
      assert.equal(welcome.authorId, "agent-planner@e1");
      assert.ok(store.users.has(welcome.authorId));
      assert.match(welcome.text, /Welcome/);
      for (const user of store.users.values())
        if (user.eventId === "e1" && user.kind === "core")
          assert.ok(store.groupsForUser(user).some(({ slug }) => slug === "announcements"));
    });

    it("keeps two events of the same type apart", () => {
      const store = seeded();
      build(store, "e1");
      build(store, "e2");
      const tasks = [...store.tasks.values()].filter(({ eventId }) => /^e[12]$/.test(eventId));
      assert.equal(tasks.length, template.milestones.length * 2);
      const e1Tasks = tasks.filter(({ eventId }) => eventId === "e1");
      assert.ok(e1Tasks.every(({ ownerGroupId }) => ownerGroupId.startsWith("g-e1-")));
    });
  });
}

describe("createEvent", () => {
  it("scopes every seeded person to the event, and generates an id when none is given", () => {
    const store = createStore();
    const { event, users } = createEvent(store, { eventType: "birthday" });
    assert.ok(event.id);
    assert.ok(users.length > 0);
    for (const user of users) {
      assert.equal(user.eventId, event.id);
      assert.ok(user.id.endsWith(`@${event.id}`));
    }
    assert.equal(store.groups.size, 0);
    assert.equal(store.budgets.size, 0);
  });

  it("refuses to build a budget for an unconfirmed guest count", () => {
    const store = createStore();
    const { event } = createEvent(store, { eventType: "birthday" });
    assert.throws(() => buildBudgetState(event, getTemplate("birthday")));
  });

  it("rejects an unknown event type", () => {
    assert.throws(() => createEvent(createStore(), { eventType: "gala" }));
  });
});

describe("postAgentMessage", () => {
  it("defaults to an AI message with no rationale, and marks system notices", () => {
    const store = createStore();
    const input = { groupId: "g", authorId: "a", text: "hi", nowIso: NOW };
    const plain = postAgentMessage(store, input);
    assert.equal(plain.authorKind, "agent");
    assert.equal(plain.rationale, null);
    assert.deepEqual(plain.fileIds, []);
    assert.equal(plain.createdAt, NOW);
    const notice = postAgentMessage(store, { ...input, authorKind: "system", rationale: "why" });
    assert.equal(notice.authorKind, "system");
    assert.notEqual(notice.id, plain.id);
    assert.equal(store.messages.size, 2);
  });
});

describe("createWorkspace", () => {
  it("returns what it created", () => {
    const store = seeded();
    const event = structuredClone(store.events.get(ID));
    event.id = "e9";
    store.events.set("e9", event);
    const { groups, tasks } = createWorkspace(store, event, NOW);
    assert.ok(groups.length > 0);
    assert.ok(tasks.every(({ eventId, id }) => eventId === "e9" && id.startsWith("e9-")));
  });
});
