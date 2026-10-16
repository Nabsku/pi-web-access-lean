import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const bothKeys = { exaApiKey: "!fixture", perplexityApiKey: "!fixture" };

async function fixture(t, config = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-search-routing-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home"), bin = join(root, "bin"), commands = join(root, "commands.jsonl");
	await Promise.all([mkdir(join(home, ".pi"), { recursive: true }), mkdir(bin)]);
	await symlink(process.execPath, join(bin, "node"));
	const resolver = join(root, "credential.mjs");
	await writeFile(resolver, `import { appendFileSync } from "node:fs"; const provider = process.argv[2]; appendFileSync(${JSON.stringify(commands)}, provider + "\\n"); process.stdout.write("synthetic-" + provider + "-routing-key");`);
	config = { ...config };
	for (const provider of ["exa", "perplexity"]) if (config[provider + "ApiKey"] === "!fixture") config[provider + "ApiKey"] = `!node ${JSON.stringify(resolver)} ${provider}`;
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	return {
		commands: () => existsSync(commands) ? readFileSync(commands, "utf8").trim().split("\n") : [],
		run(script) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: bin, PI_CODING_AGENT_DIR: join(home, "agent") },
				input: `
					const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
					const requests = [];
					const rpc = text => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
					const exa = (results = []) => Response.json({ results });
					const perplexity = (answer = "", citations = []) => Response.json({ choices: [{ message: { content: answer } }], citations });
					let respond = () => { throw new Error("Unexpected fixture network request"); };
					globalThis.fetch = async (url, init) => {
						const host = new URL(url).hostname, body = JSON.parse(init.body);
						const query = host === "api.perplexity.ai" ? body.messages[0].content : host === "mcp.exa.ai" ? body.params.arguments.query : body.query;
						requests.push({ host, query, ...(body.params ? { tool: body.params.name } : {}) });
						return respond({ host, query, body, init });
					};
					const { search } = await load("search");
					const failure = error => ({ name: error?.name, message: error instanceof Error ? error.message : String(error) });
					async function attempt(run, expected) { try { return { value: await run() }; } catch (error) { return { error: failure(error), same: error === expected }; } }
					async function web(params, signal, onUpdate) {
						const tools = [];
						(await load("index")).default({ on() {}, registerShortcut() {}, registerTool(tool) { tools.push(tool); } });
						return tools.find(tool => tool.name === "web_search").execute("fixture", params, signal, onUpdate);
					}
					${script}
				`,
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return JSON.parse(child.stdout);
		},
	};
}

test("named keyless Exa failures never reach Perplexity or its credential command", async t => {
	for (const kind of ["http", "rpc", "transport", "unparseable"]) await t.test(kind, async t => {
		const f = await fixture(t, { perplexityApiKey: "!fixture" });
		const found = f.run(`
			respond = ({ host }) => {
				if (host === "api.perplexity.ai") return perplexity("unwanted fallback");
				const kind = ${JSON.stringify(kind)};
				if (kind === "http") return new Response("MCP unavailable", { status: 503 });
				if (kind === "rpc") return Response.json({ error: { code: -32603, message: "Remote tool failure" } });
				if (kind === "transport") throw new TypeError("Network fixture failure");
				return rpc("No parseable sources");
			};
			console.log(JSON.stringify({ result: await attempt(() => search("strict", { provider: "exa" })), requests }));
		`);
		assert.ok(found.result.error, "named Exa must report its failure, not another provider's answer");
		assert.deepEqual(found.requests.map(r => r.host), ["mcp.exa.ai"]);
		assert.deepEqual(f.commands(), []);
		if (kind === "unparseable") assert.match(found.result.error.message, /Exa search returned no results/);
	});
});

test("configured named providers stay strict and explicit choices retain precedence", async t => {
	for (const [label, config, options] of [
		["configured", { searchProvider: " ExA " }, {}],
		["explicit auto honors configuration", { searchProvider: "exa" }, { provider: "auto" }],
		["legacy provider alias", { provider: "exa" }, {}],
		["explicit Exa overrides Perplexity config", { searchProvider: "perplexity" }, { provider: "exa" }],
	]) await t.test(label, async t => {
		const f = await fixture(t, { ...config, perplexityApiKey: "!fixture" });
		const found = f.run(`
			respond = ({ host }) => host === "mcp.exa.ai" ? new Response("Named Exa failure", { status: 503 }) : perplexity("unwanted fallback");
			console.log(JSON.stringify({ result: await attempt(() => search("configured", ${JSON.stringify(options)})), requests }));
		`);
		assert.ok(found.result.error);
		assert.deepEqual(found.requests.map(r => r.host), ["mcp.exa.ai"]);
		assert.deepEqual(f.commands(), []);
	});
});

test("named providers return valid empty success without switching providers", async t => {
	for (const mode of ["keyed", "keyless", "perplexity"]) await t.test(mode, async t => {
		const config = mode === "keyless" ? { perplexityApiKey: "!fixture" } : bothKeys;
		const f = await fixture(t, config);
		const provider = mode === "perplexity" ? "perplexity" : "exa";
		const found = f.run(`
			respond = ({ host }) => host === "mcp.exa.ai" ? rpc(JSON.stringify({ results: [] })) : host === "api.exa.ai" ? exa() : perplexity();
			const result = await search("empty named", { provider: ${JSON.stringify(provider)}, includeContent: true });
			console.log(JSON.stringify({ result, requests }));
		`);
		assert.deepEqual(found.result, { answer: "", results: [], provider });
		assert.equal(found.requests.length, 1);
		assert.deepEqual(f.commands(), mode === "keyless" ? [] : [provider]);
	});
});

test("strict Exa still permits its own advanced-to-basic missing-tool fallback", async t => {
	const f = await fixture(t, { perplexityApiKey: "!fixture" });
	const found = f.run(`
		respond = ({ host, body }) => {
			if (host === "api.perplexity.ai") return perplexity("unwanted fallback");
			return body.params.name === "web_search_advanced_exa"
				? Response.json({ error: { code: -32602, message: "Tool web_search_advanced_exa not found" } })
				: rpc("Title: Basic\\nURL: https://example.com/basic\\nText: Basic text");
		};
		console.log(JSON.stringify({ result: await search("internal fallback", { provider: "exa", domainFilter: ["example.com"] }), requests }));
	`);
	assert.equal(found.result.provider, "exa");
	assert.deepEqual(found.requests.map(r => r.tool), ["web_search_advanced_exa", "web_search_exa"]);
	assert.deepEqual(f.commands(), []);
});

test("registered named Exa reports its own failure instead of a Perplexity answer", async t => {
	const f = await fixture(t, { perplexityApiKey: "!fixture" });
	const found = f.run(`
		respond = ({ host }) => host === "mcp.exa.ai" ? new Response("Named MCP failure", { status: 503 }) : perplexity("unwanted fallback");
		console.log(JSON.stringify({ result: await web({ query: "strict tool", provider: "exa" }), requests }));
	`);
	assert.equal(found.result.details.successfulQueries, 0);
	assert.match(found.result.content[0].text, /Named MCP failure/);
	assert.doesNotMatch(found.result.content[0].text, /unwanted fallback/);
	assert.deepEqual(found.requests.map(r => r.host), ["mcp.exa.ai"]);
	assert.deepEqual(f.commands(), []);
});

test("only auto falls through keyed/keyless empty success and keeps the first final empty", async t => {
	for (const mode of ["keyed", "keyless"]) {
		for (const scenario of ["answer", "sources", "both empty", "later failure", "no Perplexity"]) await t.test(`${mode}: ${scenario}`, async t => {
			const config = { ...(mode === "keyed" ? { exaApiKey: "!fixture" } : {}), ...(scenario !== "no Perplexity" ? { perplexityApiKey: "!fixture" } : {}) };
			const f = await fixture(t, config);
			const found = f.run(`
				respond = ({ host }) => {
					if (host === "api.exa.ai") return exa();
					if (host === "mcp.exa.ai") return rpc(JSON.stringify({ results: [] }));
					const scenario = ${JSON.stringify(scenario)};
					if (scenario === "answer") return perplexity("Useful answer");
					if (scenario === "sources") return perplexity("", ["https://example.com/source"]);
					if (scenario === "later failure") return new Response("Remote failure", { status: 503 });
					return perplexity("   ");
				};
				console.log(JSON.stringify({ result: await search("empty auto", { provider: "auto", includeContent: true }), requests }));
			`);
			assert.deepEqual(found.requests.map(r => r.host), [mode === "keyed" ? "api.exa.ai" : "mcp.exa.ai", ...(scenario !== "no Perplexity" ? ["api.perplexity.ai"] : [])]);
			assert.deepEqual(f.commands(), [...(mode === "keyed" ? ["exa"] : []), ...(scenario !== "no Perplexity" ? ["perplexity"] : [])]);
			if (scenario === "answer") assert.deepEqual(found.result, { answer: "Useful answer", results: [], provider: "perplexity" });
			else if (scenario === "sources") assert.deepEqual(found.result.results, [{ title: "Source 1", url: "https://example.com/source", snippet: "" }]);
			else assert.deepEqual(found.result, { answer: "", results: [], provider: "exa" });
		});
	}
});

test("auto source-only Exa success stops fallback even without an answer", async t => {
	const f = await fixture(t, bothKeys);
	const found = f.run(`
		respond = ({ host }) => host === "api.exa.ai" ? exa([{ title: "Source", url: "https://example.com/source" }]) : perplexity("unwanted fallback");
		console.log(JSON.stringify({ result: await search("source only"), requests }));
	`);
	assert.equal(found.result.provider, "exa");
	assert.equal(found.result.answer, "");
	assert.equal(found.result.results.length, 1);
	assert.deepEqual(f.commands(), ["exa"]);
	assert.deepEqual(found.requests.map(r => r.host), ["api.exa.ai"]);
});

test("auto ordinary failures still fall through, but all failures retain diagnostics", async t => {
	for (const scenario of ["empty Perplexity", "all fail"]) await t.test(scenario, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			respond = ({ host }) => host === "api.perplexity.ai" && ${JSON.stringify(scenario)} === "empty Perplexity" ? perplexity() : new Response(host + " unavailable", { status: 503 });
			console.log(JSON.stringify({ result: await attempt(() => search("ordinary failures")), requests }));
		`);
		assert.deepEqual(f.commands(), ["exa", "perplexity"]);
		if (scenario === "empty Perplexity") assert.deepEqual(found.result.value, { answer: "", results: [], provider: "perplexity" });
		else assert.match(found.result.error.message, /Auto provider search failed:[\s\S]*Exa:.*503[\s\S]*Perplexity:.*503/);
	});
});

test("pre-aborted direct routes do no provider or credential work and preserve custom reason", async t => {
	for (const provider of ["auto", "exa", "perplexity"]) await t.test(provider, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			const caller = new AbortController(), reason = new Error("Stopped fixture"); caller.abort(reason);
			respond = ({ init }) => { init.signal.throwIfAborted(); return exa(); };
			console.log(JSON.stringify({ result: await attempt(() => search("pre-aborted", { provider: ${JSON.stringify(provider)}, signal: caller.signal }), reason), requests }));
		`);
		assert.equal(found.result.same, true);
		assert.deepEqual(found.requests, []);
		assert.deepEqual(f.commands(), []);
	});
});

test("cancellation after empty Exa or during fallback wins over the saved empty result", async t => {
	for (const phase of ["Exa body", "Perplexity fetch", "Perplexity named abort"]) await t.test(phase, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			const caller = new AbortController(), reason = ${JSON.stringify(phase)} === "Perplexity named abort" ? new DOMException("Cancelled fixture", "AbortError") : new Error("Stopped fixture");
			respond = ({ host }) => {
				if (host === "api.exa.ai") {
					const response = exa(), original = response.json.bind(response);
					if (${JSON.stringify(phase)} === "Exa body") response.json = async () => { const data = await original(); caller.abort(reason); return data; };
					return response;
				}
				if (${JSON.stringify(phase)} !== "Perplexity named abort") caller.abort(reason);
				throw reason;
			};
			console.log(JSON.stringify({ result: await attempt(() => search("cancel empty", { signal: caller.signal }), reason), requests }));
		`);
		assert.equal(found.result.same, true);
		assert.deepEqual(f.commands(), phase === "Exa body" ? ["exa"] : ["exa", "perplexity"]);
		assert.equal(found.requests.length, phase === "Exa body" ? 1 : 2);
	});
});

test("batch cancellation before work or from progress starts no credential commands", async t => {
	for (const phase of ["before", "progress"]) await t.test(phase, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			const caller = new AbortController(), reason = new Error("Stopped fixture");
			if (${JSON.stringify(phase)} === "before") caller.abort(reason);
			respond = ({ init }) => { init.signal.throwIfAborted(); return exa(); };
			let updates = 0;
			const result = await attempt(() => web({ queries: ["first", "second"], provider: "auto" }, caller.signal, () => { updates++; caller.abort(reason); }), reason);
			console.log(JSON.stringify({ result, requests, updates }));
		`);
		assert.equal(found.result.same, true);
		assert.equal(found.updates, phase === "before" ? 0 : 1);
		assert.deepEqual(found.requests, []);
		assert.deepEqual(f.commands(), []);
	});
});

test("mid-query batch cancellation stops later queries and fallback credential commands", async t => {
	for (const provider of ["auto", "exa", "perplexity"]) await t.test(provider, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			const caller = new AbortController(), reason = new Error("Stopped fixture");
			respond = () => { caller.abort(reason); throw reason; };
			const result = await attempt(() => web({ queries: ["first", "second", "third"], provider: ${JSON.stringify(provider)} }, caller.signal), reason);
			console.log(JSON.stringify({ result, requests }));
		`);
		assert.equal(found.result.same, true);
		assert.deepEqual(found.requests.map(r => r.query), ["first"]);
		assert.deepEqual(f.commands(), [provider === "perplexity" ? "perplexity" : "exa"]);
	});
});

test("named and message-based abort errors stop auto routing and batch execution", async t => {
	for (const kind of ["named", "message", "string"]) await t.test(kind, async t => {
		const f = await fixture(t, bothKeys);
		const found = f.run(`
			const kind = ${JSON.stringify(kind)};
			const reason = kind === "named" ? new DOMException("Cancelled fixture", "AbortError") : kind === "message" ? new Error("Request aborted fixture") : "Aborted fixture";
			respond = () => { throw reason; };
			console.log(JSON.stringify({ result: await attempt(() => web({ queries: ["first", "second"], provider: "auto" }), reason), requests }));
		`);
		assert.equal(found.result.same, true);
		if (kind === "named") assert.equal(found.result.error.name, "AbortError");
		assert.deepEqual(found.requests.map(r => r.query), ["first"]);
		assert.deepEqual(f.commands(), ["exa"]);
	});
});

test("cancellation between batch queries does not return a successful partial batch", async t => {
	const f = await fixture(t, bothKeys);
	const found = f.run(`
		const caller = new AbortController(), reason = new Error("Stopped fixture");
		let updates = 0;
		respond = () => exa([{ title: "First", url: "https://example.com/first" }]);
		const result = await attempt(() => web({ queries: ["first", "second", "third"], provider: "exa" }, caller.signal, () => { if (++updates === 2) caller.abort(reason); }), reason);
		console.log(JSON.stringify({ result, requests, updates }));
	`);
	assert.equal(found.result.same, true);
	assert.equal(found.updates, 2);
	assert.deepEqual(found.requests.map(r => r.query), ["first"]);
	assert.deepEqual(f.commands(), ["exa"]);
});

test("ordinary batch errors preserve query/source/content order and URL deduplication", async t => {
	const f = await fixture(t, bothKeys);
	const found = f.run(`
		respond = ({ query }) => {
			if (query === "broken") return new Response("Ordinary failure", { status: 503 });
			return exa(query === "alpha" ? [{ title: "Alpha", url: "https://example.com/shared", text: "Alpha body" }] : [{ title: "Shared", url: "https://example.com/shared", text: "Shared omega" }, { title: "Omega", url: "https://example.com/omega", text: "Omega body" }]);
		};
		console.log(JSON.stringify({ result: await web({ queries: ["alpha", "broken", "omega"], provider: "exa", includeContent: true }), requests }));
	`);
	assert.deepEqual(found.requests.map(r => r.query), ["alpha", "broken", "omega"]);
	assert.deepEqual(f.commands(), ["exa", "exa", "exa"]);
	assert.deepEqual(found.result.details, { queries: ["alpha", "broken", "omega"], queryCount: 3, successfulQueries: 2, totalResults: 3, urls: ["https://example.com/shared", "https://example.com/omega"] });
	const text = found.result.content[0].text;
	assert.ok(text.indexOf('## Query: "alpha"') < text.indexOf('## Query: "broken"'));
	assert.ok(text.indexOf('## Query: "broken"') < text.indexOf('## Query: "omega"'));
	assert.match(text, /Ordinary failure/);
	const inline = text.slice(text.indexOf("## Fetched Content"));
	assert.ok(inline.indexOf("Alpha body") < inline.indexOf("Shared omega"));
	assert.ok(inline.indexOf("Shared omega") < inline.indexOf("Omega body"));
});

test("registered auto empty success remains a successful query without invented sources", async t => {
	const f = await fixture(t, bothKeys);
	const found = f.run(`
		respond = ({ host }) => host === "api.exa.ai" ? exa() : perplexity();
		console.log(JSON.stringify({ result: await web({ query: "empty tool", provider: "auto" }), requests }));
	`);
	assert.equal(found.result.details.successfulQueries, 1);
	assert.equal(found.result.details.totalResults, 0);
	assert.deepEqual(found.result.details.urls, []);
	assert.match(found.result.content[0].text, /No results found/);
	assert.deepEqual(f.commands(), ["exa", "perplexity"]);
});
