import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const scriptsDir = new URL("../../public/js/", import.meta.url);
const scriptFiles = (await readdir(scriptsDir, { recursive: true })).filter((file) =>
  file.endsWith(".js"),
);
const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);

describe("index.html", () => {
  it("has no duplicate ids, which would send a click or a label to the wrong control", () => {
    const seen = new Set();
    const duplicates = ids.filter((id) => seen.has(id) || !seen.add(id));
    assert.deepEqual(duplicates, []);
  });

  it("has an element for every id the scripts look up", async () => {
    const missing = new Set();
    for (const file of scriptFiles) {
      const code = await readFile(new URL(file, scriptsDir), "utf8");
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

describe("the scripts", () => {
  it("import only names that exist, which only a browser would otherwise find out", async () => {
    const sources = new Map(
      await Promise.all(
        scriptFiles.map(async (file) => [file, await readFile(new URL(file, scriptsDir), "utf8")]),
      ),
    );
    const exportsOf = (code) =>
      new Set(
        [...code.matchAll(/export (?:async )?(?:function|const) ([$\w]+)/g)].map((m) => m[1]),
      );
    const broken = [];
    for (const [file, code] of sources)
      for (const [, names, target] of code.matchAll(/import \{([^}]*)\} from "(\.[^"]+)"/g)) {
        const targetFile = join(dirname(file), target);
        const known = exportsOf(sources.get(targetFile) ?? "");
        for (const name of names
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean))
          if (!known.has(name)) broken.push(`${file}: ${name} from ${targetFile}`);
      }
    assert.deepEqual(broken, []);
  });
});
