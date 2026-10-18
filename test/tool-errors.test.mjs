import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const credentials = { exaApiKey: "synthetic-tools01-exa", perplexityApiKey: "synthetic-tools01-sonar" };

async function fixture(t, config = credentials) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-tool-errors-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	return {
		run(script) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), PI_CODING_AGENT_DIR: join(root, "agent") },
				input: `
					import assert from "node:assert/strict";
					import dns from "node:dns/promises";
					import { syncBuiltinESMExports } from "node:module";
					import { validateToolArguments } from ${JSON.stringify(new URL("node_modules/@earendil-works/pi-ai/dist/index.js", source).href)};
					dns.lookup = async hostname => hostname === "private.example.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
					syncBuiltinESMExports();
					const tools = new Map(), handlers = new Map(), requests = [];
					let respond = () => { throw new Error("Unexpected fixture network request"); };
					globalThis.fetch = async (url, init) => { const request = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined }; requests.push(request); return respond(request, init); };
					const rpc = (text, isError = false) => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } });
					(await import(new URL("index.ts", ${JSON.stringify(source)}))).default({ on(name, handler) { handlers.set(name, handler); }, registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); } });
					async function call(name, args, signal) {
						const tool = tools.get(name), prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
						return tool.execute("fixture", validateToolArguments(tool, { type: "toolCall", id: "fixture", name, arguments: prepared }), signal);
					}
					try { ${script} } finally { await handlers.get("session_shutdown")?.(); }
				`,
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return JSON.parse(child.stdout);
		},
	};
}

test("missing and blank executable queries are tool errors without network work", async t => {
	for (const [name, args] of [["web_search", {}], ["web_search", { query: " \t " }], ["code_search", { query: " \t " }]]) await t.test(JSON.stringify([name, args]), async t => {
		const f = await fixture(t);
		const found = f.run(`const result = await call(${JSON.stringify(name)}, ${JSON.stringify(args)}); console.log(JSON.stringify({ result, requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.error, "No query provided");
		assert.match(found.result.content[0].text, /No query provided/);
		assert.deepEqual(found.requests, []);
	});
});

test("omitted required code queries remain host validation failures", async t => {
	const f = await fixture(t);
	const found = f.run(`await assert.rejects(call("code_search", {})); console.log(JSON.stringify({ requests }));`);
	assert.deepEqual(found.requests, []);
});

test("single and all-failed web searches are errors for each retained provider path", async t => {
	for (const [label, config, provider, requestCount] of [
		["keyed Exa", credentials, "exa", 3],
		["Sonar", credentials, "perplexity", 3],
		["keyless MCP", {}, "exa", 3],
		["auto fallback exhausted", credentials, "auto", 6],
	]) await t.test(label, async t => {
		const f = await fixture(t, config);
		const found = f.run(`respond = () => new Response("Fixture provider failure", { status: 503 }); const results = []; for (const args of [{ query: "one" }, { queries: ["two", "three"] }]) results.push(await call("web_search", { ...args, provider: ${JSON.stringify(provider)} })); console.log(JSON.stringify({ results, requests }));`);
		for (const [i, result] of found.results.entries()) {
			assert.equal(result.isError, true);
			assert.equal(result.details.successfulQueries, 0);
			assert.equal(result.details.queryCount, i + 1);
			assert.equal(result.details.totalResults, 0);
			assert.deepEqual(result.details.urls, []);
			assert.match(result.content[0].text, /Error:[\s\S]*503/);
		}
		assert.equal(found.requests.length, requestCount);
	});
});

test("empty exception messages are still failed web queries", async t => {
	const f = await fixture(t);
	const found = f.run(`respond = () => { throw new Error(""); }; const results = []; for (const args of [{ query: "one" }, { queries: ["two", "three"] }]) results.push(await call("web_search", { ...args, provider: "exa" })); console.log(JSON.stringify({ results, requests }));`);
	for (const result of found.results) {
		assert.equal(result.isError, true);
		assert.equal(result.details.successfulQueries, 0);
		assert.match(result.content[0].text, /Error:/);
		assert.doesNotMatch(result.content[0].text, /No results found/);
	}
	assert.equal(found.requests.length, 3);
});

test("mixed web batches preserve success and failure in either order", async t => {
	for (const queries of [["failure", "success"], ["success", "failure"]]) await t.test(queries.join(","), async t => {
		const f = await fixture(t);
		const found = f.run(`respond = ({ body }) => body.query === "failure" ? new Response("Rejected query", { status: 503 }) : Response.json({ results: [{ title: "Successful source", url: "https://docs.example.test/success", text: "Useful content" }] }); console.log(JSON.stringify({ result: await call("web_search", { queries: ${JSON.stringify(queries)}, provider: "exa" }), requests }));`);
		assert.equal("isError" in found.result, false);
		assert.equal(found.result.details.successfulQueries, 1);
		assert.equal(found.result.details.queryCount, 2);
		assert.equal(found.result.details.totalResults, 1);
		assert.deepEqual(found.result.details.urls, ["https://docs.example.test/success"]);
		assert.match(found.result.content[0].text, /Rejected query/);
		assert.match(found.result.content[0].text, /Successful source/);
		assert.deepEqual(found.requests.map(({ body }) => body.query), queries);
	});
});

test("genuine empty and answer-only web successes are not tool errors", async t => {
	for (const [label, config, provider, response] of [
		["empty Exa", credentials, "exa", 'Response.json({ results: [] })'],
		["empty Sonar", credentials, "perplexity", 'Response.json({ choices: [{ message: { content: "" } }], citations: [] })'],
		["answer-only Sonar", credentials, "perplexity", 'Response.json({ choices: [{ message: { content: "Error: is legitimate answer text" } }], citations: [] })'],
		["empty MCP", {}, "exa", 'rpc(JSON.stringify({ results: [] }))'],
	]) await t.test(label, async t => {
		const f = await fixture(t, config);
		const found = f.run(`respond = () => ${response}; const result = await call("web_search", { queries: ["first", "second"], provider: ${JSON.stringify(provider)} }); console.log(JSON.stringify({ result, requests }));`);
		assert.equal("isError" in found.result, false);
		assert.equal(found.result.details.successfulQueries, 2);
		assert.equal(found.result.details.totalResults, 0);
		assert.equal(found.requests.length, 2);
		assert.match(found.result.content[0].text, label.startsWith("empty") ? /No results found/ : /Error: is legitimate answer text/);
	});
});

test("failed page enrichment does not turn a successful search into an error", async t => {
	const f = await fixture(t);
	const found = f.run(`respond = ({ url }) => new URL(url).hostname === "api.exa.ai" ? Response.json({ results: [{ title: "Found source", url: "https://docs.example.test/failure" }] }) : new Response("Forbidden", { status: 403 }); console.log(JSON.stringify({ result: await call("web_search", { query: "source", provider: "exa", includeContent: true }), requests }));`);
	assert.equal("isError" in found.result, false);
	assert.equal(found.result.details.successfulQueries, 1);
	assert.equal(found.result.details.totalResults, 1);
	assert.match(found.result.content[0].text, /Found source[\s\S]*Fetched Content[\s\S]*Error: HTTP 403/);
	assert.equal(found.requests.length, 2);
});

test("explicit fetch failures are marked without bypassing URL or challenge policy", async t => {
	for (const [label, url, response, message, count] of [
		["invalid URL", "not a URL", null, /Invalid URL/, 0],
		["invalid protocol", "file:///tmp/private", null, /Only HTTP and HTTPS/, 0],
		["private address", "https://private.example.test/", null, /private|blocked|not allowed/i, 0],
		["HTTP failure", "https://docs.example.test/forbidden", 'new Response("Forbidden", { status: 403 })', /HTTP 403/, 1],
		["Cloudflare challenge", "https://docs.example.test/challenge", 'new Response("<html><title>Just a moment...</title><body>challenge</body></html>", { headers: { "content-type": "text/html", "cf-mitigated": "challenge" } })', /Cloudflare|challenge/i, 1],
		["empty exception", "https://docs.example.test/empty-error", '(() => { throw new Error(""); })()', /^Error: $/, 1],
	]) await t.test(label, async t => {
		const f = await fixture(t);
		const found = f.run(`${response ? `respond = () => ${response};` : ""} console.log(JSON.stringify({ result: await call("fetch_content", { url: ${JSON.stringify(url)} }), requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.successful, 0);
		assert.match(found.result.content[0].text, message);
		assert.equal(found.requests.length, count);
	});
});

test("all-failed fetch batches include empty-message failures in their error count", async t => {
	for (const emptyMessage of [false, true]) await t.test(String(emptyMessage), async t => {
		const f = await fixture(t);
		const found = f.run(`respond = () => { ${emptyMessage ? 'throw new Error("");' : 'return new Response("Forbidden", { status: 403 });'} }; const result = await call("fetch_content", { urls: ["https://docs.example.test/first", "https://docs.example.test/second"] }); console.log(JSON.stringify({ result, requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.successful, 0);
		assert.equal(found.result.details.urlCount, 2);
		assert.equal(found.requests.length, 2);
		assert.equal((found.result.content[0].text.match(/: Error -/g) || []).length, 2);
	});
});

test("mixed and fully successful fetch batches preserve content and success shape", async t => {
	for (const paths of [["failure", "success"], ["success", "failure"], ["success", "other-success"]]) await t.test(paths.join(","), async t => {
		const f = await fixture(t);
		const found = f.run(`respond = ({ url }) => url.endsWith("/failure") ? new Response("Forbidden", { status: 403 }) : new Response("Error: is legitimate page text", { headers: { "content-type": "text/plain" } }); const result = await call("fetch_content", { urls: ${JSON.stringify(paths.map(path => "https://docs.example.test/" + path))} }); console.log(JSON.stringify({ result, requests }));`);
		assert.equal("isError" in found.result, false);
		assert.equal(found.result.details.successful, paths.filter(path => path !== "failure").length);
		assert.equal(found.result.details.urlCount, 2);
		assert.match(found.result.content[0].text, /Error: is legitimate page text/);
		if (paths.includes("failure")) assert.match(found.result.content[0].text, /Error - HTTP 403/);
		assert.equal(found.requests.length, 2);
	});
});

test("empty and error-looking single fetch successes remain successful", async t => {
	for (const empty of [false, true]) await t.test(String(empty), async t => {
		const f = await fixture(t);
		const found = f.run(`respond = () => new Response(${empty ? "null" : '"Error: is legitimate page text"'}, { status: ${empty ? 204 : 200}, headers: { "content-type": "text/plain" } }); console.log(JSON.stringify({ result: await call("fetch_content", { url: "https://docs.example.test/success" }), requests }));`);
		assert.equal("isError" in found.result, false);
		assert.equal(found.result.details.successful, 1);
		assert.equal(found.result.content[0].text, empty ? "" : "Error: is legitimate page text");
		assert.equal(found.requests.length, 1);
	});
});

test("code-context and fallback failures are tool errors", async t => {
	for (const mode of ["context", "fallback", "empty-message"]) await t.test(mode, async t => {
		const f = await fixture(t);
		const found = f.run(`respond = ({ body }) => { ${mode === "empty-message" ? 'throw new Error("");' : `${mode === "fallback" ? 'if (body.params.name === "get_code_context_exa") return rpc("Tool get_code_context_exa not found", true);' : ""} return rpc("Fixture code failure", true);`} }; console.log(JSON.stringify({ result: await call("code_search", { query: "library docs" }), requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.error, mode === "empty-message" ? "" : "Fixture code failure");
		assert.match(found.result.content[0].text, /^Error:/);
		assert.equal(found.requests.length, mode === "fallback" ? 2 : 1);
	});
});

test("normal and cached-fallback code successes retain error-looking content", async t => {
	for (const fallback of [false, true]) await t.test(String(fallback), async t => {
		const f = await fixture(t);
		const found = f.run(`respond = ({ body }) => ${fallback ? 'body.params.name === "get_code_context_exa" ? rpc("Tool get_code_context_exa not found", true) :' : ""} rpc("Error: is legitimate code documentation"); const results = [await call("code_search", { query: "library docs" }), await call("code_search", { query: "other library docs" })]; console.log(JSON.stringify({ results, requests }));`);
		for (const result of found.results) {
			assert.equal("isError" in result, false);
			assert.equal(result.content[0].text, "Error: is legitimate code documentation");
			assert.equal(result.details.mode, fallback ? "web-search-fallback" : "code-context");
		}
		assert.deepEqual(found.requests.map(({ body }) => body.params.name), fallback ? ["get_code_context_exa", "web_search_exa", "web_search_exa"] : ["get_code_context_exa", "get_code_context_exa"]);
	});
});

test("caller cancellation still rejects web/code work and stops later queries", async t => {
	for (const name of ["web_search", "code_search"]) await t.test(name, async t => {
		const f = await fixture(t);
		const found = f.run(`const controller = new AbortController(), reason = new Error("Abort fixture request"); respond = () => { controller.abort(reason); throw reason; }; await assert.rejects(call(${JSON.stringify(name)}, ${JSON.stringify(name === "web_search" ? { queries: ["first", "must not run"], provider: "exa" } : { query: "library docs" })}, controller.signal), /Abort fixture request/); console.log(JSON.stringify({ requests }));`);
		assert.equal(found.requests.length, 1);
	});
});

test("aborted fetch calls keep their explicit failure result without requests", async t => {
	const f = await fixture(t);
	const found = f.run(`const controller = new AbortController(); controller.abort(); console.log(JSON.stringify({ result: await call("fetch_content", { url: "https://docs.example.test/unused" }, controller.signal), requests }));`);
	assert.equal(found.result.isError, true);
	assert.equal(found.result.details.successful, 0);
	assert.match(found.result.content[0].text, /Aborted/);
	assert.deepEqual(found.requests, []);
});

test("credential errors fail closed and flagged provider failures redact resolved keys", async t => {
	await t.test("no fallback after explicit credential failure", async t => {
		const f = await fixture(t, { ...credentials, exaApiKey: "$TOOLS01_MISSING_KEY" });
		const found = f.run(`console.log(JSON.stringify({ result: await call("web_search", { query: "private query", provider: "auto" }), requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.successfulQueries, 0);
		assert.deepEqual(found.requests, []);
	});
	for (const provider of ["exa", "perplexity"]) await t.test(provider, async t => {
		const f = await fixture(t);
		const found = f.run(`respond = () => new Response(${JSON.stringify(provider === "exa" ? credentials.exaApiKey : credentials.perplexityApiKey)}, { status: 401 }); console.log(JSON.stringify({ result: await call("web_search", { query: "private query", provider: ${JSON.stringify(provider)} }), requests }));`);
		assert.equal(found.result.isError, true);
		assert.equal(found.result.details.successfulQueries, 0);
		assert.doesNotMatch(JSON.stringify(found.result), /synthetic-tools01/);
		assert.match(found.result.content[0].text, /401/);
		assert.equal(found.requests.length, 1);
	});
});
