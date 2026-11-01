import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTools } from "../../server/agents/tools.js";
import { buildBudgetState, emptyProfile } from "../../server/core/profile.js";
import { getTemplate } from "../../server/core/templates.js";
import { createToolRunner } from "../../server/llm/toolRunner.js";

const template = getTemplate("corporate_launch");
const profile = {
  ...emptyProfile("corporate_launch", "e1"),
  guests: { min: 200, max: 200, suggested: 200, confirmed: 200 },
  budget: { totalMinor: 160000000, currency: "INR" },
  priorities: ["reveal", "food-beverage", "decor", "gifting"],
};
const state = buildBudgetState(profile, template);
const base = { profile, template, state, nowIso: "2027-01-01T00:00:00.000Z" };
const manager = { kind: "manager", eventId: "e1", categoryIds: [], groupIds: [] };
const core = { kind: "core", eventId: "e1", categoryIds: ["decor"], groupIds: [] };
const agent = { kind: "agent", eventId: "e1", categoryIds: [], groupIds: [] };

const names = (actor) =>
  buildTools({ ...base, actor })
    .map(({ name }) => name)
    .sort();
const run = (actor, name, args) =>
  createToolRunner(buildTools({ ...base, actor })).run({ name, args });

describe("buildTools: who gets which tools", () => {
  it("gives the manager every tool", () => {
    assert.deepEqual(names(manager), [
      "ack_status",
      "allocate_budget",
      "apply_change_events",
      "compute_consequences",
      "flag_at_risk",
      "groups_for_category",
      "missing_profile_fields",
      "normalise_quote",
      "overdue_acks",
      "parse_guest_count",
      "plan_timeline",
      "score_quotes",
    ]);
  });

  it("gives a core member quote and planning tools but no budget tools", () => {
    const list = names(core);
    assert.ok(list.includes("score_quotes") && list.includes("plan_timeline"));
    for (const budget of ["allocate_budget", "apply_change_events", "compute_consequences"]) {
      assert.equal(list.includes(budget), false, budget);
    }
  });

  it("gives an agent acting without a user's authority neither budget nor quote tools", () => {
    assert.deepEqual(names(agent).includes("score_quotes"), false);
    assert.equal(names(agent).includes("compute_consequences"), false);
  });

  it("offers no budget tools when there is no budget yet (intake)", () => {
    const list = buildTools({ ...base, state: undefined, actor: manager }).map(({ name }) => name);
    assert.equal(list.includes("compute_consequences"), false);
    assert.ok(list.includes("parse_guest_count"));
  });

  it("gives every tool a name, a one-line description and a schema", () => {
    for (const tool of buildTools({ ...base, actor: manager })) {
      assert.match(tool.name, /^[a-z_]+$/);
      assert.ok(tool.description.length > 10 && !tool.description.includes("\n"), tool.name);
      assert.equal(typeof tool.parameters.safeParse, "function");
    }
  });
});

describe("tool results", () => {
  it("parse_guest_count and missing_profile_fields come from core", async () => {
    assert.equal((await run(manager, "parse_guest_count", { text: "200-250" })).suggested, 263);
    assert.deepEqual(await run(manager, "parse_guest_count", { text: "lots" }), {
      error: "no guest count found",
    });
    assert.ok((await run(manager, "missing_profile_fields", {})).missing.includes("name"));
  });

  it("compute_consequences reproduces the worked example from the proposals", async () => {
    const result = await run(manager, "compute_consequences", {
      proposals: [{ type: "guest_count", delta: 50, confidence: 1 }],
    });
    assert.ok(result.shortfall.highMinor > 0);
    assert.equal("after" in result, false);
    assert.equal(result.budgetAfter.totalMinor, 160000000);
    assert.ok(result.options.length > 0);
    assert.equal(JSON.stringify(result).includes("recommend"), false);
  });

  it("apply_change_events reports clarifications instead of applying unsure changes", async () => {
    const result = await run(manager, "apply_change_events", {
      proposals: [{ type: "guest_count", delta: 50, confidence: 0.2 }],
    });
    assert.equal(result.guestCount, 200);
    assert.equal(result.needsClarification.length, 1);
  });

  it("rejects proposals that carry unknown shapes", async () => {
    const result = await run(manager, "compute_consequences", {
      proposals: [{ type: "budget_total", toMinor: 5, confidence: 1 }],
    });
    assert.deepEqual(result, { error: "invalid arguments" });
  });

  it("allocate_budget splits exactly", async () => {
    const result = await run(manager, "allocate_budget", {
      totalMinor: 1000,
      priorities: ["a", "b", "c"],
    });
    assert.equal(
      Object.values(result).reduce((a, b) => a + b, 0),
      1000,
    );
  });

  it("groups_for_category and plan_timeline use the template", async () => {
    assert.deepEqual(await run(manager, "groups_for_category", { categoryId: "food-beverage" }), [
      "food-beverage",
    ]);
    const tasks = await run(manager, "plan_timeline", { eventDateIso: "2027-06-01T00:00:00.000Z" });
    assert.equal(tasks.length, template.milestones.length);
  });

  it("ack_status and overdue_acks look directives up and handle unknown ids", async () => {
    const directive = {
      id: "d1",
      addressedUserIds: ["u1", "u2"],
      acks: [{ userId: "u1" }],
      createdAt: "2026-12-31T00:00:00.000Z",
      remindedAt: null,
    };
    const tools = buildTools({
      ...base,
      actor: manager,
      directives: [directive],
      members: [{ id: "u1" }, { id: "u2" }],
    });
    const runner = createToolRunner(tools);
    assert.equal(
      (await runner.run({ name: "ack_status", args: { directiveId: "d1" } })).label,
      "1 of 2 acknowledged",
    );
    assert.equal(
      (await runner.run({ name: "overdue_acks", args: { directiveId: "d1", slaMinutes: 60 } }))
        .isOverdue,
      true,
    );
    assert.deepEqual(await runner.run({ name: "ack_status", args: { directiveId: "nope" } }), {
      error: "unknown directive",
    });
  });

  it("score_quotes and normalise_quote use the confirmed guest count", async () => {
    const quote = {
      id: "q1",
      categoryId: "food-beverage",
      vendorName: "Caterer",
      status: "confirmed",
      perGuestMinor: 100000,
      fixedMinor: 0,
      taxBps: 0,
      mustHaveIdsMet: [],
      answers: {},
    };
    const tools = buildTools({ ...base, actor: core, quotes: [quote] });
    const runner = createToolRunner(tools);
    assert.equal(
      (await runner.run({ name: "normalise_quote", args: { quoteId: "q1" } })).totalMinor,
      20000000,
    );
    assert.equal(
      (await runner.run({ name: "score_quotes", args: { categoryId: "food-beverage" } }))[0]
        .quoteId,
      "q1",
    );
    assert.deepEqual(await runner.run({ name: "normalise_quote", args: { quoteId: "x" } }), {
      error: "unknown quote",
    });
  });
});
