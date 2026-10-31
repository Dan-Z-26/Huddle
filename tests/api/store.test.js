import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../../server/store/index.js";

function storeWithMessages(count, groupId = "g1") {
  const store = createStore();
  for (let i = 1; i <= count; i += 1) {
    store.messages.set(`m${i}`, { id: `m${i}`, groupId, text: `message ${i}` });
  }
  return store;
}

const ids = (page) => page.messages.map((message) => message.id);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);

function storeWithGroups() {
  const store = createStore();
  const groups = [
    { id: "ann", eventId: "e1", memberRoleIds: ["creative", "helper"] },
    { id: "core", eventId: "e1", memberRoleIds: ["creative"] },
    { id: "food", eventId: "e1", memberRoleIds: ["creative", "helper"] },
    { id: "other-event", eventId: "e2", memberRoleIds: ["creative", "helper"] },
  ];
  for (const group of groups) store.groups.set(group.id, group);
  return store;
}

const groupIds = (store, user) => store.groupsForUser(user).map((group) => group.id);

test("new stores are isolated and expose every Map", () => {
  const first = createStore();
  const second = createStore();
  first.users.set("u1", { id: "u1" });
  assert.equal(second.users.size, 0);

  for (const name of [
    "events",
    "users",
    "groups",
    "messages",
    "directives",
    "files",
    "quotes",
    "tasks",
    "budgets",
    "pendingChanges",
  ]) {
    assert.ok(first[name] instanceof Map, name);
    assert.notEqual(first[name], second[name], name);
  }
});

test("messagesForGroup returns the newest 50 by default, oldest first", () => {
  const page = storeWithMessages(60).messagesForGroup("g1");
  assert.deepEqual(ids(page), range(11, 60));
  assert.equal(page.nextBefore, "m11");
});

test("messagesForGroup caps limit at 100 and keeps limit at least 1", () => {
  const store = storeWithMessages(150);
  assert.deepEqual(ids(store.messagesForGroup("g1", { limit: 500 })), range(51, 150));
  assert.deepEqual(ids(store.messagesForGroup("g1", { limit: 0 })), ["m150"]);
});

test("messagesForGroup falls back to the default page for a non-integer limit", () => {
  const store = storeWithMessages(150);
  for (const limit of [NaN, 1.5, "20", Infinity]) {
    assert.deepEqual(ids(store.messagesForGroup("g1", { limit })), range(101, 150));
  }
});

test("messagesForGroup pages backwards with no gaps and ends with nextBefore null", () => {
  const store = storeWithMessages(5);
  const first = store.messagesForGroup("g1", { limit: 2 });
  assert.deepEqual(ids(first), ["m4", "m5"]);

  const second = store.messagesForGroup("g1", { before: first.nextBefore, limit: 2 });
  assert.deepEqual(ids(second), ["m2", "m3"]);

  const last = store.messagesForGroup("g1", { before: second.nextBefore, limit: 2 });
  assert.deepEqual(ids(last), ["m1"]);
  assert.equal(last.nextBefore, null);
});

test("messagesForGroup gives nextBefore null when the page exactly fits", () => {
  const page = storeWithMessages(2).messagesForGroup("g1", { limit: 2 });
  assert.deepEqual(ids(page), ["m1", "m2"]);
  assert.equal(page.nextBefore, null);
});

test("messagesForGroup gives an empty page for an unknown before id or empty group", () => {
  const store = storeWithMessages(3);
  const empty = { messages: [], nextBefore: null };
  assert.deepEqual(store.messagesForGroup("g1", { before: "missing" }), empty);
  assert.deepEqual(store.messagesForGroup("g1", { before: "m1" }), empty);
  assert.deepEqual(store.messagesForGroup("g2"), empty);
});

test("messagesForGroup never crosses groups, even through a before id", () => {
  const store = storeWithMessages(3);
  store.messages.set("x1", { id: "x1", groupId: "g2", text: "other group" });
  assert.deepEqual(ids(store.messagesForGroup("g2")), ["x1"]);
  assert.deepEqual(store.messagesForGroup("g1", { before: "x1" }), {
    messages: [],
    nextBefore: null,
  });
});

test("groupsForUser gives managers and agents every group of their own event", () => {
  const store = storeWithGroups();
  const all = ["ann", "core", "food"];
  assert.deepEqual(groupIds(store, { kind: "manager", roleId: "m", eventId: "e1" }), all);
  assert.deepEqual(groupIds(store, { kind: "agent", roleId: "ai", eventId: "e1" }), all);
});

test("groupsForUser limits core users to groups with their role", () => {
  const store = storeWithGroups();
  assert.deepEqual(groupIds(store, { kind: "core", roleId: "creative", eventId: "e1" }), [
    "ann",
    "core",
    "food",
  ]);
  assert.deepEqual(groupIds(store, { kind: "core", roleId: "helper", eventId: "e1" }), [
    "ann",
    "food",
  ]);
  assert.deepEqual(groupIds(store, { kind: "core", roleId: "unknown", eventId: "e1" }), []);
});

test("roleOf returns the shape core permissions expect", () => {
  const store = storeWithGroups();
  const user = {
    id: "u1",
    name: "Priya",
    eventId: "e1",
    kind: "core",
    roleId: "helper",
    categoryIds: ["food-beverage"],
  };
  assert.deepEqual(store.roleOf(user), {
    kind: "core",
    roleId: "helper",
    eventId: "e1",
    categoryIds: ["food-beverage"],
    groupIds: ["ann", "food"],
  });
});
