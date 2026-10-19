import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractorUrl = new URL("../pdf-extract.ts", import.meta.url).href;

test("extractPDFToMarkdown works on Node 22 without native Promise.try", () => {
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    input: buildChildScript(extractorUrl),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });

  assert.equal(
    child.status,
    0,
    "PDF extraction failed in a child process. stderr summary:\n" + errorSummary(child.stderr),
  );

  assert.match(child.stdout, /Hello PDF/);
});

for (const count of [1, 2]) {
  test(`PDF extraction survives unavailable package self-resolution with ${count} cold document(s)`, () => {
    const child = spawnSync(process.execPath, ["--input-type=module"], {
      input: buildChildScript(extractorUrl, { blockSelfResolution: true, count }),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /Hello PDF 0/);
    if (count === 2) assert.match(child.stdout, /Hello PDF 1/);
  });
}

function buildChildScript(moduleUrl, { blockSelfResolution = false, count = 1 } = {}) {
  return `
    import { mkdtemp, readFile, rm } from "node:fs/promises";
    import { register } from "node:module";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    process.on("uncaughtException", (error) => {
      console.error(error?.stack || error);
      process.exit(1);
    });
    process.on("unhandledRejection", (error) => {
      console.error(error?.stack || error);
      process.exit(1);
    });

    Reflect.deleteProperty(Promise, "try");
    if (typeof Promise.try !== "undefined") {
      throw new Error("Expected Promise.try to be unavailable before PDF extraction");
    }

    if (${blockSelfResolution}) {
      const loader = 'export async function resolve(s, c, next) {' +
        'if (s === "unpdf/pdfjs" && c.parentURL.includes("/node_modules/unpdf/")) {' +
        'throw new Error("Host cannot resolve unpdf package self-reference (fixture)"); }' +
        'return next(s, c); }';
      register("data:text/javascript," + encodeURIComponent(loader), import.meta.url);
    }

    const { extractPDFToMarkdown } = await import(${JSON.stringify(moduleUrl)});

    const outputDir = await mkdtemp(join(tmpdir(), "pi-web-access-pdf-"));
    try {
      const results = await Promise.all(Array.from({ length: ${count} }, (_, i) => extractPDFToMarkdown(
        makePdf("Hello PDF " + i),
        "https://example.test/hello-" + i + ".pdf",
        { outputDir, filename: "hello-" + i + ".md" },
      )));
      for (const result of results) console.log(await readFile(result.outputPath, "utf8"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }

    function makePdf(text) {
      const content = "BT /F1 24 Tf 72 720 Td (" + text + ") Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Length " + Buffer.byteLength(content, "ascii") + " >>\\nstream\\n" + content + "\\nendstream",
      ];
      let body = "%PDF-1.4\\n";
      const offsets = [0];

      for (let index = 0; index < objects.length; index += 1) {
        offsets.push(Buffer.byteLength(body, "ascii"));
        body += String(index + 1) + " 0 obj\\n" + objects[index] + "\\nendobj\\n";
      }

      const xrefOffset = Buffer.byteLength(body, "ascii");
      body += "xref\\n0 " + String(objects.length + 1) + "\\n";
      body += "0000000000 65535 f \\n";

      for (const offset of offsets.slice(1)) {
        body += String(offset).padStart(10, "0") + " 00000 n \\n";
      }

      body += "trailer\\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\\n";
      body += "startxref\\n" + String(xrefOffset) + "\\n%%EOF\\n";

      return new TextEncoder().encode(body).buffer;
    }
  `;
}

function errorSummary(value, size = 1200) {
  const marker = "TypeError: Promise.try is not a function";
  const index = value.indexOf(marker);
  if (index >= 0) {
    return value.slice(index, index + size);
  }

  return value.length > size ? value.slice(-size) : value;
}
