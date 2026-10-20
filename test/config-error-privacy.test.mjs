import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const canary = "S3CR3T";
const malformed = `{"exaApiKey":"!must-not-run","perplexityApiKey":"!must-not-run","unrelated":${canary}}`;

async function observe(t, expression, { tool = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-config-error-privacy-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false, "owned configuration fixture must be removed");
	});
	const configPath = join(root, "web-search.json");
	await writeFile(configPath, tool ? "{}" : malformed);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, PATH: "" },
		input: `
			import childProcess from "node:child_process";
			import dns from "node:dns/promises";
			import { writeFileSync } from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			import { inspect } from "node:util";
			const work = { command: 0, dns: 0, http: 0 };
			const forbidden = kind => { work[kind]++; throw new Error("Unexpected " + kind + " during config validation"); };
			for (const name of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) childProcess[name] = () => forbidden("command");
			dns.lookup = async () => forbidden("dns");
			globalThis.fetch = async () => forbidden("http");
			syncBuiltinESMExports();
			const load = name => import(new URL(name + ".ts", ${JSON.stringify(source)}));
			const { search } = await load("search");
			const { hasExaApiKey } = await load("exa");
			const { isPerplexityAvailable } = await load("perplexity");
			const { extractGitHub } = await load("github-extract");
			const { extractContent } = await load("extract");
			const { activityMonitor } = await load("activity");
			const { default: extension } = await load("index");
			const tools = [];
			const pi = { on() {}, registerShortcut() {}, registerTool(tool) { tools.push(tool); } };
			if (${tool}) {
				extension(pi);
				writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(malformed)});
			}
			const caller = new AbortController(), reason = new Error("Cancelled privacy fixture");
			let value, error;
			try { value = ${expression}; }
			catch (err) { error = { name: err?.name, message: err instanceof Error ? err.message : String(err), stack: err?.stack, inspected: inspect(err), sameReason: err === reason }; }
			console.log(JSON.stringify({ value, error, work, entries: activityMonitor.getEntries() }));
		`,
	});
	assert.equal(child.status, 0, child.error?.message || child.stdout + child.stderr);
	const result = JSON.parse(child.stdout);
	const canaryLeaked = (child.stdout + child.stderr).includes(canary);
	t.diagnostic(JSON.stringify({ boundary: t.name, canaryLeaked, work: result.work }));
	assert.deepEqual(result.work, { command: 0, dns: 0, http: 0 }, "invalid config must fail before external work");
	assert.equal(canaryLeaked, false, "configuration contents escaped through errors, logs, activity or tool output");
	return { ...result, configPath };
}

const readers = {
	"default search": 'await search("fixture")',
	"auto search": 'await search("fixture", { provider: "auto" })',
	"named Exa search": 'await search("fixture", { provider: "exa" })',
	"named Perplexity search": 'await search("fixture", { provider: "perplexity" })',
	"Exa availability": "hasExaApiKey()",
	"Perplexity availability": "isPerplexityAvailable()",
	"GitHub extraction": `await extractGitHub("https://github.com/owner/repo/blob/${"a".repeat(40)}/file.ts")`,
	"page extraction": 'await extractContent("https://config-privacy.example.test/article")',
	"extension initialization": "extension(pi)",
};

for (const [name, expression] of Object.entries(readers)) {
	test("malformed configuration stays private at " + name, async t => {
		const result = await observe(t, expression);
		const message = result.error?.message ?? result.value?.error;
		assert.ok(message?.startsWith("Failed to parse " + result.configPath + ":"), message);
		assert.match(message, /invalid JSON/i);
	});
}

for (const provider of ["auto", "exa", "perplexity"]) {
	test("registered web_search keeps malformed configuration private: " + provider, async t => {
		const result = await observe(t, `await tools.find(tool => tool.name === "web_search").execute("fixture", { query: "fixture", provider: ${JSON.stringify(provider)} })`, { tool: true });
		assert.equal(result.error, undefined, "the failure must reach tool execution, not stop at initialization");
		assert.equal(result.value.isError, true);
		assert.equal(result.value.details.successfulQueries, 0);
		assert.ok(result.value.content[0].text.includes("Failed to parse " + result.configPath + ":"));
		assert.match(result.value.content[0].text, /invalid JSON/i);
	});

	test("pre-aborted search preserves cancellation before malformed config: " + provider, async t => {
		const result = await observe(t, `(caller.abort(reason), await search("fixture", { provider: ${JSON.stringify(provider)}, signal: caller.signal }))`);
		assert.equal(result.error?.sameReason, true);
		assert.equal(result.error.message, "Cancelled privacy fixture");
	});
}
