import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertError, startDemo } from "./helpers.js";

const ID = "demo";
const MANAGER = "user-manager@demo";
// Owns reveal, decor, music and gifting.
const DESIGNER = "user-creative-director@demo";
const add = (call, body, as = MANAGER) =>
  call(`/events/${ID}/expenses`, { as, method: "POST", body });
const read = async (call, as = MANAGER) => (await call(`/events/${ID}/expenses`, { as })).json();

describe("expenses", () => {
  it("reads the amount in code, and shows up in the summary", async (t) => {
    const { call } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    const res = await add(call, {
      description: "Lights",
      amount: "₹1.5 lakh",
      categoryId: "decor",
    });
    assert.equal(res.status, 201);
    const { expense } = await res.json();
    assert.equal(expense.amountMinor, 15000000);
    assert.equal((await read(call)).summary.spentMinor, before + 15000000);
  });

  it("refuses unreadable, zero or foreign amounts, unknown categories and no category", async (t) => {
    const { call } = await startDemo(t);
    const body = { description: "x", categoryId: "decor" };
    await assertError(await add(call, { ...body, amount: "lots" }), 400, "BAD_REQUEST");
    await assertError(await add(call, { ...body, amount: "0" }), 400, "BAD_REQUEST");
    await assertError(await add(call, { ...body, amount: "$500" }), 400, "BAD_REQUEST");
    await assertError(
      await add(call, { description: "x", amount: "500", categoryId: "ghost" }),
      400,
      "BAD_REQUEST",
    );
    await assertError(await add(call, { description: "x", amount: "500" }), 400, "BAD_REQUEST");
  });

  it("uses up the buffer when paid from it, and gives it back when removed", async (t) => {
    const { call } = await startDemo(t);
    const left = async () => (await read(call)).summary.contingency.availableMinor;
    const start = await left();
    const res = await add(call, { description: "Rain cover", amount: "20000", fromBuffer: true });
    const { expense } = await res.json();
    assert.equal(await left(), start - 2000000);
    assert.equal(
      (await call(`/expenses/${expense.id}`, { as: MANAGER, method: "DELETE" })).status,
      204,
    );
    assert.equal(await left(), start);
  });

  it("won't pay more from the buffer than it holds", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await add(call, { description: "Too big", amount: "1 crore", fromBuffer: true }),
      400,
      "BAD_REQUEST",
    );
  });

  it("invalidates a preview when the buffer is spent", async (t) => {
    const { call } = await startDemo(t);
    const res = await call(`/events/${ID}/changes`, {
      as: MANAGER,
      method: "POST",
      body: { text: "What if 50 more guests come?" },
    });
    const { changeId } = await res.json();
    assert.ok(changeId);
    await add(call, { description: "Rain cover", amount: "1000", fromBuffer: true });
    await assertError(
      await call(`/events/${ID}/changes/${changeId}/accept`, {
        as: MANAGER,
        method: "POST",
        body: { useBuffer: true },
      }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("expense permissions", () => {
  it("gives a core member their own categories only, with no totals or buffer", async (t) => {
    const { call } = await startDemo(t);
    const { expenses, summary } = await read(call, DESIGNER);
    assert.deepEqual(summary.categories.map(({ id }) => id).sort(), [
      "decor",
      "gifting",
      "music",
      "reveal",
    ]);
    for (const key of ["totalMinor", "spentMinor", "leftMinor", "contingency"])
      assert.equal(summary[key], undefined, key);
    assert.ok(
      expenses.every(({ categoryId, fromBuffer }) => categoryId === "decor" && !fromBuffer),
    );
    assert.ok(expenses.length > 0);
  });

  it("lets a core member add to their own category, not another's or the buffer", async (t) => {
    const { call } = await startDemo(t);
    const body = { description: "x", amount: "500" };
    assert.equal((await add(call, { ...body, categoryId: "decor" }, DESIGNER)).status, 201);
    await assertError(await add(call, { ...body, categoryId: "pr" }, DESIGNER), 403, "FORBIDDEN");
    await assertError(await add(call, { ...body, fromBuffer: true }, DESIGNER), 403, "FORBIDDEN");
  });

  it("lets only the manager or the person who added it remove an expense", async (t) => {
    const { call } = await startDemo(t);
    const { expense } = await (
      await add(call, {
        description: "x",
        amount: "500",
        categoryId: "decor",
      })
    ).json();
    await assertError(
      await call(`/expenses/${expense.id}`, { as: DESIGNER, method: "DELETE" }),
      403,
      "FORBIDDEN",
    );
    const own = await (
      await add(call, { description: "y", amount: "5", categoryId: "decor" }, DESIGNER)
    ).json();
    assert.equal(
      (await call(`/expenses/${own.expense.id}`, { as: DESIGNER, method: "DELETE" })).status,
      204,
    );
  });

  it("keeps the buffer and its controls from core members", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await call(`/events/${ID}/buffer`, { as: DESIGNER, method: "POST", body: { percent: 5 } }),
      403,
      "FORBIDDEN",
    );
    await assertError(
      await call(`/events/${ID}/buffer/cover`, {
        as: DESIGNER,
        method: "POST",
        body: { categoryId: "decor" },
      }),
      403,
      "FORBIDDEN",
    );
    const budget = await (await call(`/events/${ID}/budget`, { as: DESIGNER })).json();
    assert.equal(budget.contingency, undefined);
    assert.equal(budget.categories[0].typicalBps, undefined);
  });
});

describe("the buffer controls", () => {
  it("covers an overspend from the buffer", async (t) => {
    const { call } = await startDemo(t);
    const before = (await read(call)).summary;
    const plan = before.categories.find(({ id }) => id === "pr");
    await add(call, {
      description: "Extra press",
      amount: String((plan.plannedMinor - plan.spentMinor + 500000) / 100),
      categoryId: "pr",
    });
    const res = await call(`/events/${ID}/buffer/cover`, {
      as: MANAGER,
      method: "POST",
      body: { categoryId: "pr" },
    });
    assert.deepEqual(await res.json(), { coveredMinor: 500000 });
    const after = (await read(call)).summary;
    assert.equal(after.categories.find(({ id }) => id === "pr").overMinor, 0);
    assert.equal(after.contingency.availableMinor, before.contingency.availableMinor - 500000);
    assert.equal(after.totalMinor, before.totalMinor);
    await assertError(
      await call(`/events/${ID}/buffer/cover`, {
        as: MANAGER,
        method: "POST",
        body: { categoryId: "pr" },
      }),
      400,
      "BAD_REQUEST",
    );
  });

  it("returns covered money to the buffer when the expense is removed", async (t) => {
    const { call } = await startDemo(t);
    const before = (await read(call)).summary;
    const plan = before.categories.find(({ id }) => id === "av");
    const res = await add(call, {
      description: "LED wall",
      amount: String((plan.plannedMinor + 500000) / 100),
      categoryId: "av",
    });
    const { expense } = await res.json();
    await call(`/events/${ID}/buffer/cover`, {
      as: MANAGER,
      method: "POST",
      body: { categoryId: "av" },
    });
    const covered = (await read(call)).summary;
    assert.equal(covered.coveredMinor, 500000);
    await call(`/expenses/${expense.id}`, { as: MANAGER, method: "DELETE" });
    const after = (await read(call)).summary;
    assert.equal(after.contingency.availableMinor, before.contingency.availableMinor);
    assert.equal(after.categories.find(({ id }) => id === "av").plannedMinor, plan.plannedMinor);
    assert.equal(after.coveredMinor, 0);
  });

  it("doesn't tell a core member how much came from the buffer", async (t) => {
    const { call } = await startDemo(t);
    const { summary } = await read(call, DESIGNER);
    assert.equal(summary.coveredMinor, undefined);
    for (const row of summary.categories) assert.equal(row.coveredMinor, undefined);
  });

  it("proposes a new buffer size, which changes nothing until applied", async (t) => {
    const { call, store } = await startDemo(t);
    const before = store.budgets.get(ID).contingency.reservedMinor;
    const res = await call(`/events/${ID}/buffer`, {
      as: MANAGER,
      method: "POST",
      body: { percent: 15 },
    });
    const { changeId, consequences } = await res.json();
    assert.ok(changeId);
    assert.ok(consequences.shortfall.highMinor > 0, "a bigger buffer takes money from the plan");
    assert.equal(store.budgets.get(ID).contingency.reservedMinor, before);
    const accept = await call(`/events/${ID}/changes/${changeId}/accept`, {
      as: MANAGER,
      method: "POST",
      body: { raise: true },
    });
    assert.equal(accept.status, 200);
    assert.equal(store.budgets.get(ID).contingency.reservedMinor, 24000000);
  });

  it("rejects a size outside 0 to 30", async (t) => {
    const { call } = await startDemo(t);
    await assertError(
      await call(`/events/${ID}/buffer`, { as: MANAGER, method: "POST", body: { percent: 50 } }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("the Budget agent watching expenses", () => {
  const settle = (store) => Promise.all([...store.background]);
  const AV_ROOM = `g-${ID}-music-av`;
  const CORE_ROOM = `g-${ID}-core-team`;
  const fromBudget = (store, group) =>
    store
      .messagesForGroup(group)
      .messages.filter(({ authorId }) => authorId === `agent-budget@${ID}`)
      .map(({ text }) => text);
  const overspend = async (call) => {
    const { summary } = await read(call);
    const plan = summary.categories.find(({ id }) => id === "av").plannedMinor;
    return add(call, {
      description: "LED wall advance",
      amount: String(plan / 100 + 5000),
      categoryId: "av",
    });
  };

  it("tells the category's room and Core team once, with no figures", async (t) => {
    const { call, store } = await startDemo(t);
    assert.equal((await overspend(call)).status, 201);
    await settle(store);
    for (const room of [AV_ROOM, CORE_ROOM]) {
      const [text, extra] = fromBudget(store, room);
      assert.match(text, /AV & production has gone over its plan/);
      assert.match(text, /LED wall advance/);
      assert.equal(extra, undefined);
      assert.doesNotMatch(text, /\d|₹/);
    }
    await add(call, { description: "More", amount: "2000", categoryId: "av" });
    await settle(store);
    assert.equal(fromBudget(store, AV_ROOM).length, 1);
  });

  it("stays quiet under the line, and for an expense paid from the buffer", async (t) => {
    const { call, store } = await startDemo(t);
    await add(call, { description: "Cable", amount: "1000", categoryId: "av" });
    await add(call, { description: "Rain cover", amount: "20000", fromBuffer: true });
    await settle(store);
    assert.deepEqual(fromBudget(store, AV_ROOM), []);
    assert.deepEqual(fromBudget(store, CORE_ROOM), []);
  });

  it("keeps a typed amount out of the shared message", async (t) => {
    const { call, store } = await startDemo(t);
    await add(call, {
      description: "Paid ₹9 lakh advance",
      amount: "9 lakh",
      categoryId: "av",
    });
    await settle(store);
    const [text] = fromBudget(store, CORE_ROOM);
    assert.match(text, /over its plan/);
    assert.doesNotMatch(text, /lakh|₹|\d/);
  });

  it("says nothing in a room with a vendor, and still tells Core team", async (t) => {
    const { call, store } = await startDemo(t);
    store.users.set("vendor-x", {
      id: "vendor-x",
      eventId: ID,
      kind: "vendor",
      roleId: "vendor-x",
      name: "Vendor",
      categoryIds: ["av"],
    });
    store.groups.get(AV_ROOM).memberRoleIds.push("vendor-x");
    await overspend(call);
    await settle(store);
    assert.deepEqual(fromBudget(store, AV_ROOM), []);
    assert.equal(fromBudget(store, CORE_ROOM).length, 1);
  });

  it("posts when the buffer covers it, and says if some is still over", async (t) => {
    const { call, store } = await startDemo(t);
    await overspend(call);
    await settle(store);
    await call(`/events/${ID}/buffer/cover`, {
      as: MANAGER,
      method: "POST",
      body: { categoryId: "av" },
    });
    assert.match(fromBudget(store, AV_ROOM).at(-1), /back within plan/);
    store.budgets.get(ID).contingency.reservedMinor = 26000000;
    await add(call, { description: "More", amount: "50 lakh", categoryId: "av" });
    await settle(store);
    store.budgets.set(ID, {
      ...store.budgets.get(ID),
      contingency: { reservedMinor: 2500000 + 100, spentMinor: 2500000 },
    });
    await call(`/events/${ID}/buffer/cover`, {
      as: MANAGER,
      method: "POST",
      body: { categoryId: "av" },
    });
    assert.match(fromBudget(store, AV_ROOM).at(-1), /Some of it is still over/);
  });

  it("puts spending on the attention list of those who may see it", async (t) => {
    const { call } = await startDemo(t);
    await overspend(call);
    const me = async (as) => (await (await call("/me", { as })).json()).attention.spending;
    const manager = await me(MANAGER);
    assert.equal(manager.categories[0].categoryId, "av");
    assert.equal(manager.categories[0].overMinor, 500000);
    assert.equal(manager.currency, "INR");
    assert.ok(!(await me(DESIGNER)).categories.some(({ categoryId }) => categoryId === "av"));
    assert.equal((await me("user-production-lead@demo")).categories[0].categoryId, "av");
    assert.equal((await me(DESIGNER)).bufferLeftMinor, null);
  });
});

describe("logging an expense by telling @huddle", () => {
  const settle = async (store) => {
    while (store.background.size) await Promise.all([...store.background]);
  };
  const say = (call, room, text, as = MANAGER) =>
    call(`/groups/g-${ID}-${room}/messages`, { as, method: "POST", body: { text } });
  const lastAgent = (store, room) =>
    store
      .messagesForGroup(`g-${ID}-${room}`)
      .messages.filter(({ authorKind }) => authorKind === "agent")
      .at(-1).text;

  it("reads the amount in code and keeps it out of the reply", async (t) => {
    const { call, store } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    await say(call, "music-av", "@huddle we paid ₹40,000 for the LED wall under AV");
    await settle(store);
    assert.equal((await read(call)).summary.spentMinor, before + 4000000);
    const logged = (await read(call)).expenses.at(-1);
    assert.equal(logged.categoryId, "av");
    assert.equal(logged.description, "the LED wall");
    const reply = lastAgent(store, "music-av");
    assert.match(reply, /Logged "the LED wall" under AV & production/);
    assert.doesNotMatch(reply, /40,000/);
  });

  it("asks for what is missing rather than guessing", async (t) => {
    const { call, store } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    await say(call, "music-av", "@huddle log the LED wall under AV");
    await settle(store);
    assert.match(lastAgent(store, "music-av"), /How much was it/);
    await say(call, "core-team", "@huddle paid ₹40,000 for chairs");
    await settle(store);
    assert.match(lastAgent(store, "core-team"), /Which category/);
    await say(call, "music-av", "@huddle paid $400 for cables");
    await settle(store);
    assert.match(lastAgent(store, "music-av"), /in INR/);
    assert.equal((await read(call)).summary.spentMinor, before);
  });

  it("hides the amount from the room, but still reads it", async (t) => {
    const { call, store } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    await say(call, "music-av", "@huddle we paid ₹3 lakh for the LED wall under AV");
    await settle(store);
    const asked = store
      .messagesForGroup(`g-${ID}-music-av`)
      .messages.findLast(({ authorKind }) => authorKind === "human");
    assert.equal(asked.text, "@huddle we paid [amount] for the LED wall under AV");
    assert.equal((await read(call)).summary.spentMinor, before + 30000000);
  });

  it("records nothing for a question or a what-if", async (t) => {
    const { call, store } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    await say(call, "music-av", "@huddle who paid the ₹2 lakh advance for the band?");
    await say(call, "music-av", "@huddle what if we paid 5 lakh to the band");
    await settle(store);
    assert.equal((await read(call)).summary.spentMinor, before);
    assert.match(lastAgent(store, "music-av"), /haven't recorded anything/);
  });

  it("won't log to a category the person doesn't own", async (t) => {
    const { call, store } = await startDemo(t);
    const before = (await read(call)).summary.spentMinor;
    await say(call, "core-team", "@huddle paid ₹40,000 for press kits under PR", DESIGNER);
    await settle(store);
    assert.equal((await read(call)).summary.spentMinor, before);
    assert.doesNotMatch(lastAgent(store, "core-team"), /^Logged/);
  });
});
