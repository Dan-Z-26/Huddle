import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, cookieAt, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const PR = `user-pr-head@${ID}`;
const FB = `user-fb-lead@${ID}`;
const settle = (store) => Promise.all([...store.background]);
const fresh = async (t) => {
  const ctx = await startDemo(t);
  ctx.store.briefs.clear();
  return ctx;
};
const post = (call, path, as, body) => call(path, { as, method: "POST", body });
const say = (call, as, slug, text) => post(call, `/groups/g-${ID}-${slug}/messages`, as, { text });
const prBrief = (store) => store.briefs.get(`b-${ID}-pr`);

async function approved(call, as = PR) {
  const { brief } = await (
    await post(call, `/events/${ID}/briefs`, as, { categoryId: "pr" })
  ).json();
  await post(call, `/briefs/${brief.id}/send`, as);
  await post(call, `/briefs/${brief.id}/decision`, MANAGER, { approve: true });
  return brief;
}

async function upload(base, as, file, categoryId = "pr") {
  const bytes = await readFile(new URL(`../../public/samples/${file}`, import.meta.url));
  const form = new FormData();
  form.set("categoryId", categoryId);
  form.append("file", new Blob([bytes], { type: "application/pdf" }), file);
  return fetch(`${base}/api/events/${ID}/quotes`, {
    method: "POST",
    headers: { cookie: cookieAt(base, as) },
    body: form,
  });
}

// What a person does after checking a reading: confirm it as it stands.
function confirmBody(quote) {
  const rupees = (minor) => (minor ? `₹${minor / 100}` : undefined);
  return {
    vendorName: quote.vendorName,
    perGuestText: rupees(quote.perGuestMinor),
    fixedText: rupees(quote.fixedMinor),
    ...(quote.taxStated ? { taxPercent: quote.taxBps / 100 } : {}),
    includes: quote.includes,
    exclusions: quote.exclusions,
    ...(quote.minGuests ? { minGuests: quote.minGuests } : {}),
    answers: quote.answers,
  };
}

async function threeQuotes({ call, base }) {
  const quotes = [];
  for (const file of ["pr-brightline.pdf", "pr-northstar.pdf", "pr-signal.pdf"]) {
    const { quote } = await (await upload(base, PR, file)).json();
    const res = await post(call, `/quotes/${quote.id}/confirm`, PR, confirmBody(quote));
    quotes.push((await res.json()).quote);
  }
  return quotes;
}

async function accept(call, quote) {
  const { changeId } = await (await post(call, `/quotes/${quote.id}/accept`, MANAGER)).json();
  return post(call, `/events/${ID}/changes/${changeId}/accept`, MANAGER, { useBuffer: true });
}

describe("the brief", () => {
  it("is drafted when the lead asks @huddle, and never carries money", async (t) => {
    const { call, store } = await fresh(t);
    await say(call, PR, "pr-media", "@huddle we need a vendor, please draft a brief");
    await settle(store);
    const brief = prBrief(store);
    assert.equal(brief.status, "draft");
    assert.match(brief.text, /PR & media/);
    assert.ok(!/₹|lakh|16,00,000/.test(brief.text));
    const replies = [...store.messages.values()].filter(
      ({ groupId, authorId }) =>
        groupId === `g-${ID}-pr-media` && authorId.startsWith("agent-vendor"),
    );
    assert.match(replies.at(-1).text, /drafted/);
  });

  it("refuses someone who doesn't own the category, by @huddle or directly", async (t) => {
    const { call, store } = await fresh(t);
    await say(call, FB, "food-beverage", "@huddle draft a brief for PR & media");
    await settle(store);
    assert.equal(prBrief(store), undefined);
    await assertError(
      await post(call, `/events/${ID}/briefs`, FB, { categoryId: "pr" }),
      403,
      "FORBIDDEN",
    );
  });

  it("refuses answers with amounts in them", async (t) => {
    const { call } = await fresh(t);
    await assertError(
      await post(call, `/events/${ID}/briefs`, PR, {
        categoryId: "pr",
        answers: { scope: "Budget is ₹2 lakh" },
      }),
      400,
      "BAD_REQUEST",
    );
  });

  it("goes Draft, Pending, Approved, with only the manager deciding", async (t) => {
    const { call, store } = await fresh(t);
    const { brief } = await (
      await post(call, `/events/${ID}/briefs`, PR, { categoryId: "pr" })
    ).json();
    await assertError(
      await post(call, `/briefs/${brief.id}/decision`, MANAGER, { approve: true }),
      400,
      "BAD_REQUEST",
    );
    assert.equal((await post(call, `/briefs/${brief.id}/send`, PR)).status, 200);
    assert.equal(prBrief(store).status, "pending");
    const inCore = [...store.messages.values()].filter(
      ({ groupId }) => groupId === `g-${ID}-core-team`,
    );
    assert.match(inCore.at(-1).text, /brief for approval/);
    await assertError(
      await post(call, `/briefs/${brief.id}/decision`, PR, { approve: true }),
      403,
      "FORBIDDEN",
    );
    await post(call, `/briefs/${brief.id}/decision`, MANAGER, {
      approve: false,
      note: "Add the press desk",
    });
    assert.equal(prBrief(store).status, "changes");
    assert.equal(prBrief(store).note, "Add the press desk");
    await post(call, `/briefs/${brief.id}/send`, PR);
    await post(call, `/briefs/${brief.id}/decision`, MANAGER, { approve: true });
    assert.equal(prBrief(store).status, "approved");
    assert.ok(store.tasks.has(`${ID}-task-hire-pr-visit`));
  });

  it("exports as plain text", async (t) => {
    const { call } = await fresh(t);
    const brief = await approved(call);
    const res = await call(`/briefs/${brief.id}/export`, { as: PR });
    assert.match(res.headers.get("content-type"), /text\/plain/);
    assert.match(res.headers.get("content-disposition"), /attachment/);
    assert.match(await res.text(), /Hiring brief/);
  });
});

describe("quotes", () => {
  it("wait for an approved brief", async (t) => {
    const { base } = await fresh(t);
    await assertError(await upload(base, PR, "pr-brightline.pdf"), 400, "BAD_REQUEST");
  });

  it("are read once per file, with sources and missing items, until confirmed", async (t) => {
    const { call, base } = await fresh(t);
    await approved(call);
    const { quote } = await (await upload(base, PR, "pr-brightline.pdf")).json();
    assert.equal(quote.status, "extracted");
    assert.equal(quote.vendorName, "Brightline PR");
    assert.equal(quote.fixedMinor, 9000000);
    assert.equal(quote.taxStated, false);
    assert.match(quote.sources.price, /90,000/);
    assert.deepEqual(quote.exclusions, ["Press kit printing"]);
    assert.equal(quote.validUntil, "31 January 2027");
    const { rows } = await (
      await call(`/events/${ID}/comparison?categoryId=pr`, { as: PR })
    ).json();
    assert.deepEqual(rows, [], "a reading doesn't count until a person confirms it");
  });

  it("compare with reasons and warnings, for the manager and that lead only", async (t) => {
    const ctx = await fresh(t);
    await approved(ctx.call);
    await threeQuotes(ctx);
    const { rows } = await (
      await ctx.call(`/events/${ID}/comparison?categoryId=pr`, { as: PR })
    ).json();
    const named = (name) => rows.find(({ vendorName }) => vendorName === name);
    assert.ok(named("Brightline PR").warnings.some((text) => /Taxes aren't stated/.test(text)));
    assert.ok(named("Signal House").warnings.some((text) => /Minimum 300 guests/.test(text)));
    assert.ok(named("Brightline PR").reasons.some((text) => /Lowest total as stated/.test(text)));
    await assertError(
      await ctx.call(`/events/${ID}/comparison?categoryId=pr`, { as: FB }),
      403,
      "FORBIDDEN",
    );
  });
});

describe("the demo, end to end", () => {
  it("runs from a brief to Vendor B in the PR group", async (t) => {
    const ctx = await fresh(t);
    const { call, store } = ctx;
    await say(call, PR, "pr-media", "@huddle please draft a brief for a PR vendor");
    await settle(store);
    await post(call, `/briefs/${prBrief(store).id}/send`, PR);
    await post(call, `/briefs/${prBrief(store).id}/decision`, MANAGER, { approve: true });
    const [, vendorB] = await threeQuotes(ctx);
    const before = store.budgets.get(ID).categories.find(({ id }) => id === "pr");
    const res = await accept(call, vendorB);
    assert.equal(res.status, 200);

    // In that category's group, and only there.
    const vendorId = `vendor-${vendorB.id}@${ID}`;
    const { groups } = await (await call(`/events/${ID}`, { as: vendorId })).json();
    assert.deepEqual(
      groups.map(({ slug }) => slug),
      ["pr-media"],
    );
    // The budget moved from a plan to the quote.
    const after = store.budgets.get(ID).categories.find(({ id }) => id === "pr");
    assert.notDeepEqual(after.drivers, before.drivers);
    assert.ok(after.drivers.every(({ source }) => source === "quote"));
    // Tasks, and the checklist.
    assert.ok(store.tasks.get(`${ID}-task-hire-pr-contract`).title.includes("Northstar Media"));
    const { rows } = await (await call(`/events/${ID}/hiring`, { as: MANAGER })).json();
    const row = rows.find(({ categoryId }) => categoryId === "pr");
    assert.equal(row.stage, "booked");
    assert.equal(row.vendor.name, "Northstar Media");
    assert.ok(row.vendor.deliverables.length > 0);
    // Everyone else gets a decline to copy.
    const { text } = await (
      await post(
        call,
        `/quotes/${rows[0] && ctx.store.quotes.values().next().value.id}/decline-draft`,
        PR,
      )
    ).json();
    assert.match(text, /another vendor/);
    assert.ok(!/₹/.test(text));
  });
});

describe("a booked vendor", () => {
  async function booked(t) {
    const ctx = await fresh(t);
    await approved(ctx.call);
    const quotes = await threeQuotes(ctx);
    await say(ctx.call, PR, "pr-media", "The budget for this is ₹5 lakh, keep it quiet");
    await accept(ctx.call, quotes[1]);
    return { ...ctx, quotes, vendor: `vendor-${quotes[1].id}@${ID}` };
  }

  it("sees only messages from after joining, with amounts hidden", async (t) => {
    const { call, vendor } = await booked(t);
    await say(call, PR, "pr-media", "Your deposit is ₹25,000");
    await say(call, PR, "pr-media", "Please send the staff list");
    const { messages } = await (
      await call(`/groups/g-${ID}-pr-media/messages`, { as: vendor })
    ).json();
    const texts = messages.map(({ text }) => text).join(" | ");
    assert.ok(!texts.includes("keep it quiet"), "what was said before they joined stays private");
    assert.ok(!/₹/.test(texts), texts);
    assert.match(texts, /not shared outside the team/);
    assert.match(texts, /staff list/);
    assert.ok(messages.every(({ rationale }) => !rationale));
  });

  it("can't reach the plan, the budget, other groups or quotes", async (t) => {
    const { call, vendor, quotes } = await booked(t);
    const as = { as: vendor };
    for (const path of [
      `/events/${ID}/budget`,
      `/events/${ID}/timeline`,
      `/events/${ID}/expenses`,
      `/events/${ID}/hiring`,
      `/events/${ID}/quotes?categoryId=pr`,
      `/events/${ID}/comparison?categoryId=pr`,
    ])
      await assertError(await call(path, as), 403, "FORBIDDEN");
    await assertError(await call(`/groups/g-${ID}-core-team/messages`, as), 403, "FORBIDDEN");
    await assertError(
      await call(`/quotes/${quotes[0].id}/confirm`, {
        ...as,
        method: "POST",
        body: { vendorName: "x" },
      }),
      403,
      "FORBIDDEN",
    );
    const { event, template, members } = await (await call(`/events/${ID}`, as)).json();
    assert.equal(event.budget, undefined);
    assert.equal(event.priorities, undefined);
    assert.equal(event.purpose, undefined);
    assert.deepEqual(template.roles, []);
    assert.deepEqual(
      template.categories.map(({ id }) => id),
      ["pr"],
    );
    assert.ok(!members.some(({ id }) => id === FB), "people outside their group aren't listed");
  });

  it("can't download rival quotes", async (t) => {
    const { call, vendor, quotes } = await booked(t);
    await assertError(
      await call(`/files/${quotes[0].sourceFileId}`, { as: vendor }),
      403,
      "FORBIDDEN",
    );
    assert.equal((await call(`/files/${quotes[0].sourceFileId}`, { as: PR })).status, 200);
  });

  it("is posted to, but @huddle doesn't answer them", async (t) => {
    const { call, store, vendor } = await booked(t);
    const res = await say(call, vendor, "pr-media", "@huddle what is the budget?");
    assert.equal(res.status, 201);
    await settle(store);
    assert.equal(store.background.size, 0);
    const last = [...store.messages.values()].at(-1);
    assert.equal(last.authorId, vendor);
  });

  it("ticks their deliverables, and the team sees progress", async (t) => {
    const { call, store, vendor } = await booked(t);
    const { deliverables, brief } = await (await call("/vendor/home", { as: vendor })).json();
    assert.ok(brief.length > 0);
    for (const { id } of deliverables) {
      const res = await call(`/deliverables/${id}`, {
        as: vendor,
        method: "PATCH",
        body: { done: true },
      });
      assert.equal(res.status, 200);
    }
    await assertError(
      await call(`/deliverables/${deliverables[0].id}`, {
        as: MANAGER,
        method: "PATCH",
        body: { done: false },
      }),
      404,
      "NOT_FOUND",
    );
    assert.equal(store.tasks.get(`${ID}-task-hire-pr-deliverables`).status, "done");
    const { rows } = await (await call(`/events/${ID}/hiring`, { as: MANAGER })).json();
    assert.equal(rows.find(({ categoryId }) => categoryId === "pr").stage, "delivered");
  });

  it("gets a redacted notice to acknowledge when the guest count changes", async (t) => {
    const { call, store, vendor } = await booked(t);
    const { changeId } = await (
      await post(call, `/events/${ID}/changes`, MANAGER, { text: "add 50 guests" })
    ).json();
    await post(call, `/events/${ID}/changes/${changeId}/accept`, MANAGER, { raise: true });
    const me = await (await call("/me", { as: vendor })).json();
    assert.equal(me.attention.directives.length, 1);
    assert.deepEqual(me.attention.tasks, []);
    const directive = me.attention.directives[0];
    assert.match(directive.text, /250/);
    assert.ok(!/₹/.test(directive.text));
    assert.equal((await post(call, `/directives/${directive.id}/ack`, vendor)).status, 200);
    assert.equal((await (await call("/me", { as: vendor })).json()).attention.directives.length, 0);
    assert.ok(store.directives.get(directive.id).acks.length === 1);
  });

  it("can be asked for a revised quote in one click", async (t) => {
    const { call, quotes, vendor } = await booked(t);
    const res = await post(call, `/quotes/${quotes[1].id}/request-revision`, PR);
    assert.equal(res.status, 201);
    const { messages } = await (
      await call(`/groups/g-${ID}-pr-media/messages`, { as: vendor })
    ).json();
    assert.match(messages.at(-1).text, /revised quote for 200 guests/);
    await assertError(
      await post(call, `/quotes/${quotes[0].id}/request-revision`, PR),
      400,
      "BAD_REQUEST",
    );
  });

  it("is replaced when another quote is accepted later", async (t) => {
    const { call, store, quotes, vendor } = await booked(t);
    await accept(call, quotes[0]);
    assert.equal(store.users.get(vendor), undefined);
    assert.ok(store.users.get(`vendor-${quotes[0].id}@${ID}`));
    assert.ok(
      !store.groups.get(`g-${ID}-pr-media`).memberRoleIds.includes(`vendor-${quotes[1].id}`),
    );
    await assertError(await call(`/events/${ID}`, { as: vendor }), 401, "UNAUTHENTICATED");
  });
});

describe("the invite link", () => {
  async function booked(t) {
    const ctx = await fresh(t);
    await approved(ctx.call);
    const quotes = await threeQuotes(ctx);
    await accept(ctx.call, quotes[1]);
    return { ...ctx, vendor: `vendor-${quotes[1].id}@${ID}` };
  }
  const follow = (base, path) => fetch(`${base}${path}`, { redirect: "manual" });
  const cookieOf = (res) => res.headers.get("set-cookie")?.split(";")[0];

  it("signs the vendor in as themselves, closed to the demo sign-in", async (t) => {
    const { call, base, vendor } = await booked(t);
    const { path } = await (
      await post(call, `/vendors/${encodeURIComponent(vendor)}/invite`, PR)
    ).json();
    const res = await follow(base, path);
    assert.equal(res.status, 302);
    const cookie = cookieOf(res);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.user.id, vendor);
    assert.equal(me.invited, true);
    const people = await fetch(`${base}/api/people`, { headers: { cookie } });
    await assertError(people, 403, "FORBIDDEN");
    const upgrade = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: MANAGER }),
    });
    await assertError(upgrade, 403, "FORBIDDEN");
  });

  it("stops working when revoked, ending any session it started", async (t) => {
    const { call, base, vendor } = await booked(t);
    const url = `/vendors/${encodeURIComponent(vendor)}/invite`;
    const { path } = await (await post(call, url, MANAGER)).json();
    const cookie = cookieOf(await follow(base, path));
    assert.equal((await call(url, { as: MANAGER, method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
    const again = await follow(base, path);
    assert.match(again.headers.get("location"), /invite=invalid/);
    assert.equal(again.headers.get("set-cookie"), null);
  });

  it("expires, and a new link replaces the old one", async (t) => {
    const { call, base, store, vendor } = await booked(t);
    const url = `/vendors/${encodeURIComponent(vendor)}/invite`;
    const { path: first } = await (await post(call, url, MANAGER)).json();
    const { path: second } = await (await post(call, url, MANAGER)).json();
    assert.match((await follow(base, first)).headers.get("location"), /invite=invalid/);
    for (const invite of store.invites.values()) invite.expiresAt = Date.now() - 1;
    assert.match((await follow(base, second)).headers.get("location"), /invite=invalid/);
  });

  it("is only for the manager or that lead", async (t) => {
    const { call, vendor } = await booked(t);
    await assertError(
      await post(call, `/vendors/${encodeURIComponent(vendor)}/invite`, FB),
      403,
      "FORBIDDEN",
    );
  });
});

describe("what the security review checked", () => {
  async function booked(t) {
    const ctx = await fresh(t);
    await approved(ctx.call);
    const quotes = await threeQuotes(ctx);
    await say(ctx.call, PR, "pr-media", "Before they join: keep this under ₹5 lakh");
    await accept(ctx.call, quotes[1]);
    return { ...ctx, quotes, vendor: `vendor-${quotes[1].id}@${ID}` };
  }

  it("hides amounts past the old scan limit, and rates like 850 per plate", async (t) => {
    const { call, vendor } = await booked(t);
    await say(call, PR, "pr-media", `${"Long note. ".repeat(250)}The rate is ₹5,000`);
    await say(call, PR, "pr-media", "They quoted 850 per plate");
    const { messages } = await (
      await call(`/groups/g-${ID}-pr-media/messages`, { as: vendor })
    ).json();
    const texts = messages.map(({ text }) => text).join(" ");
    assert.ok(!texts.includes("5,000"));
    assert.ok(!texts.includes("850"));
  });

  it("keeps a directive from before they joined, and its amounts, off their list", async (t) => {
    const { call, store, vendor } = await booked(t);
    const earlier = [...store.messages.values()].find(({ text }) => text.startsWith("Before they"));
    const later = await (await say(call, PR, "pr-media", "Keep it under ₹5 lakh, please")).json();
    await post(call, `/messages/${earlier.id}/directive`, MANAGER);
    await post(call, `/messages/${later.message.id}/directive`, MANAGER);
    const { attention } = await (await call("/me", { as: vendor })).json();
    assert.equal(attention.directives.length, 1);
    assert.match(attention.directives[0].text, /not shared outside the team/);
  });

  it("gives a vendor only files they attached themselves", async (t) => {
    const { call, base, store, vendor } = await booked(t);
    const bytes = await readFile(new URL("../../public/samples/pr-signal.pdf", import.meta.url));
    const form = new FormData();
    form.set("text", "The budget sheet");
    form.append("files", new Blob([bytes]), "budget-5-lakh.pdf");
    await fetch(`${base}/api/groups/g-${ID}-pr-media/messages`, {
      method: "POST",
      headers: { cookie: cookieAt(base, PR) },
      body: form,
    });
    const record = [...store.files.values()].find(({ originalName }) =>
      originalName.startsWith("budget-"),
    );
    await assertError(await call(`/files/${record.id}`, { as: vendor }), 403, "FORBIDDEN");
    const { messages } = await (
      await call(`/groups/g-${ID}-pr-media/messages`, { as: vendor })
    ).json();
    assert.ok(
      messages.every(({ files }) => files.length === 0),
      "not even the file's name",
    );
  });

  it("stops a vendor flooding the group", async (t) => {
    const { call, vendor } = await booked(t);
    let last;
    for (let i = 0; i < 51; i++) last = await say(call, vendor, "pr-media", `Message ${i}`);
    await assertError(last, 429, "RATE_LIMITED");
  });

  it("doesn't let a core member's score carry the ranking", async (t) => {
    const ctx = await fresh(t);
    await approved(ctx.call);
    await threeQuotes(ctx);
    const scores = async (as) =>
      (await (await ctx.call(`/events/${ID}/comparison?categoryId=pr`, { as })).json()).rows.map(
        ({ score }) => score,
      );
    ctx.store.events.get(ID).priorities = ["pr", "decor"];
    const first = await scores(PR);
    ctx.store.events.get(ID).priorities = ["decor", "pr"];
    assert.deepEqual(await scores(PR), first);
  });

  it("ends a stream, and any session from the old link, when an invite is replaced", async (t) => {
    const { call, base, store, vendor } = await booked(t);
    const url = `/vendors/${encodeURIComponent(vendor)}/invite`;
    const { path } = await (await post(call, url, MANAGER)).json();
    const joined = await fetch(`${base}${path}`, { redirect: "manual" });
    const cookie = joined.headers.get("set-cookie").split(";")[0];
    const stream = await fetch(`${base}/api/stream`, { headers: { cookie } });
    await post(call, url, MANAGER);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
    await say(call, PR, "pr-media", "Anyone there?");
    const reader = stream.body.getReader();
    let ended = false;
    for (let i = 0; i < 5 && !ended; i++) ({ done: ended } = await reader.read());
    assert.equal(ended, true);
    assert.ok(store.sessions.size > 0);
  });
});
