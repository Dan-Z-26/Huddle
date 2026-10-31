import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTemplate } from "../../server/core/templates.js";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo, cookieAt } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const PR_HEAD = `user-pr-head@${ID}`;

describe("a core member cannot work out other people's budgets", () => {
  it("gets neither the ranking nor their own rank, because rank plus amount reveals the total", async (t) => {
    const { call } = await startDemo(t);
    const { event } = await (await call(`/events/${ID}`, { as: PR_HEAD })).json();
    assert.equal("priorities" in event, false);
    const budget = await (await call(`/events/${ID}/budget`, { as: PR_HEAD })).json();
    assert.ok(budget.categories.every((category) => !("rank" in category)));
  });

  it("does not see figures typed into shared text, or other categories' needs", async (t) => {
    const { call, store } = await startDemo(t);
    const event = store.events.get(ID);
    event.purpose = "Launch for partners, total budget ₹16 lakh";
    event.constraints.brand = ["stage under 3 lakh", "use the blue logo"];
    event.vendorNeeds = { "food-beverage": "capped at 8 lakh", pr: "two press kits" };
    event.mustHaves.push({ id: "mh-9", text: "max 2 crore", categoryId: null, minTierId: null });
    const seen = (await (await call(`/events/${ID}`, { as: PR_HEAD })).json()).event;
    assert.doesNotMatch(JSON.stringify(seen), /lakh|crore/);
    assert.deepEqual(seen.vendorNeeds, { pr: "two press kits" });
    assert.ok(seen.constraints.brand.includes("use the blue logo"));
    assert.ok(seen.mustHaves.every(({ categoryId }) => categoryId !== "decor"));
    const own = (await (await call(`/events/${ID}`, { as: MANAGER })).json()).event;
    assert.match(own.purpose, /16 lakh/);
    assert.ok(own.priorities.length > 0);
  });
});

describe("intake keeps confirmed money and dates", () => {
  async function atMustHaves(t) {
    const { call, store } = await startDemo(t);
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "corporate_launch" } })
    ).json();
    const as = `user-manager@${event.id}`;
    const answers = [
      "Nova",
      "Unveil it",
      "12 March 2031",
      "Pune",
      "Ballroom",
      "200",
      "16 lakh",
      "reveal, food",
      "Proud",
    ];
    for (const answer of answers)
      await call(`/events/${event.id}/intake`, { as, method: "POST", body: { answer } });
    return { call, store, as, id: event.id };
  }

  it("does not let a later answer that mentions money or a date replace them", async (t) => {
    const { call, store, as, id } = await atMustHaves(t);
    assert.equal(store.events.get(id).budget.totalMinor, 160000000);
    const body = { answer: "catering max ₹8 lakh, launch on 1 June 2032" };
    await call(`/events/${id}/intake`, { as, method: "POST", body });
    assert.equal(store.events.get(id).budget.totalMinor, 160000000);
    assert.equal(store.events.get(id).date, "2031-03-12T00:00:00.000Z");
  });

  it("refuses an answer that finishes after the workspace was confirmed", async (t) => {
    const { store, call, as, id } = await atMustHaves(t);
    const slow = call(`/events/${id}/intake`, { as, method: "POST", body: { answer: "none" } });
    store.events.get(id).intakeStatus = "confirmed";
    const res = await slow;
    assert.equal(store.events.get(id).intakeStatus, "confirmed");
    await assertError(res, 400, "BAD_REQUEST");
  });
});

describe("resource limits", () => {
  it("replaces the oldest non-demo event at the cap, so nobody can block new events", async (t) => {
    const { call, store } = await startDemo(t);
    const ids = [];
    for (let i = 0; i < 49; i++) {
      store.events.set(`e${i}`, { id: `e${i}` });
      ids.push(`e${i}`);
    }
    store.users.set("u", { id: "u", eventId: "e0", kind: "manager" });
    store.tasks.set("t", { id: "t", eventId: "e0" });
    const res = await call("/events", { method: "POST", body: { eventType: "birthday" } });
    assert.equal(res.status, 201);
    assert.equal(store.events.has(ID), true);
    assert.equal(store.events.has("e0"), false);
    assert.equal(store.users.has("u"), false);
    assert.equal(store.tasks.has("t"), false);
    assert.equal(store.events.size, 50);
  });

  it("limits how fast one client can create events", async (t) => {
    const { call } = await startDemo(t);
    let last;
    for (let i = 0; i < 21; i++)
      last = await call("/events", { method: "POST", body: { eventType: "birthday" } });
    await assertError(last, 429, "RATE_LIMITED");
  });

  it("posts one digest a day, however often it is asked for", async (t) => {
    const { call, store } = await startDemo(t);
    const post = () => call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" });
    const first = (await (await post()).json()).message;
    const second = (await (await post()).json()).message;
    assert.equal(first.id, second.id);
    const posted = store
      .messagesForGroup(`g-${ID}-announcements`)
      .messages.filter(({ authorId }) => authorId === `agent-timeline@${ID}`);
    assert.equal(posted.length, 1);
  });

  it("keeps one event's proposals from evicting another's", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
    for (let i = 0; i < 100; i++)
      store.pendingChanges.set(`o${i}`, { id: `o${i}`, eventId: "other", events: [] });
    await call(`/events/${ID}/changes`, {
      as: MANAGER,
      method: "POST",
      body: { text: "add 10 guests" },
    });
    assert.equal(store.pendingChanges.has(changeId), true);
  });

  it("clears an event's other proposals when one is accepted, since they are now stale", async (t) => {
    const { call, store } = await startDemo(t);
    const propose = async (text) =>
      (
        await (
          await call(`/events/${ID}/changes`, { as: MANAGER, method: "POST", body: { text } })
        ).json()
      ).changeId;
    const first = await propose("add 50 guests");
    const second = await propose("add 10 guests");
    await call(`/events/${ID}/changes/${first}/accept`, { as: MANAGER, method: "POST" });
    assert.equal(store.pendingChanges.has(second), false);
  });
});

describe("change accept", () => {
  it("keeps the applied change when a notice fails, and reports only what was posted", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
    const realSet = store.messages.set.bind(store.messages);
    store.messages.set = () => {
      throw new Error("store down");
    };
    const res = await call(`/events/${ID}/changes/${changeId}/accept`, {
      as: MANAGER,
      method: "POST",
    });
    store.messages.set = realSet;
    assert.equal(res.status, 200);
    assert.equal((await res.json()).noticesPosted, 0);
    assert.equal(store.budgets.get(ID).guestCount, 250);
  });
});

describe("choosing how to close the gap", () => {
  const over = async (call) =>
    await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 50 guests" },
      })
    ).json();
  const accept = (call, changeId, body) =>
    call(`/events/${ID}/changes/${changeId}/accept`, { as: MANAGER, method: "POST", body });

  it("applies the cut the manager chose, and the budget balances", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId, consequences } = await over(call);
    assert.ok(consequences.shortfall.highMinor > 0);
    const res = await accept(call, changeId, { cuts: ["reveal"] });
    const { budget } = await res.json();
    assert.equal(budget.guestCount, 250);
    assert.ok(budget.remainingMinor >= 0, "the gap is closed");
    const option = consequences.options.find(({ categoryId }) => categoryId === "reveal");
    assert.equal(
      budget.categories.find(({ id }) => id === "reveal").committedMinor,
      option.atHigh.newTotalMinor,
    );
    assert.equal(store.budgets.get(ID).totalMinor, 160000000);
  });

  it("works through several cuts in order, taking only what is still needed", async (t) => {
    const { call, store } = await startDemo(t);
    const { changeId, consequences } = await over(call);
    const gap = consequences.shortfall.highMinor;
    const gifting = consequences.options.find(({ categoryId }) => categoryId === "gifting").atHigh;
    const costOfGifting = gifting.newTotalMinor + gifting.cutMinor;
    assert.ok(costOfGifting > gap, "gifting alone covers this gap");
    const pr = store.budgets.get(ID).categories.find(({ id }) => id === "pr");
    assert.ok(pr);
    const { budget } = await (await accept(call, changeId, { cuts: ["gifting", "pr"] })).json();
    assert.equal(
      budget.categories.find(({ id }) => id === "gifting").committedMinor,
      costOfGifting - gap,
    );
    const prOption = consequences.options.find(({ categoryId }) => categoryId === "pr").atHigh;
    assert.equal(
      budget.categories.find(({ id }) => id === "pr").committedMinor,
      prOption.newTotalMinor + prOption.cutMinor,
      "no more is taken than the gap needs",
    );
  });

  it("carries on to the next category when the first can't cover the gap", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await (
      await call(`/events/${ID}/changes`, {
        as: MANAGER,
        method: "POST",
        body: { text: "add 200 guests" },
      })
    ).json();
    const { budget } = await (await accept(call, changeId, { cuts: ["gifting", "pr"] })).json();
    assert.equal(budget.categories.find(({ id }) => id === "gifting").committedMinor, 0);
    assert.ok(budget.categories.find(({ id }) => id === "pr").committedMinor < 17777778);
  });

  it("raises the budget by exactly the gap when asked", async (t) => {
    const { call } = await startDemo(t);
    const { changeId, consequences } = await over(call);
    const { budget } = await (await accept(call, changeId, { raise: true })).json();
    assert.equal(budget.totalMinor, 160000000 + consequences.shortfall.highMinor);
  });

  it("stays over budget when the manager chooses nothing", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await over(call);
    const { budget } = await (await accept(call, changeId)).json();
    assert.ok(budget.remainingMinor < 0);
  });

  it("ignores a cut that isn't an option, and rejects extra fields", async (t) => {
    const { call } = await startDemo(t);
    const { changeId } = await over(call);
    await assertError(await accept(call, changeId, { budget: 1 }), 400, "BAD_REQUEST");
    const { budget } = await (await accept(call, changeId, { cuts: ["nope"] })).json();
    assert.ok(budget.remainingMinor < 0);
  });
});

describe("the assistant adapts to what is asked", () => {
  const ask = async (call, text) =>
    await (
      await call(`/events/${ID}/changes`, { as: MANAGER, method: "POST", body: { text } })
    ).json();

  it("moves money between categories", async (t) => {
    const { call, store } = await startDemo(t);
    const before = store.budgets.get(ID);
    const { changeId } = await ask(call, "move 1 lakh from decor to food");
    assert.ok(changeId);
    const { budget } = await (
      await call(`/events/${ID}/changes/${changeId}/accept`, { as: MANAGER, method: "POST" })
    ).json();
    const sum = budget.categories.reduce((total, { committedMinor }) => total + committedMinor, 0);
    const was = before.categories.length;
    assert.equal(budget.categories.length, was);
    assert.ok(sum <= 160000000);
  });

  it("reduces a category by half", async (t) => {
    const { call } = await startDemo(t);
    const { consequences } = await ask(call, "reduce gifting by half");
    const delta = consequences.deltas.find(({ categoryId }) => categoryId === "gifting");
    assert.equal(delta.afterMinor, Math.round(delta.beforeMinor / 2));
  });

  it("answers a plain question with real figures, and offers nothing to apply", async (t) => {
    const { call } = await startDemo(t);
    const body = await ask(call, "how much are we spending per guest?");
    assert.equal(body.changeId, null);
    assert.match(body.answer, /per guest/);
    assert.match(body.answer, /₹/);
    assert.equal(body.offline, true);
  });

  it("says plainly when no model was reached", async (t) => {
    const { call } = await startDemo(t);
    assert.equal((await ask(call, "add 50 guests")).offline, true);
  });
});

describe("judge's fixes", () => {
  it("hides amounts however they are written, from core members only", async (t) => {
    const { call, store } = await startDemo(t);
    store.events.get(ID).purpose = "Budget is 2500000 rupees or USD 30000";
    const seen = (await (await call(`/events/${ID}`, { as: PR_HEAD })).json()).event;
    assert.doesNotMatch(seen.purpose, /2500000|30000/);
    const own = (await (await call(`/events/${ID}`, { as: MANAGER })).json()).event;
    assert.match(own.purpose, /2500000/);
  });

  // Birthdays and community events have one helper; the host or organiser runs the other rooms.
  it("gives every category a core owner where the event has a full team", () => {
    for (const eventType of ["corporate_launch", "wedding"]) {
      const { categories, roles } = getTemplate(eventType);
      const owned = new Set(
        roles.filter(({ kind }) => kind === "core").flatMap(({ categoryIds }) => categoryIds),
      );
      for (const { id } of categories) assert.ok(owned.has(id), `${eventType}: ${id}`);
    }
  });

  it("tells Announcements when the date moves", async (t) => {
    const { call, store } = await startDemo(t);
    await call(`/events/${ID}/reschedule`, {
      as: MANAGER,
      method: "POST",
      body: { date: "20 June 2031" },
    });
    const { messages } = store.messagesForGroup(`g-${ID}-announcements`);
    assert.match(messages.at(-1).text, /20 June 2031/);
    assert.equal(messages.at(-1).authorKind, "system");
  });

  it("returns ideas that say why they fit, and whether a model wrote them", async (t) => {
    const { call } = await startDemo(t);
    const body = await (await call(`/events/${ID}/ideas`, { as: MANAGER, method: "POST" })).json();
    assert.ok(body.ideas.length > 0);
    assert.ok(body.ideas.every(({ whyItFits, costShare }) => whyItFits && costShare));
    assert.equal(body.offline, true);
  });
});

describe("review: every shared text field", () => {
  it("hides amounts typed into the venue or city from core members", async (t) => {
    const { call, store } = await startDemo(t);
    store.events.get(ID).venueType = "Ballroom under 5 lakh";
    store.events.get(ID).city = "Pune, 90000 cap";
    const seen = (await (await call(`/events/${ID}`, { as: PR_HEAD })).json()).event;
    assert.doesNotMatch(`${seen.venueType} ${seen.city}`, /lakh|90000/);
  });

  it("keeps an amount in the event name out of the welcome post", async (t) => {
    const { store } = await startDemo(t);
    const { createWorkspace, createEvent } = await import("../../server/store/workspace.js");
    const { event } = createEvent(store, { eventType: "birthday", id: "gala" });
    Object.assign(event, {
      name: "Gala 5 lakh",
      date: "2031-01-01T00:00:00.000Z",
      guests: { min: 10, max: 10, suggested: 10, confirmed: 10 },
      budget: { totalMinor: 10000000, currency: "INR" },
      priorities: ["food-cake"],
    });
    createWorkspace(store, event, "2026-10-31T09:00:00.000Z");
    const { messages } = store.messagesForGroup("g-gala-announcements");
    assert.doesNotMatch(messages[0].text, /lakh/);
  });

  it("gives all AI routes one shared limit, not one per router", async (t) => {
    const { call, store } = await startDemo(t);
    let last;
    for (let i = 0; i < 31; i++) {
      // Alternate routes: each used to have its own counter of 30.
      last =
        i % 2
          ? await call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" })
          : await call(`/events/${ID}/ideas`, { as: MANAGER, method: "POST" });
    }
    assert.equal(last.status, 429);
    assert.ok(store);
  });

  it("shares one digest between two quick requests", async (t) => {
    const { call, store } = await startDemo(t);
    const post = () => call(`/events/${ID}/digest`, { as: MANAGER, method: "POST" });
    const [a, b] = await Promise.all([post(), post()]);
    assert.equal((await a.json()).message.id, (await b.json()).message.id);
    const posted = store
      .messagesForGroup(`g-${ID}-announcements`)
      .messages.filter(({ authorId }) => authorId === `agent-timeline@${ID}`);
    assert.equal(posted.length, 1);
  });
});

describe("security review of phases 5 and 6", () => {
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
  const DESIGNER = `user-creative-director@${ID}`;

  it("keeps the manager's budget questions out of what core members can read", async (t) => {
    const { call, store } = await startDemo(t);
    const ask = (text) =>
      call(`/groups/g-${ID}-stage-decor/messages`, { as: MANAGER, method: "POST", body: { text } });
    for (const text of [
      "@huddle what if we add 50 guests?",
      "@huddle give me ideas",
      "@huddle what is left in the budget?",
    ]) {
      await ask(text);
      await Promise.all([...store.background]);
    }
    const seen = await (
      await call(`/groups/g-${ID}-stage-decor/messages`, { as: DESIGNER })
    ).json();
    const agentText = seen.messages
      .filter(({ authorKind }) => authorKind === "agent")
      .map(({ text, rationale }) => `${text} ${rationale ?? ""}`)
      .join("\n");
    assert.doesNotMatch(agentText, /₹|priority|\d{5}/);
  });

  it("refuses a quote that was edited after the manager reviewed it", async (t) => {
    const { call } = await startDemo(t);
    const made = (
      await (
        await call(`/events/${ID}/quotes`, {
          as: MANAGER,
          method: "POST",
          body: {
            categoryId: "food-beverage",
            vendorName: "Green Leaf",
            perGuestText: "₹1,000",
            taxPercent: 5,
          },
        })
      ).json()
    ).quote;
    const proposed = await (
      await call(`/quotes/${made.id}/accept`, { as: MANAGER, method: "POST" })
    ).json();
    await call(`/quotes/${made.id}/confirm`, {
      as: MANAGER,
      method: "POST",
      body: { vendorName: "Green Leaf", perGuestText: "₹900", taxPercent: 5 },
    });
    await assertError(
      await call(`/events/${ID}/changes/${proposed.changeId}/accept`, {
        as: MANAGER,
        method: "POST",
        body: {},
      }),
      400,
      "BAD_REQUEST",
    );
  });

  it("won't accept the same quote twice", async (t) => {
    const { call } = await startDemo(t);
    const made = (
      await (
        await call(`/events/${ID}/quotes`, {
          as: MANAGER,
          method: "POST",
          body: { categoryId: "food-beverage", vendorName: "Green Leaf", perGuestText: "₹1,000" },
        })
      ).json()
    ).quote;
    const first = await (
      await call(`/quotes/${made.id}/accept`, { as: MANAGER, method: "POST" })
    ).json();
    await call(`/events/${ID}/changes/${first.changeId}/accept`, {
      as: MANAGER,
      method: "POST",
      body: {},
    });
    await assertError(
      await call(`/quotes/${made.id}/accept`, { as: MANAGER, method: "POST" }),
      400,
      "BAD_REQUEST",
    );
  });

  it("downloads a file whose name isn't plain ASCII", async (t) => {
    const { base, call } = await startDemo(t);
    const form = new FormData();
    form.append("files", new Blob([PDF]), "quo’te 中.pdf");
    const res = await fetch(`${base}/api/groups/g-${ID}-core-team/messages`, {
      method: "POST",
      headers: { cookie: cookieAt(base, MANAGER) },
      body: form,
    });
    const { message } = await res.json();
    const file = await call(`/files/${message.files[0].id}`, { as: MANAGER });
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
    assert.match(
      file.headers.get("content-disposition"),
      /filename\*=UTF-8''quo%E2%80%99te%20%E4%B8%AD\.pdf/,
    );
  });

  it("caps the files an event may keep, and frees files when old messages are dropped", async (t) => {
    const { base, store, uploadsDir } = await startDemo(t);
    const { readdir } = await import("node:fs/promises");
    for (let i = 0; i < 40; i++)
      store.files.set(`f${i}`, {
        id: `f${i}`,
        groupId: `g-${ID}-core-team`,
        size: 10,
        storedName: `x${i}`,
      });
    const form = new FormData();
    form.append("files", new Blob([PDF]), "one-too-many.pdf");
    const res = await fetch(`${base}/api/groups/g-${ID}-core-team/messages`, {
      method: "POST",
      headers: { cookie: cookieAt(base, MANAGER) },
      body: form,
    });
    await assertError(res, 413, "PAYLOAD_TOO_LARGE");
    assert.deepEqual(await readdir(uploadsDir), []);
    // An evicted message takes its file with it.
    store.files.clear();
    const { addMessage } = await import("../../server/store/workspace.js");
    const { saveUpload } = await import("../../server/store/files.js");
    const record = await saveUpload(store, uploadsDir, {
      buffer: PDF,
      originalName: "a.pdf",
      groupId: `g-${ID}-music-av`,
      userId: MANAGER,
    });
    addMessage(store, {
      id: "old",
      groupId: `g-${ID}-music-av`,
      authorKind: "human",
      authorId: MANAGER,
      text: "x",
      fileIds: [record.id],
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    for (let i = 0; i < 300; i++)
      addMessage(store, {
        id: `n${i}`,
        groupId: `g-${ID}-music-av`,
        authorKind: "human",
        authorId: MANAGER,
        text: "x",
        fileIds: [],
        createdAt: "2026-10-31T00:00:00.000Z",
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(store.files.size, 0);
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  it("deletes the file of a quote that could not be read", async (t) => {
    const { base, store, uploadsDir } = await startDemo(t);
    const { readdir } = await import("node:fs/promises");
    store.events.get(ID).mustHaves = null; // makes reading fail after the file is saved
    const form = new FormData();
    form.set("categoryId", "food-beverage");
    form.set("file", new Blob([PDF]), "q.pdf");
    t.mock.method(console, "error", () => {});
    const res = await fetch(`${base}/api/events/${ID}/quotes`, {
      method: "POST",
      headers: { cookie: cookieAt(base, MANAGER) },
      body: form,
    });
    assert.equal(res.status, 500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(store.files.size, 0);
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  it("hides a directive from someone removed from its group, and doesn't remind them", async (t) => {
    const { call, store } = await startDemo(t);
    const message = (
      await (
        await call(`/groups/g-${ID}-stage-decor/messages`, {
          as: MANAGER,
          method: "POST",
          body: { text: "Specs by Friday" },
        })
      ).json()
    ).message;
    await call(`/messages/${message.id}/directive`, { as: MANAGER, method: "POST", body: {} });
    await call(`/groups/g-${ID}-stage-decor`, {
      as: MANAGER,
      method: "PATCH",
      body: { memberRoleIds: ["production-lead"] },
    });
    const me = await (await call("/me", { as: DESIGNER })).json();
    assert.deepEqual(me.attention.directives, []);
    const { runReminders } = await import("../../server/reminders.js");
    const generate = async () => ({
      data: { reminderText: "Nudge", rationale: "ok" },
      toolCalls: [],
    });
    await runReminders(store, new Date(Date.now() + 5 * 3600000).toISOString(), {
      slaMinutes: 120,
      generate,
    });
    const text = store.messagesForGroup(`g-${ID}-stage-decor`).messages.at(-1).text;
    assert.doesNotMatch(text, /Rohan Kapoor/);
  });
});
