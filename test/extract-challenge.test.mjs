import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const hostname = "challenge.example.test";
const origin = "https://" + hostname;
const home = await mkdtemp(join(tmpdir(), "pi-extract-challenge-"));
const environment = {
	HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi"),
	EXA_API_KEY: "synthetic-challenge-key", PERPLEXITY_API_KEY: "",
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});
await mkdir(join(home, ".pi"));
await writeFile(join(home, ".pi/web-search.json"), JSON.stringify({
	exaApiKey: environment.EXA_API_KEY, githubClone: { clonePath: join(home, "clones") },
}));
const { extractContent } = await import("../extract.ts");
const { activityMonitor } = await import("../activity.ts");

const bootstrap = "window._cf_chl_opt={cvId:'3',cType:'managed'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=fixture';document.head.appendChild(a);";
const shortArticle = "<article><h1>Ordinary short page</h1><p>Useful short content remains available.</p></article>";
const readableChallenge = "<article><h1>Verifying you are human</h1><p>" + "Readable interstitial text is not the requested article. ".repeat(30) + "</p></article>";
const html = (body, title = "Just a moment...") => "<!doctype html><html><head><title>" + title + "</title></head><body>" + body + "</body></html>";
const challengeHtml = html(readableChallenge + "<script>" + bootstrap + "</script>");

function streamedResponse({ body = challengeHtml, status = 200, type = "text/html", headers = {}, cancelError, onCancel, readError } = {}) {
	const state = { reads: 0, cancellations: 0 };
	const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
	const stream = body === null ? null : new ReadableStream({
		pull(controller) {
			if (readError) { controller.error(readError); return; }
			if (state.reads++ === 0) controller.enqueue(bytes);
			else controller.close();
		},
		cancel() {
			state.cancellations++;
			onCancel?.();
			if (cancelError) throw cancelError;
		},
	}, { highWaterMark: 0 });
	const response = new Response(stream, { status, headers: { "content-type": type, ...headers } });
	return { response, state };
}

function transport(t, reply, providerResults) {
	const requests = [];
	t.mock.method(dns, "lookup", async name => {
		assert.equal(name, hostname, "only the owned page hostname may resolve");
		return [{ address: "93.184.216.34", family: 4 }];
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const target = new URL(input), headers = new Headers(init.headers);
		requests.push(target.href);
		if (target.href === "https://api.exa.ai/search" && providerResults) {
			assert.equal(headers.get("x-api-key"), environment.EXA_API_KEY);
			return Response.json({ results: providerResults });
		}
		assert.equal(target.hostname, hostname, "no hosted fallback or unexpected transport");
		assert.equal(init.redirect, "manual");
		assert.equal(headers.has("authorization"), false);
		assert.equal(headers.has("x-api-key"), false);
		return reply(target, init);
	});
	return requests;
}

function mockResponse(t, options) {
	const fixture = streamedResponse(options);
	const requests = transport(t, () => fixture.response);
	t.after(async () => {
		if (fixture.response.body && !fixture.response.bodyUsed) {
			try { await fixture.response.body.cancel(); }
			catch (error) { if (error !== options?.cancelError) throw error; }
		}
	});
	return { ...fixture, requests };
}

function assertChallenge(result, status = 200) {
	assert.equal(result.title, "");
	assert.equal(result.content, "");
	assert.match(result.error, new RegExp("^HTTP " + status + ": Blocked by Cloudflare challenge page"));
	assert.match(result.error, /Use web_search/);
	assert.doesNotMatch(result.error, /jina|fetchRouting|allowRemoteHostedProviders/i);
}

test("authoritative challenge headers reject before status, body or PDF handling (mock DNS/fetch)", async t => {
	for (const row of [
		{ name: "HTML" },
		{ name: "plain text", type: "text/plain" },
		{ name: "JSON", type: "application/json" },
		{ name: "markdown", type: "text/markdown" },
		{ name: "PDF media type", type: "application/pdf", path: "/report.pdf" },
		{ name: "PDF-shaped URL returning HTML", path: "/report.pdf" },
		{ name: "binary", type: "application/octet-stream" },
		{ name: "HTTP 403", status: 403 },
		{ name: "HTTP 503", status: 503 },
		{ name: "absent body", status: 204, body: null },
		// The retained PDF limit must not force a read of a known interstitial.
		{ name: "oversized declaration", headers: { "content-length": String(20 * 1024 * 1024 + 1) } },
	]) await t.test(row.name, async t => {
		const before = await readdir(home, { recursive: true });
		const { response, state, requests } = mockResponse(t, { ...row, headers: { ...row.headers, "Cf-Mitigated": "challenge" } });
		const caller = new AbortController(), url = origin + (row.path ?? "/challenge");
		assertChallenge(await extractContent(url, caller.signal), row.status ?? 200);
		assert.equal(state.reads, 0);
		assert.equal(state.cancellations, row.body === null ? 0 : 1);
		assert.equal(response.body?.locked ?? false, false);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
		assert.deepEqual(requests, [url]);
		assert.deepEqual(await readdir(home, { recursive: true }), before, "no PDF artifact or other write");
	});
});

test("readable HTML challenge signatures reject before article or RSC success (mock DNS/fetch)", async t => {
	for (const [name, options] of [
		["readable interstitial", {}],
		["XHTML", { type: "application/xhtml+xml" }],
		["explicit JavaScript type", { body: challengeHtml.replace("<script>", '<script type="text/javascript">') }],
		["declared UTF-16 HTML", { body: Buffer.from(challengeHtml, "utf16le"), type: "text/html; charset=utf-16le" }],
		["short interstitial", { body: html("<p>Checking your browser.</p><script>" + bootstrap + "</script>") }],
	]) await t.test(name, async t => {
		const { response, requests } = mockResponse(t, options);
		assertChallenge(await extractContent(origin + "/body"));
		assert.equal(response.body.locked, false);
		assert.deepEqual(requests, [origin + "/body"]);
		assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
	});
});

test("ordinary short pages and partial or quoted signatures remain readable (mock DNS/fetch)", async t => {
	const escaped = ("<script>" + bootstrap + "</script>").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	for (const [name, body, title = "Just a moment...", headers = {}] of [
		["generic moment title", shortArticle],
		["ordinary title", shortArticle, "Short article"],
		["Cloudflare CDN", shortArticle, "Short article", { server: "cloudflare", "cf-ray": "fixture" }],
		["invalid mitigation token", shortArticle, "Short article", { "cf-mitigated": "not-challenge" }],
		["marker substring is not the token", shortArticle, "Short article", { "cf-mitigated": "challenge-other" }],
		["options without platform", shortArticle + "<script>window._cf_chl_opt={};</script>"],
		["platform without options", shortArticle + "<script src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'></script>"],
		["both scripts without challenge title", shortArticle + "<script>" + bootstrap + "</script>", "Ordinary guide"],
		["escaped code example", shortArticle + "<pre><code>" + escaped + "</code></pre>"],
		["inert JSON data", shortArticle + '<script type="application/json">' + JSON.stringify({ example: bootstrap }) + "</script>"],
		["Turnstile widget", shortArticle + '<div class="cf-turnstile" data-sitekey="fixture"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'],
	]) await t.test(name, async t => {
		const { requests } = mockResponse(t, { body: html(body, title), headers });
		const result = await extractContent(origin + "/ordinary");
		assert.equal(result.error, null);
		assert.match(result.content, /Useful short content remains available/);
		assert.deepEqual(requests, [origin + "/ordinary"]);
	});
});

test("non-HTML content quoting the entire challenge remains verbatim (mock DNS/fetch)", async t => {
	for (const type of ["text/plain", "text/markdown", "application/json"]) await t.test(type, async t => {
		mockResponse(t, { body: challengeHtml, type });
		const result = await extractContent(origin + "/example.txt");
		assert.equal(result.error, null);
		assert.equal(result.content, challengeHtml);
	});
});

test("ordinary HTTP errors keep their status without reading or inventing a challenge (mock DNS/fetch)", async t => {
	for (const status of [403, 503]) await t.test(String(status), async t => {
		const { state } = mockResponse(t, { status, headers: { server: "cloudflare" } });
		const result = await extractContent(origin + "/denied");
		assert.match(result.error, new RegExp("^HTTP " + status + ":"));
		assert.doesNotMatch(result.error, /Cloudflare challenge|jina|fetchRouting/i);
		assert.equal(state.reads, 0);
	});
});

test("challenge cancellation failures are explicit and release the caller listener (mock DNS/fetch)", async t => {
	const { response, state } = mockResponse(t, { headers: { "cf-mitigated": "challenge" }, cancelError: new Error("fixture cancel failed") });
	const caller = new AbortController();
	const result = await extractContent(origin + "/cancel", caller.signal);
	assertChallenge(result);
	assert.match(result.error, /Body cancellation failed/);
	assert.equal(state.cancellations, 1);
	assert.equal(response.body.locked, false);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
});

test("caller cancellation wins over a detected challenge (mock DNS/fetch)", async t => {
	const caller = new AbortController();
	const { state, requests } = mockResponse(t, { headers: { "cf-mitigated": "challenge" }, onCancel: () => caller.abort() });
	const url = origin + "/aborted";
	assert.deepEqual(await extractContent(url, caller.signal), { url, title: "", content: "", error: "Aborted" });
	assert.equal(state.cancellations, 1);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.deepEqual(requests, [url]);
});

test("body-only detection does not bypass retained read errors or byte limits (mock DNS/fetch)", async t => {
	await t.test("read failure", async t => {
		const { response } = mockResponse(t, { readError: new Error("fixture challenge read failed") });
		const result = await extractContent(origin + "/broken");
		assert.match(result.error, /fixture challenge read failed/);
		assert.doesNotMatch(result.error, /Cloudflare challenge/);
		assert.equal(response.body.locked, false);
	});
	await t.test("actual body overflow", async t => {
		const limit = 5 * 1024 * 1024; // Existing production text-byte budget.
		const { response, state } = mockResponse(t, { body: challengeHtml + " ".repeat(limit + 1 - Buffer.byteLength(challengeHtml)) });
		const result = await extractContent(origin + "/oversized");
		assert.match(result.error, /^Response too large/);
		assert.match(result.error, new RegExp("configured body limit: " + limit + " bytes; received: " + (limit + 1) + " bytes"));
		assert.doesNotMatch(result.error, /Cloudflare challenge|Fallback options/);
		assert.equal(state.cancellations, 1);
		assert.equal(response.body.locked, false);
	});
});

test("existing caller abort and timeout stop a stalled potential challenge body (mock DNS/fetch/clock)", async t => {
	for (const trigger of ["caller", "timeout"]) await t.test(trigger, async t => {
		const started = Promise.withResolvers(), caller = new AbortController();
		let streamController;
		const response = new Response(new ReadableStream({
			start(controller) { streamController = controller; },
			pull() { started.resolve(); },
		}, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		transport(t, (_target, init) => {
			const onAbort = () => streamController.error(init.signal.reason);
			init.signal.addEventListener("abort", onAbort, { once: true });
			t.after(() => init.signal.removeEventListener("abort", onAbort));
			return response;
		});
		const operation = extractContent(origin + "/stalled", caller.signal);
		await Promise.race([started.promise, operation.then(() => assert.fail("body reading did not start"))]);
		if (trigger === "caller") caller.abort();
		else t.mock.timers.tick(30000); // Existing extraction timeout, not a new test policy.
		assert.match((await operation).error, /abort/i);
		assert.equal(response.body.locked, false);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		assert.notEqual(activityMonitor.getEntries().at(-1).endTime, undefined);
	});
});

test("registered tools report challenge errors while preserving successful page and provider content (mock DNS/fetch)", async t => {
	for (const name of ["fetch_content", "web_search"]) await t.test(name, async t => {
		const tools = new Map(), handlers = new Map();
		(await import("../index.ts")).default({
			on(event, handler) { handlers.set(event, handler); },
			registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); },
		});
		t.after(async () => { await handlers.get("session_shutdown")?.(); });
		await handlers.get("session_start")?.();
		const blocked = origin + "/blocked", safe = origin + "/safe", provided = origin + "/provided";
		const results = [
			{ url: blocked, title: "Blocked" },
			{ url: provided, title: "Supplied", text: "Provider body stays intact." },
			{ url: safe, title: "Safe" },
		];
		const requests = transport(t, target => target.pathname === "/blocked"
			? new Response(challengeHtml, { headers: { "content-type": "text/html" } })
			: new Response("# Safe\n\nOrdinary fetched page.", { headers: { "content-type": "text/plain" } }), results);
		const params = name === "web_search"
			? { query: "owned challenge test", provider: "exa", includeContent: true }
			: { urls: [blocked, safe] };
		const result = await tools.get(name).execute("challenge-fixture", params);
		const text = result.content.map(block => block.text ?? "").join("\n");
		const fetched = name === "web_search" ? text.slice(text.indexOf("## Fetched Content")) : text;
		assert.match(fetched, /HTTP 200: Blocked by Cloudflare challenge page/);
		assert.match(fetched, /Ordinary fetched page/);
		assert.doesNotMatch(fetched, /Readable interstitial text|window\._cf_chl_opt|jina|fetchRouting/i);
		if (name === "web_search") {
			assert.match(fetched, /Provider body stays intact/);
			assert.equal(result.details.successfulQueries, 1);
			assert.deepEqual(requests, ["https://api.exa.ai/search", blocked, safe]);
		} else {
			assert.equal(result.details.successful, 1);
			assert.deepEqual(requests, [blocked, safe]);
		}
	});
});
