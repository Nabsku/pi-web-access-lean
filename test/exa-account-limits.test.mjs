import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const key = "synthetic-exa-account-key";
const currentUsage = count => JSON.stringify({ month: new Date().toISOString().slice(0, 7), count });

async function snapshot(home) {
	const entries = [];
	for (const path of (await readdir(home, { recursive: true })).sort()) {
		const full = join(home, path);
		const stat = await lstat(full, { bigint: true });
		if (stat.isFile()) entries.push({ path, bytes: (await readFile(full)).toString("base64"), inode: String(stat.ino), modified: String(stat.mtimeNs) });
		else if (stat.isSymbolicLink()) entries.push({ path, link: await readlink(full) });
		else entries.push({ path, directory: true });
	}
	return entries;
}

async function fixture(t, legacy, config = { exaApiKey: key, perplexityApiKey: "synthetic-perplexity-fallback" }) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pi-exa-account-")));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".pi"));
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	const usage = join(home, ".pi", "exa-usage.json");
	if (legacy === "directory") {
		await mkdir(usage);
		await writeFile(join(usage, "keep"), "preserve legacy directory");
	} else if (legacy === "symlink") {
		const target = join(home, "legacy-target");
		await writeFile(target, currentUsage(799)); // The old warning threshold is 800.
		await symlink(target, usage);
	} else if (legacy !== undefined) await writeFile(usage, legacy);
	const before = await snapshot(home);
	return {
		before,
		snapshot: () => snapshot(home),
		run(script, env = {}) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), PI_CODING_AGENT_DIR: join(home, "agent"), ...env },
				input: `
					const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
					const key = ${JSON.stringify(key)};
					const calls = [];
					globalThis.fetch = async (url, init) => {
						calls.push({ url: String(url), keyMatches: new Headers(init.headers).get("x-api-key") === key });
						return new Response(JSON.stringify({ results: [{ title: "Fixture", url: "https://example.com/source", highlights: ["Exa account fixture"] }], choices: [{ message: { content: "Perplexity fallback fixture" } }] }));
					};
					async function attempt(run) { try { return { value: await run() }; } catch (error) { return { error: { name: error.name, message: error.message, stack: error.stack } }; } }
					const exa = await load("exa");
					const { search } = await load("search");
					${script}
				`,
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return { ...JSON.parse(child.stdout), transcript: child.stdout + child.stderr };
		},
	};
}

test("keyed Exa ignores legacy usage artifacts without modifying or creating them", async t => {
	for (const [name, legacy] of [
		["full counter", currentUsage(1000)], // The obsolete production cap, not a new budget.
		["malformed JSON", "{invalid legacy usage"],
		["directory", "directory"],
		["symlink", "symlink"],
		["below old warning threshold", currentUsage(799)],
		["old month", JSON.stringify({ month: "2000-01", count: 1000 })],
		["missing", undefined],
	]) await t.test(name, async t => {
		const f = await fixture(t, legacy);
		const result = f.run(`
			const available = await attempt(() => exa.isExaAvailable());
			const direct = await attempt(() => exa.searchWithExa("direct fixture"));
			const named = await attempt(() => search("named fixture", { provider: "exa" }));
			const auto = await attempt(() => search("auto fixture"));
			const tools = [];
			(await load("index")).default({ on() {}, registerShortcut() {}, registerTool(tool) { tools.push(tool); } });
			const tool = await tools.find(tool => tool.name === "web_search").execute("fixture", { query: "registered fixture", provider: "auto" });
			console.log(JSON.stringify({ available, direct, named, auto, tool, calls }));
		`);
		t.diagnostic(JSON.stringify({ evidence: "isolated process/filesystem; mocked provider I/O", name, available: result.available, directError: result.direct.error, namedError: result.named.error, autoProvider: result.auto.value?.provider, urls: result.calls.map(call => call.url) }));
		assert.equal(result.direct.error, undefined);
		assert.equal(result.direct.value?.answer, "Exa account fixture\nSource: Fixture (https://example.com/source)");
		assert.deepEqual(result.direct.value.results, [{ title: "Fixture", url: "https://example.com/source", snippet: "" }]);
		assert.deepEqual(result.available, { value: true });
		assert.equal(result.named.value?.provider, "exa");
		assert.equal(result.auto.value?.provider, "exa");
		assert.equal(result.tool.details.successfulQueries, 1);
		assert.match(result.tool.content[0].text, /Exa account fixture/);
		assert.deepEqual(result.calls, Array.from({ length: 4 }, () => ({ url: "https://api.exa.ai/search", keyMatches: true })));
		assert.doesNotMatch(result.transcript, /Exa usage warning|monthly free tier exhausted/);
		assert.deepEqual(await f.snapshot(), f.before, "legacy files, symlink targets and missing journals must remain untouched");
	});
});

test("keyed search payloads, inline content and request-time credentials survive removal of the quota gate", async t => {
	const f = await fixture(t, currentUsage(1000), { exaApiKey: "$SCOPED_EXA_KEY" });
	const result = f.run(`
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(init.body), keyMatches: new Headers(init.headers).get("x-api-key") === process.env.SCOPED_EXA_KEY });
			return new Response(JSON.stringify({ results: [{ title: "Fixture", url: "https://example.com/source", text: "inline fixture" }] }));
		};
		const found = await exa.searchWithExa("search fixture", { includeContent: true, numResults: 2, domainFilter: ["example.com"] });
		process.env.SCOPED_EXA_KEY = "synthetic-refreshed-key";
		const refreshed = await exa.searchWithExa("refreshed fixture");
		console.log(JSON.stringify({ found, refreshed, calls }));
	`, { SCOPED_EXA_KEY: key });
	assert.deepEqual(result.calls, [
		{ url: "https://api.exa.ai/search", keyMatches: true, body: { query: "search fixture", type: "auto", numResults: 2, includeDomains: ["example.com"], contents: { text: true, highlights: true } } },
		{ url: "https://api.exa.ai/search", keyMatches: true, body: { query: "refreshed fixture", type: "auto", numResults: 5, contents: { highlights: true } } },
	]);
	assert.match(result.found.answer, /inline fixture/);
	assert.deepEqual(result.found.inlineContent, [{ url: "https://example.com/source", title: "Fixture", content: "inline fixture", error: null }]);
	assert.equal(result.refreshed.answer, "inline fixture\nSource: Fixture (https://example.com/source)");
	assert.deepEqual(await f.snapshot(), f.before);
});

test("remote account/authentication errors still reject explicit Exa requests and redact the key", async t => {
	for (const status of [429, 401]) await t.test(String(status), async t => {
		const f = await fixture(t, currentUsage(0));
		const result = f.run(`
			globalThis.fetch = async url => { calls.push(String(url)); return new Response("remote account rejection " + key, { status: ${status} }); };
			const direct = await attempt(() => exa.searchWithExa("direct remote error"));
			const named = await attempt(() => search("named remote error", { provider: "exa" }));
			const { activityMonitor } = await load("activity");
			console.log(JSON.stringify({ direct, named, entries: activityMonitor.getEntries(), calls }));
		`);
		assert.deepEqual(result.calls, ["https://api.exa.ai/search", "https://api.exa.ai/search"]);
		for (const attempt of [result.direct, result.named]) assert.match(attempt.error.message, new RegExp(`Exa API error ${status}: remote account rejection \\[redacted\\]`));
		assert.equal(result.transcript.includes(key), false);
		assert.ok(result.entries.every(entry => entry.endTime !== undefined));
	});
});

test("ordinary remote Exa refusal still permits auto fallback", async t => {
	const f = await fixture(t, currentUsage(0));
	const result = f.run(`
		globalThis.fetch = async url => {
			const host = new URL(url).hostname; calls.push(host);
			if (host === "api.exa.ai") return new Response("remote quota", { status: 429 });
			return new Response(JSON.stringify({ choices: [{ message: { content: "fallback answer" } }], citations: [] }));
		};
		console.log(JSON.stringify({ found: await search("auto refusal"), calls }));
	`);
	assert.equal(result.found.provider, "perplexity");
	assert.equal(result.found.answer, "fallback answer");
	assert.deepEqual(result.calls, ["api.exa.ai", "api.perplexity.ai"]);
});

test("caller abort remains terminal rather than triggering fallback", async t => {
	const f = await fixture(t, currentUsage(0));
	const result = f.run(`
		const caller = new AbortController();
		caller.abort(new DOMException("Aborted fixture", "AbortError"));
		globalThis.fetch = async (url, init) => { calls.push({ host: new URL(url).hostname, aborted: init.signal.aborted }); throw init.signal.reason; };
		const found = await attempt(() => search("aborted fixture", { signal: caller.signal }));
		console.log(JSON.stringify({ found, calls }));
	`);
	assert.equal(result.found.error.name, "AbortError");
	assert.deepEqual(result.calls, [{ host: "api.exa.ai", aborted: true }]);
});

test("keyless web and code search keep using Exa MCP with an untouched malformed legacy journal", async t => {
	const f = await fixture(t, "{invalid legacy usage", {});
	const result = f.run(`
		globalThis.fetch = async (url, init) => {
			const request = JSON.parse(init.body);
			calls.push({ url: String(url), name: request.params.name, hasKey: new Headers(init.headers).has("x-api-key") });
			const text = request.params.name === "web_search_exa" ? "Title: Fixture\\nURL: https://example.com/source\\nText: MCP web fixture" : "MCP code fixture";
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
		};
		const available = exa.isExaAvailable();
		const web = await search("keyless fixture");
		const code = await (await load("code-search")).executeCodeSearch("fixture", { query: "code fixture" });
		console.log(JSON.stringify({ available, web, code, calls }));
	`);
	assert.equal(result.available, true);
	assert.equal(result.web.provider, "exa");
	assert.match(result.web.answer, /MCP web fixture/);
	assert.deepEqual(result.web.results, [{ title: "Fixture", url: "https://example.com/source", snippet: "" }]);
	assert.equal(result.code.details.mode, "code-context");
	assert.equal(result.code.content[0].text, "MCP code fixture");
	assert.deepEqual(result.calls, ["web_search_exa", "get_code_context_exa"].map(name => ({ url: "https://mcp.exa.ai/mcp?tools=" + name, name, hasKey: false })));
	assert.deepEqual(await f.snapshot(), f.before);
});
