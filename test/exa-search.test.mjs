import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const key = "synthetic-exa-search-key";
const result = { url: "https://docs.example.com/page", title: "Docs", highlights: ["Relevant highlight"], text: "Full page text" };
const invalidResponse = /Exa MCP returned invalid search results/;

async function run(t, script, config = {}) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pi-exa-search-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".pi"));
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), PI_CODING_AGENT_DIR: join(home, "agent") },
		input: `
			const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
			const requests = [];
			const item = ${JSON.stringify(result)};
			const rpc = (text, sse = false) => {
				const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
				return new Response(sse ? "event: message\\ndata: " + body + "\\n\\n" : body);
			};
			const record = (url, init) => {
				const request = { url: String(url), method: init.method, body: JSON.parse(init.body), hasKey: new Headers(init.headers).has("x-api-key"), aborted: init.signal.aborted };
				requests.push(request);
				return request;
			};
			globalThis.fetch = async () => { throw new Error("Unexpected fixture network request"); };
			const { searchWithExa } = await load("exa");
			const { activityMonitor } = await load("activity");
			async function attempt(fn) { try { return { value: await fn() }; } catch (error) { return { error: { name: error.name, message: error.message, stack: error.stack } }; } }
			${script}
		`,
	});
	assert.equal(child.status, 0, child.error?.message || child.stderr);
	return { ...JSON.parse(child.stdout), transcript: child.stdout + child.stderr };
}

test("all keyed searches use /search and request highlights without unwanted full text", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => { record(url, init); return Response.json({ results: [item] }); };
		const results = [];
		for (const options of [{}, { numResults: 5 }, { numResults: 2, includeContent: false }]) results.push(await searchWithExa("keyed query", options));
		console.log(JSON.stringify({ results, requests }));
	`, { exaApiKey: key });
	assert.deepEqual(found.requests.map(({ url, method, hasKey, body }) => ({ url, method, hasKey, body })), [5, 5, 2].map(numResults => ({
		url: "https://api.exa.ai/search", method: "POST", hasKey: true,
		body: { query: "keyed query", type: "auto", numResults, contents: { highlights: true } },
	})));
	for (const response of found.results) assert.deepEqual(response, {
		answer: "Relevant highlight\nSource: Docs (https://docs.example.com/page)",
		results: [{ title: "Docs", url: result.url, snippet: "" }],
	});
});

test("keyed filters and requested full content keep the final search payload", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => { record(url, init); return Response.json({ results: [item] }); };
		const before = Date.now();
		const response = await searchWithExa("filtered", { numResults: 3, recencyFilter: "week", domainFilter: [" docs.example.com ", "-spam.example.net", "", "-"], includeContent: true });
		console.log(JSON.stringify({ before, after: Date.now(), response, requests }));
	`, { exaApiKey: key });
	const { startPublishedDate, ...body } = found.requests[0].body;
	assert.deepEqual(body, { query: "filtered", type: "auto", numResults: 3, includeDomains: ["docs.example.com"], excludeDomains: ["spam.example.net"], contents: { text: true, highlights: true } });
	assert.ok(Date.parse(startPublishedDate) >= found.before - 7 * 86400000);
	assert.ok(Date.parse(startPublishedDate) <= found.after - 7 * 86400000);
	assert.deepEqual(found.response.inlineContent, [{ url: result.url, title: "Docs", content: "Full page text", error: null }]);
});

test("keyless filters and content use the enabled advanced tool with structured parameters", async t => {
	for (const [recencyFilter, days] of [["day", 1], ["week", 7], ["month", 30], ["year", 365]]) await t.test(recencyFilter, async t => {
		const found = await run(t, `
			globalThis.fetch = async (url, init) => { record(url, init); return rpc(JSON.stringify({ results: [item] }), true); };
			const before = Date.now();
			const response = await searchWithExa("semantic query", { numResults: 3, recencyFilter: ${JSON.stringify(recencyFilter)}, domainFilter: ["docs.example.com", "-spam.example.net"], includeContent: true });
			console.log(JSON.stringify({ before, after: Date.now(), response, requests }));
		`);
		assert.equal(found.requests.length, 1);
		const request = found.requests[0];
		assert.equal(request.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
		assert.equal(request.hasKey, false);
		assert.equal(request.body.method, "tools/call");
		assert.equal(request.body.params.name, "web_search_advanced_exa");
		const { startPublishedDate, ...args } = request.body.params.arguments;
		assert.deepEqual(args, { query: "semantic query", type: "auto", numResults: 3, includeDomains: ["docs.example.com"], excludeDomains: ["spam.example.net"], enableHighlights: true, textMaxCharacters: 50000 });
		assert.ok(Date.parse(startPublishedDate) >= found.before - days * 86400000);
		assert.ok(Date.parse(startPublishedDate) <= found.after - days * 86400000);
		assert.match(found.response.answer, /Relevant highlight/);
		assert.deepEqual(found.response.inlineContent, [{ url: result.url, title: "Docs", content: "Full page text", error: null }]);
	});
});

test("content-only and filter-only keyless calls select advanced with the existing content sizes", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => { record(url, init); return rpc(JSON.stringify({ results: [item] })); };
		const content = await searchWithExa("content only", { includeContent: true });
		const filtered = await searchWithExa("filter only", { domainFilter: ["docs.example.com"] });
		console.log(JSON.stringify({ content, filtered, requests }));
	`);
	assert.deepEqual(found.requests.map(request => request.body.params), [
		{ name: "web_search_advanced_exa", arguments: { query: "content only", type: "auto", numResults: 5, enableHighlights: true, textMaxCharacters: 50000 } },
		{ name: "web_search_advanced_exa", arguments: { query: "filter only", type: "auto", numResults: 5, includeDomains: ["docs.example.com"], enableHighlights: true, textMaxCharacters: 3000 } },
	]);
	assert.equal(found.content.inlineContent.length, 1);
	assert.equal(found.filtered.inlineContent, undefined);
});

test("missing advanced tools get one basic fallback with query hints, without sticking across calls", async t => {
	for (const kind of ["rpc-error", "tool-error"]) await t.test(kind, async t => {
		const found = await run(t, `
			globalThis.fetch = async (url, init) => {
				const request = record(url, init);
				if (requests.length === 1) {
					const error = "Tool web_search_advanced_exa not found";
					return Response.json(${JSON.stringify(kind)} === "rpc-error" ? { jsonrpc: "2.0", id: 1, error: { code: -32602, message: error } } : { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: error }] } });
				}
				return rpc(request.body.params.name === "web_search_exa" ? "Title: Basic\\nURL: https://example.com/basic\\nText: Basic text" : JSON.stringify({ results: [item] }));
			};
			const options = { domainFilter: ["example.com", "-spam.example.net"], recencyFilter: "week", includeContent: true };
			const fallback = await searchWithExa("fallback query", options);
			const recovered = await searchWithExa("recovered", options);
			console.log(JSON.stringify({ fallback, recovered, requests }));
		`);
		assert.deepEqual(found.requests.map(request => request.body.params.name), ["web_search_advanced_exa", "web_search_exa", "web_search_advanced_exa"]);
		assert.equal(found.requests[1].url, "https://mcp.exa.ai/mcp?tools=web_search_exa");
		assert.deepEqual(found.requests[1].body.params.arguments, { query: "fallback query site:example.com -site:spam.example.net past week", numResults: 5 });
		assert.equal(found.fallback.results[0].title, "Basic");
		assert.equal(found.fallback.inlineContent[0].content, "Basic text");
		assert.equal(found.recovered.results[0].title, "Docs");
	});
});

test("ordinary advanced failures surface without a weaker basic retry", async t => {
	for (const kind of ["429", "401", "503", "transport", "missing-like-transport", "rpc", "tool"]) await t.test(kind, async t => {
		const found = await run(t, `
			globalThis.fetch = async (url, init) => {
				record(url, init);
				const kind = ${JSON.stringify(kind)};
				if (kind === "transport") throw new TypeError("network fixture failure");
				if (kind === "missing-like-transport") throw new TypeError("Tool web_search_advanced_exa not found in transport fixture");
				if (kind === "rpc") return Response.json({ error: { code: -32602, message: "Tool web_search_advanced_exa failed: API key not found (401)" } });
				if (kind === "tool") return Response.json({ result: { isError: true, content: [{ type: "text", text: "Tool web_search_advanced_exa failed: API key not found (401)" }] } });
				return new Response("Remote account failure", { status: Number(kind) });
			};
			const response = await attempt(() => searchWithExa("failure", { includeContent: true }));
			console.log(JSON.stringify({ response, requests, entries: activityMonitor.getEntries() }));
		`);
		assert.equal(found.requests.length, 1);
		assert.ok(found.response.error);
		assert.ok(found.entries.every(entry => entry.endTime !== undefined && entry.error));
		if (kind === "429") {
			assert.match(found.response.error.message, /429/);
			assert.match(found.response.error.message, /exaApiKey/);
			assert.doesNotMatch(found.response.error.message, /unlimited|unthrottled/i);
		}
	});
});

test("invalid advanced search payloads fail explicitly without basic fallback", async t => {
	for (const payload of ["not JSON", "null", "[]", "{}", '{"results":"bad"}', '{"results":[null]}', '{"results":[{"url":42}]}', '{"results":[{"url":"https://example.com","title":{}}]}', '{"results":[{"url":"https://example.com","text":42}]}']) await t.test(payload, async t => {
		const found = await run(t, `
			globalThis.fetch = async (url, init) => { record(url, init); return rpc(${JSON.stringify(payload)}); };
			console.log(JSON.stringify({ response: await attempt(() => searchWithExa("invalid", { includeContent: true })), requests }));
		`);
		assert.equal(found.requests.length, 1);
		assert.match(found.response.error?.message ?? "", invalidResponse);
	});
});

test("valid empty searches do not trigger basic retries or invent sources", async t => {
	for (const config of [{}, { exaApiKey: key }]) await t.test(config.exaApiKey ? "keyed" : "advanced", async t => {
		const found = await run(t, `
			globalThis.fetch = async (url, init) => { record(url, init); return new URL(url).hostname === "api.exa.ai" ? Response.json({ results: [] }) : rpc(JSON.stringify({ results: [] })); };
			console.log(JSON.stringify({ response: await searchWithExa("empty", { includeContent: true }), requests }));
		`, config);
		assert.deepEqual(found.response, { answer: "", results: [] });
		assert.equal(found.requests.length, 1);
	});
});

test("caller cancellation is terminal before fetch, during fetch and while reading MCP bodies", async t => {
	for (const phase of ["before", "fetch", "body"]) await t.test(phase, async t => {
		const found = await run(t, `
			const caller = new AbortController();
			const reason = new Error("caller cancelled fixture");
			const phase = ${JSON.stringify(phase)};
			if (phase === "before") caller.abort(reason);
			globalThis.fetch = async (url, init) => {
				record(url, init);
				if (phase === "fetch") { caller.abort(reason); throw init.signal.reason; }
				const response = rpc(JSON.stringify({ results: [item] }));
				response.text = async () => { caller.abort(reason); throw init.signal.reason; };
				return response;
			};
			const response = await attempt(() => searchWithExa("cancel", { includeContent: true, signal: caller.signal }));
			console.log(JSON.stringify({ response, requests, entries: activityMonitor.getEntries() }));
		`);
		assert.equal(found.requests.length, phase === "before" ? 0 : 1);
		assert.match(found.response.error.message, /caller cancelled fixture/);
		assert.ok(found.entries.every(entry => entry.endTime !== undefined && entry.status === 0 && !entry.error));
	});
});

test("hostname and Source N labels agree across keyed, advanced and basic outputs", async t => {
	const items = [
		{ url: "https://example.com/no-text" },
		{ url: "https://cdn.jsdelivr.net/npm/pkg/file.ts", title: "", text: "page two" },
		{ url: "mailto:team@example.com", text: "page three" },
		{ url: "file:///tmp/notes.txt", text: "page four" },
		{ url: "not-a-url", text: "page five" },
		{ url: "https://example.com/kept", title: "Kept title", text: "page six" },
	];
	const titles = ["example.com", "cdn.jsdelivr.net", "Source 3", "Source 4", "Source 5", "Kept title"];
	for (const mode of ["keyed", "advanced", "basic"]) await t.test(mode, async t => {
		const found = await run(t, `
			const mode = ${JSON.stringify(mode)}, items = ${JSON.stringify(items)};
			globalThis.fetch = async (url, init) => {
				record(url, init);
				if (mode === "keyed") return Response.json({ results: items });
				if (mode === "advanced") return rpc(JSON.stringify({ results: items }));
				return rpc(items.map(item => "Title: " + (item.title || "") + "\\nURL: " + item.url + (item.text ? "\\nText: " + item.text : "")).join("\\n\\n"));
			};
			const response = await searchWithExa("labels", { includeContent: true });
			console.log(JSON.stringify({ response, requests }));
		`, mode === "keyed" ? { exaApiKey: key } : {});
		assert.deepEqual(found.response.results.map(item => item.title), titles);
		assert.deepEqual(found.response.answer.split("\n").filter(line => line.startsWith("Source: ")), items.slice(1).map((item, i) => `Source: ${titles[i + 1]} (${item.url})`));
		assert.deepEqual(found.response.inlineContent.map(({ url, title }) => ({ url, title })), items.slice(1).map((item, i) => ({ url: item.url, title: titles[i + 1] })));
	});
});

test("basic web search and code-context/fallback keep their enabled MCP tool contracts", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => {
			const request = record(url, init);
			if (request.body.params.name === "get_code_context_exa") return Response.json({ error: { code: -32602, message: "Tool get_code_context_exa not found" } });
			return rpc("Title: Basic\\nURL: https://example.com/basic\\nText: Basic text", true);
		};
		const web = await searchWithExa("basic query", { numResults: 2 });
		const code = await (await load("code-search")).executeCodeSearch("fixture", { query: "library docs", maxTokens: 5000 });
		console.log(JSON.stringify({ web, code, requests }));
	`);
	assert.deepEqual(found.requests.map(request => request.url), ["web_search_exa", "get_code_context_exa", "web_search_exa"].map(tool => "https://mcp.exa.ai/mcp?tools=" + tool));
	assert.deepEqual(found.requests[0].body.params.arguments, { query: "basic query", numResults: 2 });
	assert.deepEqual(found.requests[1].body.params.arguments, { query: "library docs", tokensNum: 5000 });
	assert.equal(found.requests.every(request => !request.hasKey), true);
	assert.equal(found.web.inlineContent, undefined);
	assert.equal(found.code.details.mode, "web-search-fallback");
	assert.match(found.code.content[0].text, /Basic text/);
});

test("registered web_search forwards advanced options and renders consistent source/content labels", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => { record(url, init); return rpc(JSON.stringify({ results: [{ ...item, title: "" }] })); };
		const tools = [];
		(await load("index")).default({ on() {}, registerShortcut() {}, registerTool(tool) { tools.push(tool); } });
		const response = await tools.find(tool => tool.name === "web_search").execute("fixture", { query: "registered", provider: "exa", domainFilter: ["docs.example.com"], includeContent: true });
		console.log(JSON.stringify({ response, requests, tools: tools.map(tool => tool.name) }));
	`);
	assert.deepEqual(found.tools.sort(), ["code_search", "fetch_content", "web_search"]);
	assert.equal(found.requests.length, 1);
	assert.equal(found.requests[0].body.params.name, "web_search_advanced_exa");
	assert.deepEqual(found.requests[0].body.params.arguments.includeDomains, ["docs.example.com"]);
	assert.equal(found.response.details.successfulQueries, 1);
	assert.deepEqual(found.response.details.urls, [result.url]);
	assert.match(found.response.content[0].text, /Source: docs\.example\.com/);
	assert.match(found.response.content[0].text, /### docs\.example\.com\nhttps:\/\/docs\.example\.com\/page\n\nFull page text/);
});

test("a failing basic fallback is final rather than another advanced retry", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => {
			const request = record(url, init);
			return request.body.params.name === "web_search_advanced_exa"
				? Response.json({ error: { code: -32602, message: "Tool web_search_advanced_exa not found" } })
				: new Response("Basic unavailable", { status: 503 });
		};
		console.log(JSON.stringify({ response: await attempt(() => searchWithExa("fallback failure", { includeContent: true })), requests }));
	`);
	assert.deepEqual(found.requests.map(request => request.body.params.name), ["web_search_advanced_exa", "web_search_exa"]);
	assert.match(found.response.error.message, /503.*Basic unavailable/);
});

test("keyed transport failures keep redaction and never retry through MCP", async t => {
	const found = await run(t, `
		globalThis.fetch = async (url, init) => { record(url, init); throw new TypeError("transport rejected " + ${JSON.stringify(key)}); };
		const response = await attempt(() => searchWithExa("redaction"));
		console.log(JSON.stringify({ response, requests, entries: activityMonitor.getEntries() }));
	`, { exaApiKey: key });
	assert.equal(found.requests.length, 1);
	assert.equal(found.requests[0].url, "https://api.exa.ai/search");
	assert.match(found.response.error.message, /\[redacted\]/);
	assert.equal(found.transcript.includes(key), false);
	assert.ok(found.entries.every(entry => entry.endTime !== undefined));
});
