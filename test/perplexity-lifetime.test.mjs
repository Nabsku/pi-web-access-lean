import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;

async function fixture(t, config = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-perplexity-lifetime-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home"), bin = join(root, "bin"), commands = join(root, "commands.jsonl");
	await Promise.all([mkdir(join(home, ".pi"), { recursive: true }), mkdir(bin)]);
	await symlink(process.execPath, join(bin, "node"));
	const resolver = join(root, "credential.mjs");
	await writeFile(resolver, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(commands)}, "perplexity\\n"); process.stdout.write("synthetic-perplexity-lifetime-key");`);
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({
		perplexityApiKey: `!node ${JSON.stringify(resolver)}`, ...config,
	}));
	return {
		commands: () => existsSync(commands) ? readFileSync(commands, "utf8").trim().split("\n") : [],
		run(script) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: bin, PI_CODING_AGENT_DIR: join(home, "agent") },
				input: `
					import { inspect } from "node:util";
					const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
					const key = "synthetic-perplexity-lifetime-key", requests = [], deadlines = [];
					let now = 0;
					Object.defineProperty(performance, "now", { value: () => now });
					AbortSignal.timeout = () => { const controller = new AbortController(); deadlines.push(controller); return controller.signal; };
					// Event-controlled clock samples, not real elapsed-time calibration.
					const expire = () => { now += 30017; for (const controller of deadlines) controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")); };
					const sonar = (answer = "Healthy answer", citations = []) => Response.json({ choices: [{ message: { content: answer } }], citations });
					let respond = () => { throw new Error("Unexpected fixture network request"); };
					globalThis.fetch = async (url, init) => {
						const body = JSON.parse(init.body), host = new URL(url).hostname;
						requests.push({ url: String(url), host, body });
						return respond({ host, body, init });
					};
					const { searchWithPerplexity } = await load("perplexity");
					const { search } = await load("search");
					const { activityMonitor } = await load("activity");
					const failure = error => ({ name: error?.name, message: error instanceof Error ? error.message : String(error), stack: error?.stack, inspected: inspect(error) });
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
			return { ...JSON.parse(child.stdout), transcript: child.stdout + child.stderr };
		},
	};
}

function deadlineFailure(result) {
	assert.ok(result.error, "a request that exceeds its own deadline must reject");
	assert.equal(result.error.name, "Error");
	assert.match(result.error.message, /Perplexity.*408.*request deadline/i);
	assert.match(result.error.message, /30000\s*ms/);
	assert.match(result.error.message, /30017\s*ms/);
	assert.match(result.error.message, /retry|narrow/i);
	assert.doesNotMatch(result.error.message, /abort|invalid JSON/i);
}

test("Perplexity owns a deadline through headers, JSON and HTTP-error bodies", async t => {
	for (const phase of ["headers", "JSON", "HTTP error"]) {
		for (const callerSignal of [false, true]) {
			for (const lateSuccess of [false, true]) await t.test(`${phase}; caller=${callerSignal}; late=${lateSuccess}`, async t => {
				const f = await fixture(t);
				const found = f.run(`
					respond = ({ init }) => {
						const finish = value => { expire(); if (!${lateSuccess}) init.signal?.throwIfAborted(); return value; };
						const response = ${JSON.stringify(phase)} === "HTTP error" ? new Response("remote failure", { status: 503 }) : sonar();
						if (${JSON.stringify(phase)} === "headers") return finish(response);
						const method = ${JSON.stringify(phase)} === "JSON" ? "json" : "text", read = response[method].bind(response);
						response[method] = async () => finish(await read());
						return response;
					};
					const result = await attempt(() => searchWithPerplexity("stalled", ${callerSignal ? "{ signal: new AbortController().signal }" : "{}"}));
					console.log(JSON.stringify({ result, entries: activityMonitor.getEntries(), requests }));
				`);
				deadlineFailure(found.result);
				assert.equal(found.requests.length, 1);
				assert.equal(found.entries.length, 1);
				assert.ok(found.entries[0].endTime !== undefined);
				assert.match(found.entries[0].error, /request deadline/i);
				assert.notEqual(found.entries[0].status, 200);
			});
		}
	}
});

test("caller cancellation wins before, during and after provider awaits, including a deadline race", async t => {
	for (const phase of ["before", "headers", "JSON", "HTTP error", "late JSON", "deadline race"]) {
		for (const custom of [false, true]) await t.test(`${phase}; custom=${custom}`, async t => {
			const f = await fixture(t);
			const found = f.run(`
				const caller = new AbortController(), reason = ${custom} ? new Error("Caller stopped fixture") : new DOMException("Caller stopped fixture", "AbortError");
				const phase = ${JSON.stringify(phase)};
				if (phase === "before") caller.abort(reason);
				respond = ({ init }) => {
					const finish = value => { if (phase === "deadline race") expire(); caller.abort(reason); if (phase !== "late JSON") init.signal?.throwIfAborted(); return value; };
					const response = phase === "HTTP error" ? new Response("remote failure", { status: 503 }) : sonar();
					if (phase === "headers" || phase === "deadline race") return finish(response);
					const method = phase === "HTTP error" ? "text" : "json", read = response[method].bind(response);
					response[method] = async () => finish(await read());
					return response;
				};
				console.log(JSON.stringify({ result: await attempt(() => searchWithPerplexity("cancelled", { signal: caller.signal }), reason), requests, entries: activityMonitor.getEntries() }));
			`);
			assert.equal(found.result.same, true, "clean caller reasons retain identity, even when not named AbortError");
			assert.equal(found.result.error.name, custom ? "Error" : "AbortError");
			assert.equal(found.requests.length, phase === "before" ? 0 : 1);
			assert.deepEqual(f.commands(), phase === "before" ? [] : ["perplexity"]);
			assert.ok(found.entries.every(entry => entry.endTime !== undefined && entry.status === 0 && entry.error === undefined));
		});
	}
});

test("body failures and cancellation redact credentials on every observable surface", async t => {
	for (const phase of ["JSON", "HTTP error"]) {
		for (const kind of ["failure", "named abort", "caller abort"]) await t.test(`${phase}; ${kind}`, async t => {
			const f = await fixture(t);
			const found = f.run(`
				const caller = new AbortController();
				const reason = ${JSON.stringify(kind)} === "named abort" ? new DOMException("Stopped " + key, "AbortError") : new TypeError("Body failed " + key);
				respond = () => {
					const response = ${JSON.stringify(phase)} === "JSON" ? sonar() : new Response("failure", { status: 503 });
					response[${JSON.stringify(phase === "JSON" ? "json" : "text")}] = async () => { if (${JSON.stringify(kind)} === "caller abort") caller.abort(reason); throw reason; };
					return response;
				};
				const direct = await attempt(() => searchWithPerplexity("body failure", { signal: caller.signal }));
				const tool = await attempt(() => web({ query: "body failure", provider: "perplexity" }));
				console.log(JSON.stringify({ direct, tool, entries: activityMonitor.getEntries(), requests }));
			`);
			assert.equal(found.transcript.includes("synthetic-perplexity-lifetime-key"), false);
			assert.match(found.direct.error.message, /\[redacted\]/);
			if (kind === "named abort") {
				assert.equal(found.direct.error.name, "AbortError");
				assert.equal(found.tool.error.name, "AbortError");
			} else {
				assert.equal(found.tool.value.details.successfulQueries, 0);
				assert.match(found.tool.value.content[0].text, /\[redacted\]/);
			}
			assert.ok(found.entries.every(entry => entry.endTime !== undefined));
		});
	}
});

test("ordinary HTTP and invalid-JSON failures remain distinct from request deadlines", async t => {
	for (const phase of ["HTTP", "JSON"]) await t.test(phase, async t => {
		const f = await fixture(t);
		const found = f.run(`
			respond = () => ${JSON.stringify(phase)} === "HTTP" ? new Response("remote rejected", { status: 429 }) : new Response("not JSON");
			console.log(JSON.stringify({ result: await attempt(() => searchWithPerplexity("ordinary failure")), entries: activityMonitor.getEntries() }));
		`);
		assert.match(found.result.error.message, phase === "HTTP" ? /Perplexity API error 429: remote rejected/ : /Perplexity API returned invalid JSON:/);
		assert.doesNotMatch(found.result.error.message, /request deadline/);
		assert.ok(found.entries.every(entry => entry.endTime !== undefined));
	});
});

test("an auto deadline preserves an earlier empty success; all-failure diagnostics remain operational", async t => {
	for (const emptyExa of [false, true]) await t.test(`empty Exa=${emptyExa}`, async t => {
		const f = await fixture(t, { exaApiKey: "synthetic-exa-lifetime-key" });
		const found = f.run(`
			respond = ({ host, init }) => {
				if (host === "api.exa.ai") return ${emptyExa} ? Response.json({ results: [] }) : new Response("Exa unavailable", { status: 503 });
				expire(); init.signal?.throwIfAborted(); return sonar();
			};
			console.log(JSON.stringify({ result: await attempt(() => search("auto deadline")), requests }));
		`);
		if (emptyExa) assert.deepEqual(found.result.value, { answer: "", results: [], provider: "exa" });
		else {
			assert.match(found.result.error.message, /Auto provider search failed:[\s\S]*Exa:.*503[\s\S]*Perplexity:.*408/);
			assert.doesNotMatch(found.result.error.message, /abort/i);
		}
		assert.deepEqual(found.requests.map(request => request.host), ["api.exa.ai", "api.perplexity.ai"]);
	});
});

test("registered serial batches continue after a deadline but stop after body cancellation", async t => {
	for (const cancel of [false, true]) await t.test(`cancel=${cancel}`, async t => {
		const f = await fixture(t, { searchProvider: "perplexity" });
		const found = f.run(`
			const caller = new AbortController(), reason = new Error("Caller stopped batch");
			respond = ({ body, init }) => {
				const query = body.messages[0].content, response = sonar(query + " [2]", ["https://example.com/shared", "https://example.com/" + query]);
				if (query === "broken") response.json = async () => { if (${cancel}) caller.abort(reason); else expire(); init.signal?.throwIfAborted(); return {}; };
				return response;
			};
			const result = await attempt(() => web({ queries: ["alpha", "broken", "omega"], numResults: 1, includeContent: true }, caller.signal), reason);
			console.log(JSON.stringify({ result, requests }));
		`);
		assert.deepEqual(found.requests.map(request => request.body.messages[0].content), cancel ? ["alpha", "broken"] : ["alpha", "broken", "omega"]);
		assert.deepEqual(f.commands(), Array(cancel ? 2 : 3).fill("perplexity"));
		if (cancel) assert.equal(found.result.same, true);
		else {
			assert.deepEqual(found.result.value.details, { queries: ["alpha", "broken", "omega"], queryCount: 3, successfulQueries: 2, totalResults: 4, urls: ["https://example.com/shared", "https://example.com/alpha", "https://example.com/omega"] });
			const text = found.result.value.content[0].text;
			assert.match(text, /408.*request deadline/);
			assert.ok(text.indexOf('## Query: "alpha"') < text.indexOf('## Query: "broken"'));
			assert.ok(text.indexOf('## Query: "broken"') < text.indexOf('## Query: "omega"'));
		}
	});
});

test("Sonar footnotes preserve their source prefix without imposing a new ceiling", async t => {
	for (const [label, answer, available, requested, kept] of [
		["uncited", "No markers", 9, 2, 2],
		["low citation does not shrink request", "A [1]", 9, 5, 5],
		["beyond request", "A [7]", 9, 2, 7],
		["out of order and repeated", "A [7][2] and [7][4]", 9, 2, 7],
		["beyond twenty", "A [25]", 30, 2, 25],
		["four digit footnote", "A [1001]", 1002, 2, 1001],
		["out of range is bounded by available", "A [99999]", 9, 2, 9],
		["no sources", "A [3]", 0, 2, 0],
		["uncited request clamp unchanged", "No markers", 30, 100, 20],
	]) await t.test(label, async t => {
		const f = await fixture(t);
		const found = f.run(`
			const citations = Array.from({ length: ${available} }, (_, i) => i % 2 === 0 ? "https://example.com/" + (i + 1) : { title: "Title " + (i + 1), url: "https://example.com/" + (i + 1) });
			respond = () => sonar(${JSON.stringify(answer)}, citations);
			console.log(JSON.stringify({ result: await searchWithPerplexity("footnotes", { numResults: ${requested} }) }));
		`);
		assert.equal(found.result.answer, answer);
		assert.deepEqual(found.result.results, Array.from({ length: kept }, (_, i) => ({ title: i % 2 === 0 ? `Source ${i + 1}` : `Title ${i + 1}`, url: `https://example.com/${i + 1}`, snippet: "" })));
	});
});

test("healthy Sonar requests retain endpoint, payload, credentials, filters and default count", async t => {
	const f = await fixture(t);
	const found = f.run(`
		let authorized;
		respond = ({ init }) => { authorized = init.headers.Authorization === "Bearer " + key; return sonar("Answer", Array.from({ length: 9 }, (_, i) => "https://example.com/" + (i + 1))); };
		const result = await searchWithPerplexity("healthy fixture", { recencyFilter: "week", domainFilter: ["example.com", "-blocked.example", "invalid domain"] });
		console.log(JSON.stringify({ result, requests, authorized, entries: activityMonitor.getEntries() }));
	`);
	assert.equal(found.authorized, true);
	assert.equal(found.requests[0].url, "https://api.perplexity.ai/chat/completions");
	assert.deepEqual(found.requests[0].body, { model: "sonar", messages: [{ role: "user", content: "healthy fixture" }], max_tokens: 1024, return_related_questions: false, search_recency_filter: "week", search_domain_filter: ["example.com", "-blocked.example"] });
	assert.equal(found.result.results.length, 5);
	assert.equal(found.entries[0].status, 200);
	assert.ok(found.entries[0].endTime !== undefined);
	assert.deepEqual(f.commands(), ["perplexity"]);
});
