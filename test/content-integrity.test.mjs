import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-content-integrity-"));
const environment = { HOME: home, USERPROFILE: home, EXA_API_KEY: "synthetic-integrity-key", PERPLEXITY_API_KEY: "", PI_CODING_AGENT_DIR: join(home, "agent") };
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});
await mkdir(join(home, ".pi"));
await writeFile(join(home, ".pi/web-search.json"), JSON.stringify({ githubClone: { enabled: false, clonePath: join(home, "clones") } }));
const { extractContent, fetchAllContent } = await import("../extract.ts");
const { default: initialize } = await import("../index.ts");
const { activityMonitor } = await import("../activity.ts");
const origin = "https://integrity.example.test";
const url = origin + "/page";
const notice = "\n\n[Content truncated]";
const markerPattern = /\[pi-web-access inline data URI omitted;[^\]]+\]/g;

function transport(t, body, { type = "text/plain", supplied, keyed = true } = {}) {
	const requests = [], responses = [];
	if (!keyed) {
		process.env.EXA_API_KEY = "";
		t.after(() => { process.env.EXA_API_KEY = environment.EXA_API_KEY; });
	}
	t.mock.method(dns, "lookup", async host => {
		assert.equal(host, "integrity.example.test", "only the fixture page may resolve");
		return [{ address: "93.184.216.34", family: 4 }];
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const target = new URL(input), headers = new Headers(init.headers);
		requests.push(target.href);
		if (target.hostname === "api.exa.ai" || target.hostname === "mcp.exa.ai") {
			const results = [{ url, title: "Fixture", ...(supplied === undefined ? {} : { text: supplied }) }];
			return target.hostname === "api.exa.ai" ? Response.json({ results }) : Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results }) }] } });
		}
		assert.equal(target.hostname, "integrity.example.test", "no hosted fallback or other network");
		assert.equal(init.redirect, "manual");
		assert.equal(headers.has("authorization"), false);
		assert.equal(headers.has("x-api-key"), false);
		const response = new Response(body, { headers: { "content-type": type } });
		responses.push(response);
		return response;
	});
	t.after(() => { for (const response of responses) assert.equal(response.body.locked, false); });
	return requests;
}

function tools(t) {
	const registered = new Map(), handlers = new Map();
	initialize({ registerTool(tool) { registered.set(tool.name, tool); }, registerShortcut() {}, on(event, handler) { handlers.set(event, handler); } });
	assert.deepEqual([...registered.keys()], ["web_search", "code_search", "fetch_content"]);
	t.after(async () => { await handlers.get("session_shutdown")?.(); });
	return registered;
}

function html(body, rsc, scripts = 0) {
	const payload = `23:${JSON.stringify(["$", "article", null, { children: ["$", "p", null, { children: rsc }] }])}\n`;
	return `<!doctype html><html><head><title>Fixture RSC</title></head><body>${body}${rsc === undefined ? "" : `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`}${"<script>/* bootstrap */</script>".repeat(scripts)}</body></html>`;
}

for (const shell of ["", "<article><p>Loading...</p></article>"]) {
	for (const length of [500, 501]) test(`RSC recovers ${shell ? "weak" : "absent"} Readability at ${length} characters`, async t => {
		const content = "R".repeat(length), requests = transport(t, html(shell, content), { type: "text/html" });
		const caller = new AbortController();
		assert.deepEqual(await extractContent(url, caller.signal), { url, title: "Fixture RSC", content, error: null });
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
		assert.deepEqual(requests, [url]);
	});
}

test("useful RSC wins before the weak-shell JavaScript error", async t => {
	const content = "Recovered flight content. ".repeat(30);
	transport(t, html("<article>Loading...</article>", content, 4), { type: "text/html" });
	const result = await extractContent(url);
	assert.equal(result.error, null);
	assert.equal(result.content, content.trim());
});

test("sub-threshold RSC cannot turn absent readable content into success", async t => {
	transport(t, html("", "R".repeat(499)), { type: "text/html" });
	const result = await extractContent(url);
	assert.notEqual(result.error, null);
	assert.equal(result.content, "");
});

for (const rsc of [undefined, "R".repeat(499)]) test(`short ordinary HTML stays readable with ${rsc ? "weak" : "no"} RSC`, async t => {
	transport(t, html("<article><p>Short useful prose.</p></article>", rsc), { type: "text/html" });
	const result = await extractContent(url);
	assert.equal(result.error, null);
	assert.equal(result.content, "Short useful prose.");
});

test("already useful HTML is not replaced by competing RSC", async t => {
	const content = "The readable article is authoritative. ".repeat(30);
	transport(t, html(`<article><p>${content}</p></article>`, "Competing flight. ".repeat(50)), { type: "text/html" });
	const result = await extractContent(url);
	assert.equal(result.error, null);
	assert.equal(result.content, content.trim());
});

test("invalid RSC and a weak JS shell retain the existing diagnostic", async t => {
	transport(t, html("<article>Loading...</article>", undefined, 4) + '<script>self.__next_f.push([1,"invalid"])</script>', { type: "text/html" });
	assert.match((await extractContent(url)).error, /JavaScript-rendered/);
});

test("pre-aborted extraction never starts transport", async t => {
	const requests = transport(t, html("", "R".repeat(500)), { type: "text/html" });
	const caller = new AbortController(); caller.abort();
	assert.equal((await extractContent(url, caller.signal)).error, "Aborted");
	assert.deepEqual(requests, []);
});

function marker(text) {
	const found = text.match(markerPattern) ?? [];
	assert.equal(found.length, 1, "expected exactly one explicit inline-URI omission");
	assert.match(found[0], /retrieval=not-retained\]$/);
	return found[0];
}

const uriCases = [
	["base64", "data:image/png;base64,SGk=", "image/png", "base64", "SGk=", Buffer.from("Hi")],
	["percent binary", "data:application/octet-stream,%FF%00", "application/octet-stream", "percent-encoded", "%FF%00", Buffer.from([255, 0])],
	["missing MIME", "data:;base64,SGk=", "text/plain", "base64", "SGk=", Buffer.from("Hi")],
	["parameters", "data:text/plain;charset=utf-8,hello%2Cworld", "text/plain", "percent-encoded", "hello%2Cworld", Buffer.from("hello,world")],
	["mixed case", "DaTa:IMAGE/PNG;BaSe64,SGk=", "image/png", "base64", "SGk=", Buffer.from("Hi")],
	["escaped base64", "data:image/png;base64,%53%47%6B%3D", "image/png", "base64", "%53%47%6B%3D", Buffer.from("Hi")],
	["balanced parentheses", "data:text/plain,abc(def)ghi", "text/plain", "percent-encoded", "abc(def)ghi", Buffer.from("abc(def)ghi")],
	["apostrophe", "data:text/plain,it's", "text/plain", "percent-encoded", "it's", Buffer.from("it's")],
];
for (const [name, uri, mime, encoding, payload, decoded] of uriCases) test(`batch fetch omits ${name} URI with truthful bounded metadata`, async t => {
	const before = 'Before <img alt="diagram" src="', after = '"> after prose.';
	transport(t, before + uri + after);
	const [result] = await fetchAllContent([url]);
	assert.equal(result.error, null);
	const omission = marker(result.content);
	assert.equal(result.content, before + omission + after);
	for (const field of [`mime=${mime};`, `encoding=${encoding};`, `encodedBytes=${Buffer.byteLength(payload)};`, `decodedBytes=${decoded.length};`, `sha256=${createHash("sha256").update(decoded).digest("hex")};`, "digestBasis=decoded;"]) assert.ok(omission.includes(field), field);
});

for (const [name, uri, payload, error] of [
	["invalid base64", "data:image/png;base64,***opaque***", "***opaque***", "invalid-base64-character"],
	["invalid percent", "data:text/plain,%ZZopaque", "%ZZopaque", "invalid-percent-escape"],
	["missing comma", "data:image/png;base64", "image/png;base64", "missing-comma"],
	["wrapped whitespace", "data:image/png;base64,QUFB\nQkJC", "QUFB\nQkJC", "invalid-base64-character"],
	["invalid padding", "data:image/png;base64,SG=k", "SG=k", "invalid-base64-padding"],
	["invalid base64 length", "data:image/png;base64,S", "S", "invalid-base64-length"],
	["non-ASCII base64", "data:image/png;base64,雪", "雪", "non-ascii-base64"],
]) test(`malformed ${name} is wholly omitted without leaking its suffix`, async t => {
	transport(t, `Before ![alt text](${uri}) after.`);
	const [result] = await fetchAllContent([url]);
	const omission = marker(result.content);
	assert.equal(result.content, `Before ![alt text](${omission}) after.`);
	for (const field of ["decodedBytes=unknown;", `decodeError=${error};`, "digestBasis=encoded;", `encodedBytes=${Buffer.byteLength(payload)};`, `sha256=${createHash("sha256").update(payload).digest("hex")};`]) assert.ok(omission.includes(field), field);
});

for (const wrap of [uri => `![diagram](${uri})`, uri => `<${uri}>`, uri => `'${uri}'`, uri => uri]) test(`URI enclosure preserves surrounding prose: ${wrap("URI")}`, async t => {
	transport(t, "Before " + wrap("data:text/plain,opaque%20value") + " after.");
	const [result] = await fetchAllContent([url]);
	assert.equal(result.content, "Before " + wrap(marker(result.content)) + " after.");
});

test("ordinary prose and a direct unformatted extraction remain unchanged", async t => {
	const body = "Ordinary data: value; metadata:text/plain,keep and other words.";
	transport(t, body);
	assert.equal((await fetchAllContent([url]))[0].content, body);
});

test("direct extraction retains its raw textual contract", async t => {
	const body = "Before data:text/plain,opaque after.";
	transport(t, body);
	assert.equal((await extractContent(url)).content, body);
});

test("MIME bounds are derived from RFC token names, not attacker header size", async t => {
	const valid = "x".repeat(127) + "/" + "y".repeat(127);
	const invalid = "x".repeat(128) + "/png";
	const header = "image/png;name=" + "z".repeat(30000) + ";base64";
	transport(t, [valid, invalid, header].map(mime => `![alt](data:${mime},SGk=)`).join("\n"));
	const [result] = await fetchAllContent([url]);
	const omissions = result.content.match(markerPattern);
	assert.equal(omissions.length, 3);
	assert.ok(omissions[0].includes(`mime=${valid};`));
	assert.ok(omissions[1].includes("mime=application/octet-stream;"));
	assert.ok(omissions[2].includes("mime=image/png;"));
	assert.ok(!result.content.includes("z"));
});

test("MIME/header text cannot inject marker fields or retain arbitrary header bytes", async t => {
	transport(t, "Before ![diagram](data:bad]header;name=opaque-header,opaque-payload) after.");
	const [result] = await fetchAllContent([url]);
	const omission = marker(result.content);
	assert.equal(result.content, `Before ![diagram](${omission}) after.`);
	assert.ok(omission.includes("mime=application/octet-stream;"));
	assert.doesNotMatch(result.content, /opaque|bad\]header/);
});

test("nested URI parentheses remain wholly omitted inside Markdown", async t => {
	transport(t, "Before ![alt](data:text/plain,abc(def(ghi))jkl) after.");
	const [result] = await fetchAllContent([url]);
	assert.equal(result.content, `Before ![alt](${marker(result.content)}) after.`);
});

for (const type of ["text/html", "RSC"]) test(`${type} extraction omits URI payloads without losing readable content`, async t => {
	const prose = "Useful surrounding prose. ".repeat(30);
	const body = type === "RSC" ? html("<article>Loading...</article>", prose + "![diagram](data:image/png;base64,SGk=) Final prose.")
		: html(`<article><p>${prose}</p><img alt="diagram" src="data:image/png;base64,SGk="><p>Final prose.</p></article>`);
	transport(t, body, { type: "text/html" });
	const [result] = await fetchAllContent([url]);
	assert.equal(result.error, null);
	assert.ok(result.content.includes("Useful surrounding prose."));
	assert.ok(result.content.endsWith("Final prose."));
	assert.ok(result.content.includes("![diagram]("));
	marker(result.content);
	assert.doesNotMatch(result.content, /data:image|SGk=/);
});

test("sanitizing an already marked body is idempotent", async t => {
	transport(t, "Before ![alt](data:image/png;base64,SGk=) after.");
	const [first] = await fetchAllContent([url]);
	t.mock.method(globalThis, "fetch", async () => new Response(first.content, { headers: { "content-type": "text/plain" } }));
	const [second] = await fetchAllContent([url]);
	assert.equal(second.content, first.content);
	marker(second.content);
});

test("early image payloads no longer hide following prose at the retained inline limit", async t => {
	// Reproduce the upstream 21-image shape below the existing 5 MiB HTTP limit.
	const payload = Buffer.alloc(160 * 1024, 0xa5).toString("base64");
	const body = Array.from({ length: 21 }, (_, i) => `Before ${i} ![image ${i}](data:image/png;base64,${payload}) after ${i}.`).join("\n") + "\nFinal prose remains visible.";
	assert.ok(Buffer.byteLength(body) < 5 * 1024 * 1024);
	transport(t, body);
	const result = await tools(t).get("fetch_content").execute("fixture", { url });
	const text = result.content[0].text;
	assert.equal((text.match(markerPattern) ?? []).length, 21);
	assert.ok(text.endsWith("Final prose remains visible."));
	assert.equal(result.details.truncated, false);
	t.diagnostic(JSON.stringify({ inputBytes: Buffer.byteLength(body), outputChars: text.length, existingInlineLimit: 30000, existingHttpLimit: 5 * 1024 * 1024 }));
});

test("many small URIs have no payload-size exemption", async t => {
	const body = Array.from({ length: 500 }, (_, i) => `Prose ${i} ![alt](data:image/png;base64,SGk=) end.`).join("\n");
	transport(t, body);
	const [result] = await fetchAllContent([url]);
	assert.equal((result.content.match(markerPattern) ?? []).length, 500);
	assert.doesNotMatch(result.content, /data:image/i);
	assert.ok(result.content.endsWith(" end."));
});

for (const route of ["single", "multi", "fetched search", "keyed supplied", "keyless supplied"]) test(`${route} omits page URIs before tool output without refetching supplied bodies`, async t => {
	const body = "Before ![diagram](data:image/png;base64,SGk=) after prose.";
	const supplied = route.includes("supplied");
	const requests = transport(t, body, { supplied: supplied ? body : undefined, keyed: route !== "keyless supplied" });
	const registered = tools(t);
	const result = route.includes("search") || supplied
		? await registered.get("web_search").execute("fixture", { query: "integrity", provider: "exa", includeContent: true })
		: await registered.get("fetch_content").execute("fixture", route === "multi" ? { urls: [url, origin + "/other"] } : { url });
	const text = result.content[0].text;
	const pages = supplied || route.includes("search") ? text.slice(text.indexOf("## Fetched Content")) : text;
	assert.ok(pages.includes("Before ![diagram]("));
	assert.ok(pages.includes(") after prose."));
	assert.doesNotMatch(pages, /data:image|SGk=/);
	assert.equal((pages.match(markerPattern) ?? []).length, route === "multi" ? 2 : 1);
	assert.equal(requests.filter(target => new URL(target).hostname === "integrity.example.test").length, supplied ? 0 : route === "multi" ? 2 : 1);
	if (supplied) assert.ok(text.slice(0, text.indexOf("## Fetched Content")).includes(body), "search answers are outside the page-body sanitizer");
});

for (const route of ["single", "multi", "fetched search", "keyed supplied", "keyless supplied"]) {
	for (const prefix of [29998, 29999, 30000]) test(`${route} keeps a pair whole at prefix ${prefix} near the existing 30000 limit`, async t => {
		const body = "A".repeat(prefix) + "😀" + "TAIL";
		transport(t, body, { supplied: route.includes("supplied") ? body : undefined, keyed: route !== "keyless supplied" });
		const registered = tools(t);
		const result = route.includes("search") || route.includes("supplied")
			? await registered.get("web_search").execute("fixture", { query: "unicode", provider: "exa", includeContent: true })
			: await registered.get("fetch_content").execute("fixture", route === "multi" ? { urls: [url, origin + "/other"] } : { url });
		const text = result.content[0].text;
		assert.ok(text.isWellFormed(), "tool output split a valid surrogate pair");
		const expected = body.slice(0, prefix === 29999 ? 29999 : 30000) + notice;
		assert.ok(text.includes(expected), "existing body budget or truncation notice changed");
		assert.ok(!text.includes("TAIL"));
		if (route === "single") {
			assert.equal(text, expected);
			assert.equal(result.details.totalChars, body.length);
			assert.equal(result.details.truncated, true);
		}
	});
}

for (const body of ["Short café 雪 😀", "A".repeat(30000), "A".repeat(29998) + "😀"]) test(`untruncated single fetch preserves ${body.length} code units exactly`, async t => {
	transport(t, body);
	const result = await tools(t).get("fetch_content").execute("fixture", { url });
	assert.equal(result.content[0].text, body);
	assert.equal(result.details.truncated, false);
	assert.equal(result.details.totalChars, body.length);
});
