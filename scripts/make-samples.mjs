// Writes the tiny sample quote PDFs in public/samples from the seeded data. Run: node scripts/make-samples.mjs
import { writeFileSync } from "node:fs";
import { SAMPLE_QUOTES } from "../server/agents/sampleQuotes.js";

const line = (text) => text.replace(/[\\()]/g, "\\$&");

function pdfOf(lines) {
  const stream = [
    "BT /F1 12 Tf 60 760 Td 16 TL",
    ...lines.map((text) => `(${line(text)}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

for (const { file, extracted: q } of SAMPLE_QUOTES) {
  const lines = [
    `Quotation from ${q.vendorName}`,
    "",
    q.sources.price,
    q.sources.tax ?? "",
    `Includes: ${q.includes.join(", ")}`,
    q.exclusions ? `Not included: ${q.exclusions.join(", ")}` : "",
    q.minGuests ? `Minimum ${q.minGuests} guests` : "",
    `Staffing: ${q.answers.staffing}`,
    `Setup time: ${q.answers.setupHours}`,
    `Cancellation: ${q.answers.cancellationTerms}`,
    `Valid until ${q.validUntil}`,
  ].filter((text, index) => text || index === 1);
  writeFileSync(new URL(`../public/samples/${file}`, import.meta.url), pdfOf(lines));
}
