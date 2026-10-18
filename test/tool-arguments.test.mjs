import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-tool-arguments-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home"), bin = join(root, "bin"), commands = join(root, "commands.jsonl");
	await Promise.all([mkdir(join(home, ".pi"), { recursive: true }), mkdir(bin)]);
	await symlink(process.execPath, join(bin, "node"));
	const resolver = join(root, "credential.mjs");
	await writeFile(resolver, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(commands)}, "exa\\n"); process.stdout.write("synthetic-arguments-key");`);
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ exaApiKey: `!node ${JSON.stringify(resolver)}` }));
	return {
		commands: () => existsSync(commands) ? readFileSync(commands, "utf8").trim().split("\n") : [],
		run(script) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: bin, PI_CODING_AGENT_DIR: join(home, "agent") },
				input: `
					import assert from "node:assert/strict";
					import dns from "node:dns/promises";
					import { registerHooks, syncBuiltinESMExports } from "node:module";
					import { validateToolArguments } from ${JSON.stringify(new URL("node_modules/@earendil-works/pi-ai/dist/index.js", source).href)};
					import { Value } from ${JSON.stringify(new URL("node_modules/typebox/build/value/index.mjs", source).href)};
					const requests = [], tools = new Map(), handlers = new Map();
					dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
					syncBuiltinESMExports();
					globalThis.fetch = async (url, init) => {
						const target = new URL(url);
						if (target.hostname === "api.exa.ai") {
							const body = JSON.parse(init.body); requests.push({ url: String(url), body });
							return Response.json({ results: [{ title: body.query, url: "https://docs.example.test/" + encodeURIComponent(body.query), text: "Inline " + body.query }] });
						}
						assert.equal(target.hostname, "docs.example.test", "Unexpected fixture network destination");
						requests.push({ url: String(url) });
						return new Response("# Fixture document\\n\\nOwned content", { headers: { "content-type": "text/plain" } });
					};
					(await import(new URL("index.ts", ${JSON.stringify(source)}))).default({
						on(name, handler) { handlers.set(name, handler); }, registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); },
					});
					const theme = { fg: (_name, text) => text, bold: text => text };
					const render = (name, args) => tools.get(name).renderCall(args, theme).render(160).map(line => line.trimEnd()).join("\\n");
					const prepare = args => { const tool = tools.get("web_search"); assert.equal(typeof tool.prepareArguments, "function", "web_search must prepare retained arrays before validation"); return tool.prepareArguments(args); };
					async function call(name, args, signal, onUpdate) {
						const tool = tools.get(name), prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
						return tool.execute("fixture", validateToolArguments(tool, { type: "toolCall", id: "fixture", name, arguments: prepared }), signal, onUpdate);
					}
					try { ${script} } finally { await handlers.get("session_shutdown")?.(); }
				`,
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return JSON.parse(child.stdout);
		},
	};
}

test("fetch_content execute and render share URL fallback, trimming, stable deduplication and precedence", async t => {
	const one = "https://docs.example.test/one", two = "https://docs.example.test/two";
	for (const [params, urls] of [
		[{ url: `  ${one}  `, urls: [] }, [one]],
		[{ url: ` ${one} `, urls: ["", "  "] }, [one]],
		[{ url: ` ${one} ` }, [one]],
		[{ url: one, urls: [` ${two} `, two, "", ` ${one} `, one] }, [two, one]],
		[{ url: one, urls: [two] }, [two]],
		[{ urls: [one, one + "/", "https://docs.example.test/One"] }, [one, one + "/", "https://docs.example.test/One"]],
	]) await t.test(JSON.stringify(params), async t => {
		const f = await fixture(t);
		const found = f.run(`const params = ${JSON.stringify(params)}; console.log(JSON.stringify({ rendered: render("fetch_content", params), result: await call("fetch_content", params), requests }));`);
		assert.deepEqual(found.result.details.urls, urls);
		assert.equal(found.result.details.successful, urls.length);
		assert.deepEqual(found.requests.map(request => request.url), urls);
		assert.equal(found.rendered, "fetch " + (urls.length === 1 ? urls[0] : `${urls.length} URLs`));
		assert.deepEqual(f.commands(), []);
	});
});

test("empty fetch URLs return the existing error without loading extraction or doing I/O", async t => {
	for (const params of [{}, { urls: [] }, { url: "  ", urls: ["", " "] }]) await t.test(JSON.stringify(params), async t => {
		const f = await fixture(t);
		const found = f.run(`
			const hook = registerHooks({ resolve(specifier, context, next) { if (specifier.endsWith("/extract.ts")) throw new Error("Empty fetch eagerly loaded extraction"); return next(specifier, context); } });
			try { let updates = 0; const params = ${JSON.stringify(params)}; const result = await call("fetch_content", params, undefined, () => updates++); console.log(JSON.stringify({ result, updates, requests, rendered: render("fetch_content", params) })); } finally { hook.deregister(); }
		`);
		assert.deepEqual(found.result, { content: [{ type: "text", text: "Error: No URL provided. Use 'url' or 'urls'." }], details: { error: "No URL provided" }, isError: true });
		assert.equal(found.rendered, "fetch (no URL)");
		assert.equal(found.updates, 0);
		assert.deepEqual(found.requests, []);
		assert.deepEqual(f.commands(), []);
	});
});

test("renderers tolerate partial malformed fields without I/O and forceClone remains a boolean schema", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const fetchInputs = [{}, { urls: "[]" }, { url: 5, urls: null }, { urls: [null, 4, "  "] }];
		const searchInputs = [{}, { query: 5 }, { queries: [null, {}] }];
		const schema = tools.get("fetch_content").parameters;
		console.log(JSON.stringify({ fetch: fetchInputs.map(args => render("fetch_content", args)), search: searchInputs.map(args => render("web_search", args)), booleans: [true, false, "true", 1, null].map(forceClone => Value.Check(schema, { forceClone })), requests, tools: [...tools.keys()] }));
	`);
	assert.deepEqual(found.fetch, Array(4).fill("fetch (no URL)"));
	assert.deepEqual(found.search, Array(3).fill("search (no query)"));
	assert.deepEqual(found.booleans, [true, true, false, false, false]);
	assert.deepEqual(found.tools, ["web_search", "code_search", "fetch_content"]);
	assert.deepEqual(found.requests, []);
	assert.deepEqual(f.commands(), []);
});

test("singular string-only JSON arrays expand serially with rendering, duplicates, filters and inline content intact", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const params = { query: '  [" alpha ", "", " beta ", "alpha", "  "]  ', provider: "exa", numResults: 2, recencyFilter: "week", domainFilter: ["docs.example.test", "-spam.example.test"], includeContent: true };
		let active = 0, maximum = 0; const fetch = globalThis.fetch;
		globalThis.fetch = async (...args) => { maximum = Math.max(maximum, ++active); try { return await fetch(...args); } finally { active--; } };
		console.log(JSON.stringify({ result: await call("web_search", params), rendered: render("web_search", params), requests, maximum }));
	`);
	assert.deepEqual(found.result.details.queries, ["alpha", "beta", "alpha"]);
	assert.equal(found.result.details.successfulQueries, 3);
	assert.deepEqual(found.requests.map(request => request.body.query), ["alpha", "beta", "alpha"]);
	assert.equal(found.maximum, 1);
	for (const { body } of found.requests) {
		assert.equal(body.numResults, 2);
		assert.deepEqual(body.includeDomains, ["docs.example.test"]);
		assert.deepEqual(body.excludeDomains, ["spam.example.test"]);
		assert.ok(body.startPublishedDate);
		assert.deepEqual(body.contents, { text: true, highlights: true });
	}
	assert.equal(found.rendered, "search 3 queries");
	assert.match(found.result.content[0].text, /## Fetched Content[\s\S]*Inline alpha[\s\S]*Inline beta[\s\S]*Inline alpha/);
	assert.deepEqual(f.commands(), ["exa", "exa", "exa"]);
});

test("singular mixed, non-array and malformed JSON queries remain literal text", async t => {
	for (const query of ['["alpha", 5]', '["alpha", null]', '[true]', '[{}]', '[["alpha"]]', '["broken",]', '[not JSON', '{"query":"alpha"}', '"alpha"', ' ordinary query ']) await t.test(query, async t => {
		const f = await fixture(t);
		const found = f.run(`const params = { query: ${JSON.stringify(query)}, provider: "exa" }; console.log(JSON.stringify({ result: await call("web_search", params), rendered: render("web_search", params), requests }));`);
		assert.deepEqual(found.result.details.queries, [query.trim()]);
		assert.deepEqual(found.requests.map(request => request.body.query), [query.trim()]);
		assert.equal(found.rendered, "search " + query.trim());
	});
});

test("structured plural queries retain precedence, literal JSON members and duplicates", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const params = { query: '["ignored"]', queries: [' ["alpha", "beta"] ', "same", "same"], provider: "exa" };
		console.log(JSON.stringify({ result: await call("web_search", params), rendered: render("web_search", params), requests }));
	`);
	assert.deepEqual(found.result.details.queries, ['["alpha", "beta"]', "same", "same"]);
	assert.deepEqual(found.requests.map(request => request.body.query), found.result.details.queries);
	assert.equal(found.rendered, "search 3 queries");
});

test("empty singular JSON arrays and empty plural precedence start no search or credentials", async t => {
	for (const params of [{ query: "[]" }, { query: '["  ", ""]' }, { query: "ignored", queries: [] }]) await t.test(JSON.stringify(params), async t => {
		const f = await fixture(t);
		const found = f.run(`const params = ${JSON.stringify(params)}; console.log(JSON.stringify({ result: await call("web_search", params), rendered: render("web_search", params), requests }));`);
		assert.deepEqual(found.result, { content: [{ type: "text", text: "Error: No query provided." }], details: { error: "No query provided" }, isError: true });
		assert.equal(found.rendered, "search (no query)");
		assert.deepEqual(found.requests, []);
		assert.deepEqual(f.commands(), []);
	});
});

test("retained stringified arrays are prepared before validation without mutating input or other fields", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const input = Object.freeze({ query: "ignored", queries: '[" alpha ", "beta"]', domainFilter: '["docs.example.test", "-spam.example.test"]', provider: "exa", numResults: 1, includeContent: true, recencyFilter: "day" });
		const prepared = prepare(input), unchanged = Object.freeze({ query: "literal", queries: Object.freeze(["structured"]), provider: "exa" });
		assert.equal(prepare(unchanged), unchanged);
		const result = await call("web_search", input);
		console.log(JSON.stringify({ input, prepared, result, rendered: render("web_search", prepared), rawRendered: render("web_search", input), requests }));
	`);
	assert.equal(typeof found.input.queries, "string");
	assert.equal(typeof found.input.domainFilter, "string");
	assert.deepEqual(found.prepared, { ...found.input, queries: [" alpha ", "beta"], domainFilter: ["docs.example.test", "-spam.example.test"] });
	assert.deepEqual(found.result.details.queries, ["alpha", "beta"]);
	assert.equal(found.rendered, "search 2 queries");
	assert.equal(found.rawRendered, found.rendered);
	assert.deepEqual(found.requests.map(request => request.body.query), ["alpha", "beta"]);
	for (const { body } of found.requests) assert.deepEqual(body.includeDomains, ["docs.example.test"]);
});

test("single expanded queries render trimmed text and decoded empty lists retain plural precedence", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const single = { query: '["  solo  "]', provider: "exa" };
		const empty = { query: "ignored", queries: "[]", domainFilter: "[]", provider: "exa" };
		const singleResult = await call("web_search", single), emptyResult = await call("web_search", empty);
		const domainOnly = Object.freeze({ queries: Object.freeze(["structured"]), domainFilter: '["docs.example.test"]', provider: "exa", urls: '["untouched"]' });
		const domainPrepared = prepare(domainOnly);
		console.log(JSON.stringify({ singleResult, singleRender: render("web_search", single), emptyResult, emptyRender: render("web_search", empty), domainOnly, domainPrepared, requests }));
	`);
	assert.deepEqual(found.singleResult.details.queries, ["solo"]);
	assert.equal(found.singleRender, "search solo");
	assert.equal(found.emptyResult.details.error, "No query provided");
	assert.equal(found.emptyRender, "search (no query)");
	assert.deepEqual(found.domainPrepared, { ...found.domainOnly, domainFilter: ["docs.example.test"] });
	assert.deepEqual(found.requests.map(request => request.body.query), ["solo"]);
	assert.deepEqual(f.commands(), ["exa"]);
});

test("malformed retained stringified arrays identify the field and never start work", async t => {
	for (const key of ["queries", "domainFilter"]) await t.test(key, async t => {
		const f = await fixture(t);
		const found = f.run(`
			const key = ${JSON.stringify(key)}, args = { query: "must not run", provider: "exa", [key]: "  [not JSON" };
			let error; try { await call("web_search", args); } catch (failure) { error = failure.message; }
			console.log(JSON.stringify({ error, requests }));
		`);
		assert.equal(found.error, `${key} must be an array of strings; the given value is not valid JSON`);
		assert.deepEqual(found.requests, []);
		assert.deepEqual(f.commands(), []);
	});
});

test("wrong stringified-array shapes, provider arrays and invalid roots fail closed", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const outcomes = [];
		for (const key of ["queries", "domainFilter"]) for (const value of ['["ok", 1]', '[null]', '[true]', '[{}]', '[["nested"]]', '{"not":"array"}', '"text"', "example.test", 7, {}]) {
			const args = { query: "must not run", provider: "exa", [key]: value };
			try { await call("web_search", args); outcomes.push({ key, value, rejected: false }); } catch { outcomes.push({ key, value, rejected: true }); }
		}
		for (const provider of [['exa'], '["exa"]']) { try { await call("web_search", { query: "must not run", provider }); outcomes.push({ provider, rejected: false }); } catch { outcomes.push({ provider, rejected: true }); } }
		for (const root of [null, [], 4, "text", true]) { try { await call("web_search", root); outcomes.push({ root, rejected: false }); } catch { outcomes.push({ root, rejected: true }); } }
		console.log(JSON.stringify({ outcomes, requests }));
	`);
	assert.ok(found.outcomes.every(outcome => outcome.rejected), JSON.stringify(found.outcomes));
	assert.deepEqual(found.requests, []);
	assert.deepEqual(f.commands(), []);
});

test("numResults schema enforces the documented integer request range, not a citation output ceiling", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const schema = tools.get("web_search").parameters;
		const values = [1, 20, 0, -1, 21, 1.5, "2", true, null, NaN, Infinity, -Infinity];
		const checks = values.map(numResults => Value.Check(schema, { query: "range", numResults }));
		const defaults = await call("web_search", { query: "default", provider: "exa" });
		for (const numResults of [1, 20]) await call("web_search", { query: "endpoint", provider: "exa", numResults });
		const rejected = [];
		for (const numResults of [0, -1, 21, 1.5, "invalid"]) { try { await call("web_search", { query: "must not run", provider: "exa", numResults }); rejected.push(false); } catch { rejected.push(true); } }
		console.log(JSON.stringify({ checks, omitted: Value.Check(schema, { query: "default" }), description: schema.properties.numResults.description, rejected, requests }));
	`);
	assert.deepEqual(found.checks, [true, true, false, false, false, false, false, false, false, false, false, false]);
	assert.equal(found.omitted, true);
	assert.match(found.description, /Sonar keeps additional cited sources/);
	assert.deepEqual(found.rejected, Array(5).fill(true));
	assert.deepEqual(found.requests.map(request => request.body.numResults), [5, 1, 20]);
	assert.deepEqual(f.commands(), ["exa", "exa", "exa"]);
});

test("expanded-query cancellation still stops later queries before credential work", async t => {
	const f = await fixture(t);
	const found = f.run(`
		const controller = new AbortController(), reason = new Error("Stopped expanded query");
		let updates = 0, same = false;
		try { await call("web_search", { query: '["first", "must not run"]', provider: "exa" }, controller.signal, () => { if (++updates === 2) controller.abort(reason); }); } catch (error) { same = error === reason; }
		console.log(JSON.stringify({ same, updates, requests }));
	`);
	assert.equal(found.same, true);
	assert.equal(found.updates, 2);
	assert.deepEqual(found.requests.map(request => request.body.query), ["first"]);
	assert.deepEqual(f.commands(), ["exa"]);
});
