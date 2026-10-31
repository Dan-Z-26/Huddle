import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFileType, safeFileName } from "../../server/validation/uploads.js";

const bytes = (...values) => Buffer.from(values);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = Buffer.concat([Buffer.from("RIFF"), bytes(1, 0, 0, 0), Buffer.from("WEBPVP8 ")]);

describe("detectFileType", () => {
  it("recognises PDF, PNG, JPEG and WEBP from their first bytes", () => {
    assert.deepEqual(detectFileType(PDF), { mime: "application/pdf", ext: "pdf" });
    assert.deepEqual(detectFileType(PNG), { mime: "image/png", ext: "png" });
    assert.deepEqual(detectFileType(JPG), { mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(detectFileType(WEBP), { mime: "image/webp", ext: "webp" });
  });

  it("refuses SVG, HTML, scripts and executables, however they are named", () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "<!doctype html><script>alert(1)</script>",
      "#!/bin/sh\nrm -rf /",
      "MZ\x90\x00 not really a pdf",
      "GIF89a",
    ])
      assert.equal(detectFileType(Buffer.from(text)), null, text.slice(0, 20));
  });

  it("refuses a RIFF file that is not WEBP, and anything too short or not a buffer", () => {
    const wave = Buffer.concat([Buffer.from("RIFF"), bytes(1, 0, 0, 0), Buffer.from("WAVEfmt ")]);
    assert.equal(detectFileType(wave), null);
    assert.equal(detectFileType(Buffer.from("%PD")), null);
    assert.equal(detectFileType(Buffer.alloc(0)), null);
    assert.equal(detectFileType("%PDF-1.4"), null);
    assert.equal(detectFileType(undefined), null);
  });
});

describe("safeFileName", () => {
  it("drops paths, control characters and quotes, and caps the length", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Users\\me\\quote.pdf"), "quote.pdf");
    assert.equal(safeFileName('a"b<c>.pdf'), "abc.pdf");
    assert.equal(safeFileName("line\nbreak\u0000.pdf"), "linebreak.pdf");
    assert.equal(safeFileName("x".repeat(500)).length, 100);
  });

  it("never returns an empty name", () => {
    for (const name of ["", "   ", "///", undefined, null])
      assert.equal(safeFileName(name), "file");
  });
});
