import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEMO_EVENT_ID as ID } from "../../server/store/seed.js";
import { assertError, startDemo } from "./helpers.js";

const MANAGER = `user-manager@${ID}`;
const DESIGNER = `user-creative-director@${ID}`; // owns decor, not food-beverage
const LEAD = `user-production-lead@${ID}`; // owns food-beverage
const PR_HEAD = `user-pr-head@${ID}`;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const TEXT =
  "Vendor: Saffron Table Caterers\n₹1,800 per guest\nGST 18%\nIncludes: buffet, service staff";

const post = (call, path, body, as = MANAGER) => call(path, { as, method: "POST", body });
const quote = (call, categoryId, extra, as = MANAGER) =>
  post(call, `/events/${ID}/quotes`, { categoryId, ...extra }, as);

async function upload(base, as, fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set("file", new Blob([file.buffer]), file.name);
  return fetch(`${base}/api/events/${ID}/quotes`, {
    method: "POST",
    headers: { cookie: `huddle_user=${encodeURIComponent(as)}` },
    body: form,
  });
}

describe("RFQ and checklist", () => {
  it("gives the standard questions, and posts them once in the category's group", async (t) => {
    const { call, store } = await startDemo(t);
    const first = await (
      await post(call, `/events/${ID}/rfq`, { categoryId: "food-beverage" })
    ).json();
    assert.ok(first.rfqQuestions.length >= 5);
    assert.ok(first.checklist.length > 0);
    assert.equal(first.offline, true);
    assert.equal(first.message.groupId, `g-${ID}-food-beverage`);
    assert.equal(first.message.authorId, `agent-vendor@${ID}`);
    const again = await (
      await post(call, `/events/${ID}/rfq`, { categoryId: "food-beverage" })
    ).json();
    assert.equal(again.message, null);
    const posted = store
      .messagesForGroup(`g-${ID}-food-beverage`)
      .messages.filter(({ authorId }) => authorId.startsWith("agent-vendor"));
    assert.equal(posted.length, 1);
  });

  it("is open to the manager and to core members who own the category, and nobody else", async (t) => {
    const { call } = await startDemo(t);
    const rfq = (as, categoryId = "food-beverage") =>
      post(call, `/events/${ID}/rfq`, { categoryId }, as);
    assert.equal((await rfq(LEAD)).status, 200);
    await assertError(await rfq(DESIGNER), 403, "FORBIDDEN");
    await assertError(await rfq(PR_HEAD), 403, "FORBIDDEN");
    await assertError(await rfq(MANAGER, "nope"), 400, "BAD_REQUEST");
    await assertError(
      await post(call, `/events/${ID}/rfq`, { categoryId: "pr" }, null),
      401,
      "UNAUTHENTICATED",
    );
  });
});

describe("adding a quote", () => {
  it("reads pasted text, with prices parsed in code, and waits for confirmation", async (t) => {
    const { call, store } = await startDemo(t);
    const body = await (await quote(call, "food-beverage", { text: TEXT })).json();
    assert.equal(body.quote.status, "extracted");
    assert.equal(body.quote.vendorName, "Saffron Table Caterers");
    assert.equal(body.quote.perGuestMinor, 180000);
    assert.equal(body.quote.taxBps, 1800);
    assert.equal(store.quotes.get(body.quote.id).eventId, ID);
  });

  it("takes typed details as confirmed, because a person entered them", async (t) => {
    const { call } = await startDemo(t);
    const body = await (
      await quote(call, "food-beverage", {
        vendorName: "Green Leaf",
        perGuestText: "₹1,500 per guest",
        fixedText: "₹50,000",
        taxPercent: 5,
        includes: "buffet, desserts",
      })
    ).json();
    assert.equal(body.quote.status, "confirmed");
    assert.equal(body.quote.fixedMinor, 5000000);
    assert.equal(body.quote.taxBps, 500);
    assert.deepEqual(body.quote.includes, ["buffet", "desserts"]);
  });

  it("leaves typed details with no readable price for confirmation, with a warning", async (t) => {
    const { call } = await startDemo(t);
    const body = await (await quote(call, "food-beverage", { vendorName: "No Price Co" })).json();
    assert.equal(body.quote.status, "extracted");
    assert.ok(body.warnings.length > 0);
  });

  it("needs something to read, and the right category", async (t) => {
    const { call } = await startDemo(t);
    await assertError(await quote(call, "food-beverage", {}), 400, "BAD_REQUEST");
    await assertError(await quote(call, "food-beverage", { text: "  " }), 400, "BAD_REQUEST");
    await assertError(
      await quote(call, "food-beverage", { text: TEXT }, DESIGNER),
      403,
      "FORBIDDEN",
    );
    await assertError(await quote(call, "nope", { text: TEXT }), 400, "BAD_REQUEST");
    await assertError(
      await quote(call, "food-beverage", { text: "x".repeat(8001) }),
      400,
      "BAD_REQUEST",
    );
  });

  it("is shown to members of the same event only", async (t) => {
    const { call } = await startDemo(t);
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "corporate_launch" } })
    ).json();
    const other = `user-manager@${event.id}`;
    await assertError(await quote(call, "food-beverage", { text: TEXT }, other), 404, "NOT_FOUND");
  });
});

describe("uploading a quote file", () => {
  it("stores a PDF under a random name, against the category's group, and reads it", async (t) => {
    const { base, store, uploadsDir } = await startDemo(t);
    const res = await upload(
      base,
      MANAGER,
      { categoryId: "food-beverage" },
      { buffer: PDF, name: "../../caterer quote.pdf" },
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.quote.status, "extracted");
    assert.equal(body.offline, true);
    const record = store.files.get(body.quote.sourceFileId);
    assert.equal(record.groupId, `g-${ID}-food-beverage`);
    assert.equal(record.mime, "application/pdf");
    assert.equal(record.originalName, "caterer quote.pdf");
    const [stored] = await readdir(uploadsDir);
    assert.match(stored, /^[0-9a-f-]{36}\.pdf$/);
    assert.equal(stored, record.storedName);
    assert.deepEqual(await readFile(`${uploadsDir}/${stored}`), PDF);
  });

  it("refuses HTML named .pdf by its contents, and writes nothing", async (t) => {
    const { base, uploadsDir, store } = await startDemo(t);
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    const res = await upload(
      base,
      MANAGER,
      { categoryId: "food-beverage" },
      { buffer: html, name: "quote.pdf" },
    );
    await assertError(res, 400, "UNSUPPORTED_FILE");
    assert.deepEqual(await readdir(uploadsDir), []);
    assert.equal(store.files.size, 0);
    assert.equal(store.quotes.size, 0);
  });

  it("refuses SVG, even with an image name", async (t) => {
    const { base } = await startDemo(t);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await upload(
      base,
      MANAGER,
      { categoryId: "food-beverage" },
      { buffer: svg, name: "quote.png" },
    );
    await assertError(res, 400, "UNSUPPORTED_FILE");
  });

  it("refuses a file over 5 MB", async (t) => {
    const { base, uploadsDir } = await startDemo(t);
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(
      base,
      MANAGER,
      { categoryId: "food-beverage" },
      { buffer: big, name: "big.pdf" },
    );
    await assertError(res, 413, "PAYLOAD_TOO_LARGE");
    assert.deepEqual(await readdir(uploadsDir), []);
  });

  it("takes one file only, from the file field", async (t) => {
    const { base } = await startDemo(t);
    const form = new FormData();
    form.set("categoryId", "food-beverage");
    form.set("file", new Blob([PDF]), "a.pdf");
    form.set("extra", new Blob([PDF]), "b.pdf");
    const res = await fetch(`${base}/api/events/${ID}/quotes`, {
      method: "POST",
      headers: { cookie: `huddle_user=${encodeURIComponent(MANAGER)}` },
      body: form,
    });
    await assertError(res, 400, "BAD_REQUEST");
  });

  it("is limited to people who work on the category", async (t) => {
    const { base, uploadsDir } = await startDemo(t);
    const res = await upload(
      base,
      DESIGNER,
      { categoryId: "food-beverage" },
      { buffer: PDF, name: "a.pdf" },
    );
    await assertError(res, 403, "FORBIDDEN");
    assert.deepEqual(await readdir(uploadsDir), []);
  });
});

describe("downloading a file", () => {
  async function uploaded(t) {
    const ctx = await startDemo(t);
    const res = await upload(
      ctx.base,
      MANAGER,
      { categoryId: "food-beverage" },
      { buffer: PDF, name: "quote.pdf" },
    );
    const { quote: made } = await res.json();
    return { ...ctx, fileId: made.sourceFileId };
  }

  it("sends the bytes safely to members of the group", async (t) => {
    const { call, fileId } = await uploaded(t);
    const res = await call(`/files/${fileId}`, { as: LEAD });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="quote.pdf"/);
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
  });

  it("refuses people outside the group, and hides it from other events", async (t) => {
    const { call, fileId } = await uploaded(t);
    await assertError(await call(`/files/${fileId}`, { as: DESIGNER }), 403, "FORBIDDEN");
    await assertError(await call(`/files/${fileId}`), 401, "UNAUTHENTICATED");
    await assertError(await call("/files/nope", { as: MANAGER }), 404, "NOT_FOUND");
    const { event } = await (
      await call("/events", { method: "POST", body: { eventType: "wedding" } })
    ).json();
    await assertError(
      await call(`/files/${fileId}`, { as: `user-manager@${event.id}` }),
      404,
      "NOT_FOUND",
    );
  });

  it("never exposes the stored name", async (t) => {
    const { store, fileId, call } = await uploaded(t);
    const res = await call(`/files/${fileId}`, { as: MANAGER });
    const text = JSON.stringify([...res.headers.entries()]);
    assert.doesNotMatch(text, new RegExp(store.files.get(fileId).storedName));
  });
});

describe("confirming a quote", () => {
  it("replaces what was read with what the person confirms, parsed in code", async (t) => {
    const { call } = await startDemo(t);
    const { quote: made } = await (await quote(call, "food-beverage", { text: TEXT })).json();
    const res = await post(call, `/quotes/${made.id}/confirm`, {
      vendorName: "Saffron Table",
      perGuestText: "₹1,700 per guest",
      fixedText: "₹20,000",
      taxPercent: 12,
      includes: ["buffet"],
      mustHaveIdsMet: ["mh-2", "mh-1", "made-up"],
      answers: { staffing: "12 staff", dietary: null },
    });
    const { quote: confirmed } = await res.json();
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.perGuestMinor, 170000);
    assert.equal(confirmed.taxBps, 1200);
    assert.deepEqual(confirmed.mustHaveIdsMet, ["mh-2"], "only this category's must-haves");
    assert.equal(confirmed.answers.staffing, "12 staff");
    assert.equal(confirmed.id, made.id);
  });

  it("needs a price, a name, and the right person", async (t) => {
    const { call } = await startDemo(t);
    const { quote: made } = await (await quote(call, "food-beverage", { text: TEXT })).json();
    const path = `/quotes/${made.id}/confirm`;
    await assertError(await post(call, path, { vendorName: "X" }), 400, "BAD_REQUEST");
    await assertError(await post(call, path, { perGuestText: "₹10" }), 400, "BAD_REQUEST");
    await assertError(
      await post(call, path, { vendorName: "X", perGuestText: "₹10" }, DESIGNER),
      403,
      "FORBIDDEN",
    );
    await assertError(
      await post(call, "/quotes/nope/confirm", { vendorName: "X" }),
      404,
      "NOT_FOUND",
    );
  });
});

describe("comparing quotes", () => {
  async function two(t) {
    const ctx = await startDemo(t);
    const add = (vendorName, perGuestText, extra = {}) =>
      quote(ctx.call, "food-beverage", { vendorName, perGuestText, taxPercent: 5, ...extra });
    await add("Cheaper Co", "₹1,000 per guest");
    await add("Dearer Co", "₹1,500 per guest");
    await quote(ctx.call, "food-beverage", { text: TEXT });
    return ctx;
  }

  it("scores confirmed quotes by cost, must-have fit and priority, best first", async (t) => {
    const { call } = await two(t);
    const { rows } = await (
      await call(`/events/${ID}/comparison?categoryId=food-beverage`, { as: MANAGER })
    ).json();
    assert.deepEqual(
      rows.map(({ vendorName }) => vendorName),
      ["Cheaper Co", "Dearer Co"],
    );
    assert.ok(rows[0].score > rows[1].score);
    assert.ok(
      rows.every(({ status }) => status !== "extracted"),
      "unconfirmed quotes are not scored",
    );
    assert.ok(rows[0].missing.includes("staffing"));
    assert.ok(rows[0].riskFlags.length > 0, "the vegetarian must-have isn't met");
  });

  it("lets a core member compare only their own category", async (t) => {
    const { call } = await two(t);
    const own = await call(`/events/${ID}/comparison?categoryId=food-beverage`, { as: LEAD });
    assert.equal(own.status, 200);
    await assertError(
      await call(`/events/${ID}/comparison?categoryId=food-beverage`, { as: DESIGNER }),
      403,
      "FORBIDDEN",
    );
    await assertError(await call(`/events/${ID}/comparison`, { as: MANAGER }), 400, "BAD_REQUEST");
  });

  it("lists every quote of the category with its total and gaps", async (t) => {
    const { call } = await two(t);
    const { quotes } = await (
      await call(`/events/${ID}/quotes?categoryId=food-beverage`, { as: LEAD })
    ).json();
    assert.equal(quotes.length, 3);
    const cheaper = quotes.find(({ vendorName }) => vendorName === "Cheaper Co");
    assert.equal(cheaper.totalMinor, 105000 * 200);
  });
});

describe("accepting a quote", () => {
  async function confirmed(t) {
    const ctx = await startDemo(t);
    const make = async (vendorName, perGuestText) =>
      (
        await (
          await quote(ctx.call, "food-beverage", { vendorName, perGuestText, taxPercent: 5 })
        ).json()
      ).quote;
    return {
      ...ctx,
      a: await make("Cheaper Co", "₹1,000 per guest"),
      b: await make("Dearer Co", "₹1,500 per guest"),
    };
  }
  const accept = (call, id, as = MANAGER) => post(call, `/quotes/${id}/accept`, undefined, as);

  it("shows the consequences first, and changes nothing yet", async (t) => {
    const { call, store, a } = await confirmed(t);
    const before = store.budgets.get(ID);
    const body = await (await accept(call, a.id)).json();
    assert.ok(body.changeId);
    assert.match(body.consequenceText, /Costs change|within budget|over budget/);
    assert.equal(store.budgets.get(ID), before);
    assert.equal(store.quotes.get(a.id).status, "confirmed");
  });

  it("applies the quote's prices to the category when the manager accepts the change", async (t) => {
    const { call, store, a, b } = await confirmed(t);
    const first = await (await accept(call, a.id)).json();
    const res = await post(call, `/events/${ID}/changes/${first.changeId}/accept`, {});
    assert.equal(res.status, 200);
    const food = store.budgets.get(ID).categories.find(({ id }) => id === "food-beverage");
    assert.ok(food.drivers.every(({ source }) => source === "quote"));
    assert.equal(store.quotes.get(a.id).status, "accepted");
    // Accepting another quote in the category returns the first to confirmed.
    const second = await (await accept(call, b.id)).json();
    await post(call, `/events/${ID}/changes/${second.changeId}/accept`, {});
    assert.equal(store.quotes.get(a.id).status, "confirmed");
    assert.equal(store.quotes.get(b.id).status, "accepted");
  });

  it("refuses an unconfirmed quote, and anyone but the manager", async (t) => {
    const { call } = await startDemo(t);
    const { quote: made } = await (await quote(call, "food-beverage", { text: TEXT })).json();
    await assertError(await accept(call, made.id), 400, "BAD_REQUEST");
    await assertError(await accept(call, made.id, LEAD), 403, "FORBIDDEN");
    await assertError(await accept(call, "nope"), 404, "NOT_FOUND");
  });

  it("won't edit an accepted quote", async (t) => {
    const { call, a } = await confirmed(t);
    const first = await (await accept(call, a.id)).json();
    await post(call, `/events/${ID}/changes/${first.changeId}/accept`, {});
    await assertError(
      await post(call, `/quotes/${a.id}/confirm`, { vendorName: "X", perGuestText: "₹1" }),
      400,
      "BAD_REQUEST",
    );
  });
});
