import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runReminders } from "../../server/reminders.js";
import { assertError, settle, startDemo } from "./helpers.js";

const ID = "demo";
const MANAGER = `user-manager@${ID}`;
const FOOD_LEAD = `user-fb-lead@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const post = async (call, path, body, as = MANAGER) => call(path, { as, method: "POST", body });
const addQuote = async (call, fields, as = MANAGER) =>
  post(call, `/events/${ID}/quotes`, { vendorName: "Vendor", ...fields }, as);

async function book(call, store, categoryId, fields = { fixedText: "₹50,000", taxPercent: 0 }) {
  const { quote } = await (await addQuote(call, { categoryId, ...fields })).json();
  const { changeId } = await (await post(call, `/quotes/${quote.id}/accept`)).json();
  const applied = await post(call, `/events/${ID}/changes/${changeId}/accept`, { raise: true });
  assert.equal(applied.status, 200);
  await settle(store);
  return { quote, vendorId: `vendor-${quote.id}@${ID}` };
}

describe("typed quote prices", () => {
  it("counts a per-guest price under a thousand", async (t) => {
    const { call } = await startDemo(t);
    const res = await addQuote(call, {
      categoryId: "food-beverage",
      perGuestText: "800",
      fixedText: "₹50,000",
      taxPercent: 18,
    });
    const { quote, warnings } = await res.json();
    assert.equal(quote.perGuestMinor, 80000);
    assert.equal(quote.status, "confirmed");
    assert.deepEqual(warnings, []);
  });

  it("reads '800 per plate' too", async (t) => {
    const { call } = await startDemo(t);
    const { quote } = await (
      await addQuote(call, { categoryId: "food-beverage", perGuestText: "800 per plate" })
    ).json();
    assert.equal(quote.perGuestMinor, 80000);
  });

  it("doesn't confirm a quote with a price it couldn't read", async (t) => {
    const { call } = await startDemo(t);
    const { quote, warnings } = await (
      await addQuote(call, {
        categoryId: "food-beverage",
        perGuestText: "about eight hundred",
        fixedText: "₹50,000",
      })
    ).json();
    assert.equal(quote.status, "extracted");
    assert.match(warnings[0], /couldn't read the per-guest price/);
  });

  it("refuses another currency, and so does confirming", async (t) => {
    const { call } = await startDemo(t);
    const { quote, warnings } = await (
      await addQuote(call, { categoryId: "food-beverage", fixedText: "$5,000" })
    ).json();
    assert.equal(quote.status, "extracted");
    assert.equal(quote.fixedMinor, 0);
    assert.ok(warnings.some((text) => /isn't in INR/.test(text)));
    await assertError(
      await post(call, `/quotes/${quote.id}/confirm`, { vendorName: "V", fixedText: "$5,000" }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("a quote's minimum guests", () => {
  it("is what gets compared and what enters the plan", async (t) => {
    const { call, store } = await startDemo(t);
    const addConfirmed = async (vendorName, perGuestText, minGuests) => {
      const { quote } = await (
        await addQuote(call, {
          categoryId: "food-beverage",
          vendorName,
          perGuestText,
          taxPercent: 0,
        })
      ).json();
      if (minGuests)
        await post(call, `/quotes/${quote.id}/confirm`, {
          vendorName,
          perGuestText,
          taxPercent: 0,
          minGuests,
        });
      return quote;
    };
    const min = await addConfirmed("MinCo", "1,000", 500);
    await addConfirmed("Plain", "1,200");
    const { rows } = await (
      await call(`/events/${ID}/comparison?categoryId=food-beverage`, { as: MANAGER })
    ).json();
    const total = (name) => rows.find(({ vendorName }) => vendorName === name).totalMinor;
    assert.equal(total("MinCo"), 50000000);
    assert.equal(total("Plain"), 24000000);
    const { changeId } = await (await post(call, `/quotes/${min.id}/accept`)).json();
    await post(call, `/events/${ID}/changes/${changeId}/accept`, { raise: true });
    const budget = await (await call(`/events/${ID}/budget`, { as: MANAGER })).json();
    assert.equal(
      budget.categories.find(({ id }) => id === "food-beverage").committedMinor,
      50000000,
    );
    assert.ok(store.budgets.get(ID));
  });
});

describe("a booked vendor's room", () => {
  it("is never Core team: a category with no room gets one", async (t) => {
    const { call, store } = await startDemo(t);
    const { vendorId } = await book(call, store, "gifting");
    await assertError(
      await call(`/groups/g-${ID}-core-team/messages`, { as: vendorId }),
      403,
      "FORBIDDEN",
    );
    const room = store.groups.get(`g-${ID}-vendor-gifting`);
    assert.ok(room.memberRoleIds.includes(store.users.get(vendorId).roleId));
    assert.ok(room.memberRoleIds.includes("manager"));
    assert.ok(room.memberRoleIds.includes("creative-director"));
    assert.ok(!room.memberRoleIds.includes("fb-lead"));
    assert.equal((await call(`/groups/${room.id}/messages`, { as: vendorId })).status, 200);
  });

  it("leaves Core team hearing about overspending", async (t) => {
    const { call, store } = await startDemo(t);
    await book(call, store, "gifting");
    await post(call, `/events/${ID}/expenses`, {
      description: "Hampers",
      amount: "9 lakh",
      categoryId: "decor",
    });
    await settle(store);
    assert.ok(
      store
        .messagesForGroup(`g-${ID}-core-team`)
        .messages.some(({ text }) => /over its plan/.test(text)),
    );
  });

  it("is made when the category's room was removed, and hiring still works", async (t) => {
    const { call, store } = await startDemo(t);
    await call(`/groups/g-${ID}-photo-video`, { as: MANAGER, method: "DELETE" });
    const { vendorId } = await book(call, store, "photo-video");
    assert.ok(store.users.has(vendorId));
    assert.ok(store.groups.has(`g-${ID}-vendor-photo-video`));
    assert.ok(store.tasksForEvent(ID).some(({ source }) => source === "vendor"));
  });

  it("is told when the date moves", async (t) => {
    const { call, store } = await startDemo(t);
    await book(call, store, "food-beverage");
    const res = await post(call, `/events/${ID}/reschedule`, { date: "2030-03-03" });
    assert.equal(res.status, 200);
    await settle(store);
    assert.match(
      store.messagesForGroup(`g-${ID}-food-beverage`).messages.at(-1).text,
      /date has moved to 3 March 2030/,
    );
  });
});

describe("buffer money when a plan is replaced", () => {
  const overspend = async (call, store, categoryId, extra = 200000) => {
    const state = await (await call(`/events/${ID}/expenses`, { as: MANAGER })).json();
    const { plannedMinor } = state.summary.categories.find(({ id }) => id === categoryId);
    const { expense } = await (
      await post(call, `/events/${ID}/expenses`, {
        description: "Over",
        amount: String((plannedMinor + extra) / 100),
        categoryId,
      })
    ).json();
    await post(call, `/events/${ID}/buffer/cover`, { categoryId });
    await settle(store);
    return expense;
  };
  const buffer = (store) => store.budgets.get(ID).contingency;

  it("goes back to the buffer when a quote replaces the plan", async (t) => {
    const { call, store } = await startDemo(t);
    const before = buffer(store).reservedMinor;
    await overspend(call, store, "gifting");
    assert.equal(buffer(store).reservedMinor, before - 200000);
    const { quote } = await (
      await addQuote(call, { categoryId: "gifting", fixedText: "₹1,000", taxPercent: 0 })
    ).json();
    const { changeId } = await (await post(call, `/quotes/${quote.id}/accept`)).json();
    await post(call, `/events/${ID}/changes/${changeId}/accept`, { raise: true });
    assert.equal(buffer(store).reservedMinor, before);
  });

  it("stays its own line when money is moved, so it can still go back", async (t) => {
    const { call, store } = await startDemo(t);
    const before = buffer(store).reservedMinor;
    const expense = await overspend(call, store, "gifting");
    const { changeId } = await (
      await post(call, `/events/${ID}/changes`, { text: "Move ₹5,000 from PR to Gifting" })
    ).json();
    const applied = await post(call, `/events/${ID}/changes/${changeId}/accept`, {});
    assert.equal(applied.status, 200);
    const { summary } = await (await call(`/events/${ID}/expenses`, { as: MANAGER })).json();
    assert.equal(summary.coveredMinor, 200000);
    await call(`/expenses/${expense.id}`, { as: MANAGER, method: "DELETE" });
    assert.equal(buffer(store).reservedMinor, before);
  });
});

describe("a group the manager adds", () => {
  it("lets the people in it post", async (t) => {
    const { call } = await startDemo(t);
    const { group } = await (
      await post(call, `/events/${ID}/groups`, {
        name: "Logistics",
        memberRoleIds: ["creative-director"],
      })
    ).json();
    const res = await post(call, `/groups/${group.id}/messages`, { text: "Hello" }, DESIGNER);
    assert.equal(res.status, 201);
  });
});

describe("telling @huddle about a payment", () => {
  const say = (call, text, as) =>
    post(call, `/groups/g-${ID}-food-beverage/messages`, { text }, as);
  const logged = (store) =>
    [...store.expenses.values()].filter(
      ({ description }) => !/advance|deposit|kit|generator/i.test(description),
    );

  it("isn't thrown by a word that starts like a category", async (t) => {
    const { call, store } = await startDemo(t);
    await say(call, "@huddle paid ₹40,000 for the premium dessert counter", FOOD_LEAD);
    await settle(store);
    assert.equal(logged(store).at(-1).categoryId, "food-beverage");
  });

  it("explains why a brief can't be redrafted, rather than saying try again", async (t) => {
    const { call, store } = await startDemo(t);
    await say(call, "@huddle please draft a brief for food", FOOD_LEAD);
    await settle(store);
    const text = store.messagesForGroup(`g-${ID}-food-beverage`).messages.at(-1).text;
    assert.doesNotMatch(text, /try again/);
    assert.match(text, /approved/i);
  });
});

describe("asking about vendors in a category's room", () => {
  it("takes the category from the room when the words don't name it", async (t) => {
    const { call, store } = await startDemo(t);
    await post(
      call,
      `/groups/g-${ID}-food-beverage/messages`,
      { text: "@huddle a few partners are vegan, which vendor questions matter?" },
      FOOD_LEAD,
    );
    await settle(store);
    const reply = store.messagesForGroup(`g-${ID}-food-beverage`).messages.at(-1).text;
    assert.doesNotMatch(reply, /Which category/);
    assert.match(reply, /Food & beverage/);
  });
});

describe("reminders", () => {
  it("aren't held up by directives with nobody left to remind", async (t) => {
    const { store } = await startDemo(t);
    const nowIso = "2027-01-01T00:00:00.000Z";
    const directive = (id, addressedUserIds, messageId) => ({
      id,
      messageId,
      groupId: `g-${ID}-core-team`,
      addressedUserIds,
      acks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      remindedAt: null,
      taskId: null,
    });
    const { id: messageId } = store.messagesForGroup(`g-${ID}-core-team`).messages[0];
    for (const n of [1, 2, 3, 4, 5, 6])
      store.directives.set(`old-${n}`, directive(`old-${n}`, ["gone"], messageId));
    store.directives.set("real", directive("real", [DESIGNER], messageId));
    await runReminders(store, nowIso);
    await runReminders(store, nowIso);
    assert.ok(store.directives.get("real").remindedAt);
  });

  it("can be limited to one event", async (t) => {
    const { store } = await startDemo(t);
    const { id: messageId } = store.messagesForGroup(`g-${ID}-core-team`).messages[0];
    store.directives.set("d", {
      id: "d",
      messageId,
      groupId: `g-${ID}-core-team`,
      addressedUserIds: [DESIGNER],
      acks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      remindedAt: null,
      taskId: null,
    });
    await runReminders(store, "2027-01-01T00:00:00.000Z", { eventId: "someone-else" });
    assert.equal(store.directives.get("d").remindedAt, null);
  });
});
