import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const first = "https://pages.example.test/first";
const second = "https://pages.example.test/second";

async function fixture(t, config = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-search-content-")));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
		t.diagnostic(JSON.stringify({ fixtureDirectoryRemoved: !existsSync(root), root }));
	});
	const home = join(root, "home"), bin = join(root, "bin");
	await Promise.all([mkdir(join(home, ".pi"), { recursive: true }), mkdir(bin)]);
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({
		exaApiKey: "synthetic-content-exa-key", perplexityApiKey: "synthetic-content-sonar-key",
		githubClone: { clonePath: join(root, "clones") }, ...config,
	}));
	return {
		run(script) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: bin, NODE_OPTIONS: "", PI_CODING_AGENT_DIR: join(home, "agent") },
				input: `
					import assert from "node:assert/strict";
					import dns from "node:dns/promises";
					import { getEventListeners } from "node:events";
					import { registerHooks, syncBuiltinESMExports } from "node:module";
					const requests = [], lookups = [], updates = [], tools = new Map(), handlers = new Map();
					let lookup = () => [{ address: "93.184.216.34", family: 4 }];
					const originalLookup = dns.lookup, originalFetch = globalThis.fetch;
					dns.lookup = async hostname => { lookups.push(hostname); return lookup(hostname); };
					syncBuiltinESMExports();
					const exa = (results = []) => Response.json({ results });
					const sonar = (answer = "", citations = []) => Response.json({ choices: [{ message: { content: answer } }], citations });
					const mcp = results => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results }) }] } });
					let providerResponse = () => { throw new Error("Unexpected provider request"); };
					let pageResponse = () => { throw new Error("Unexpected page request"); };
					globalThis.fetch = async (input, init) => {
						const target = new URL(input), host = target.hostname;
						if (["api.exa.ai", "api.perplexity.ai", "mcp.exa.ai"].includes(host)) {
							const body = JSON.parse(init.body);
							const query = host === "api.perplexity.ai" ? body.messages[0].content : host === "mcp.exa.ai" ? body.params.arguments.query : body.query;
							requests.push({ kind: "search", host, query, body });
							return providerResponse({ host, query, body, init });
						}
						const headers = new Headers(init.headers);
						assert.equal(headers.has("authorization"), false, "page requests must not carry provider authorization");
						assert.equal(headers.has("x-api-key"), false, "page requests must not carry provider keys");
						requests.push({ kind: "page", url: target.href, redirect: init.redirect });
						return pageResponse({ target, init });
					};
					(await import(${JSON.stringify(indexUrl)})).default({
						on(name, handler) { handlers.set(name, handler); }, registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); },
					});
					const web = (params, signal, onUpdate) => tools.get("web_search").execute("fixture", params, signal, update => { updates.push(update); onUpdate?.(update); });
					async function attempt(run, expected) {
						try { return { value: await run() }; }
						catch (error) { return { error: { name: error?.name, message: error instanceof Error ? error.message : String(error) }, same: error === expected }; }
					}
					let value;
					try {
						await handlers.get("session_start")?.();
						value = await (async () => { ${script} })();
					} finally {
						await handlers.get("session_shutdown")?.();
						globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports();
					}
					console.log(JSON.stringify({ value, requests, lookups, updates, tools: [...tools.keys()] }));
				`,
			});
			t.diagnostic(JSON.stringify({ evidence: "registered tool with mocked DNS/provider/page transport", childPid: child.pid, status: child.status }));
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			const result = JSON.parse(child.stdout);
			assert.deepEqual(result.tools, ["web_search", "code_search", "fetch_content"]);
			return result;
		},
	};
}

function pageUrls(found) {
	return found.requests.filter(request => request.kind === "page").map(request => request.url);
}

function fetchedText(result) {
	const text = result.content[0].text;
	assert.ok(text.includes("## Fetched Content"), "includeContent must return fetched pages inline");
	return text.slice(text.indexOf("## Fetched Content"));
}

for (const provider of ["exa", "perplexity", "keyless exa"]) {
	test(`includeContent fetches missing ${provider} pages through the registered tool`, async t => {
		const f = await fixture(t, provider === "keyless exa" ? { exaApiKey: undefined } : {});
		const found = f.run(`
			const results = [{ title: "First", url: ${JSON.stringify(first)}, text: "" }, { title: "Second", url: ${JSON.stringify(second)} }];
			providerResponse = ({ host }) => host === "api.perplexity.ai" ? sonar("Answer [2]", results.map(item => item.url)) : host === "mcp.exa.ai" ? mcp(results) : exa(results);
			pageResponse = ({ target }) => new Response("# Fetched " + target.pathname.slice(1) + "\\n\\nPage body " + target.pathname, { headers: { "content-type": "text/plain" } });
			return web({ query: "missing pages", provider: ${JSON.stringify(provider === "perplexity" ? "perplexity" : "exa")}, numResults: 2, includeContent: true });
		`);
		assert.deepEqual(pageUrls(found), [first, second]);
		assert.ok(found.requests.filter(request => request.kind === "page").every(request => request.redirect === "manual"));
		const text = fetchedText(found.value);
		assert.ok(text.indexOf("Page body /first") < text.indexOf("Page body /second"));
		assert.deepEqual(found.value.details, { queries: ["missing pages"], queryCount: 1, successfulQueries: 1, totalResults: 2, urls: [first, second] });
		assert.doesNotMatch(found.value.content[0].text, /responseId|fetchId|get_search_content/);
	});
}

test("partial content keeps exact provider text while uncovered page failures stay in source order", async t => {
	const f = await fixture(t);
	const third = "https://pages.example.test/third";
	const body = "  Provider body stays unchanged.\n\nKeep this supplied paragraph.";
	const found = f.run(`
		providerResponse = () => exa([{ title: "Missing first", url: ${JSON.stringify(first)} }, { title: "Provided second", url: ${JSON.stringify(second)}, text: ${JSON.stringify(body)} }, { title: "Missing third", url: ${JSON.stringify(third)} }]);
		pageResponse = ({ target }) => target.href === ${JSON.stringify(first)} ? new Response("unavailable", { status: 503 }) : new Response("# Third\\n\\nFetched third body", { headers: { "content-type": "text/plain" } });
		return web({ query: "partial pages", provider: "exa", includeContent: true });
	`);
	assert.deepEqual(pageUrls(found), [first, third]);
	const text = fetchedText(found.value);
	assert.ok(text.includes(body));
	assert.match(text, /HTTP 503/);
	assert.ok(text.indexOf(`### ${first}`) < text.indexOf("### Provided second"));
	assert.ok(text.indexOf("### Provided second") < text.indexOf("Fetched third body"));
	assert.equal(found.value.details.successfulQueries, 1);
	assert.deepEqual(found.value.details.urls, [first, second, third]);
});

for (const kind of ["disabled", "fully covered", "answer only", "empty sources", "failed search"]) {
	test(`${kind} does not fetch pages or load the extractor`, async t => {
		const f = await fixture(t);
		const found = f.run(`
			const hook = registerHooks({ resolve(specifier, context, next) { if (specifier.endsWith("extract.ts")) throw new Error("Unused extractor loaded"); return next(specifier, context); } });
			try {
				const kind = ${JSON.stringify(kind)};
				providerResponse = () => kind === "failed search" ? new Response("Search unavailable", { status: 503 }) : kind === "answer only" ? sonar("Answer without sources") : exa(kind === "empty sources" ? [] : kind === "fully covered" ? [{ title: "A1", url: ${JSON.stringify(first)}, text: "Body A1" }, { title: "B1", url: ${JSON.stringify(second)}, text: "Body B1" }, { title: "A2", url: ${JSON.stringify(first)}, text: "Body A2" }] : [{ title: "Not fetched", url: ${JSON.stringify(first)} }]);
				return await web({ query: "no page work", provider: kind === "answer only" ? "perplexity" : "exa", includeContent: kind !== "disabled" });
			} finally { hook.deregister(); }
		`);
		assert.deepEqual(pageUrls(found), []);
		if (kind === "fully covered") {
			const text = fetchedText(found.value);
			assert.ok(text.indexOf("Body A1") < text.indexOf("Body B1"));
			assert.ok(text.indexOf("Body B1") < text.indexOf("Body A2"), "fully covered batches retain their existing body order");
		} else {
			assert.doesNotMatch(found.value.content[0].text, /## Fetched Content/);
		}
		if (kind === "answer only") assert.match(found.value.content[0].text, /Answer without sources/);
		if (kind === "failed search") assert.equal(found.value.details.successfulQueries, 0);
	});
}

test("gap filling preserves every repeated provider body and uses approved first-seen URL groups", async t => {
	const f = await fixture(t);
	const missing = "https://pages.example.test/missing", later = "https://pages.example.test/later";
	const found = f.run(`
		providerResponse = ({ query }) => exa(query === "alpha" ? [{ title: "A1", url: ${JSON.stringify(first)}, text: "Body A1" }, { title: "B1", url: ${JSON.stringify(second)}, text: "Body B1" }, { title: "Missing", url: ${JSON.stringify(missing)} }, { title: "Later", url: ${JSON.stringify(later)} }] : [{ title: "A2", url: ${JSON.stringify(first)}, text: "Body A2" }, { title: "Repeated missing", url: ${JSON.stringify(missing)} }, { title: "Later supplied", url: ${JSON.stringify(later)}, text: "Later provider body" }]);
		pageResponse = () => new Response("# Missing\\n\\nFetched missing body", { headers: { "content-type": "text/plain" } });
		const params = { queries: ["alpha", "omega"], provider: "exa", includeContent: true };
		return { first: await web(params), second: await web(params) };
	`);
	assert.deepEqual(pageUrls(found), [missing, missing], "one fetch per uncovered URL per invocation, not a cross-call cache");
	assert.deepEqual(found.requests.filter(request => request.kind === "search").map(request => request.query), ["alpha", "omega", "alpha", "omega"]);
	for (const result of [found.value.first, found.value.second]) {
		const text = fetchedText(result);
		const bodies = ["Body A1", "Body A2", "Body B1", "Fetched missing body", "Later provider body"];
		for (let i = 1; i < bodies.length; i++) assert.ok(text.indexOf(bodies[i - 1]) >= 0 && text.indexOf(bodies[i - 1]) < text.indexOf(bodies[i]), bodies.join(" -> "));
		assert.deepEqual(result.details, { queries: ["alpha", "omega"], queryCount: 2, successfulQueries: 2, totalResults: 7, urls: [first, second, missing, later] });
	}
});

test("fetched page output follows source order rather than transport completion order", async t => {
	const f = await fixture(t);
	const found = f.run(`
		providerResponse = () => exa([{ title: "First", url: ${JSON.stringify(first)} }, { title: "Second", url: ${JSON.stringify(second)} }]);
		let releaseFirst;
		const completed = [];
		pageResponse = ({ target }) => {
			if (target.href === ${JSON.stringify(first)}) return new Promise(resolve => { releaseFirst = () => { completed.push("first"); resolve(new Response("# First\\n\\nFirst completed body", { headers: { "content-type": "text/plain" } })); }; });
			completed.push("second");
			setImmediate(() => releaseFirst());
			return new Response("# Second\\n\\nSecond completed body", { headers: { "content-type": "text/plain" } });
		};
		return { result: await web({ query: "out of order", provider: "exa", includeContent: true }), completed };
	`);
	assert.deepEqual(found.value.completed, ["second", "first"]);
	const text = fetchedText(found.value.result);
	assert.ok(text.indexOf("First completed body") < text.indexOf("Second completed body"));
});

test("missing search pages retain URL, DNS, redirect and body-size protections without provider credentials", async t => {
	const f = await fixture(t);
	const urls = ["file:///private/fixture", "http://127.0.0.1/private", "https://private.example.test/private", "https://pages.example.test/redirect", "https://pages.example.test/oversize", "https://pages.example.test/unavailable", first];
	const found = f.run(`
		const urls = ${JSON.stringify(urls)};
		lookup = hostname => [{ address: hostname === "private.example.test" ? "127.0.0.1" : "93.184.216.34", family: 4 }];
		providerResponse = () => exa(urls.map((url, i) => ({ title: "Source " + i, url })));
		let redirectCancelled = false, oversizedCancelled = false;
		pageResponse = ({ target }) => {
			if (target.pathname === "/redirect") return new Response(new ReadableStream({ cancel() { redirectCancelled = true; } }), { status: 302, headers: { location: "http://127.0.0.1/redirected-private" } });
			// One byte above the existing text-body limit in extract.ts, not a new budget.
			if (target.pathname === "/oversize") return new Response(new ReadableStream({ cancel() { oversizedCancelled = true; } }), { headers: { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024 + 1) } });
			if (target.pathname === "/unavailable") return new Response("unavailable", { status: 503 });
			assert.equal(target.href, ${JSON.stringify(first)}, "forbidden targets must not reach transport");
			return new Response("# Public\\n\\nSafe fetched control", { headers: { "content-type": "text/plain" } });
		};
		return { result: await web({ query: "protected pages", provider: "exa", includeContent: true }), redirectCancelled, oversizedCancelled };
	`);
	assert.deepEqual(pageUrls(found).toSorted(), urls.slice(3).toSorted());
	assert.equal(found.value.redirectCancelled, true);
	assert.equal(found.value.oversizedCancelled, true);
	assert.ok(found.lookups.includes("private.example.test"));
	const text = fetchedText(found.value.result);
	for (const message of ["Only HTTP and HTTPS", "Blocked fetch target", "Response too large", "HTTP 503", "Safe fetched control"]) assert.ok(text.includes(message), message);
	assert.equal(found.value.result.details.successfulQueries, 1);
});

test("cancellation at the content phase prevents extraction and preserves the caller reason", async t => {
	const f = await fixture(t);
	const found = f.run(`
		providerResponse = () => exa([{ title: "First", url: ${JSON.stringify(first)} }]);
		const caller = new AbortController(), reason = new Error("Stopped before page work");
		const hook = registerHooks({ resolve(specifier, context, next) { if (specifier.endsWith("extract.ts")) throw new Error("Cancelled call loaded extractor"); return next(specifier, context); } });
		try {
			return { outcome: await attempt(() => web({ query: "cancel at fetch", provider: "exa", includeContent: true }, caller.signal, update => { if (update.details.phase === "fetch") caller.abort(reason); }), reason), listeners: getEventListeners(caller.signal, "abort").length };
		} finally { hook.deregister(); }
	`);
	assert.equal(found.value.outcome.same, true);
	assert.equal(found.value.outcome.error.message, "Stopped before page work");
	assert.deepEqual(pageUrls(found), []);
	assert.equal(found.value.listeners, 0);
});

test("cancellation during page fetching rejects partial success and stops queued work", async t => {
	const f = await fixture(t);
	const found = f.run(`
		providerResponse = () => exa(Array.from({ length: 5 }, (_, i) => ({ title: "Page " + i, url: "https://pages.example.test/page-" + i })));
		const caller = new AbortController(), reason = new Error("Stopped active page work");
		pageResponse = () => { caller.abort(reason); return new Response("# Cancelled\\n\\nMust not be returned as success", { headers: { "content-type": "text/plain" } }); };
		const outcome = await attempt(() => web({ query: "cancel active", provider: "exa", includeContent: true }, caller.signal), reason);
		return { outcome, listeners: getEventListeners(caller.signal, "abort").length };
	`);
	assert.equal(found.value.outcome.same, true);
	assert.equal(found.value.outcome.error.message, "Stopped active page work");
	assert.deepEqual(pageUrls(found), ["https://pages.example.test/page-0"]);
	assert.equal(found.value.listeners, 0);
});
