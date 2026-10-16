import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractContent, fetchAllContent } from "../extract.ts";

const publicAddress = { address: "93.184.216.34", family: 4 };

function mockDns(t, lookup = async () => [publicAddress]) {
	const mocked = t.mock.method(dnsPromises, "lookup", lookup);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return mocked;
}

function mockTextFetch(t) {
	return t.mock.method(globalThis, "fetch", async () => new Response("# Public document\n\nPublic text", {
		headers: { "content-type": "text/plain" },
	}));
}

function assertRefused(result) {
	assert.equal(result.title, "");
	assert.equal(result.content, "");
	assert.match(result.error, /Blocked|Only HTTP|resolve|DNS|non-IP/);
	assert.doesNotMatch(result.error, /Fallback options/);
}

test("extraction rejects internal literals and normalized IP forms before transport (mock DNS/fetch)", async (t) => {
	mockDns(t);
	const transport = mockTextFetch(t);
	for (const host of [
		"localhost", "LOCALHOST.", "service.localhost", "service.localhost.",
		"0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "127.1", "2130706433",
		"0177.0.0.1", "0x7f.0.0.1", "%31%32%37.0.0.1",
		"100.64.0.1", "100.127.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.254",
		"192.168.0.1", "198.18.0.1", "198.19.255.254", "224.0.0.1", "255.255.255.255",
		"[::]", "[::1]", "[0:0:0:0:0:0:0:1]", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[febf::1]",
		"[fec0::1]", "[ff02::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]",
	]) {
		await t.test(host, async () => assertRefused(await extractContent(`http://${host}/private`)));
	}
	assert.equal(transport.mock.callCount(), 0);
});

test("extraction rejects non-HTTP schemes before transport, including GitHub-shaped URLs", async (t) => {
	mockDns(t);
	const transport = mockTextFetch(t);
	for (const url of ["file:///etc/hosts", "ftp://example.test/file", "data:text/plain,secret", "ftp://github.com/owner/repo"]) {
		assertRefused(await extractContent(url));
	}
	assert.equal(transport.mock.callCount(), 0);
	assert.deepEqual(await extractContent("not a URL"), { url: "not a URL", title: "", content: "", error: "Invalid URL" });
});

test("extraction refuses private, mixed and malformed DNS answers before transport (mock DNS/fetch)", async (t) => {
	for (const [name, answer] of [
		["private v4", [{ address: "192.168.1.2", family: 4 }]],
		["metadata", [{ address: "169.254.169.254", family: 4 }]],
		["private v6", [{ address: "fd00::1", family: 6 }]],
		["mapped", [{ address: "::ffff:192.168.1.2", family: 6 }]],
		["mixed", [publicAddress, { address: "::1", family: 6 }]],
		["empty", []], ["not array", {}], ["null", null], ["missing address", [{}]],
		["not IP", [{ address: "example.test", family: 4 }]],
		["wrong family", [{ address: "93.184.216.34", family: 6 }]],
	]) {
		await t.test(name, async (t) => {
			mockDns(t, async () => answer);
			const transport = mockTextFetch(t);
			assertRefused(await extractContent("https://internal.example.test/private"));
			assert.equal(transport.mock.callCount(), 0);
		});
	}
	await t.test("lookup failure", async (t) => {
		mockDns(t, async () => { throw new Error("fixture ENOTFOUND"); });
		const transport = mockTextFetch(t);
		assertRefused(await extractContent("https://missing.example.test/"));
		assert.equal(transport.mock.callCount(), 0);
	});
});

test("absolute DNS names retain their trailing dot during validation (mock DNS/fetch)", async (t) => {
	mockDns(t, async hostname => hostname === "absolute.example.test."
		? [{ address: "127.0.0.1", family: 4 }]
		: [publicAddress]);
	const transport = mockTextFetch(t);
	assertRefused(await extractContent("https://absolute.example.test./private"));
	assert.equal(transport.mock.callCount(), 0);
});

test("public HTTP(S) text extraction and batch result shape are preserved (mock DNS/fetch)", async (t) => {
	mockDns(t, async () => [publicAddress, { address: "2606:4700:4700::1111", family: 6 }]);
	mockTextFetch(t);
	const urls = ["https://public.example.test/document", "https://public.example.test./document", "http://1.1.1.1/document", "http://[2606:4700:4700::1111]/document", "http://[::ffff:8.8.8.8]/document"];
	const results = await fetchAllContent(urls);
	assert.deepEqual(results, urls.map(url => ({ url, title: "Public document", content: "# Public document\n\nPublic text", error: null })));
});

test("public HTML extraction still produces readable Markdown (mock DNS/fetch)", async (t) => {
	mockDns(t);
	t.mock.method(globalThis, "fetch", async () => new Response(`<html><head><title>Public article</title></head><body><article><h1>Public article</h1><p>${"Readable public article text. ".repeat(50)}</p></article></body></html>`, {
		headers: { "content-type": "text/html" },
	}));
	const result = await extractContent("https://public.example.test/article");
	assert.equal(result.error, null);
	assert.match(result.title, /Public article/);
	assert.match(result.content, /Readable public article text/);
});

async function localServer(t, handler) {
	const requests = [];
	const server = createServer((req, res) => {
		requests.push({ host: req.headers.host, path: req.url });
		handler(req, res);
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	return { requests, port, origin: `http://127.0.0.1:${port}` };
}

function routeFixtureDns(t) {
	mockDns(t, async hostname => {
		assert.ok(["public.example.test", "other.example.test", "private.example.test"].includes(hostname), hostname);
		return hostname === "private.example.test" ? [{ address: "127.0.0.1", family: 4 }] : [publicAddress];
	});
	t.mock.method(dns, "lookup", (hostname, options, callback) => {
		assert.ok(["public.example.test", "other.example.test", "private.example.test"].includes(hostname), hostname);
		if (typeof options === "function") { callback = options; options = {}; }
		if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
		else callback(null, "127.0.0.1", 4);
	});
	syncBuiltinESMExports();
}

test("owned loopback server receives no refused literal request (real HTTP positive control)", async (t) => {
	const server = await localServer(t, (_req, res) => res.end("owned private server"));
	assert.equal(await (await fetch(server.origin + "/control")).text(), "owned private server");
	server.requests.length = 0;
	const result = await extractContent(server.origin + "/private");
	t.diagnostic(JSON.stringify({ evidence: "owned real HTTP server", result, refusedRequests: server.requests }));
	assertRefused(result);
	assert.deepEqual(server.requests, []);
});

test("every redirect status refuses literal/DNS/protocol-relative internal targets (real HTTP, controlled DNS)", async (t) => {
	for (const status of [301, 302, 303, 307, 308]) {
		await t.test(String(status), async (t) => {
			const target = await localServer(t, (_req, res) => res.end("private content"));
			assert.equal(await (await fetch(target.origin + "/control")).text(), "private content");
			target.requests.length = 0;
			let location;
			const source = await localServer(t, (_req, res) => { res.writeHead(status, { location }); res.end(); });
			routeFixtureDns(t);
			for (const destination of [target.origin + "/private", `//127.0.0.1:${target.port}/private`, `http://private.example.test:${target.port}/private`]) {
				location = destination;
				source.requests.length = 0;
				const result = await extractContent(`http://public.example.test:${source.port}/redirect`);
				t.diagnostic(JSON.stringify({ evidence: "real HTTP, mocked DNS", status, location, error: result.error, sourceRequests: source.requests, refusedRequests: target.requests }));
				assertRefused(result);
				assert.equal(source.requests.length, 1);
				assert.deepEqual(target.requests, []);
			}
		});
	}
});

test("relative and cross-host public redirects still extract content (real HTTP, controlled DNS)", async (t) => {
	const target = await localServer(t, (_req, res) => { res.setHeader("content-type", "text/plain"); res.end("# Redirect destination\n\nPublic content"); });
	const source = await localServer(t, (req, res) => {
		const location = req.url === "/start" ? "/next" : `http://other.example.test:${target.port}/document`;
		res.writeHead(302, { location }); res.end();
	});
	routeFixtureDns(t);
	const url = `http://public.example.test:${source.port}/start`;
	const result = await extractContent(url);
	assert.deepEqual(result, { url, title: "Redirect destination", content: "# Redirect destination\n\nPublic content", error: null });
	assert.deepEqual(source.requests.map(({ path }) => path), ["/start", "/next"]);
	assert.equal(target.requests.length, 1);
	t.diagnostic(JSON.stringify({ evidence: "real HTTP, mocked DNS", result, sourceRequests: source.requests, destinationRequests: target.requests }));
});

test("empty relative redirects retain native Fetch behavior (real HTTP, controlled DNS)", async (t) => {
	const source = await localServer(t, (_req, res) => {
		if (source.requests.length === 1) { res.writeHead(302, { location: "" }); res.end(); }
		else { res.setHeader("content-type", "text/plain"); res.end("public content after empty redirect"); }
	});
	assert.equal(await (await fetch(source.origin + "/same")).text(), "public content after empty redirect");
	assert.equal(source.requests.length, 2);
	source.requests.length = 0;
	routeFixtureDns(t);
	const result = await extractContent(`http://public.example.test:${source.port}/same`);
	t.diagnostic(JSON.stringify({ evidence: "real HTTP, mocked DNS", result, sourceRequests: source.requests }));
	assert.equal(result.error, null);
	assert.equal(result.content, "public content after empty redirect");
	assert.equal(source.requests.length, 2);
});

test("relative redirects recheck DNS rather than reusing a prior validation (mock DNS/fetch)", async (t) => {
	let requests = 0;
	mockDns(t, async () => requests === 0 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }]);
	t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("", { status: 302, headers: { location: "/private" } }); });
	assertRefused(await extractContent("https://public.example.test/start"));
	assert.equal(requests, 1);
});

test("redirect bodies are cancelled before a public next hop or refusal (mock DNS/fetch)", async (t) => {
	for (const location of ["/next", "http://127.0.0.1/private", "file:///etc/hosts"]) {
		await t.test(location, async (t) => {
			mockDns(t);
			let cancelled = false;
			let requests = 0;
			t.mock.method(globalThis, "fetch", async () => {
				if (requests++ === 0) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location } });
				assert.equal(cancelled, true, "release the redirect body before the next transport");
				return new Response("public content", { headers: { "content-type": "text/plain" } });
			});
			const result = await extractContent("https://public.example.test/start");
			assert.equal(cancelled, true);
			if (location === "/next") assert.equal(result.error, null);
			else { assertRefused(result); assert.equal(requests, 1); }
		});
	}
});

test("an already-errored redirect body neither blocks public redirects nor bypasses target checks (mock DNS/fetch)", async (t) => {
	for (const location of ["/next", "http://127.0.0.1/private"]) {
		await t.test(location, async (t) => {
			mockDns(t);
			let requests = 0;
			t.mock.method(globalThis, "fetch", async () => {
				if (requests++ === 0) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("fixture socket ended")); } }), {
					status: 302, headers: { location },
				});
				return new Response("public content", { headers: { "content-type": "text/plain" } });
			});
			const result = await extractContent("https://public.example.test/start");
			if (location === "/next") { assert.equal(result.error, null); assert.equal(requests, 2); }
			else { assertRefused(result); assert.equal(requests, 1); }
		});
	}
});

test("unexpected locked redirect bodies still surface an error (mock DNS/fetch)", async (t) => {
	mockDns(t);
	const response = new Response(new ReadableStream(), {
		status: 302, headers: { location: "/next" },
	});
	const reader = response.body.getReader();
	t.after(() => reader.releaseLock());
	const transport = t.mock.method(globalThis, "fetch", async () => response);
	assert.match((await extractContent("https://public.example.test/start")).error, /locked/);
	assert.equal(transport.mock.callCount(), 1);
});

test("manual redirects retain native Fetch's existing 20-redirect allowance (mock DNS/fetch)", async (t) => {
	for (const redirects of [20, 21]) {
		await t.test(String(redirects), async (t) => {
			mockDns(t);
			let requests = 0;
			let cancelled = 0;
			t.mock.method(globalThis, "fetch", async (_url, init) => {
				assert.equal(init.redirect, "manual");
				requests++;
				if (requests <= redirects) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: "/next" } });
				return new Response("public content", { headers: { "content-type": "text/plain" } });
			});
			const result = await extractContent("https://public.example.test/start");
			assert.equal(requests, 21);
			assert.equal(cancelled, redirects);
			if (redirects === 20) assert.equal(result.error, null);
			else assert.match(result.error, /redirect.*limit.*20.*21|redirect.*budget.*20.*21/i);
		});
	}
});

test("caller abort during DNS preflight prevents transport and releases listeners (mock DNS/fetch)", async (t) => {
	const started = Promise.withResolvers();
	const released = Promise.withResolvers();
	mockDns(t, () => { started.resolve(); return released.promise; });
	const transport = mockTextFetch(t);
	const controller = new AbortController();
	const operation = extractContent("https://public.example.test/document", controller.signal);
	try {
		await Promise.race([started.promise, operation.then(() => assert.fail("DNS preflight was not reached"))]);
		controller.abort();
		assert.deepEqual(await operation, { url: "https://public.example.test/document", title: "", content: "", error: "Aborted" });
		assert.equal(transport.mock.callCount(), 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally { released.resolve([publicAddress]); }
});

test("the existing HTTP timeout includes stalled DNS validation (mock DNS/fetch and clock)", async (t) => {
	const started = Promise.withResolvers();
	const released = Promise.withResolvers();
	mockDns(t, () => { started.resolve(); return released.promise; });
	const transport = mockTextFetch(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const operation = extractContent("https://public.example.test/document");
	try {
		await Promise.race([started.promise, operation.then(() => assert.fail("DNS preflight was not reached"))]);
		t.mock.timers.tick(30000);
		assert.match((await operation).error, /abort/i);
		assert.equal(transport.mock.callCount(), 0);
	} finally { released.resolve([publicAddress]); }
});

test("already-aborted callers and aborts between redirects make no further request (mock DNS/fetch)", async (t) => {
	const lookup = mockDns(t);
	const controller = new AbortController();
	const transport = t.mock.method(globalThis, "fetch", async () => {
		controller.abort();
		return new Response("", { status: 302, headers: { location: "/next" } });
	});
	assert.equal((await extractContent("https://public.example.test/start", controller.signal)).error, "Aborted");
	assert.equal(transport.mock.callCount(), 1);
	const lookupsBefore = lookup.mock.callCount();
	assert.equal((await extractContent("https://public.example.test/start", controller.signal)).error, "Aborted");
	assert.equal(transport.mock.callCount(), 1);
	assert.equal(lookup.mock.callCount(), lookupsBefore);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("public PDF extraction still writes the extracted artifact in an isolated HOME (mock fetch/DNS)", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-ssrf-pdf-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home },
		input: `
			import assert from "node:assert/strict";
			import dns from "node:dns/promises";
			import { syncBuiltinESMExports } from "node:module";
			import { readFile } from "node:fs/promises";
			dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
			syncBuiltinESMExports();
			globalThis.fetch = async () => new Response((${makePdf.toString()})("Public PDF"), { headers: { "content-type": "application/pdf" } });
			const { extractContent } = await import(${JSON.stringify(new URL("../extract.ts", import.meta.url).href)});
			const result = await extractContent("https://public.example.test/public.pdf");
			assert.equal(result.error, null);
			const path = result.content.match(/^PDF extracted and saved to: (.+)$/m)[1];
			assert.ok(path.startsWith(process.env.HOME + "/"));
			const artifact = await readFile(path, "utf8");
			assert.match(artifact, /Public PDF/);
			console.log(JSON.stringify({ result, artifact }));
		`,
	});
	assert.equal(child.status, 0, child.error?.message || child.stderr);
	t.diagnostic(child.stdout.trim());
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
	return new TextEncoder().encode(body);
}
