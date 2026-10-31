import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);

describe("index.html", () => {
  it("has no duplicate ids, which would send a click or a label to the wrong control", () => {
    const seen = new Set();
    const duplicates = ids.filter((id) => seen.has(id) || !seen.add(id));
    assert.deepEqual(duplicates, []);
  });

  it("has an element for every id the scripts look up", async () => {
    const dir = new URL("../../public/js/", import.meta.url);
    const missing = new Set();
    for (const file of await readdir(dir)) {
      const code = await readFile(new URL(file, dir), "utf8");
      for (const [, id] of code
        .matchAll(/\$\("([a-z0-9-]+)"\)|getElementById\("([a-z0-9-]+)"\)/g)
        .map((m) => [m[0], m[1] ?? m[2]])) {
        if (!ids.includes(id)) missing.add(`${file}: ${id}`);
      }
    }
    assert.deepEqual([...missing], []);
  });

  it("labels every form control and names every dialog", () => {
    assert.equal(/<img\b(?![^>]*\balt=)/.test(html), false);
    for (const [, tag] of html.matchAll(/<dialog\b([^>]*)>/g))
      assert.match(tag, /aria-labelledby="/);
    for (const [, tag] of html.matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)) {
      const id = tag.match(/\sid="([^"]+)"/)?.[1];
      const labelled = /aria-label/.test(tag) || (id && new RegExp(`for="${id}"`).test(html));
      assert.ok(labelled, `unlabelled control: ${tag.slice(0, 60)}`);
    }
  });
});
