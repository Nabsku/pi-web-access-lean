import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const shaUrl = `https://github.com/owner/repo/blob/${"a".repeat(40)}/file.ts`;

async function fixture(t, config, { raw, missing = false } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-credential-config-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	await Promise.all([mkdir(join(home, ".pi"), { recursive: true }), mkdir(bin)]);
	await symlink(process.execPath, join(bin, "node"));
	const command = join(root, "credential.mjs");
	const marker = join(root, "credential-ran");
	await writeFile(command, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(1);`);
	if (config?.exaApiKey === "!fixture") config = { ...config, exaApiKey: `!node ${JSON.stringify(command)}` };
	if (!missing) await writeFile(join(home, ".pi", "web-search.json"), raw ?? JSON.stringify(config));
	const commands = join(root, "commands.jsonl");
	await writeFile(join(bin, "gh"), String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + "\n");
if (args[0] === "--version") process.exit(0);
if (args[0] !== "api" || args.at(-1) !== ".content") throw new Error("Unexpected fixture command");
process.stdout.write(Buffer.from("config fixture file").toString("base64"));
`, { mode: 0o755 });
	return {
		marker,
		commands: () => existsSync(commands) ? readFileSync(commands, "utf8").trim().split("\n").map(JSON.parse) : [],
		run(script, env = {}) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PATH: bin, PI_CODING_AGENT_DIR: join(home, ".pi"), ...env },
				input: `
					import { existsSync } from "node:fs";
					import { inspect } from "node:util";
					import dns from "node:dns/promises";
					import { syncBuiltinESMExports } from "node:module";
					dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
					syncBuiltinESMExports();
					const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
					const calls = [];
					globalThis.fetch = async url => { calls.push(new URL(url).hostname); throw new Error("Fixture network disabled"); };
					const failure = error => ({ name: error?.name, message: error instanceof Error ? error.message : String(error), stack: error?.stack, inspected: inspect(error) });
					const { activityMonitor } = await load("activity");
					async function webSearch(params) {
						const tools = [];
						(await load("index")).default({ on() {}, registerShortcut() {}, registerTool(tool) { tools.push(tool); } });
						return tools.find(tool => tool.name === "web_search").execute("fixture", params);
					}
					const response = () => new Response(JSON.stringify({ results: [{ title: "Exa fixture", url: "https://example.com/exa", highlights: ["Exa fixture"] }], citations: [], choices: [{ message: { content: "Perplexity fixture" } }] }));
					${script}
				`,
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return { ...JSON.parse(child.stdout), transcript: child.stdout + child.stderr };
		},
	};
}

test("auto search fails closed for explicit Exa credential failures without executing sources during availability checks", async t => {
	for (const [source, category] of [["$MISSING_EXA_SOURCE", "environment-empty"], ["!fixture", "command-failed"]]) {
		await t.test(category, async t => {
			const f = await fixture(t, { exaApiKey: source, perplexityApiKey: "synthetic-perplexity-fallback" });
			const result = f.run(`
				const { CredentialResolutionError } = await load("credential-source");
				const { isExaAvailable } = await load("exa");
				const available = isExaAvailable();
				const ranBefore = existsSync(${JSON.stringify(f.marker)});
				globalThis.fetch = async url => { calls.push(new URL(url).hostname); return response(); };
				let error;
				try { await (await load("search")).search("private fixture query"); }
				catch (err) { error = { ...failure(err), credentialError: err instanceof CredentialResolutionError, category: err.category }; }
				console.log(JSON.stringify({ available, ranBefore, error, calls }));
			`);
			assert.equal(result.available, true);
			assert.equal(result.ranBefore, false);
			assert.equal(existsSync(f.marker), source === "!fixture");
			assert.deepEqual(result.calls, [], "credential failures must not send the query to another provider");
			assert.equal(result.error?.credentialError, true);
			assert.equal(result.error.category, category);
		});
	}
});

test("ordinary auto fallback, explicit provider choice and request-time credential refresh are retained", async t => {
	const f = await fixture(t, { exaApiKey: "$SCOPED_EXA", perplexityApiKey: "synthetic-perplexity" });
	const result = f.run(`
		const { search } = await load("search");
		let exaFails = true;
		const keys = [];
		globalThis.fetch = async (url, init) => {
			const host = new URL(url).hostname; calls.push(host);
			if (host === "api.exa.ai") { keys.push(init.headers["x-api-key"]); if (exaFails) throw new TypeError("ordinary transport failure"); }
			return response();
		};
		const fallback = await search("fallback");
		const explicit = await search("explicit", { provider: "perplexity" });
		process.env.SCOPED_EXA = "synthetic-refreshed-exa";
		exaFails = false;
		const refreshed = await search("refreshed", { provider: "exa" });
		console.log(JSON.stringify({ providers: [fallback.provider, explicit.provider, refreshed.provider], keys, calls }));
	`, { SCOPED_EXA: "synthetic-initial-exa" });
	assert.deepEqual(result.providers, ["perplexity", "perplexity", "exa"]);
	assert.deepEqual(result.keys, ["synthetic-initial-exa", "synthetic-refreshed-exa"]);
	assert.deepEqual(result.calls, ["api.exa.ai", "api.perplexity.ai", "api.perplexity.ai", "api.exa.ai"]);
});

test("Perplexity transport errors redact credentials from errors, stacks, activity and registered tool output", async t => {
	for (const kind of ["Error", "TypeError", "AbortError", "string", "native-header", "http-body", "clean-error"]) {
		await t.test(kind, async t => {
			const key = kind === "native-header" ? "synthetic-perplexity-transport-secret\ninvalid-header" : "synthetic-perplexity-transport-secret";
			const f = await fixture(t, { perplexityApiKey: key });
			const result = f.run(`
				const key = ${JSON.stringify(key)};
				const kind = ${JSON.stringify(kind)};
				let original;
				globalThis.fetch = async (url, init) => {
					calls.push(new URL(url).hostname);
					if (kind === "native-header") return new Request(url, init); // Native validation, never a network request.
					if (kind === "http-body") return new Response("rejected " + key, { status: 401 });
					if (kind === "string") original = "transport " + key;
					else if (kind === "AbortError") original = new DOMException("aborted " + key, "AbortError");
					else original = new (kind === "TypeError" ? TypeError : Error)(kind === "clean-error" ? "ordinary failure" : "transport " + key);
					throw original;
				};
				let error;
				try { await (await load("perplexity")).searchWithPerplexity("fixture"); }
				catch (err) { error = { ...failure(err), same: err === original }; }
				let tool, toolError;
				try { tool = await webSearch({ query: "fixture", provider: "perplexity" }); }
				catch (err) { toolError = failure(err); }
				console.log(JSON.stringify({ error, tool, toolError, entries: activityMonitor.getEntries(), calls }));
			`);
			assert.ok(result.error);
			assert.equal(result.transcript.includes("synthetic-perplexity-transport-secret"), false, "secret escaped through an observable error surface");
			assert.deepEqual(result.calls, ["api.perplexity.ai", "api.perplexity.ai"]);
			if (kind === "AbortError") {
				assert.equal(result.tool, undefined, "cancellation must reject the batch, not return a successful tool result");
				assert.equal(result.toolError.name, "AbortError");
			} else {
				assert.equal(result.toolError, undefined);
				assert.equal(result.tool.details.successfulQueries, 0);
			}
			if (kind === "clean-error") {
				assert.equal(result.error.same, true, "unmodified errors retain their identity");
				assert.equal(result.error.message, "ordinary failure");
			} else {
				assert.match(result.error.message, /\[redacted\]/);
				assert.match(kind === "AbortError" ? result.toolError.message : result.tool.content[0].text, /\[redacted\]/);
				const expectedNames = { TypeError: "TypeError", AbortError: "AbortError", "native-header": "TypeError" };
				assert.equal(result.error.name, expectedNames[kind] ?? "Error");
			}
			assert.ok(result.entries.every(entry => entry.endTime !== undefined));
			if (kind === "AbortError") assert.ok(result.entries.every(entry => entry.status === 0 && entry.error === undefined));
		});
	}
});

const readers = {
	search: 'await (await load("search")).search("fixture")',
	exa: '(await load("exa")).hasExaApiKey()',
	perplexity: '(await load("perplexity")).isPerplexityAvailable()',
	github: `await (await load("github-extract")).extractGitHub(${JSON.stringify(shaUrl)})`,
	extract: `await (await load("extract")).extractContent(${JSON.stringify(shaUrl)})`,
};

test("every retained config reader rejects non-object JSON roots before provider or GitHub work", async t => {
	for (const raw of ["null", "[]", '"scalar"', "42", "true", "{invalid"]) {
		for (const [name, expression] of Object.entries(readers)) await t.test(`${name}: ${raw}`, async t => {
			const f = await fixture(t, undefined, { raw });
			const result = f.run(`
				const { parseGitHubUrl } = await load("github-extract");
				if (!parseGitHubUrl(${JSON.stringify(shaUrl)}).refIsFullSha) throw new Error("Fixture must never clone");
				let error;
				try { const value = ${expression}; error = value?.error; }
				catch (err) { error = failure(err).message; }
				console.log(JSON.stringify({ error, calls }));
			`, { EXA_API_KEY: "synthetic-exa", PERPLEXITY_API_KEY: "synthetic-perplexity" });
			assert.match(result.error ?? "", /^Failed to parse .*web-search\.json:/);
			if (raw !== "{invalid") assert.match(result.error, /expected a JSON object/);
			assert.deepEqual(result.calls, [], "invalid config must not reach HTTP fallback");
			assert.deepEqual(f.commands(), [], "invalid config must not reach GitHub commands");
		});
	}
});

test("missing and object config roots retain defaults, unknown fields and provider aliases", async t => {
	for (const [label, config, options, provider] of [
		["missing", undefined, { missing: true }, "exa"],
		["empty", {}, {}, "exa"],
		["unknown fields", { futureSetting: true }, {}, "exa"],
		["provider alias", { provider: " Perplexity " }, {}, "perplexity"],
		["searchProvider", { searchProvider: " PERPLEXITY " }, {}, "perplexity"],
	]) await t.test(label, async t => {
		const f = await fixture(t, config, options);
		const result = f.run(`
			globalThis.fetch = async url => { calls.push(new URL(url).hostname); return response(); };
			const found = await (await load("search")).search("fixture");
			const exa = (await load("exa")).hasExaApiKey();
			const perplexity = (await load("perplexity")).isPerplexityAvailable();
			const github = await (await load("extract")).extractContent(${JSON.stringify(shaUrl)});
			console.log(JSON.stringify({ provider: found.provider, exa, perplexity, github, calls }));
		`, { EXA_API_KEY: "synthetic-exa", PERPLEXITY_API_KEY: "synthetic-perplexity" });
		assert.equal(result.provider, provider);
		assert.equal(result.exa, true);
		assert.equal(result.perplexity, true);
		assert.equal(result.github.error, null);
		assert.match(result.github.content, /config fixture file/);
		assert.deepEqual(result.calls, [provider === "exa" ? "api.exa.ai" : "api.perplexity.ai"]);
		assert.equal(f.commands().length, 2);
	});
});

test("registered auto web_search reports credential errors without a fallback provider request", async t => {
	const f = await fixture(t, { exaApiKey: "$MISSING_EXA_SOURCE", perplexityApiKey: "synthetic-perplexity" });
	const result = f.run(`
		globalThis.fetch = async url => { calls.push(new URL(url).hostname); return response(); };
		const tool = await webSearch({ query: "private fixture query", provider: "auto" });
		console.log(JSON.stringify({ tool, calls }));
	`);
	assert.deepEqual(result.calls, []);
	assert.equal(result.tool.details.successfulQueries, 0);
	assert.match(result.tool.content[0].text, /Exa credential resolution failed: environment-empty/);
});
