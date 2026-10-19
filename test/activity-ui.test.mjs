import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-activity-ui-")));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
		t.diagnostic(JSON.stringify({ boundary: "isolated host facade, not native Pi", fixtureRemoved: true, root }));
	});
	const home = join(root, "home"), cwd = join(root, "cwd");
	const dirs = { explicit: join(root, "agent"), xdg: join(root, "xdg", "pi"), agent: join(home, ".pi", "agent"), legacy: join(home, ".pi") };
	for (const path of [home, cwd, ...Object.values(dirs)]) await mkdir(path, { recursive: true });
	return {
		dirs,
		async write(location, value) {
			await writeFile(join(dirs[location], "web-search.json"), typeof value === "string" ? value : JSON.stringify(value));
		},
		run(script, env = {}) {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				cwd, encoding: "utf8",
				env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: dirs.explicit, ...env },
				input: [
					'import assert from "node:assert/strict";',
					'import dns from "node:dns/promises";',
					'import { syncBuiltinESMExports } from "node:module";',
					'dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }]; syncBuiltinESMExports();',
					"const requests = [], writes = [], staleWrites = [], stale = new Set();",
					"globalThis.fetch = async (input, init) => {",
					'  const url = new URL(input); assert.equal(url.hostname, "ui01.example.test", "Unexpected network destination");',
					"  requests.push(url.href);",
					'  return new Response(url.pathname === "/ok" ? "# Owned title\\n\\nOwned body." : "Unavailable", { status: url.pathname === "/ok" ? 200 : 503, headers: { "content-type": "text/plain" } });',
					"};",
					"const { default: initialize } = await import(new URL('index.ts', " + JSON.stringify(source) + "));",
					"const { activityMonitor } = await import(new URL('activity.ts', " + JSON.stringify(source) + "));",
					"function context(id) { return { id, mode: 'tui', hasUI: true, ui: {",
					"  theme: { fg: (_color, text) => text },",
					"  setWidget(key, content) {",
					"    if (stale.has(id)) { staleWrites.push(id); throw new Error('Stale context: ' + id); }",
					"    assert.ok(content === undefined || Array.isArray(content), 'Widget must use the string-array API');",
					"    writes.push({ id, key, content: content ?? null });",
					"  },",
					"} }; }",
					"const instances = [];",
					"function instance(id) {",
					"  const tools = new Map(), handlers = new Map(), shortcuts = new Map();",
					"  initialize({",
					"    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },",
					"    registerTool(tool) { tools.set(tool.name, tool); },",
					"    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },",
					"  });",
					"  const host = { tools, shortcuts, current: context(id),",
					"    async emit(name, ctx = this.current) {",
					"      this.current = ctx;",
					"      for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);",
					"    },",
					"    async toggle(ctx = this.current) { this.current = ctx; await [...shortcuts.values()][0].handler(ctx); },",
					"  };",
					"  instances.push(host); return host;",
					"}",
					"function render(result, isPartial = false, expanded = false) {",
					"  const colors = [], theme = { fg: (color, text) => { colors.push(color); return text; } };",
					"  const text = a.tools.get('fetch_content').renderResult(result, { isPartial, expanded }, theme).render(80).map(line => line.trimEnd()).join('\\n');",
					"  return { text, colors };",
					"}",
					"const last = id => writes.filter(write => write.id === id).at(-1);",
					"const log = query => activityMonitor.logStart({ type: 'api', query });",
					"let a, initError;",
					"try { a = instance('a'); } catch (error) { initError = error.message; }",
					"try {",
					script,
					"} finally { for (const host of instances) await host.emit('session_shutdown'); }",
				].join("\n"),
			});
			assert.equal(child.status, 0, child.error?.message || child.stderr);
			const observed = JSON.parse(child.stdout);
			t.diagnostic(JSON.stringify({ observation: observed }));
			return observed;
		},
	};
}

for (const row of [
	{ name: "missing config", files: {}, expected: "ctrl+shift+w" },
	{ name: "missing shortcuts", files: { explicit: {} }, expected: "ctrl+shift+w" },
	{ name: "missing activity setting", files: { explicit: { shortcuts: {} } }, expected: "ctrl+shift+w" },
	{ name: "explicit selected file", files: { explicit: { shortcuts: { activity: "alt+w" } }, legacy: { shortcuts: { activity: "alt+l" } } }, expected: "alt+w" },
	{ name: "missing explicit file never uses legacy", files: { legacy: { shortcuts: { activity: "alt+l" } } }, expected: "ctrl+shift+w" },
	{ name: "XDG selected file", mode: "xdg", files: { xdg: { shortcuts: { activity: "alt+x" } }, legacy: { shortcuts: { activity: "alt+l" } } }, expected: "alt+x" },
	{ name: "XDG legacy fallback", mode: "xdg", files: { legacy: { shortcuts: { activity: "alt+l" } }, agent: { shortcuts: { activity: "alt+a" } } }, expected: "alt+l" },
	{ name: "default agent selected file", mode: "default", files: { agent: { shortcuts: { activity: "alt+a" } }, legacy: { shortcuts: { activity: "alt+l" } } }, expected: "alt+a" },
	{ name: "legacy without agent file", mode: "default", files: { legacy: { shortcuts: { activity: "alt+l" } } }, expected: "alt+l" },
]) test("activity shortcut config: " + row.name, async t => {
	const f = await fixture(t);
	for (const [location, value] of Object.entries(row.files)) await f.write(location, value);
	const env = row.mode ? { PI_CODING_AGENT_DIR: "", ...(row.mode === "xdg" ? { XDG_CONFIG_HOME: join(f.dirs.xdg, "..") } : {}) } : {};
	const found = f.run("console.log(JSON.stringify({ keys: [...a.shortcuts.keys()], tools: [...a.tools.keys()], requests }));", env);
	assert.deepEqual(found.keys, [row.expected]);
	assert.deepEqual(found.tools, ["web_search", "code_search", "fetch_content"]);
	assert.deepEqual(found.requests, []);
});

for (const key of ["alt+w", "ctrl+shift+f5", "super+k", "ctrl++", "pageUp"]) {
	test("activity shortcut accepts host key syntax: " + key, async t => {
		const f = await fixture(t);
		await f.write("explicit", { shortcuts: { activity: key }, exaApiKey: "!ui01-credential-must-not-execute" });
		const found = f.run("console.log(JSON.stringify({ keys: [...a.shortcuts.keys()], requests }));");
		assert.deepEqual(found.keys, [key]);
		assert.deepEqual(found.requests, []);
	});
}

for (const [name, config] of [
	["invalid JSON without leaking credentials", '{"exaApiKey":"UI01_SECRET", invalid}'],
	["array root", "[]"], ["null root", "null"],
	["non-object shortcuts", { shortcuts: "UI01_SECRET" }],
	["array shortcuts", { shortcuts: [] }], ["null shortcuts", { shortcuts: null }],
	["non-string activity", { shortcuts: { activity: 42 } }],
	["null activity", { shortcuts: { activity: null } }],
	["empty activity", { shortcuts: { activity: "" } }],
	["whitespace activity", { shortcuts: { activity: " " } }],
	["unknown key", { shortcuts: { activity: "UI01_SECRET" } }],
	["unknown modifier", { shortcuts: { activity: "cmd+w" } }],
	["repeated modifier", { shortcuts: { activity: "ctrl+ctrl+w" } }],
]) test("invalid activity config is explicit: " + name, async t => {
	const f = await fixture(t);
	await f.write("explicit", config);
	await f.write("legacy", { shortcuts: { activity: "alt+l" } });
	const found = f.run("console.log(JSON.stringify({ initError, requests }));");
	assert.ok(found.initError?.startsWith("Failed to parse " + join(f.dirs.explicit, "web-search.json") + ":"), found.initError);
	assert.doesNotMatch(found.initError, /UI01_SECRET/);
	assert.deepEqual(found.requests, []);
});

for (const event of ["session_start", "session_tree"]) {
	test("visible activity detaches, clears and rebinds on " + event, async t => {
		const f = await fixture(t);
		const found = f.run([
			"await a.emit('session_start'); await a.toggle(); const oldId = log('old-session');",
			"stale.add('a'); const b = context('b'); await a.emit(" + JSON.stringify(event) + ", b);",
			"const empty = last('b'), oldWrites = writes.filter(write => write.id === 'a').length;",
			"log('new-session'); activityMonitor.logComplete(oldId, 200);",
			"console.log(JSON.stringify({ empty, current: last('b'), entries: activityMonitor.getEntries(), oldWrites, finalOldWrites: writes.filter(write => write.id === 'a').length, staleWrites }));",
		].join("\n"));
		assert.deepEqual(found.staleWrites, []);
		assert.equal(found.finalOldWrites, found.oldWrites);
		assert.match(found.empty?.content.join("\n") ?? "", /No activity yet/);
		assert.match(found.current?.content.join("\n") ?? "", /new-session/);
		assert.doesNotMatch(found.current.content.join("\n"), /old-session/);
		assert.deepEqual(found.entries.map(entry => entry.query), ["new-session"]);
	});
}

test("hidden activity clears on tree navigation and stays hidden until toggled", async t => {
	const f = await fixture(t);
	const found = f.run([
		"log('old-hidden'); await a.emit('session_tree', context('tree'));",
		"const hiddenWrites = writes.length, entries = activityMonitor.getEntries(); await a.toggle();",
		"console.log(JSON.stringify({ hiddenWrites, entries, visible: last('tree') }));",
	].join("\n"));
	assert.equal(found.hiddenWrites, 0);
	assert.deepEqual(found.entries, []);
	assert.match(found.visible.content.join("\n"), /No activity yet/);
});

test("toggling activity off releases the subscription", async t => {
	const f = await fixture(t);
	const found = f.run([
		"await a.toggle(); log('visible'); await a.toggle(); const hidden = last('a'), count = writes.length;",
		"log('after-hide'); console.log(JSON.stringify({ hidden, count, finalCount: writes.length }));",
	].join("\n"));
	assert.equal(found.hidden.content, null);
	assert.equal(found.finalCount, found.count);
});

test("activity shutdown clears, hides, detaches and resets the next toggle", async t => {
	const f = await fixture(t);
	const found = f.run([
		"await a.emit('session_start'); await a.toggle(); log('old-session'); const before = writes.length;",
		"await a.emit('session_shutdown'); const stopped = writes.slice(before), entries = [...activityMonitor.getEntries()];",
		"stale.add('a'); log('after-shutdown'); await a.emit('session_shutdown');",
		"await a.emit('session_start', context('restart')); const beforeToggle = writes.length; await a.toggle();",
		"console.log(JSON.stringify({ stopped, entries, staleWrites, beforeToggle, current: last('restart') }));",
	].join("\n"));
	assert.deepEqual(found.entries, []);
	assert.deepEqual(found.staleWrites, []);
	assert.deepEqual(found.stopped, [{ id: "a", key: "web-activity", content: null }]);
	assert.match(found.current?.content.join("\n") ?? "", /No activity yet/);
});

test("overlapping extension hosts own independent toggles and subscriptions", async t => {
	const f = await fixture(t);
	const found = f.run([
		"const b = instance('b'); await a.emit('session_start'); await b.emit('session_start');",
		"await a.toggle(); await b.toggle(); log('both-visible');",
		"const both = [last('a'), last('b')]; await a.emit('session_shutdown'); stale.add('a');",
		"log('b-survives'); const surviving = last('b'); await b.toggle();",
		"console.log(JSON.stringify({ both, surviving, hiddenB: last('b'), staleWrites }));",
	].join("\n"));
	assert.ok(found.both.every(write => Array.isArray(write?.content)));
	assert.match(found.surviving.content.join("\n"), /b-survives/);
	assert.equal(found.hiddenB.content, null);
	assert.deepEqual(found.staleWrites, []);
});

for (const expanded of [false, true]) {
	test("actual fetch update renders progress, not success; expanded=" + expanded, async t => {
		const f = await fixture(t);
		const found = f.run([
			"const updates = []; await a.tools.get('fetch_content').execute('progress', { urls: ['https://ui01.example.test/ok', 'https://ui01.example.test/fail'] }, undefined, update => updates.push(update));",
			"console.log(JSON.stringify({ update: updates[0], rendered: render(updates[0], true, " + expanded + "), requests }));",
		].join("\n"));
		assert.equal(found.rendered.text, "Fetching 2 URL(s)...");
		assert.deepEqual(found.rendered.colors, ["accent"]);
		assert.doesNotMatch(found.rendered.text, /content fetched|chars|undefined/);
		assert.equal(found.requests.length, 2);
	});
}

test("partial fetch without content or details still renders pending work", async t => {
	const f = await fixture(t);
	const found = f.run("console.log(JSON.stringify(render({ content: [], details: undefined }, true)));");
	assert.equal(found.text, "Fetching...");
	assert.deepEqual(found.colors, ["accent"]);
});

for (const [name, paths, summary, color] of [
	["all failed", ["/fail", "/fail-again"], "0/2 URLs", "error"],
	["mixed", ["/ok", "/fail"], "1/2 URLs", "success"],
	["all succeeded", ["/ok", "/ok?again"], "2/2 URLs", "success"],
]) test("final multi-fetch rendering: " + name, async t => {
	const f = await fixture(t);
	const found = f.run([
		"const result = await a.tools.get('fetch_content').execute('final', { urls: " + JSON.stringify(paths.map(path => "https://ui01.example.test" + path)) + " });",
		"console.log(JSON.stringify({ result, collapsed: render(result), expanded: render(result, false, true) }));",
	].join("\n"));
	assert.equal(found.result.isError === true, color === "error");
	for (const rendered of [found.collapsed, found.expanded]) {
		assert.equal(rendered.text, summary);
		assert.deepEqual(rendered.colors, [color]);
	}
});

test("final single-fetch rendering retains title, full length and explicit error", async t => {
	const f = await fixture(t);
	const found = f.run([
		"const tool = a.tools.get('fetch_content');",
		"const success = await tool.execute('success', { url: 'https://ui01.example.test/ok' });",
		"const failure = await tool.execute('failure', { url: 'https://ui01.example.test/fail' });",
		"console.log(JSON.stringify({ success: render(success), failure: render(failure), failed: failure.isError }));",
	].join("\n"));
	assert.equal(found.success.text, "Owned title (26 chars)");
	assert.deepEqual(found.success.colors, ["success", "muted"]);
	assert.match(found.failure.text, /^Error: HTTP 503/);
	assert.deepEqual(found.failure.colors, ["error"]);
	assert.equal(found.failed, true);
});
