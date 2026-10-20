import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-script-types-"));
const environment = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" };
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
	assert.equal(existsSync(home), false);
});
await writeFile(join(home, "web-search.json"), JSON.stringify({ githubClone: { enabled: false } }));
const { extractContent } = await import("../extract.ts");
const { activityMonitor } = await import("../activity.ts");
const hostname = "script-types.example.test", url = "https://" + hostname + "/article";
const prose = "Short useful content stays readable.";
const article = "<article><p>" + prose + "</p></article>";
const digest = text => createHash("sha256").update(text).digest("hex");
const scripts = (type = null, count = 4, code = "/* script fixture */") =>
	(`<script${type === null ? "" : ' type="' + type + '"'}>${code}</script>`).repeat(count);
const page = (markup, location = "head", body = article, title = "Script fixture") =>
	`<!doctype html><html><head><title>${title}</title>${location === "head" ? markup : ""}</head><body>${body}${location === "body" ? markup : ""}</body></html>`;

async function extractPage(t, html) {
	const requests = [], responses = [];
	t.mock.method(dnsPromises, "lookup", async host => {
		assert.equal(host, hostname);
		return [{ address: "93.184.216.34", family: 4 }];
	});
	t.mock.method(globalThis, "fetch", async (input, init) => {
		assert.equal(String(input), url, "no script resources or hosted fallback may be fetched");
		assert.equal(new Headers(init.headers).has("authorization"), false);
		assert.equal(new Headers(init.headers).has("x-api-key"), false);
		requests.push(String(input));
		const response = new Response(html, { headers: { "content-type": "text/html" } });
		responses.push(response);
		return response;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const caller = new AbortController();
	const result = await extractContent(url, caller.signal);
	assert.deepEqual(requests, [url]);
	assert.ok(responses.every(response => !response.body.locked));
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
	t.diagnostic(JSON.stringify({ boundary: "public extractContent and real parsers; controlled DNS/fetch", inputSha256: digest(html), outputSha256: digest(result.content), error: result.error, requests }));
	return result;
}

const dataTypes = [
	"application/ld+json", "application/json", "text/json", "text/template", "text/x-template", "text/html",
	"importmap", "speculationrules", "APPLICATION/LD+JSON", "text/javascript-widget",
	// Script type attributes use MIME essence matches, unlike HTTP Content-Type headers.
	"text/javascript; charset=utf-8", "module; charset=utf-8",
];
const executableTypes = [
	null, "", " \t ", "module", "MoDuLe", " TEXT/JAVASCRIPT \t", "text&#x2f;javascript",
	"application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
	"text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
	"text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
	"text/x-ecmascript", "text/x-javascript",
];

for (const location of ["head", "body"]) {
	for (const type of dataTypes) test(`short page accepts inert ${type} scripts in ${location}`, async t => {
		const result = await extractPage(t, page(scripts(type), location));
		assert.equal(result.error, null);
		assert.equal(result.content, prose);
	});
	for (const type of executableTypes) test(`short page detects four executable ${JSON.stringify(type)} scripts in ${location}`, async t => {
		const result = await extractPage(t, page(scripts(type), location));
		assert.match(result.error, /^Page appears to be JavaScript-rendered/);
		assert.equal(result.content, prose);
	});
}

for (const count of [3, 4]) test(`mixed data blocks retain the ${count}-executable-script boundary`, async t => {
	const result = await extractPage(t, page(scripts(null, count) + scripts("application/ld+json") + scripts("text/template")));
	if (count === 3) assert.equal(result.error, null);
	else assert.match(result.error, /^Page appears to be JavaScript-rendered/);
	assert.equal(result.content, prose);
});

for (const [name, markup] of [
	["no scripts", ""],
	["commented scripts", "<!--" + scripts() + "-->"],
	["script-like element names", "<scripture></scripture>".repeat(4)],
	["script text inside one executable script", scripts(null, 1, 'const quoted = "<script <script <script <script";')],
	["inert external data", '<script type="application/json" src="/data.json"></script>'.repeat(4)],
]) test("short page ignores " + name, async t => {
	const result = await extractPage(t, page(markup));
	assert.equal(result.error, null);
	assert.equal(result.content, prose);
});

for (const [name, markup] of [
	["external executable scripts", '<script src="/bundle.js"></script>'.repeat(4)],
	["data-type is not type", '<script data-type="application/json"></script>'.repeat(4)],
	["type text in another attribute", '<script title="type=application/json"></script>'.repeat(4)],
]) test("short page still counts " + name, async t => {
	assert.match((await extractPage(t, page(markup))).error, /^Page appears to be JavaScript-rendered/);
});

for (const [type, expected] of [["application/ld+json", /^Could not extract readable content/], [null, /^Page appears to be JavaScript-rendered/]]) {
	test(`empty page distinguishes ${type ?? "executable"} scripts without inventing readable content`, async t => {
		const result = await extractPage(t, page(scripts(type), "head", ""));
		assert.match(result.error, expected);
		assert.equal(result.content, "");
	});
}

test("useful HTML with executable scripts keeps the existing quality policy", async t => {
	const content = prose.repeat(20);
	const result = await extractPage(t, page(scripts(), "head", "<article><p>" + content + "</p></article>"));
	assert.equal(result.error, null);
	assert.equal(result.content, content);
});

const bootstrap = "window._cf_chl_opt={};var path='/cdn-cgi/challenge-platform/';";
for (const type of [null, "module", "text/javascript", "text/ecmascript", "text/jscript", "text/livescript", "text/javascript1.5", "application/x-javascript"]) {
	test(`executable challenge bootstrap stays refused: ${type ?? "default"}`, async t => {
		const result = await extractPage(t, page(scripts(type, 1, bootstrap), "body", "<article><p>" + prose.repeat(20) + "</p></article>", "Just a moment..."));
		assert.match(result.error, /^HTTP 200: Blocked by Cloudflare challenge page/);
		assert.equal(result.content, "");
	});
}
for (const type of ["application/ld+json", "text/template", "text/javascript; charset=utf-8"]) {
	test("inert challenge-like data stays readable: " + type, async t => {
		const result = await extractPage(t, page(scripts(type, 4, bootstrap), "body", article, "Just a moment..."));
		assert.equal(result.error, null);
		assert.equal(result.content, prose);
	});
}

test("owned HTTP journey accepts JSON-LD/templates and retains executable-script refusal", async t => {
	const requests = [], results = [];
	const documents = {
		"/plain": page(""),
		"/data": page(scripts("application/ld+json") + scripts("text/template")),
		"/scripted": page(scripts("module")),
	};
	const server = createServer((request, response) => {
		requests.push({ path: request.url, hasCredential: request.headers.authorization !== undefined || request.headers["x-api-key"] !== undefined });
		assert.ok(Object.hasOwn(documents, request.url));
		response.setHeader("content-type", "text/html");
		response.end(documents[request.url]);
	});
	try {
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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
		for (const path of Object.keys(documents)) results.push(await extractContent(`http://${hostname}:${server.address().port}${path}`));
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		t.mock.restoreAll();
		syncBuiltinESMExports();
		t.diagnostic(JSON.stringify({ boundary: "native owned HTTP -> real Readability/Turndown -> public extractContent; controlled DNS only", requests, results, contentSha256: results.map(result => digest(result.content)), serverClosed: !server.listening }));
	}
	assert.deepEqual(requests, Object.keys(documents).map(path => ({ path, hasCredential: false })));
	assert.equal(results[0].error, null);
	assert.equal(results[1].error, null);
	assert.match(results[2].error, /^Page appears to be JavaScript-rendered/);
	assert.ok(results.every(result => result.content === prose));
	assert.equal(server.listening, false);
});
