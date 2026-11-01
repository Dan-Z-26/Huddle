import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget, contingencyOf } from "../../server/core/budgetEngine.js";
import { applyChangeEvents } from "../../server/core/changeEvents.js";
import { computeConsequences, resolutionEvents } from "../../server/core/consequences.js";
import {
  coverEvents,
  expenseAlerts,
  expenseSummary,
  spendingWatch,
  uncoverEvents,
} from "../../server/core/expenses.js";
import { buildBudgetState, emptyProfile } from "../../server/core/profile.js";
import { getTemplate } from "../../server/core/templates.js";

const template = getTemplate("corporate_launch");
const profile = {
  ...emptyProfile("corporate_launch", "e1"),
  guests: { min: 200, max: 200, suggested: 200, confirmed: 200 },
  budget: { totalMinor: 100000000, currency: "INR" },
  priorities: ["reveal", "decor"],
};
const state = buildBudgetState(profile, template);
const planOf = (id, from = state) =>
  computeBudget(from).categories.find((category) => category.id === id).committedMinor;
const expense = (amountMinor, categoryId, fromBuffer = false) => ({
  amountMinor,
  categoryId,
  fromBuffer,
});

describe("the opening budget", () => {
  it("sets 10% aside and plans the rest, to the rupee", () => {
    const budget = computeBudget(state);
    assert.equal(budget.contingency.reservedMinor, 10000000);
    // Dividing per guest can leave a few paise unplanned, never more.
    assert.ok(budget.remainingMinor >= 0 && budget.remainingMinor < 100000);
    assert.equal(budget.committedMinor + budget.remainingMinor, 90000000);
  });

  it("funds every category, ranked or not", () => {
    for (const { id, committedMinor } of computeBudget(state).categories)
      assert.ok(committedMinor > 0, id);
  });
});

describe("the buffer in a change", () => {
  const extra = { type: "guest_count", delta: 50 };

  it("isn't spent by a change: going over the plan is a shortfall even with buffer left", () => {
    const { shortfall, bufferAvailableMinor } = computeConsequences(state, [extra], profile);
    assert.ok(shortfall.highMinor > 0);
    assert.equal(bufferAvailableMinor, 10000000);
  });

  it("closes the gap when chosen, and the plan then fits", () => {
    const first = computeConsequences(state, [extra], profile);
    const { events, remainingMinor } = resolutionEvents(first, { useBuffer: true });
    assert.equal(events[0].type, "contingency_draw");
    assert.equal(remainingMinor, 0);
    const final = computeConsequences(state, [extra, ...events], profile);
    assert.equal(final.shortfall.highMinor, 0);
    assert.equal(final.after.totalMinor, state.totalMinor);
    assert.equal(contingencyOf(final.after).reservedMinor, 10000000 - first.shortfall.highMinor);
  });

  it("isn't offered to fill the gap that making it bigger just created", () => {
    const toMinor = state.contingency.reservedMinor + 5000000;
    const result = computeConsequences(state, [{ type: "contingency_set", toMinor }], profile);
    assert.ok(result.shortfall.highMinor > 0);
    assert.equal(result.bufferAvailableMinor, 0);
    assert.deepEqual(resolutionEvents(result, { useBuffer: true }).events, []);
  });

  it("goes first, and a cut or a raise covers only what it can't", () => {
    const small = { ...state, contingency: { reservedMinor: 1000, spentMinor: 0 } };
    // Spendable is then the plan less 2000, which a 1000 buffer can only half cover.
    const toMinor = computeBudget(small).committedMinor - 1000;
    const first = computeConsequences(small, [{ type: "budget_total", toMinor }], profile);
    assert.equal(first.shortfall.highMinor, 2000);
    const { events, remainingMinor } = resolutionEvents(first, { useBuffer: true, raise: true });
    assert.deepEqual(
      events.map(({ type }) => type),
      ["contingency_draw", "budget_total"],
    );
    assert.equal(remainingMinor, 0);
  });

  it("won't draw more than is left, or set the buffer below what it has paid", () => {
    const used = { ...state, contingency: { reservedMinor: 1000, spentMinor: 800 } };
    assert.equal(
      applyChangeEvents(used, [{ type: "contingency_draw", amountMinor: 201 }]).rejected.length,
      1,
    );
    assert.equal(
      applyChangeEvents(used, [{ type: "contingency_draw", amountMinor: 200 }]).rejected.length,
      0,
    );
    assert.equal(
      applyChangeEvents(used, [{ type: "contingency_set", toMinor: 799 }]).rejected.length,
      1,
    );
    assert.equal(
      applyChangeEvents(used, [{ type: "contingency_set", toMinor: used.totalMinor + 1 }]).rejected
        .length,
      1,
    );
  });
});

describe("expenseSummary", () => {
  it("compares spend with plan, per category and overall", () => {
    const plan = planOf("decor");
    const summary = expenseSummary(state, [expense(1000, "decor"), expense(plan, "decor")]);
    const decor = summary.categories.find(({ id }) => id === "decor");
    assert.equal(decor.spentMinor, plan + 1000);
    assert.equal(decor.leftMinor, 0);
    assert.equal(decor.overMinor, 1000);
    assert.equal(summary.spentMinor, plan + 1000);
    assert.equal(summary.leftMinor, state.totalMinor - plan - 1000);
  });

  it("doesn't count a buffer expense against a category, but does overall", () => {
    const summary = expenseSummary(state, [
      expense(5000, "decor", true),
      expense(7000, null, true),
    ]);
    assert.equal(summary.categories.find(({ id }) => id === "decor").spentMinor, 0);
    assert.equal(summary.spentMinor, 12000);
  });
});

describe("coverEvents", () => {
  it("moves the overspend from the buffer into the plan, leaving the total alone", () => {
    const plan = planOf("decor");
    const spent = [expense(plan + 5000, "decor")];
    const { events, coveredMinor } = coverEvents(state, spent, "decor");
    assert.equal(coveredMinor, 5000);
    const { state: after, rejected } = applyChangeEvents(state, events);
    assert.deepEqual(rejected, []);
    assert.equal(planOf("decor", after), plan + 5000);
    assert.equal(contingencyOf(after).reservedMinor, 10000000 - 5000);
    assert.equal(computeBudget(after).remainingMinor, computeBudget(state).remainingMinor);
    assert.equal(after.totalMinor, state.totalMinor);
    assert.equal(
      expenseSummary(after, spent).categories.find(({ id }) => id === "decor").overMinor,
      0,
    );
  });

  it("keeps per-guest costs working, instead of flattening the category", () => {
    const plan = planOf("food-beverage");
    const { events } = coverEvents(state, [expense(plan + 5000, "food-beverage")], "food-beverage");
    const { state: after } = applyChangeEvents(state, events);
    const { state: more } = applyChangeEvents(after, [{ type: "guest_count", delta: 10 }]);
    assert.ok(planOf("food-beverage", more) > planOf("food-beverage", after));
  });

  it("covers only what the buffer holds, and nothing when nothing is over", () => {
    const low = { ...state, contingency: { reservedMinor: 300, spentMinor: 100 } };
    assert.equal(
      coverEvents(low, [expense(planOf("decor") + 5000, "decor")], "decor").coveredMinor,
      200,
    );
    assert.deepEqual(coverEvents(state, [], "decor"), { events: [], coveredMinor: 0 });
    assert.equal(coverEvents(state, [], "ghost").coveredMinor, 0);
  });
});

describe("what a cover shows and undoes", () => {
  const cover = (from, spent, id) =>
    applyChangeEvents(from, coverEvents(from, spent, id).events).state;
  const rowOf = (summary, id) => summary.categories.find((row) => row.id === id);

  it("says how much of a plan came from the buffer, per category and overall", () => {
    const plan = planOf("decor");
    const spent = [expense(plan + 5000, "decor")];
    const summary = expenseSummary(cover(state, spent, "decor"), spent);
    const decor = rowOf(summary, "decor");
    assert.equal(decor.plannedMinor, plan + 5000);
    assert.equal(decor.coveredMinor, 5000);
    assert.equal(decor.overMinor, 0);
    assert.equal(summary.coveredMinor, 5000);
    assert.equal(rowOf(summary, "pr").coveredMinor, 0);
  });

  it("adds up several covers, and leaves what the buffer couldn't pay as over", () => {
    const low = { ...state, contingency: { reservedMinor: 3000, spentMinor: 0 } };
    const spent = [expense(planOf("decor") + 2000, "decor")];
    const once = cover(low, spent, "decor");
    const more = [...spent, expense(5000, "decor")];
    const decor = rowOf(expenseSummary(cover(once, more, "decor"), more), "decor");
    assert.equal(decor.coveredMinor, 3000);
    assert.equal(decor.overMinor, 4000);
  });

  it("gives everything back once the overspend has gone", () => {
    const spent = [expense(planOf("decor") + 5000, "decor")];
    const covered = cover(state, spent, "decor");
    const { events, returnedMinor } = uncoverEvents(covered, [], "decor");
    assert.equal(returnedMinor, 5000);
    const { state: after, rejected } = applyChangeEvents(covered, events);
    assert.deepEqual(rejected, []);
    assert.equal(planOf("decor", after), planOf("decor"));
    assert.equal(contingencyOf(after).availableMinor, 10000000);
  });

  it("gives back only what is no longer needed", () => {
    const plan = planOf("decor");
    const spent = [expense(plan, "decor"), expense(5000, "decor")];
    const covered = cover(state, spent, "decor");
    const smaller = [expense(plan, "decor"), expense(2000, "decor")];
    const { events, returnedMinor } = uncoverEvents(covered, smaller, "decor");
    assert.equal(returnedMinor, 3000);
    const { state: after } = applyChangeEvents(covered, events);
    assert.equal(rowOf(expenseSummary(after, smaller), "decor").coveredMinor, 2000);
    assert.equal(contingencyOf(after).availableMinor, 10000000 - 2000);
  });

  it("does nothing when nothing was covered, or it is all still needed", () => {
    assert.deepEqual(uncoverEvents(state, [], "decor"), { events: [], returnedMinor: 0 });
    assert.equal(uncoverEvents(state, [], "ghost").returnedMinor, 0);
    const spent = [expense(planOf("decor") + 5000, "decor")];
    assert.equal(uncoverEvents(cover(state, spent, "decor"), spent, "decor").returnedMinor, 0);
  });
});

describe("watching spending", () => {
  const plan = planOf("decor");
  const summaryOf = (spent, from = state) => expenseSummary(from, spent);
  const near = Math.ceil((plan * 80) / 100);

  it("alerts once when a category crosses a line, not on every expense after", () => {
    const empty = summaryOf([]);
    const nearly = summaryOf([expense(near, "decor")]);
    const over = summaryOf([expense(plan + 1, "decor")]);
    const alert = (status) => [{ categoryId: "decor", name: "Décor", status }];
    assert.deepEqual(expenseAlerts(empty, summaryOf([expense(near - 1, "decor")])), []);
    assert.deepEqual(expenseAlerts(empty, nearly), alert("near"));
    assert.deepEqual(expenseAlerts(nearly, over), alert("over"));
    assert.deepEqual(expenseAlerts(empty, over), alert("over"));
    assert.deepEqual(expenseAlerts(over, summaryOf([expense(plan + 9, "decor")])), []);
    assert.deepEqual(expenseAlerts(over, nearly), []);
  });

  it("says over, not near, exactly past the plan, and ok when nothing is spent", () => {
    assert.equal(spendingWatch(summaryOf([expense(plan, "decor")])).categories[0].status, "near");
    assert.equal(
      spendingWatch(summaryOf([expense(plan + 1, "decor")])).categories[0].status,
      "over",
    );
    assert.deepEqual(spendingWatch(summaryOf([])).categories, []);
  });

  it("lists what is over first, with the figures", () => {
    const { categories } = spendingWatch(
      summaryOf([expense(near, "decor"), expense(planOf("pr") + 500, "pr")]),
    );
    assert.deepEqual(
      categories.map(({ categoryId, status }) => [categoryId, status]),
      [
        ["pr", "over"],
        ["decor", "near"],
      ],
    );
    assert.equal(categories[0].overMinor, 500);
    assert.equal(categories[1].leftMinor, plan - near);
  });

  it("flags a low buffer only when it can be seen, counting what moved out of it", () => {
    const low = { ...state, contingency: { reservedMinor: 1000, spentMinor: 800 } };
    assert.equal(spendingWatch(summaryOf([], low)).bufferLeftMinor, 200);
    assert.equal(spendingWatch(summaryOf([])).bufferLeftMinor, null);
    assert.equal(spendingWatch({ categories: [] }).bufferLeftMinor, null);
    const drawn = { ...state, contingency: { reservedMinor: 100, spentMinor: 0 } };
    const spent = [expense(planOf("decor") + 100, "decor")];
    const covered = applyChangeEvents(drawn, coverEvents(drawn, spent, "decor").events).state;
    assert.equal(spendingWatch(summaryOf(spent, covered)).bufferLeftMinor, 0);
  });
});
