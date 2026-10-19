import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const shaUrl = "https://github.com/owner/repo/blob/" + "a".repeat(40) + "/file.ts";
const configName = "web-search.json";
const key = (location, provider) => "synthetic-config01-" + location + "-" + provider;
const profile = (location, selected = true) => ({
	searchProvider: selected ? "perplexity" : "exa",
	exaApiKey: key(location, "exa"),
	perplexityApiKey: key(location, "perplexity"),
	githubClone: { enabled: !selected },
});

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-config-path-")));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
		t.diagnostic(JSON.stringify({ fixtureDirectoryRemoved: !existsSync(root), root }));
	});
	const home = join(root, "home"), cwd = join(root, "cwd"), bin = join(root, "bin");
	const dirs = { explicit: join(root, "agent"), xdg: join(root, "xdg", "pi"), agent: join(home, ".pi", "agent"), legacy: join(home, ".pi") };
	await Promise.all([home, cwd, bin].map(path => mkdir(path, { recursive: true })));
	await symlink(process.execPath, join(bin, "node"));
	await writeFile(join(root, "outside-marker"), "CONFIG01_OUTSIDE_PRIVATE");
	const executable = [
		"#!/usr/bin/env node",
		'const fs = require("node:fs"), path = require("node:path");',
		"const root = " + JSON.stringify(root) + ", args = process.argv.slice(2), tool = path.basename(process.argv[1]);",
		'fs.appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\\n");',
		'if (args[0] === "--version") process.exit(process.env.CONFIG01_ROUTE === "git" ? 1 : 0);',
		'if (args[0] === "api") {',
		'  const values = { ".size": "1", ".default_branch": "main", ".tree[].path": "README.md", ".content": Buffer.from("CONFIG01_API_OWNED").toString("base64") };',
		'  if (!(args.at(-1) in values)) throw new Error("Unexpected fixture API command");',
		"  process.stdout.write(values[args.at(-1)]); return;",
		"}",
		'const destination = tool === "gh" && args[0] === "repo" && args[1] === "clone" ? args[3] : tool === "git" && args[0] === "clone" ? args.at(-1) : null;',
		'if (!destination || !path.resolve(destination).startsWith(root + path.sep)) throw new Error("Fixture clone destination escaped owned root");',
		"fs.mkdirSync(destination, { recursive: true });",
		'fs.writeFileSync(path.join(destination, "README.md"), "CONFIG01_CLONE_OWNED");',
		'fs.symlinkSync(path.join(root, "outside-marker"), path.join(destination, "escape.txt"));',
	].join("\n");
	await Promise.all(["gh", "git"].map(name => writeFile(join(bin, name), executable, { mode: 0o755 })));
	return {
		root, home, cwd, dirs,
		async write(location, value) {
			await mkdir(dirs[location], { recursive: true });
			await writeFile(join(dirs[location], configName), typeof value === "string" ? value : JSON.stringify(value));
		},
		env(mode = "default") {
			return mode === "explicit"
				? { PI_CODING_AGENT_DIR: dirs.explicit, XDG_CONFIG_HOME: join(root, "xdg") }
				: mode === "xdg" ? { XDG_CONFIG_HOME: join(root, "xdg") } : {};
		},
		run(script, extraEnv = {}) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8", cwd,
				env: { HOME: home, USERPROFILE: home, PATH: bin, ...extraEnv },
				input: [
					'import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";',
					'import { dirname, join, resolve } from "node:path";',
					'import dns from "node:dns/promises";',
					'import { syncBuiltinESMExports } from "node:module";',
					'dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }]; syncBuiltinESMExports();',
					"const root = " + JSON.stringify(root) + ", dirs = " + JSON.stringify(dirs) + ";",
					"const load = name => import(new URL(name + '.ts', " + JSON.stringify(source) + "));",
					"const requests = [];",
					"globalThis.fetch = async (input, init) => {",
					"  const host = new URL(input).hostname, headers = new Headers(init?.headers);",
					'  requests.push({ host, key: headers.get("x-api-key") ?? headers.get("authorization") });',
					'  if (host === "api.exa.ai") return Response.json({ results: [{ title: "Config fixture", url: "https://example.test/config", highlights: ["Owned config result"] }] });',
					'  if (host === "mcp.exa.ai") return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Keyless fixture", url: "https://example.test/keyless", text: "Owned keyless result" }] }) }] } });',
					'  if (host === "api.perplexity.ai") return Response.json({ choices: [{ message: { content: "Owned Sonar result" } }], citations: [] });',
					'  if (host === "github.com") return new Response("# Owned HTTP fallback", { headers: { "content-type": "text/plain" } });',
					'  throw new Error("Unexpected fixture network target: " + host);',
					"};",
					'const commands = () => existsSync(join(root, "commands.jsonl")) ? readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\\n").map(JSON.parse) : [];',
					'async function attempt(run) { try { return { value: await run() }; } catch (error) { return { error: { name: error.name, message: error.message, category: error.category } }; } }',
					script,
				].join("\n"),
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			return JSON.parse(child.stdout);
		},
	};
}

const observe = [
	'const route = await attempt(() => load("search").then(module => module.search("configured route")));',
	'const exa = await attempt(() => load("exa").then(module => module.searchWithExa("direct Exa")));',
	'const perplexity = await attempt(() => load("perplexity").then(module => module.searchWithPerplexity("direct Sonar")));',
	'const github = await attempt(() => load("github-extract").then(module => module.extractGitHub(' + JSON.stringify(shaUrl) + ")));",
	"console.log(JSON.stringify({ route, exa, perplexity, github, requests, commands: commands() }));",
].join("\n");

function assertSelected(found, location) {
	assert.equal(found.route.value?.provider, "perplexity");
	assert.equal(found.exa.error, undefined);
	assert.equal(found.perplexity.error, undefined);
	assert.deepEqual(found.requests, [
		{ host: "api.perplexity.ai", key: "Bearer " + key(location, "perplexity") },
		{ host: "api.exa.ai", key: key(location, "exa") },
		{ host: "api.perplexity.ai", key: "Bearer " + key(location, "perplexity") },
	]);
	assert.equal(found.github.value, null, "selected githubClone.enabled=false must prevent GitHub specialization");
	assert.deepEqual(found.commands, []);
}

function assertMissing(found, expectedPath) {
	assert.equal(found.route.value?.provider, "exa");
	assert.equal(found.exa.error, undefined);
	assert.deepEqual(found.requests, [{ host: "mcp.exa.ai", key: null }, { host: "mcp.exa.ai", key: null }]);
	assert.ok(found.perplexity.error?.message.includes("Create " + expectedPath + " with"), found.perplexity.error?.message);
	assert.match(found.github.value?.content ?? "", /CONFIG01_API_OWNED/);
	assert.equal(found.github.value.error, null);
}

for (const row of [
	{ id: "explicit agent precedes every competing file", mode: "explicit", files: ["explicit", "xdg", "agent", "legacy"], selected: "explicit" },
	{ id: "missing explicit agent never falls back", mode: "explicit", files: ["xdg", "agent", "legacy"], target: "explicit" },
	{ id: "XDG precedes legacy and default agent", mode: "xdg", files: ["xdg", "agent", "legacy"], selected: "xdg" },
	{ id: "missing XDG falls back to legacy, not default agent", mode: "xdg", files: ["agent", "legacy"], selected: "legacy" },
	{ id: "new XDG target ignores a default-agent file", mode: "xdg", files: ["agent"], target: "xdg" },
	{ id: "empty XDG setup keeps the XDG target", mode: "xdg", files: [], target: "xdg" },
	{ id: "default agent precedes legacy", files: ["agent", "legacy"], selected: "agent" },
	{ id: "legacy remains supported without an agent file", files: ["legacy"], selected: "legacy" },
	{ id: "empty default setup targets the agent directory", files: [], target: "agent" },
	{ id: "empty selector variables act as unset", files: ["legacy"], selected: "legacy", empty: true },
]) test("config discovery: " + row.id, async t => {
	const f = await fixture(t);
	for (const location of row.files) await f.write(location, profile(location, location === row.selected));
	const found = f.run(observe, { ...f.env(row.mode), ...(row.empty ? { PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "" } : {}) });
	if (row.selected) assertSelected(found, row.selected);
	else assertMissing(found, join(f.dirs[row.target], configName));
	t.diagnostic(JSON.stringify({ policy: row.id, requests: found.requests, commands: found.commands }));
});

const readers = {
	search: 'await (await load("search")).search("invalid selected config")',
	exa: '(await load("exa")).hasExaApiKey()',
	perplexity: '(await load("perplexity")).isPerplexityAvailable()',
	github: 'await (await load("github-extract")).extractGitHub(' + JSON.stringify(shaUrl) + ")",
	extract: 'await (await load("extract")).extractContent(' + JSON.stringify(shaUrl) + ")",
};
for (const [location, mode] of [["explicit", "explicit"], ["xdg", "xdg"], ["agent", "default"]]) {
	for (const raw of ["[]", "{invalid"]) {
		for (const [reader, expression] of Object.entries(readers)) {
			test("malformed selected " + location + " config: " + reader + " " + raw, async t => {
				const f = await fixture(t);
				await f.write("legacy", profile("legacy"));
				await f.write(location, raw);
				const found = f.run("const result = await attempt(async () => " + expression + "); console.log(JSON.stringify({ result, requests, commands: commands() }));", f.env(mode));
				const message = found.result.error?.message ?? found.result.value?.error ?? "";
				assert.ok(message.startsWith("Failed to parse " + join(f.dirs[location], configName) + ":"), message);
				if (raw === "[]") assert.match(message, /expected a JSON object/);
				assert.deepEqual(found.requests, [], "invalid selected config must not trigger provider or HTTP fallback");
				assert.deepEqual(found.commands, [], "invalid selected config must not trigger GitHub work");
			});
		}
	}
}

for (const [mode, higher] of [["xdg", "xdg"], ["default", "agent"]]) {
	test("legacy selection stays shared when a later " + higher + " file appears", async t => {
		const f = await fixture(t);
		await f.write("legacy", profile("legacy"));
		const found = f.run([
			'await load("exa");',
			"mkdirSync(dirs." + higher + ", { recursive: true });",
			"writeFileSync(join(dirs." + higher + ", " + JSON.stringify(configName) + "), " + JSON.stringify(JSON.stringify(profile(higher, false))) + ");",
			observe,
		].join("\n"), f.env(mode));
		assertSelected(found, "legacy");
	});
	test("fresh " + higher + " target does not switch to a newly created legacy file", async t => {
		const f = await fixture(t);
		const found = f.run([
			'await attempt(() => load("perplexity").then(module => module.searchWithPerplexity("pin fresh target")));',
			"mkdirSync(dirs.legacy, { recursive: true });",
			"writeFileSync(join(dirs.legacy, " + JSON.stringify(configName) + "), " + JSON.stringify(JSON.stringify(profile("legacy"))) + ");",
			observe,
		].join("\n"), f.env(mode));
		assertMissing(found, join(f.dirs[higher], configName));
	});
}

for (const provider of ["exa", "perplexity"]) {
	for (const kind of ["environment over literal", "explicit variable", "explicit command", "missing explicit variable"]) {
		test("selected config retains " + provider + " credential semantics: " + kind, async t => {
			const f = await fixture(t);
			const marker = join(f.root, "credential-ran"), token = join(f.root, "credential-value"), command = join(f.root, "credential.mjs");
			await writeFile(token, "synthetic-source-first");
			await writeFile(command, [
				'import { appendFileSync, readFileSync } from "node:fs";',
				"appendFileSync(" + JSON.stringify(marker) + ', "ran\\n");',
				"process.stdout.write(readFileSync(" + JSON.stringify(token) + ', "utf8"));',
			].join("\n"));
			const configured = kind === "explicit command" ? "!node " + JSON.stringify(command)
				: kind === "explicit variable" ? "$CONFIG01_TOKEN"
					: kind === "missing explicit variable" ? "$CONFIG01_MISSING" : "synthetic-literal";
			await f.write("explicit", { [provider + "ApiKey"]: configured });
			const operation = provider === "exa" ? 'module.searchWithExa("credential")' : 'module.searchWithPerplexity("credential")';
			const available = provider === "exa" ? "module.hasExaApiKey()" : "module.isPerplexityAvailable()";
			const variable = provider === "exa" ? "EXA_API_KEY" : "PERPLEXITY_API_KEY";
			const found = f.run([
				"const module = await load(" + JSON.stringify(provider) + ");",
				"const available = " + available + ", ranDuringAvailability = existsSync(" + JSON.stringify(marker) + ");",
				"const first = await attempt(() => " + operation + ");",
				"process.env." + variable + ' = "synthetic-environment-second"; process.env.CONFIG01_TOKEN = "synthetic-source-second";',
				"writeFileSync(" + JSON.stringify(token) + ', "synthetic-source-second");',
				"const second = await attempt(() => " + operation + ");",
				"console.log(JSON.stringify({ available, ranDuringAvailability, first, second, requests }));",
			].join("\n"), { ...f.env("explicit"), [variable]: "synthetic-environment-first", CONFIG01_TOKEN: "synthetic-source-first" });
			assert.equal(found.available, true);
			assert.equal(found.ranDuringAvailability, false);
			if (kind === "missing explicit variable") {
				assert.equal(found.first.error?.category, "environment-empty");
				assert.equal(found.second.error?.category, "environment-empty");
				assert.deepEqual(found.requests, []);
			} else {
				assert.equal(found.first.error, undefined);
				assert.equal(found.second.error, undefined);
				const prefix = provider === "exa" ? "" : "Bearer ";
				const expected = kind === "environment over literal" ? ["synthetic-environment-first", "synthetic-environment-second"] : ["synthetic-source-first", "synthetic-source-second"];
				assert.deepEqual(found.requests.map(request => request.key), expected.map(value => prefix + value));
			}
			assert.equal(existsSync(marker), kind === "explicit command");
			if (kind === "explicit command") assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), ["ran", "ran"]);
		});
	}
}

const clonePaths = f => [
	{ id: "leading home", value: "~/Owned Cache", expected: join(f.home, "Owned Cache") },
	{ id: "bare home", value: "~", expected: f.home },
	{ id: "HOME variable", value: "$HOME/repos", expected: join(f.home, "repos") },
	{ id: "multiple variables", value: "$CONFIG01_CACHE/$CONFIG01_NAME/repos", env: { CONFIG01_CACHE: join(f.root, "cache"), CONFIG01_NAME: "Name With Spaces" }, expected: join(f.root, "cache", "Name With Spaces", "repos") },
	{ id: "lowercase variable", value: "$config01_cache/repos", env: { config01_cache: join(f.root, "lower") }, expected: join(f.root, "lower", "repos") },
	{ id: "empty defined variable", value: join(f.root, "$CONFIG01_EMPTY", "repos"), env: { CONFIG01_EMPTY: "" }, expected: join(f.root, "repos") },
	{ id: "trim before expansion", value: "  $HOME/trimmed  ", expected: join(f.home, "trimmed") },
	{ id: "unknown variable stays literal", value: "$CONFIG01_UNKNOWN/repos", expected: join(f.cwd, "$CONFIG01_UNKNOWN", "repos") },
	{ id: "braced variable stays literal", value: "$" + "{HOME}/repos", expected: join(f.cwd, "$" + "{HOME}", "repos") },
	{ id: "user-qualified tilde stays literal", value: "~other/repos", expected: join(f.cwd, "~other", "repos") },
	{ id: "nonleading tilde stays literal", value: "prefix~/repos", expected: join(f.cwd, "prefix~", "repos") },
	{ id: "absolute path", value: join(f.root, "absolute"), expected: join(f.root, "absolute") },
	{ id: "relative path", value: "relative/../repos", expected: resolve(f.cwd, "repos") },
	{ id: "variable values are argv, not shell", value: "$CONFIG01_CACHE", env: { CONFIG01_CACHE: join(f.root, "cache $(touch SHELL_RAN); literal") }, expected: join(f.root, "cache $(touch SHELL_RAN); literal") },
];
for (const route of ["gh", "git"]) {
	for (let index = 0; index < clonePaths({ home: "", root: "", cwd: "" }).length; index++) {
		test("expanded " + route + " clone destination: " + clonePaths({ home: "", root: "", cwd: "" })[index].id, async t => {
			const f = await fixture(t), row = clonePaths(f)[index];
			await f.write("legacy", { githubClone: { clonePath: row.value } });
			await mkdir(row.expected, { recursive: true });
			await writeFile(join(row.expected, "keep"), "CONFIG01_SIBLING");
			const found = f.run([
				'const { createGitHubCloneSession, disposeGitHubCloneSession, extractGitHub } = await load("github-extract");',
				"const session = createGitHubCloneSession();",
				"let first, readme, escaped;",
				"try {",
				'  first = await extractGitHub("https://github.com/owner/repo/tree/main", undefined, true, session);',
				'  readme = await extractGitHub("https://github.com/owner/repo/blob/main/README.md", undefined, true, session);',
				'  escaped = await extractGitHub("https://github.com/owner/repo/blob/main/escape.txt", undefined, true, session);',
				"} finally { await disposeGitHubCloneSession(session); }",
				'const cloneCommands = commands().filter(command => command.args[0] === "clone" || command.args[0] === "repo");',
				'const destination = cloneCommands[0]?.tool === "gh" ? cloneCommands[0].args[3] : cloneCommands[0]?.args.at(-1);',
				"console.log(JSON.stringify({ first, readme, escaped, cloneCommands, destination,",
				"  expectedParent: realpathSync(" + JSON.stringify(row.expected) + "),",
				'  runtimeRemoved: destination ? !existsSync(dirname(destination)) : false,',
				"  sibling: readFileSync(" + JSON.stringify(join(row.expected, "keep")) + ', "utf8"),',
				'  outside: readFileSync(join(root, "outside-marker"), "utf8"), shellExecuted: existsSync("SHELL_RAN") }));',
			].join("\n"), { PI_CODING_AGENT_DIR: f.dirs.legacy, CONFIG01_ROUTE: route, ...row.env });
			assert.equal(found.first?.error, null);
			assert.equal(found.readme?.error, null);
			assert.match(found.readme.content, /CONFIG01_CLONE_OWNED/);
			assert.equal(found.cloneCommands.length, 1, "same ref must share a single owned clone");
			assert.equal(found.cloneCommands[0].tool, route);
			assert.equal(dirname(dirname(found.destination)), found.expectedParent);
			assert.ok(dirname(found.destination).startsWith(join(found.expectedParent, "runtime-")));
			assert.match(found.destination.slice(dirname(found.destination).length + 1), /^[0-9a-f]{64}$/);
			assert.equal(found.escaped?.error, null);
			assert.match(found.escaped.content, /not found in clone/);
			assert.equal(found.escaped.content.includes("CONFIG01_OUTSIDE_PRIVATE"), false);
			assert.equal(found.runtimeRemoved, true);
			assert.equal(found.sibling, "CONFIG01_SIBLING");
			assert.equal(found.outside, "CONFIG01_OUTSIDE_PRIVATE");
			assert.equal(found.shellExecuted, false);
			t.diagnostic(JSON.stringify({ pathCase: row.id, route, cloneCommands: found.cloneCommands, expectedParent: found.expectedParent, runtimeRemoved: found.runtimeRemoved }));
		});
	}
}
