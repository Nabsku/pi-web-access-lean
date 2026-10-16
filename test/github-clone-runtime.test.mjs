import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;
const indexModuleUrl = new URL("../index.ts", import.meta.url).href;

async function fixture(t, route) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-github-runtime-")));
	const runners = [];
	t.after(async () => {
		try {
			await writeFile(join(root, "release-a"), "release");
			await writeFile(join(root, "release-sweep"), "release");
			await Promise.all(runners.map(async (runner) => {
				if (runner.child.exitCode === null && runner.child.signalCode === null) await runner.call("close");
				await runner.exited;
			}));
			const recordsPath = join(root, "processes.jsonl");
			const identities = existsSync(recordsPath) ? readFileSync(recordsPath, "utf8").trim().split("\n").map(JSON.parse) : [];
			const states = identities.map((identity) => {
				const result = spawnSync("/bin/ps", ["-ww", "-p", String(identity.pid), "-o", "stat=", "-o", "command="], { encoding: "utf8" });
				assert.ok(result.status === 0 || result.status === 1, result.error?.message || result.stderr);
				const [state, ...command] = result.stdout.trim().split(/\s+/);
				return { ...identity, alive: result.status === 0 && !state.startsWith("Z") && command.join(" ").includes(identity.executable) };
			});
			const sentinelsPreserved = readFileSync(join(root, "cache", "keep"), "utf8") === "sibling"
				&& readFileSync(join(root, "outside", "keep"), "utf8") === "outside";
			t.diagnostic(JSON.stringify({ root, states, sentinelsPreserved }));
			assert.ok(states.every(({ alive }) => !alive), JSON.stringify(states));
			assert.equal(sentinelsPreserved, true);
		} finally {
			await rm(root, { recursive: true, force: true });
			t.diagnostic(JSON.stringify({ fixtureDirectoryRemoved: !existsSync(root), root }));
		}
	});
	await Promise.all(["home/.pi", "bin", "cache", "outside"].map((path) => mkdir(join(root, path), { recursive: true })));
	await Promise.all([
		symlink(process.execPath, join(root, "bin", "node")),
		writeFile(join(root, "home", ".pi", "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "cache") } })),
		writeFile(join(root, "cache", "keep"), "sibling"),
		writeFile(join(root, "outside", "keep"), "outside"),
	]);
	const executable = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.RUNTIME_FIXTURE_ROOT;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const identity = { pid: process.pid, executable: process.argv[1] };
fs.appendFileSync(path.join(root, "processes.jsonl"), JSON.stringify(identity) + "\\n");
if (args[0] === "--version") process.exit(process.env.RUNTIME_FIXTURE_ROUTE === "git" ? 1 : 0);
if (args[0] === "api") {
	const values = { ".default_branch": "main", ".tree[].path": "README.md", ".content": Buffer.from("api fixture").toString("base64") };
	if (!(args.at(-1) in values)) throw new Error("Unexpected fixture API request");
	process.stdout.write(values[args.at(-1)]);
	return;
}
const destination = tool === "gh" && args[0] === "repo" && args[1] === "clone" ? args[3] : tool === "git" && args[0] === "clone" ? args.at(-1) : null;
if (!destination || !path.resolve(destination).startsWith(path.join(root, "cache") + path.sep)) throw new Error("Unsafe runtime-fixture destination");
const instance = process.env.RUNTIME_FIXTURE_INSTANCE;
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, "README.md"), instance);
const ready = path.join(root, "started-" + instance);
const temporary = ready + "." + process.pid;
fs.writeFileSync(temporary, JSON.stringify({ ...identity, destination }));
fs.renameSync(temporary, ready);
if (process.env.RUNTIME_FIXTURE_FAIL === "1") process.exit(1);
if (process.env.RUNTIME_FIXTURE_HOLD === "1") {
	const check = () => { if (fs.existsSync(path.join(root, "release-" + instance))) { watcher.close(); process.exit(0); } };
	const watcher = fs.watch(root, check);
	check();
}
`;
	await Promise.all(["gh", "git"].map((name) => writeFile(join(root, "bin", name), executable, { mode: 0o755 })));
	const runnerPath = join(root, "runner.mjs");
	await writeFile(runnerPath, `
		import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
		import fs from "node:fs/promises";
		import { join } from "node:path";
		import { registerHooks, syncBuiltinESMExports } from "node:module";
		const root = process.env.RUNTIME_FIXTURE_ROOT;
		const waitFor = (name) => new Promise((resolve) => {
			const check = () => { if (existsSync(join(root, name))) { watcher.close(); resolve(); } };
			const watcher = watch(root, check);
			check();
		});
		if (process.env.RUNTIME_FIXTURE_SWEEP_TARGET) {
			const operation = process.env.RUNTIME_FIXTURE_SWEEP_OPERATION;
			const original = fs[operation];
			fs[operation] = async (path, ...args) => {
				if (path === process.env.RUNTIME_FIXTURE_SWEEP_TARGET) {
					writeFileSync(join(root, "sweep-blocked"), "blocked");
					await waitFor("release-sweep");
				}
				return original(path, ...args);
			};
			syncBuiltinESMExports();
		}
		const { extractGitHub, clearCloneCache } = await import(${JSON.stringify(extractModuleUrl)});
		globalThis.fetch = async () => { throw new Error("Network disabled in runtime fixture"); };
		async function lifecycle(phase) {
			const hook = phase === "unused" ? registerHooks({ resolve(specifier, context, next) { if (specifier.endsWith("/extract.ts")) throw new Error("Unused lifecycle eagerly loaded extraction"); return next(specifier, context); } }) : undefined;
			const initialize = (await import(${JSON.stringify(indexModuleUrl)})).default;
			const instances = [];
			function instance() {
				const handlers = new Map();
				const tools = new Map();
				initialize({ on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { tools.set(tool.name, tool); }, registerShortcut() {} });
				const value = { emit: (type) => handlers.get(type)?.({ type }), fetch: () => tools.get("fetch_content").execute("fixture", { url: "https://github.com/owner/repo", forceClone: true }), tools: [...tools.keys()] };
				instances.push(value);
				return value;
			}
			const pathOf = (result) => result?.content[0].text.match(/^Repository cloned to: (.+)$/m)?.[1];
			try {
				const a = instance();
				await a.emit("session_start");
				if (phase === "unused") {
					await a.emit("session_shutdown"); await a.emit("session_shutdown"); await a.emit("session_start");
					return { noCloneWork: !existsSync(join(root, "started-a")), tools: a.tools };
				}
				const pending = a.fetch();
				if (phase === "late-import") {
					await a.emit("session_shutdown");
					await a.emit("session_start");
					const old = await pending;
					return { aborted: old.content[0].text.includes("Aborted"), noCloneWork: !existsSync(join(root, "started-a")) };
				}
				await waitFor("started-a");
				const first = JSON.parse(readFileSync(join(root, "started-a"), "utf8")).destination;
				if (phase === "shutdown-in-flight") {
					await a.emit("session_shutdown");
					const result = await pending;
					return { aborted: result.content[0].text.includes("Aborted"), removed: !existsSync(first) };
				}
				if (phase === "returned") await pending;
				const b = instance();
				await b.emit("session_start");
				process.env.RUNTIME_FIXTURE_INSTANCE = "b";
				process.env.RUNTIME_FIXTURE_HOLD = "0";
				const resultB = await b.fetch();
				const second = pathOf(resultB);
				await b.emit("session_shutdown");
				const preserved = existsSync(join(first, "README.md")) && readFileSync(join(first, "README.md"), "utf8") === "a";
				writeFileSync(join(root, "release-a"), "release");
				const resultA = await pending;
				await a.emit("session_tree");
				const reusedAfterTree = pathOf(await a.fetch()) === first;
				await a.emit("session_shutdown");
				const removed = !existsSync(first) && !existsSync(second);
				const ended = await a.fetch();
				await a.emit("session_start");
				process.env.RUNTIME_FIXTURE_INSTANCE = "new-session";
				const fresh = await a.fetch();
				return { preserved, distinct: first !== second, firstReturned: pathOf(resultA) === first, reusedAfterTree, removed,
					endedAborted: ended.content[0].text.includes("Aborted"), fresh: pathOf(fresh) !== first && fresh.content[0].text.includes("new-session") };
			} finally {
				writeFileSync(join(root, "release-a"), "release");
				for (const value of instances) await value.emit("session_shutdown");
				hook?.deregister();
			}
		}
		process.on("message", async ({ id, action, phase }) => {
			try {
				const result = action === "extract" ? await extractGitHub("https://github.com/owner/repo", undefined, true)
					: action === "lifecycle" ? await lifecycle(phase) : action === "exit" ? undefined : await clearCloneCache();
				process.send({ id, result }, () => { if (action === "close" || action === "exit") process.disconnect(); });
			} catch (error) { process.send({ id, error: error.stack }); }
		});
		process.send({ ready: true });
	`);
	async function start(instance, { hold = false, fail = false, sweepTarget, sweepOperation = "open" } = {}) {
		const pending = new Map();
		let id = 0;
		let stderr = "";
		const child = spawn(process.execPath, [runnerPath], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), PATH: join(root, "bin"), NODE_OPTIONS: "",
				RUNTIME_FIXTURE_ROOT: root, RUNTIME_FIXTURE_ROUTE: route, RUNTIME_FIXTURE_INSTANCE: instance,
				RUNTIME_FIXTURE_HOLD: hold ? "1" : "0", RUNTIME_FIXTURE_FAIL: fail ? "1" : "0", RUNTIME_FIXTURE_SWEEP_TARGET: sweepTarget, RUNTIME_FIXTURE_SWEEP_OPERATION: sweepOperation },
		});
		child.stderr.on("data", (data) => { stderr += data; });
		const exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => {
				const error = new Error(`Runtime fixture exited ${code}: ${stderr}`);
				for (const { reject } of pending.values()) reject(error);
				pending.clear();
				if (code === 0) resolve(); else reject(error);
			});
		});
		// Attach rejection observation now, including when startup fails before a request.
		exited.catch(() => {});
		const ready = new Promise((resolve, reject) => {
			child.on("message", (message) => {
				if (message.ready) { resolve(); return; }
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
			});
			exited.then(() => reject(new Error("Runner exited before ready")), reject);
		});
		const runner = { child, exited, get stderr() { return stderr; }, call(action, phase) {
			return new Promise((resolve, reject) => {
				const requestId = ++id;
				pending.set(requestId, { resolve, reject });
				child.send({ id: requestId, action, phase }, (error) => { if (error) { pending.delete(requestId); reject(error); } });
			});
		} };
		runners.push(runner);
		await ready;
		return runner;
	}
	function started(instance) {
		return new Promise((resolve) => {
			const path = join(root, "started-" + instance);
			const check = () => { if (existsSync(path)) { watcher.close(); resolve(JSON.parse(readFileSync(path, "utf8"))); } };
			const watcher = watch(root, check);
			check();
		});
	}
	return { root, start, started };
}

for (const phase of ["returned", "in-flight", "shutdown-in-flight", "late-import", "unused"]) {
	test(`session lifecycle: ${phase}`, { skip: process.platform === "win32" }, async (t) => {
		const f = await fixture(t, "gh");
		const runner = await f.start("a", { hold: phase.includes("in-flight") });
		const result = await runner.call("lifecycle", phase);
		t.diagnostic(JSON.stringify({ phase, result }));
		for (const [field, value] of Object.entries(result)) {
			if (field === "tools") assert.deepEqual(value, ["web_search", "code_search", "fetch_content"]);
			else assert.equal(value, true, field);
		}
	});
}

test("stale cleanup removes only a proven-dead local owner", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t, "gh");
	const crashed = await f.start("crashed");
	const deadRoot = dirname(clonePath(await crashed.call("extract")));
	assert.equal(existsSync(join(deadRoot, ".owner.json")), true, "clones need versioned owner metadata");
	const ownerText = readFileSync(join(deadRoot, ".owner.json"), "utf8");
	const owner = JSON.parse(ownerText);
	await crashed.call("exit");
	await crashed.exited;
	const cache = join(f.root, "cache");
	const preserve = [];
	async function seed(name, text) {
		const path = join(cache, name);
		await mkdir(path);
		await writeFile(join(path, "keep"), name);
		if (text !== undefined) await writeFile(join(path, ".owner.json"), text);
		preserve.push(path);
		return path;
	}
	await seed("runtime-live", JSON.stringify({ ...owner, pid: process.pid }));
	await seed("runtime-same-hostname-unproven", JSON.stringify({ ...owner, bootId: undefined }));
	await seed("runtime-foreign-boot", JSON.stringify({ ...owner, bootId: "00000000-0000-0000-0000-000000000000" }));
	await seed("runtime-foreign-host", JSON.stringify({ ...owner, hostname: "foreign-host" }));
	await seed("runtime-foreign-platform", JSON.stringify({ ...owner, platform: "other" }));
	await seed("runtime-unknown-version", JSON.stringify({ ...owner, version: "unknown" }));
	await seed("runtime-invalid-pid", JSON.stringify({ ...owner, pid: -owner.pid }));
	await seed("runtime-malformed", "{");
	await seed("runtime-ownerless");
	await seed("runtime-oversized", ownerText + " ".repeat(Buffer.byteLength(ownerText)));
	await seed("legacy-clone", ownerText);
	const unreadable = await seed("runtime-unreadable", ownerText);
	await chmod(join(unreadable, ".owner.json"), 0);
	let permissionReadDenied = false;
	try { await readFile(join(unreadable, ".owner.json")); }
	catch (error) {
		if (!["EACCES", "EPERM"].includes(error.code)) throw error;
		permissionReadDenied = true;
	}
	if (!permissionReadDenied) preserve.splice(preserve.indexOf(unreadable), 1);
	await symlink(join(f.root, "outside"), join(cache, "runtime-symlink"), "dir");
	preserve.push(join(cache, "runtime-symlink"));
	const symlinkOwner = await seed("runtime-symlink-owner");
	await writeFile(join(f.root, "outside", "owner.json"), ownerText);
	await symlink(join(f.root, "outside", "owner.json"), join(symlinkOwner, ".owner.json"));
	const b = await f.start("b");
	const result = await b.call("extract");
	assert.ok(clonePath(result));
	await b.call("clear");
	const preserved = preserve.map((path) => ({ path, exists: existsSync(path) }));
	t.diagnostic(JSON.stringify({ deadRoot, removed: !existsSync(deadRoot), preserved, permissionReadDenied, ownerBytes: Buffer.byteLength(ownerText) }));
	assert.equal(existsSync(deadRoot), false);
	assert.ok(preserved.every(({ exists }) => exists));
	assert.equal(existsSync(unreadable), permissionReadDenied);
	assert.match(b.stderr, /metadata read budget exceeded \(configured: \d+ bytes; observed: \d+ bytes\).*Preserving unknown runtime/);
	assert.deepEqual((await readdir(cache)).filter((name) => !preserve.includes(join(cache, name))), ["keep"]);
});

for (const operation of ["open", "rm"]) test(`clone creation does not await stale ${operation}, but cleanup joins it`, { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t, "gh");
	const crashed = await f.start("crashed");
	const deadRoot = dirname(clonePath(await crashed.call("extract")));
	assert.equal(existsSync(join(deadRoot, ".owner.json")), true);
	await crashed.call("exit");
	await crashed.exited;
	const b = await f.start("b", { sweepTarget: operation === "open" ? join(deadRoot, ".owner.json") : deadRoot, sweepOperation: operation });
	const result = await b.call("extract");
	assert.ok(clonePath(result), "clone completes without releasing the sweep gate");
	assert.equal(existsSync(join(f.root, "sweep-blocked")), true);
	const clearing = b.call("clear");
	await writeFile(join(f.root, "release-sweep"), "release");
	await clearing;
	assert.equal(existsSync(deadRoot), false);
	assert.equal(existsSync(clonePath(result)), false);
});

test("cleanup tolerates a cache parent disappearing before its sweep opens", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t, "gh");
	const cache = join(f.root, "cache");
	const retired = join(f.root, "retired-cache");
	const runner = await f.start("b", { sweepTarget: cache, sweepOperation: "opendir" });
	await runner.call("extract");
	assert.equal(existsSync(join(f.root, "sweep-blocked")), true);
	await rename(cache, retired);
	let error;
	try {
		await writeFile(join(f.root, "release-sweep"), "release");
		try { await runner.call("clear"); } catch (failure) { error = failure.message; }
	} finally {
		await rename(retired, cache);
	}
	assert.equal(error, undefined, error);
});

const clonePath = (result) => result?.content.match(/^Repository cloned to: (.+)$/m)?.[1];

for (const route of ["gh", "git"]) {
	for (const phase of ["returned", "in-flight"]) {
		for (const outcome of ["success", "failure"]) {
			test(`${route}: another runtime's ${outcome}/clear preserves an ${phase} clone`, { skip: process.platform === "win32" }, async (t) => {
				const startAt = performance.now();
				const f = await fixture(t, route);
				const a = await f.start("a", { hold: phase === "in-flight" });
				const pendingA = a.call("extract");
				const first = await f.started("a");
				if (phase === "returned") await pendingA;
				const readyMs = performance.now() - startAt;
				const b = await f.start("b", { fail: outcome === "failure" });
				const resultB = await b.call("extract");
				const second = await f.started("b");
				await b.call("clear");
				const preserved = existsSync(join(first.destination, "README.md")) && readFileSync(join(first.destination, "README.md"), "utf8") === "a";
				await writeFile(join(f.root, "release-a"), "release");
				const resultA = await pendingA;
				t.diagnostic(JSON.stringify({ readyMs, elapsedMs: performance.now() - startAt, first, second, preserved }));
				assert.equal(preserved, true, "another runtime removed or overwrote the first checkout");
				assert.notEqual(first.destination, second.destination);
				assert.equal(clonePath(resultA), first.destination);
				assert.equal(resultA.error, null);
				assert.equal(!!clonePath(resultB), outcome === "success");
				assert.equal(existsSync(second.destination), false);
			});
		}
	}
}
