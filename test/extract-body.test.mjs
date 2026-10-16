import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";

// Retained production budgets, not new test-only size policies.
const textLimit = 5 * 1024 * 1024;
const pdfLimit = 20 * 1024 * 1024;
const hostname = "body.example.test";
const publicAddress = { address: "93.184.216.34", family: 4 };
const home = await mkdtemp(join(tmpdir(), "pi-web-access-body-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
after(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	await rm(home, { recursive: true, force: true });
});
const { extractContent } = await import("../extract.ts");
const { activityMonitor } = await import("../activity.ts");

function mockDns(t, realTransport = false) {
	t.mock.method(dnsPromises, "lookup", async name => {
		assert.equal(name, hostname, "fixture must not resolve external hosts");
		return [publicAddress];
	});
	if (realTransport) t.mock.method(dns, "lookup", (name, options, callback) => {
		assert.equal(name, hostname, "fixture transport must stay on the owned server");
		if (typeof options === "function") { callback = options; options = {}; }
		if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
		else callback(null, "127.0.0.1", 4);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function mockResponse(t, chunks, { type = "text/plain", length, cancelError, readError } = {}) {
	mockDns(t);
	const state = { chunksRead: 0, cancellations: 0 };
	const response = new Response(new ReadableStream({
		pull(controller) {
			if (state.chunksRead < chunks.length) controller.enqueue(chunks[state.chunksRead++]);
			else if (readError) controller.error(readError);
			else controller.close();
		},
		cancel() {
			state.cancellations++;
			if (cancelError) throw cancelError;
		},
	}, { highWaterMark: 0 }), { headers: {
		"content-type": type,
		...(length === undefined ? {} : { "content-length": String(length) }),
	} });
	t.mock.method(globalThis, "fetch", async () => response);
	return { response, state };
}

function assertTooLarge(result, limit, observed, source = "received") {
	assert.equal(result.title, "");
	assert.equal(result.content, "");
	assert.match(result.error, /^Response too large/);
	assert.match(result.error, new RegExp(`configured[^;)]*${limit} bytes`));
	assert.match(result.error, new RegExp(`${source}: ${observed} bytes`, "i"));
	assert.match(result.error, /smaller|download/i);
	assert.doesNotMatch(result.error, /Fallback options|PDF extraction failed/);
}

test("text accepts the exact byte boundary and releases its stream (mock DNS/fetch)", async t => {
	for (const [name, chunks] of [
		["one chunk", [Buffer.alloc(textLimit, 0x61)]],
		["multiple chunks", [Buffer.alloc(textLimit - 1, 0x61), Buffer.from("a")]],
		["split UTF-8", [Buffer.from([0xc3]), Buffer.from([0xa9]), Buffer.alloc(textLimit - 2, 0x61)]],
	]) await t.test(name, async t => {
		const { response, state } = mockResponse(t, chunks);
		const result = await extractContent(`https://${hostname}/boundary.txt`);
		assert.equal(result.error, null);
		assert.equal(result.content, Buffer.concat(chunks).toString("utf8"));
		assert.equal(Buffer.byteLength(result.content), textLimit);
		assert.equal(state.cancellations, 0);
		assert.equal(response.body.locked, false);
	});
});

test("actual text bytes enforce the limit despite missing or misleading length (mock DNS/fetch)", async t => {
	for (const [name, length, chunks] of [
		["single-chunk headerless overflow", undefined, [Buffer.alloc(textLimit + 1)]],
		["multi-chunk understated length", 1, [Buffer.alloc(textLimit), Buffer.from("x")]],
		["UTF-8 bytes, not character count", undefined, [Buffer.from("é".repeat(textLimit / 2)), Buffer.from("x")]],
	]) await t.test(name, async t => {
		const { response, state } = mockResponse(t, [...chunks, Buffer.from("unread sentinel")], { length });
		const result = await extractContent(`https://${hostname}/oversized.txt`);
		assertTooLarge(result, textLimit, textLimit + 1);
		assert.equal(state.chunksRead, chunks.length, "do not read the sentinel after overflow");
		assert.equal(state.cancellations, 1);
		assert.equal(response.body.locked, false);
	});
});

test("oversized declared lengths reject before reading and cancel the body (mock DNS/fetch)", async t => {
	for (const [type, limit, path] of [["text/plain", textLimit, "large.txt"], ["application/pdf", pdfLimit, "large.pdf"]]) {
		await t.test(type, async t => {
			const { response, state } = mockResponse(t, [Buffer.from("unread sentinel")], { type, length: limit + 1 });
			assertTooLarge(await extractContent(`https://${hostname}/${path}`), limit, limit + 1, "Content-Length");
			assert.equal(state.chunksRead, 0);
			assert.equal(state.cancellations, 1);
			assert.equal(response.body.locked, false);
		});
	}
});

test("PDF accepts exactly 20 MiB and still writes its Markdown artifact (mock DNS/fetch)", async t => {
	const pdf = makePdf("Bounded PDF control");
	const marker = pdf.indexOf("startxref");
	const bytes = Buffer.concat([pdf.subarray(0, marker), Buffer.alloc(pdfLimit - pdf.length, 0x20), pdf.subarray(marker)]);
	const { response } = mockResponse(t, [bytes.subarray(0, pdfLimit - 1), bytes.subarray(pdfLimit - 1)], { type: "application/pdf", length: pdfLimit });
	const result = await extractContent(`https://${hostname}/boundary.pdf`);
	assert.equal(result.error, null);
	assert.match(result.content, /Pages: 1/);
	const path = result.content.match(/^PDF extracted and saved to: (.+)$/m)[1];
	assert.ok(path.startsWith(home + sep));
	const artifact = await readFile(path, "utf8");
	assert.match(artifact, /Bounded PDF control/);
	t.diagnostic(JSON.stringify({ evidence: "actual PDF parser/filesystem, mocked DNS/fetch", bytes: bytes.length, result, artifact }));
	assert.equal(response.body.locked, false);
});

test("PDF stream overflow remains terminal and never writes an artifact (mock DNS/fetch)", async t => {
	for (const [name, length, chunks] of [
		["single-chunk headerless", undefined, [Buffer.alloc(pdfLimit + 1)]],
		["multi-chunk understated length", 1, [Buffer.alloc(pdfLimit), Buffer.from("x")]],
	]) await t.test(name, async t => {
		const before = await readdir(home, { recursive: true });
		const { response, state } = mockResponse(t, [...chunks, Buffer.from("unread sentinel")], { type: "application/pdf", length });
		assertTooLarge(await extractContent(`https://${hostname}/overflow.pdf`), pdfLimit, pdfLimit + 1);
		assert.equal(state.chunksRead, chunks.length);
		assert.equal(state.cancellations, 1);
		assert.equal(response.body.locked, false);
		assert.deepEqual(await readdir(home, { recursive: true }), before);
	});
});

test("read and cancellation failures release owned locks without hiding the size refusal (mock DNS/fetch)", async t => {
	await t.test("body read error", async t => {
		const { response } = mockResponse(t, [Buffer.from("partial")], { readError: new Error("fixture body failed") });
		assert.match((await extractContent(`https://${hostname}/broken.txt`)).error, /fixture body failed/);
		assert.equal(response.body.locked, false);
	});
	for (const length of [undefined, textLimit + 1]) await t.test(`cancel rejects; length=${length}`, async t => {
		const { response, state } = mockResponse(t, [Buffer.alloc(textLimit + 1)], { length, cancelError: new Error("fixture cancel failed") });
		const result = await extractContent(`https://${hostname}/cancel.txt`);
		assertTooLarge(result, textLimit, textLimit + 1, length === undefined ? "received" : "Content-Length");
		assert.match(result.error, /cancellation failed/i);
		assert.equal(state.cancellations, 1);
		assert.equal(response.body.locked, false);
	});
});

test("declared charset decoding preserves text and scoped UTF-8 fallbacks (mock DNS/fetch)", async t => {
	for (const [name, type, bytes, expected] of [
		["quoted mixed-case label", 'text/plain; ChArSeT="WiNdOwS-1252"', Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]), "# Café €"],
		["UTF-16LE", "text/plain; charset=utf-16le", Buffer.from("# Snow 雪", "utf16le"), "# Snow 雪"],
		["missing", "text/plain", Buffer.from("# UTF-8 café 雪"), "# UTF-8 café 雪"],
		["unsupported", "text/plain; charset=not-an-encoding", Buffer.from("# UTF-8 café 雪"), "# UTF-8 café 雪"],
		["empty", 'text/plain; charset=""', Buffer.from("# UTF-8 café 雪"), "# UTF-8 café 雪"],
		["malformed media type", "not-a-media-type", Buffer.from("# UTF-8 café 雪"), "# UTF-8 café 雪"],
		["unrelated quoted parameter", 'text/plain; note="charset=windows-1252"; charset=utf-8', Buffer.from("# UTF-8 café 雪"), "# UTF-8 café 雪"],
	]) await t.test(name, async t => {
		mockResponse(t, [bytes], { type });
		const url = `https://${hostname}/charset.txt`;
		assert.deepEqual(await extractContent(url), { url, title: expected.slice(2), content: expected, error: null });
	});
	await t.test("HTML is decoded before readability extraction", async t => {
		const html = `<html><head><title>Café</title></head><body><article><h1>Café</h1><p>${"Café costs €5. ".repeat(60)}</p></article></body></html>`;
		const bytes = Buffer.from(html.replaceAll("€", "\x80"), "latin1");
		mockResponse(t, [bytes], { type: "text/html; charset=windows-1252" });
		const result = await extractContent(`https://${hostname}/article`);
		assert.equal(result.error, null);
		assert.match(result.title, /Café/);
		assert.match(result.content, /Café costs €5/);
		assert.doesNotMatch(result.content, /�/);
	});
});

test("unexpected decoder failures are surfaced instead of retried as UTF-8 (mock DNS/fetch/decoder)", async t => {
	mockResponse(t, [Buffer.from("ordinary text")]);
	t.mock.method(globalThis, "TextDecoder", function () { throw new TypeError("fixture decoder failed"); });
	assert.match((await extractContent(`https://${hostname}/decoder.txt`)).error, /fixture decoder failed/);
});

test("empty responses remain successful (mock DNS/fetch)", async t => {
	mockDns(t);
	t.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "content-type": "text/plain" } }));
	const url = `https://${hostname}/empty.txt`;
	assert.deepEqual(await extractContent(url), { url, title: "empty.txt", content: "", error: null });
});

test("caller abort and the existing timeout stop stalled text/PDF reads and release resources (mock DNS/fetch/clock)", async t => {
	for (const type of ["text/plain", "application/pdf"]) for (const trigger of ["caller", "timeout"]) {
		await t.test(`${type}: ${trigger}`, async t => {
			mockDns(t);
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const started = Promise.withResolvers();
			const caller = new AbortController();
			let streamController;
			const response = new Response(new ReadableStream({
				start(controller) { streamController = controller; },
				pull() { started.resolve(); },
			}, { highWaterMark: 0 }), { headers: { "content-type": type } });
			t.mock.method(globalThis, "fetch", async (_url, init) => {
				const onAbort = () => streamController.error(init.signal.reason);
				init.signal.addEventListener("abort", onAbort, { once: true });
				t.after(() => init.signal.removeEventListener("abort", onAbort));
				return response;
			});
			const before = await readdir(home, { recursive: true });
			const url = `https://${hostname}/stalled`;
			const operation = extractContent(url, caller.signal);
			await Promise.race([started.promise, operation.then(() => assert.fail("body read was not reached"))]);
			if (trigger === "caller") caller.abort();
			else t.mock.timers.tick(30000); // Existing HTTP deadline.
			assert.match((await operation).error, /abort/i);
			assert.equal(response.body.locked, false);
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
			assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
			assert.deepEqual(await readdir(home, { recursive: true }), before);
		});
	}
});

test("owned HTTP transport enforces chunked and decompressed byte budgets (real HTTP, controlled DNS)", async t => {
	const requests = [];
	const textOverflow = Buffer.alloc(textLimit + 1, 0x61);
	const compressedText = gzipSync(textOverflow);
	const compressedPdf = gzipSync(Buffer.alloc(pdfLimit + 1, 0x20));
	const server = createServer((req, res) => {
		requests.push(req.url);
		res.setHeader("content-type", req.url.endsWith(".pdf") ? "application/pdf" : "text/plain");
		if (req.url.startsWith("/compressed")) {
			const compressed = req.url.endsWith(".pdf") ? compressedPdf : compressedText;
			res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
			res.end(compressed);
		} else {
			res.write(textOverflow.subarray(0, textLimit));
			res.end(req.url === "/exact.txt" ? undefined : textOverflow.subarray(textLimit));
		}
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	mockDns(t, true);
	const origin = `http://${hostname}:${server.address().port}`;
	const control = await extractContent(origin + "/exact.txt");
	assert.equal(control.error, null);
	assert.equal(Buffer.byteLength(control.content), textLimit);
	t.diagnostic(JSON.stringify({ evidence: "real HTTP positive control; mocked DNS only", bytes: textLimit, sha256: createHash("sha256").update(control.content).digest("hex") }));
	const results = [];
	for (const [path, limit, compressedBytes] of [
		["/chunked.txt", textLimit, null],
		["/compressed.txt", textLimit, compressedText.length],
		["/compressed.pdf", pdfLimit, compressedPdf.length],
	]) await t.test(path, async t => {
		const result = await extractContent(origin + path);
		const receipt = { path, limit, returnedBytes: Buffer.byteLength(result.content), compressedBytes, error: result.error };
		results.push(receipt);
		t.diagnostic(JSON.stringify(receipt));
		assertTooLarge(result, limit, limit + 1);
	});
	assert.deepEqual(requests, ["/exact.txt", "/chunked.txt", "/compressed.txt", "/compressed.pdf"]);
	t.diagnostic(JSON.stringify({ evidence: "real owned HTTP and Fetch decompression; mocked DNS only; finite responses do not prove early disconnect", control: { bytes: textLimit, sha256: createHash("sha256").update(control.content).digest("hex") }, requests, results }));
});

function makePdf(text) {
	const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body, "ascii"));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body, "ascii");
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "ascii");
}
