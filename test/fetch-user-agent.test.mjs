import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const origin = "https://user-agent.example.test";
const defaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const customUserAgent = "LeanFetchFixture/1.0";
const plain = 'const results = [await extractContent(origin + "/plain.txt")];';

async function observe(t, config, { missing = false, raw, location = "explicit", script = plain } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-user-agent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home"), agent = join(root, "agent"), xdg = join(root, "xdg");
	const directory = location === "explicit" ? agent : location === "xdg" ? join(xdg, "pi") : join(home, ".pi");
	const configPath = join(directory, "web-search.json");
	await mkdir(directory, { recursive: true });
	if (!missing) await writeFile(configPath, raw ?? JSON.stringify(config));
	else {
		// An explicitly selected missing file must not fall through to this decoy.
		await mkdir(join(home, ".pi"), { recursive: true });
		await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ fetchContent: { userAgent: "UnselectedDecoy/1.0" } }));
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: {
			HOME: home, USERPROFILE: home, PATH: process.env.PATH,
			PI_CODING_AGENT_DIR: location === "explicit" ? agent : "",
			XDG_CONFIG_HOME: location === "xdg" || location === "xdg-legacy" ? xdg : "",
			EXA_API_KEY: "", PERPLEXITY_API_KEY: "",
		},
		input: [
			'import assert from "node:assert/strict";',
			'import dns from "node:dns/promises";',
			'import { getEventListeners } from "node:events";',
			'import { readFile, writeFile } from "node:fs/promises";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const origin = " + JSON.stringify(origin) + ", configPath = " + JSON.stringify(configPath) + ";",
			"const requests = [], lookups = [], artifacts = [], extra = {};",
			'dns.lookup = async hostname => { assert.equal(hostname, "user-agent.example.test"); lookups.push(hostname); return [{ address: "93.184.216.34", family: 4 }]; };',
			"syncBuiltinESMExports();",
			"const makePdf = " + makePdf.toString() + ";",
			"const nativeFetch = globalThis.fetch;",
			"globalThis.fetch = async (input, init) => {",
			"  const url = new URL(input), headers = new Headers(init.headers);",
			'  requests.push({ url: url.href, userAgent: headers.get("user-agent"), authorization: headers.get("authorization") });',
			'  if (url.hostname === "api.exa.ai") return Response.json({ results: [{ url: origin + "/plain.txt", title: "Provider source" }] });',
			'  assert.equal(url.origin, origin, "no unexpected host or hosted fallback");',
			'  if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: origin + "/plain.txt" } });',
			'  if (url.pathname === "/denied") return new Response("denied", { status: 403 });',
			'  if (url.pathname === "/challenge") return new Response("interstitial", { headers: { "cf-mitigated": "challenge", "content-type": "text/html" } });',
			'  if (url.pathname === "/cancel") { caller.abort(); throw new DOMException("fixture cancelled", "AbortError"); }',
			'  if (url.pathname === "/broken") throw new TypeError("fixture transport failed");',
			'  if (url.pathname === "/document.pdf") return new Response(makePdf("Configured PDF sentinel"), { headers: { "content-type": "application/pdf" } });',
			'  if (url.pathname === "/article") return new Response("<html><head><title>Configured article</title></head><body><article><h1>Configured article</h1><p>" + "Configured HTML sentinel remains readable. ".repeat(20) + "</p></article></body></html>", { headers: { "content-type": "text/html" } });',
			'  return new Response("# Configured text\\n\\nConfigured text sentinel.", { headers: { "content-type": "text/plain" } });',
			"};",
			"const load = name => import(new URL(name + '.ts', " + JSON.stringify(source) + "));",
			'const { extractContent, fetchAllContent } = await load("extract");',
			'const { activityMonitor } = await load("activity");',
			"const caller = new AbortController();",
			script,
			"for (const result of results) {",
			'  const path = result.content?.match(/^PDF extracted and saved to: (.+)$/m)?.[1];',
			'  if (path) artifacts.push(await readFile(path, "utf8"));',
			"}",
			'console.log("UA_RESULT " + JSON.stringify({ results, requests, lookups, artifacts, extra, entries: activityMonitor.getEntries(), listeners: getEventListeners(caller.signal, "abort").length }));',
		].join("\n"),
	});
	assert.equal(child.status, 0, String(child.error ?? "") + "\n" + child.stdout + "\n" + child.stderr);
	const line = child.stdout.split("\n").find(line => line.startsWith("UA_RESULT "));
	assert.ok(line, child.stdout + child.stderr);
	return { ...JSON.parse(line.slice("UA_RESULT ".length)), configPath };
}

for (const [name, config, options] of [
	["missing selected file", undefined, { missing: true }],
	["missing fetchContent", {}, {}],
	["null fetchContent", { fetchContent: null }, {}],
	["missing userAgent", { fetchContent: {} }, {}],
	["null userAgent", { fetchContent: { userAgent: null } }, {}],
]) test("HTTP User-Agent keeps the browser default: " + name, async t => {
	const found = await observe(t, config, options);
	assert.equal(found.results[0].error, null);
	assert.equal(found.requests[0].userAgent, defaultUserAgent);
});

for (const [name, value, expected] of [
	["explicit custom value", customUserAgent, customUserAgent],
	["trimmed surrounding spaces and tabs", " \t" + customUserAgent + "\t ", customUserAgent],
	["upstream's combined value", "OpenAI File Downloader, XaiImageApiFetch/1.0", "OpenAI File Downloader, XaiImageApiFetch/1.0"],
	["internal horizontal tab", "LeanFetchFixture/1.0\tcompatible", "LeanFetchFixture/1.0\tcompatible"],
]) test("HTTP User-Agent sends " + name, async t => {
	const found = await observe(t, { fetchContent: { userAgent: value } });
	assert.equal(found.results[0].error, null);
	assert.equal(found.requests[0].userAgent, expected);
});

for (const location of ["xdg", "legacy", "xdg-legacy"]) test("HTTP User-Agent honors shared config selection: " + location, async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, { location });
	assert.equal(found.results[0].error, null);
	assert.equal(found.requests[0].userAgent, customUserAgent);
});

for (const [name, value] of [
	["number", 42], ["boolean", true], ["array", []], ["object", {}],
	["empty", ""], ["whitespace only", " \t "],
	["line feed", "private-UA\nInjected: value"], ["carriage return", "private-UA\rvalue"],
	["NUL", "private-UA\u0000value"], ["DEL", "private-UA\u007fvalue"],
	["emoji", "private-UA 😀"], ["non-ASCII Latin-1", "private-UA café"],
	["leading newline must not be repaired", "\nprivate-UA"],
]) test("HTTP User-Agent rejects " + name + " before DNS or any request", async t => {
	const found = await observe(t, { fetchContent: { userAgent: value } });
	assert.ok(found.results[0].error?.startsWith("Failed to parse " + found.configPath + ":"), found.results[0].error);
	assert.match(found.results[0].error, /fetchContent\.userAgent/);
	assert.doesNotMatch(found.results[0].error, /private-UA|Fallback options/);
	assert.deepEqual(found.requests, []);
	assert.deepEqual(found.lookups, []);
	assert.equal(found.entries.at(-1).endTime !== undefined, true);
	assert.equal(found.listeners, 0);
});

for (const [name, value] of [["number", 1], ["boolean", true], ["array", []], ["string", "invalid"]]) {
	test("HTTP User-Agent rejects a non-object fetchContent: " + name, async t => {
		const found = await observe(t, { fetchContent: value });
		assert.ok(found.results[0].error?.startsWith("Failed to parse " + found.configPath + ":"), found.results[0].error);
		assert.match(found.results[0].error, /fetchContent/);
		assert.doesNotMatch(found.results[0].error, /Fallback options/);
		assert.deepEqual(found.requests, []);
		assert.deepEqual(found.lookups, []);
	});
}

for (const raw of ["[]", "{invalid"]) test("HTTP User-Agent rejects malformed selected config: " + raw, async t => {
	const found = await observe(t, undefined, { raw });
	assert.ok(found.results[0].error?.startsWith("Failed to parse " + found.configPath + ":"), found.results[0].error);
	assert.doesNotMatch(found.results[0].error, /Fallback options/);
	assert.deepEqual(found.requests, []);
	assert.deepEqual(found.lookups, []);
});

test("configured HTTP User-Agent covers HTML, text and real PDF extraction in a batch", async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
		script: 'const results = await fetchAllContent([origin + "/article", origin + "/plain.txt", origin + "/document.pdf"]);',
	});
	assert.ok(found.results.every(result => result.error === null), JSON.stringify(found.results));
	assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent, customUserAgent, customUserAgent]);
	assert.match(found.results[0].content, /Configured HTML sentinel/);
	assert.match(found.results[1].content, /Configured text sentinel/);
	assert.match(found.artifacts[0], /Configured PDF sentinel/);
});

test("owned HTTP receives the configured header and returns real HTML, text and PDF artifacts", async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
		script: [
			'const { createServer } = await import("node:http");',
			'const { default: nodeDns } = await import("node:dns");',
			"const savedLookup = nodeDns.lookup, mockedFetch = globalThis.fetch;",
			"const server = createServer((request, response) => {",
			'  requests.push({ path: request.url, userAgent: request.headers["user-agent"], authorization: request.headers.authorization ?? null });',
			'  const pdf = request.url === "/document.pdf", html = request.url === "/article";',
			'  response.setHeader("content-type", pdf ? "application/pdf" : html ? "text/html" : "text/plain");',
			'  response.end(pdf ? makePdf("Owned HTTP PDF sentinel") : html ? "<html><head><title>Owned HTTP</title></head><body><article><h1>Owned HTTP</h1><p>" + "Owned HTTP HTML sentinel remains readable. ".repeat(20) + "</p></article></body></html>" : "Owned HTTP text sentinel.");',
			"});",
			"let results;",
			"try {",
			'  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });',
			"  nodeDns.lookup = (hostname, options, callback) => {",
			'    assert.equal(hostname, "user-agent.example.test");',
			'    if (typeof options === "function") { callback = options; options = {}; }',
			'    if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);',
			'    else callback(null, "127.0.0.1", 4);',
			"  };",
			"  syncBuiltinESMExports();",
			"  globalThis.fetch = nativeFetch;",
			'  const ownedOrigin = "http://user-agent.example.test:" + server.address().port;',
			'  results = await fetchAllContent(["/article", "/plain.txt", "/document.pdf"].map(path => ownedOrigin + path));',
			"} finally {",
			"  server.closeAllConnections();",
			"  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));",
			"  globalThis.fetch = mockedFetch; nodeDns.lookup = savedLookup; syncBuiltinESMExports();",
			"  extra.serverClosed = !server.listening;",
			"}",
		].join("\n"),
	});
	t.diagnostic(JSON.stringify({ boundary: "real owned HTTP and parsers; controlled DNS only", ...found }));
	assert.ok(found.results.every(result => result.error === null), JSON.stringify(found.results));
	assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent, customUserAgent, customUserAgent]);
	assert.ok(found.requests.every(request => request.authorization === null));
	assert.match(found.results[0].content, /Owned HTTP HTML sentinel/);
	assert.match(found.results[1].content, /Owned HTTP text sentinel/);
	assert.match(found.artifacts[0], /Owned HTTP PDF sentinel/);
	assert.equal(found.extra.serverClosed, true);
});

test("configured HTTP User-Agent is retained on redirects", async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
		script: 'const results = [await extractContent(origin + "/redirect")];',
	});
	assert.equal(found.results[0].error, null);
	assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent, customUserAgent]);
});

for (const [path, expected] of [["denied", /HTTP 403:/], ["challenge", /Blocked by Cloudflare challenge page/], ["broken", /fixture transport failed/]]) {
	test("configured HTTP User-Agent does not retry or hide " + path, async t => {
		const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
			script: 'const results = [await extractContent(origin + "/' + path + '")];',
		});
		assert.match(found.results[0].error, expected);
		assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent]);
		assert.equal(found.listeners, 0);
	});
}

test("configured HTTP User-Agent preserves caller cancellation and listener cleanup", async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
		script: 'const results = [await extractContent(origin + "/cancel", caller.signal)];',
	});
	assert.equal(found.results[0].error, "Aborted");
	assert.equal(found.listeners, 0);
	assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent]);
	assert.ok(found.entries.every(entry => entry.endTime !== undefined));
});

test("an already-cancelled caller takes precedence over invalid User-Agent config", async t => {
	const found = await observe(t, { fetchContent: { userAgent: "\nprivate-UA" } }, {
		script: 'caller.abort(); const results = [await extractContent(origin + "/plain.txt", caller.signal)];',
	});
	assert.equal(found.results[0].error, "Aborted");
	assert.deepEqual(found.requests, []);
});

test("configured HTTP User-Agent stays cached until the extension is restarted", async t => {
	const found = await observe(t, { fetchContent: { userAgent: customUserAgent } }, {
		script: [
			'const results = [await extractContent(origin + "/plain.txt")];',
			"await writeFile(configPath, JSON.stringify({ fetchContent: { userAgent: 'ChangedLater/1.0' } }));",
			'results.push(await extractContent(origin + "/plain.txt"));',
		].join("\n"),
	});
	assert.ok(found.results.every(result => result.error === null));
	assert.deepEqual(found.requests.map(request => request.userAgent), [customUserAgent, customUserAgent]);
});

test("search includeContent uses the page User-Agent without changing the provider request", async t => {
	const found = await observe(t, { exaApiKey: "synthetic-fetch-UA-key", fetchContent: { userAgent: customUserAgent } }, {
		script: [
			"const tools = new Map(), handlers = new Map();",
			'(await load("index")).default({ on(name, handler) { handlers.set(name, handler); }, registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); } });',
			"let result;",
			'try { result = await tools.get("web_search").execute("ua-fixture", { query: "fixture", provider: "exa", includeContent: true }); }',
			'finally { await handlers.get("session_shutdown")?.(); }',
			"assert.equal(result.details.successfulQueries, 1);",
			'assert.match(result.content[0].text, /Configured text sentinel/);',
			"const results = [];",
		].join("\n"),
	});
	assert.deepEqual(found.requests.map(request => request.userAgent), [null, customUserAgent]);
	assert.deepEqual(found.requests.map(request => new URL(request.url).hostname), ["api.exa.ai", "user-agent.example.test"]);
});

function makePdf(text) {
	const content = "BT /F1 24 Tf 72 720 Td (" + text + ") Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Length " + Buffer.byteLength(content, "ascii") + " >>\nstream\n" + content + "\nendstream",
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body, "ascii"));
		body += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
	}
	const xref = Buffer.byteLength(body, "ascii");
	body += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
	for (const offset of offsets) body += String(offset).padStart(10, "0") + " 00000 n \n";
	body += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
	return Buffer.from(body, "ascii");
}
