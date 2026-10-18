import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-content-http-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home; process.env.USERPROFILE = home;
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});
await mkdir(join(home, ".pi"));
await writeFile(join(home, ".pi/web-search.json"), JSON.stringify({ githubClone: { enabled: false, clonePath: join(home, "clones") } }));
const { default: initialize } = await import("../index.ts");
const hostname = "content-http.example.test";
const digest = value => createHash("sha256").update(value).digest("hex");

async function fetchOwnedPage(t, body, type = "text/html", multiple = false) {
	const requests = [], tools = new Map(), handlers = new Map();
	const server = createServer((req, res) => {
		requests.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] });
		res.setHeader("content-type", type); res.end(body);
	});
	t.after(async () => {
		try { await handlers.get("session_shutdown")?.(); }
		finally {
			server.closeAllConnections();
			await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			t.mock.restoreAll(); syncBuiltinESMExports();
			t.diagnostic(JSON.stringify({ boundary: "owned HTTP cleanup", serverClosed: !server.listening }));
		}
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	// Exercise native Fetch over owned HTTP, keeping production target validation enabled.
	t.mock.method(dnsPromises, "lookup", async host => {
		assert.equal(host, hostname);
		return [{ address: "93.184.216.34", family: 4 }];
	});
	t.mock.method(dns, "lookup", (host, options, callback) => {
		assert.equal(host, hostname);
		if (typeof options === "function") { callback = options; options = {}; }
		if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
		else callback(null, "127.0.0.1", 4);
	});
	syncBuiltinESMExports();
	initialize({ registerTool(tool) { tools.set(tool.name, tool); }, registerShortcut() {}, on(event, handler) { handlers.set(event, handler); } });
	const url = `http://${hostname}:${server.address().port}/article`;
	const result = await tools.get("fetch_content").execute("owned-http", multiple ? { urls: [url, url + "/other"] } : { url });
	const artifact = { boundary: "native HTTP -> Readability/Turndown -> registered fetch_content; controlled DNS only", inputSha256: digest(body), outputSha256: digest(result.content[0].text), result, requests };
	t.diagnostic(JSON.stringify(artifact));
	assert.deepEqual(requests, (multiple ? ["/article", "/article/other"] : ["/article"]).map(path => ({ path, authorization: undefined, apiKey: undefined })));
	assert.equal(result.details.successful, multiple ? 2 : 1);
	return result.content[0].text;
}

const prose = "A readable article must preserve its image explanation. ".repeat(12);
const document = image => `<html><head><title>Owned image article</title></head><body><article><p>${prose}</p>${image}<p>Following prose sentinel.</p></article></body></html>`;

for (const payload of ["abc)OPAQUE_SUFFIX", "abc(OPAQUE_SUFFIX", "abc(def)ghi"]) {
	test(`owned HTTP journey omits escaped destination ${payload} and preserves following prose`, async t => {
		const text = await fetchOwnedPage(t, document(`<img alt="diagram" src="data:text/plain,${payload}">`));
		const markers = text.match(/\[pi-web-access inline data URI omitted;[^\]]+\]/g) ?? [];
		assert.equal(markers.length, 1);
		assert.ok(text.includes("![diagram](")); assert.ok(text.endsWith("Following prose sentinel."));
		assert.ok(!text.includes("OPAQUE_SUFFIX"));
		for (const field of [`encodedBytes=${Buffer.byteLength(payload)};`, `decodedBytes=${Buffer.byteLength(payload)};`, `sha256=${digest(payload)};`, "digestBasis=decoded;"]) assert.ok(markers[0].includes(field), field);
	});
}

test("owned HTTP journey keeps the Markdown title outside URI metadata", async t => {
	const text = await fetchOwnedPage(t, document('<img alt="diagram" title="Diagram &quot;quoted&quot; title" src="data:image/png;base64,SGk=">'));
	assert.ok(text.endsWith("Following prose sentinel."));
	assert.ok(text.includes(' "Diagram \\"quoted\\" title"'));
	for (const field of ["encodedBytes=4;", "decodedBytes=2;", `sha256=${digest("Hi")};`, "digestBasis=decoded;"]) assert.ok(text.includes(field), field);
});

test("owned HTTP documentation journey preserves quoted scheme-name labels exactly", async t => {
	const body = 'Use the `data:` scheme, "data:" labels and \'data:\' in documentation; `data: URL` and "data: value" are labels too.';
	assert.equal(await fetchOwnedPage(t, body, "text/plain"), body);
});

test("owned HTTP journey preserves ordinary parenthetical prose around a data URI", async t => {
	const body = "Use the URL (data:text/plain,Hello for this example) and keep reading.";
	const text = await fetchOwnedPage(t, body, "text/plain");
	const markers = text.match(/\[pi-web-access inline data URI omitted;[^\]]+\]/g) ?? [];
	assert.equal(markers.length, 1);
	assert.equal(text, body.replace("data:text/plain,Hello", markers[0]));
	for (const field of ["encodedBytes=5;", "decodedBytes=5;", `sha256=${digest("Hello")};`]) assert.ok(markers[0].includes(field), field);
});

for (const payload of ['<svg xmlns="http://www.w3.org/2000/svg"><text>OPAQUE_SUFFIX</text></svg>', "ends\\"]) {
	test(`owned JSON HTTP journey respects escaped-quote parity: ${payload}`, async t => {
		const body = JSON.stringify({ image: "data:image/svg+xml," + payload, after: "Following prose sentinel." });
		const text = await fetchOwnedPage(t, body, "application/json");
		const value = JSON.parse(text);
		assert.equal(value.after, "Following prose sentinel.");
		assert.match(value.image, /^\[pi-web-access inline data URI omitted;/);
		assert.ok(!text.includes("OPAQUE_SUFFIX"));
		const scanned = JSON.stringify(payload).slice(1, -1);
		for (const field of [`encodedBytes=${Buffer.byteLength(scanned)};`, `decodedBytes=${Buffer.byteLength(scanned)};`, `sha256=${digest(scanned)};`]) assert.ok(value.image.includes(field), field);
	});
}

test("owned HTML HTTP journey hashes a bare URI without Turndown presentation escapes", async t => {
	const text = await fetchOwnedPage(t, document("<p>Before data:text/plain,hello_world After.</p>"));
	for (const field of ["encodedBytes=11;", "decodedBytes=11;", `sha256=${digest("hello_world")};`]) assert.ok(text.includes(field), field);
});

test("owned raw-text HTTP control keeps literal payload backslashes in its metadata", async t => {
	const payload = "hello\\_world";
	const text = await fetchOwnedPage(t, "Before `data:text/plain," + payload + "` After.", "text/plain");
	for (const field of [`encodedBytes=${Buffer.byteLength(payload)};`, `decodedBytes=${Buffer.byteLength(payload)};`, `sha256=${digest(payload)};`]) assert.ok(text.includes(field), field);
});

test("owned HTTP multi-fetch journey omits URIs from derived headings as well as bodies", async t => {
	const text = await fetchOwnedPage(t, "# Brand ![logo](data:image/png;base64,SGk=)\n\nFollowing prose sentinel.", "text/markdown", true);
	assert.ok(text.includes("## Brand ![logo]("));
	assert.ok(text.includes("Following prose sentinel."));
	assert.doesNotMatch(text, /data:image|SGk=/);
});

test("owned HTTP journey does not skip an actual URI after a quoted scheme-name label", async t => {
	const body = 'Read "data: URL example data:text/plain,Hello" here.';
	const text = await fetchOwnedPage(t, body, "text/plain");
	const markers = text.match(/\[pi-web-access inline data URI omitted;[^\]]+\]/g) ?? [];
	assert.equal(markers.length, 1);
	assert.equal(text, body.replace("data:text/plain,Hello", markers[0]));
	for (const field of ["encodedBytes=5;", "decodedBytes=5;", `sha256=${digest("Hello")};`]) assert.ok(markers[0].includes(field), field);
});

for (const [name, payload, markup] of [
	["inline trailing backslash", "ends\\", '<p><code>data:text/plain,ends\\</code> After prose sentinel.</p>'],
	["inline literal escape", "hello\\_world", '<p><code>data:text/plain,hello\\_world</code> After prose sentinel.</p>'],
	["fenced literal escape", "hello\\_world", '<pre><code>data:text/plain,hello\\_world</code></pre><p>After prose sentinel.</p>'],
]) test(`owned HTML code journey preserves literal URI bytes: ${name}`, async t => {
	const text = await fetchOwnedPage(t, document(markup));
	assert.ok(text.includes("After prose sentinel."));
	assert.ok(text.endsWith("Following prose sentinel."));
	for (const field of [`encodedBytes=${Buffer.byteLength(payload)};`, `decodedBytes=${Buffer.byteLength(payload)};`, `sha256=${digest(payload)};`]) assert.ok(text.includes(field), field);
});
