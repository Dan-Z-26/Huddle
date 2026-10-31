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
