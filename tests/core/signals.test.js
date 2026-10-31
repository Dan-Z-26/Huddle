import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBudget } from "../../server/core/budgetEngine.js";
import { planningSignals } from "../../server/core/signals.js";
import { buildBudgetState, emptyProfile } from "../../server/core/profile.js";
import { getTemplate } from "../../server/core/templates.js";

const template = getTemplate("corporate_launch");
const NOW = "2027-01-10T00:00:00.000Z";
const profile = {
  ...emptyProfile("corporate_launch", "e1"),
  guests: { min: 200, max: 200, suggested: 200, confirmed: 200 },
  budget: { totalMinor: 100000000, currency: "INR" },
  priorities: ["reveal", "decor"],
};
const state = buildBudgetState(profile, template);
const quote = (categoryId, status) => ({ categoryId, status });
const ids = (input) =>
  planningSignals({ profile, state, nowIso: NOW, ...input }).map(({ id }) => id);

describe("planningSignals", () => {
  it("flags missing quotes for a top priority on a fresh plan", () => {
    assert.deepEqual(ids({}), ["no-quotes-reveal"]);
  });

  it("flags over budget, an overspend and late tasks, most urgent first", () => {
    const over = { ...state, totalMinor: 50000000 };
    const plan = computeBudget(state).categories.find(({ id }) => id === "decor").committedMinor;
    const found = planningSignals({
      profile,
      state: over,
      expenses: [{ amountMinor: plan + 1000, categoryId: "decor", fromBuffer: false }],
      tasks: [{ title: "Book venue", status: "todo", atRisk: true, dueDate: NOW }],
      nowIso: NOW,
    });
    const names = found.map(({ id }) => id);
    assert.ok(names.includes("over-budget"));
    assert.ok(names.includes("overspent-decor"));
    assert.ok(names.includes("tasks-late"));
    assert.equal(found[0].severity, 3);
    assert.equal(found.at(-1).severity <= found[0].severity, true);
  });

  it("only mentions a task due soon, and not a done one", () => {
    const soon = {
      title: "Sign",
      status: "todo",
      atRisk: false,
      dueDate: "2027-01-15T00:00:00.000Z",
    };
    const far = { ...soon, dueDate: "2027-06-15T00:00:00.000Z" };
    assert.ok(ids({ tasks: [soon] }).includes("task-soon"));
    assert.ok(!ids({ tasks: [far] }).includes("task-soon"));
    assert.ok(!ids({ tasks: [{ ...soon, status: "done" }] }).includes("task-soon"));
  });

  it("flags quotes to check and quotes to compare", () => {
    const found = ids({
      quotes: [
        quote("reveal", "extracted"),
        quote("decor", "confirmed"),
        quote("decor", "confirmed"),
      ],
    });
    assert.ok(found.includes("quotes-unchecked"));
    assert.ok(found.includes("quotes-waiting-decor"));
    assert.ok(!found.includes("no-quotes-reveal"));
    assert.ok(
      !ids({ quotes: [quote("decor", "confirmed"), quote("decor", "accepted")] }).includes(
        "quotes-waiting-decor",
      ),
    );
  });

  it("flags a buffer that is gone or nearly gone", () => {
    assert.ok(
      ids({ state: { ...state, contingency: { reservedMinor: 0, spentMinor: 0 } } }).includes(
        "no-buffer",
      ),
    );
    assert.ok(
      ids({ state: { ...state, contingency: { reservedMinor: 1000, spentMinor: 900 } } }).includes(
        "buffer-low",
      ),
    );
  });

  it("flags a must-have whose category fell below the level it needs", () => {
    const mustHaves = [
      { id: "m", text: "full wrap", categoryId: "decor", minTierId: "full-stage-wrap" },
    ];
    const tier = state.categories
      .find(({ id }) => id === "decor")
      .tiers.find(({ id }) => id === "full-stage-wrap");
    const decor = state.categories.find(({ id }) => id === "decor");
    const cut = {
      ...state,
      categories: state.categories.map((item) =>
        item === decor
          ? {
              ...item,
              drivers: [
                { ...item.drivers[0], kind: "fixed", unitMinor: tier.minMinor - 1, source: "user" },
              ],
            }
          : item,
      ),
    };
    assert.ok(
      planningSignals({ profile: { ...profile, mustHaves }, state: cut, nowIso: NOW })
        .map(({ id }) => id)
        .includes("must-have-decor"),
    );
  });
});
