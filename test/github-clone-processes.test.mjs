import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;
const apiModuleUrl = new URL("../github-api.ts", import.meta.url).href;
// Local cold import/helper readiness <=275 ms, cooperative exit <=19 ms (Node 22).
// Outer tripwire covers the existing 5 s gh probe, clone ceiling, escalation and exit observation.
// Re-measure startup/exit before resizing; a tripwire failure reports timings and reclaims owned PIDs.
const CLONE_TIMEOUT_SECONDS = 2;
const RUNNER_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 2_000;
const POLL_MS = 25;

function records(root, name) {
	const path = join(root, name);
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

function processState(identity) {
	const observed = spawnSync("/bin/ps", ["-ww", "-p", String(identity.pid), "-o", "stat=", "-o", "command="], { encoding: "utf8" });
	if (observed.status === 1) return { ...identity, alive: false };
	assert.equal(observed.status, 0, observed.error?.message || observed.stderr);
	const [state, ...command] = observed.stdout.trim().split(/\s+/);
	const owned = command.join(" ").includes(identity.executable);
	return { ...identity, alive: owned && !state.startsWith("Z"), state, pidReused: !owned && !state.startsWith("Z") };
}

async function observeExit(identities) {
	const start = performance.now();
	let states;
	do {
		states = identities.map(processState);
		if (states.every(({ alive }) => !alive)) break;
		await delay(POLL_MS);
	} while (performance.now() - start < EXIT_TIMEOUT_MS);
	return { budgetMs: EXIT_TIMEOUT_MS, elapsedMs: performance.now() - start, states: identities.map(processState) };
}

async function fixture(t, route, mode) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-github-processes-")));
	t.after(async () => {
		try {
			const identities = records(root, "processes.jsonl");
			const forced = [];
			const errors = [];
			for (const identity of identities.toReversed()) {
				if (!processState(identity).alive) continue;
				try { process.kill(identity.pid, "SIGKILL"); forced.push(identity.pid); }
				catch (error) { if (error.code !== "ESRCH") errors.push(String(error)); }
			}
			const exit = await observeExit(identities);
			const sentinelsPreserved = readFileSync(join(root, "outside", "keep"), "utf8") === "outside"
				&& readFileSync(join(root, "cache", "keep"), "utf8") === "sibling";
			t.diagnostic(JSON.stringify({ cleanup: { root, forced, errors, ...exit, sentinelsPreserved } }));
			assert.deepEqual(errors, []);
			assert.equal(exit.states.some(({ alive }) => alive), false, JSON.stringify(exit));
			assert.equal(sentinelsPreserved, true);
		} finally {
			await rm(root, { recursive: true, force: true });
			t.diagnostic(JSON.stringify({ fixtureDirectoryRemoved: !existsSync(root), root }));
		}
	});
	await Promise.all(["home/.pi", "bin", "cache", "outside"].map((path) => mkdir(join(root, path), { recursive: true })));
	await Promise.all([
		symlink(process.execPath, join(root, "bin", "node")),
		writeFile(join(root, "home", ".pi", "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "cache"), cloneTimeoutSeconds: CLONE_TIMEOUT_SECONDS } })),
		writeFile(join(root, "outside", "keep"), "outside"),
		writeFile(join(root, "cache", "keep"), "sibling"),
		writeFile(join(root, "helper.cjs"), `process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);`),
	]);
	const executable = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.env.GITHUB_PROCESS_ROOT;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const record = (name, value) => fs.appendFileSync(path.join(root, name), JSON.stringify(value) + "\\n");
record("processes.jsonl", { pid: process.pid, role: args[0] === "--version" ? "probe" : args[0] === "api" ? "api" : "clone", executable: process.argv[1] });
record("commands.jsonl", { tool, args, at: Date.now() });
if (args[0] === "--version") {
	const finish = () => process.exit(process.env.GITHUB_PROCESS_ROUTE === "git" ? 1 : 0);
	if (process.env.GITHUB_PROCESS_WAIT_PROBE !== "1") finish();
	const check = () => { if (fs.existsSync(path.join(root, "probe-release"))) { watcher.close(); finish(); } };
	const watcher = fs.watch(root, check);
	fs.writeFileSync(path.join(root, "probe-ready"), "ready");
	check();
	return;
}
if (args[0] === "api") {
	const values = { ".default_branch": "main", ".tree[].path": "README.md", ".content": Buffer.from("api fixture").toString("base64") };
	if (!(args.at(-1) in values)) throw new Error("Unexpected API request");
	process.stdout.write(values[args.at(-1)]);
	return;
}
const destination = tool === "gh" && args[0] === "repo" && args[1] === "clone" ? args[3] : tool === "git" && args[0] === "clone" ? args.at(-1) : null;
if (!destination || !path.resolve(destination).startsWith(path.join(root, "cache") + path.sep)) throw new Error("Unsafe process-fixture destination");
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, "README.md"), "process fixture");
const mode = process.env.GITHUB_PROCESS_MODE;
if (mode === "prompts") {
	let controllingTty = false;
	try { const fd = fs.openSync("/dev/tty", "r"); fs.closeSync(fd); controllingTty = true; }
	catch (error) { if (!["ENXIO", "ENODEV", "ENOENT"].includes(error.code)) throw error; }
	const flags = { GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT, GCM_INTERACTIVE: process.env.GCM_INTERACTIVE, GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED };
	const suppressed = flags.GIT_TERMINAL_PROMPT === "0" && flags.GCM_INTERACTIVE === "Never" && flags.GH_PROMPT_DISABLED === "1";
	record("observations.jsonl", { ...flags, askpassDisabled: process.env.GIT_ASKPASS === "", controllingTty, stdinEof: suppressed && fs.readSync(0, Buffer.alloc(1), 0, 1, null) === 0, authRetained: process.env.GH_TOKEN === "synthetic-fixture-token" });
	return;
}
const publishReady = (value) => {
	const ready = path.join(root, "clone-ready");
	const temporary = ready + "." + process.pid;
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, ready);
};
if (mode === "startup") {
	process.on("SIGTERM", () => {});
	publishReady({ at: Date.now(), rootPid: process.pid });
	setInterval(() => {}, 1000);
	return;
}
if (mode === "resistant" || mode === "root-exits") {
	process.on("SIGTERM", () => { if (mode === "root-exits") process.exit(0); });
	const executable = path.join(root, "helper.cjs");
	const helper = spawn(process.execPath, [executable], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	// Identity comes from the spawner, before helper boot; readiness is separate.
	record("processes.jsonl", { pid: helper.pid, role: "helper", executable });
	helper.once("message", () => publishReady({ at: Date.now(), rootPid: process.pid, helperPid: helper.pid }));
	setInterval(() => {}, 1000);
}
`;
	await Promise.all(["gh", "git"].map((name) => writeFile(join(root, "bin", name), executable, { mode: 0o755 })));
	return {
		root,
		env: {
			...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
			PATH: join(root, "bin"), NODE_OPTIONS: "",
			GITHUB_PROCESS_ROOT: root, GITHUB_PROCESS_ROUTE: route, GITHUB_PROCESS_MODE: mode,
			GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "Always", GH_PROMPT_DISABLED: "0", GH_TOKEN: "synthetic-fixture-token",
			GIT_ASKPASS: join(root, "interactive-askpass"),
		},
	};
}

async function run(t, fixture, source) {
	const runner = join(fixture.root, "runner.mjs");
	await writeFile(runner, `
		import { existsSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
		import { getEventListeners } from "node:events";
		import { join } from "node:path";
		const { extractGitHub, clearCloneCache } = await import(${JSON.stringify(extractModuleUrl)});
		globalThis.fetch = async () => { throw new Error("Network disabled in process fixture"); };
		const root = process.env.GITHUB_PROCESS_ROOT;
		const controller = new AbortController();
		const url = "https://github.com/owner/repo";
		const requestAt = Date.now();
		const waitForFile = (name) => new Promise((resolve) => {
			const check = () => { if (existsSync(join(root, name))) { watcher.close(); resolve(); } };
			const watcher = watch(root, check);
			check();
		});
		${source}
	`);
	const start = performance.now();
	const child = spawnSync(process.execPath, [runner], { encoding: "utf8", env: fixture.env, timeout: RUNNER_TIMEOUT_MS });
	const runnerElapsedMs = performance.now() - start;
	const identities = records(fixture.root, "processes.jsonl");
	const exit = await observeExit(identities);
	const result = child.status === 0 ? JSON.parse(child.stdout) : undefined;
	t.diagnostic(JSON.stringify({ scenario: t.name, runnerBudgetMs: RUNNER_TIMEOUT_MS, runnerElapsedMs,
		status: child.status, error: child.error?.message, result, ...exit, readiness: records(fixture.root, "clone-ready"), observations: records(fixture.root, "observations.jsonl") }));
	assert.equal(child.status, 0, child.error?.message || child.stderr);
	assert.equal(exit.states.some(({ alive }) => alive), false, `owned process exit budget exceeded: ${JSON.stringify(exit)}`);
	return { ...result, commands: records(fixture.root, "commands.jsonl"), identities, observations: records(fixture.root, "observations.jsonl") };
}

for (const mode of ["startup", "resistant"]) {
	test(`clone fixture publishes complete ${mode} readiness`, { skip: process.platform === "win32" }, async (t) => {
		const f = await fixture(t, "gh", mode);
		const preload = join(f.root, "observe-readiness.cjs");
		await writeFile(preload, `
			const fs = require("node:fs");
			const path = require("node:path");
			const root = process.env.GITHUB_PROCESS_ROOT;
			const ready = path.join(root, "clone-ready");
			const write = fs.writeFileSync;
			fs.writeFileSync = (file, data, ...options) => {
				if (typeof file !== "string" || !path.basename(file).startsWith("clone-ready")) return write(file, data, ...options);
				const fd = fs.openSync(file, "w");
				try {
					// Observe the public name between creation and the first byte, without a scheduling race.
					fs.appendFileSync(path.join(root, "readiness-writes.jsonl"), JSON.stringify({ readyVisible: fs.existsSync(ready) }) + "\\n");
					return write(fd, data, ...options);
				} finally {
					fs.closeSync(fd);
				}
			};
		`);
		f.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
		const result = await run(t, f, `
			const pending = extractGitHub(url, controller.signal, true);
			await waitForFile("clone-ready");
			const ready = JSON.parse(readFileSync(join(root, "clone-ready"), "utf8"));
			controller.abort();
			const result = await pending;
			console.log(JSON.stringify({ ready, cancelled: result === null, listeners: getEventListeners(controller.signal, "abort").length, requestAt, completedAt: Date.now() }));
		`);
		assert.deepEqual(records(f.root, "readiness-writes.jsonl"), [{ readyVisible: false }]);
		assert.equal(result.cancelled, true);
		assert.equal(result.listeners, 0);
		assert.ok(Number.isInteger(result.ready.at) && result.ready.at >= result.requestAt && result.ready.at <= result.completedAt);
		const rootPid = result.identities.find(({ role }) => role === "clone").pid;
		const helperPid = result.identities.find(({ role }) => role === "helper")?.pid;
		assert.deepEqual(result.ready, { at: result.ready.at, rootPid, ...(mode === "resistant" ? { helperPid } : {}) });
	});
}

for (const route of ["gh", "git"]) {
	test(`${route} clones disable interactive input and retain noninteractive authentication`, { skip: process.platform === "win32" }, async (t) => {
		const f = await fixture(t, route, "prompts");
		const result = await run(t, f, `
			const result = await extractGitHub(url, controller.signal, true);
			const cloned = result?.content.includes("process fixture") === true;
			const listeners = getEventListeners(controller.signal, "abort").length;
			await clearCloneCache();
			console.log(JSON.stringify({ cloned, listeners, requestAt, completedAt: Date.now() }));
		`);
		assert.equal(result.cloned, true);
		assert.equal(result.listeners, 0);
		assert.deepEqual(result.observations, [{ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GH_PROMPT_DISABLED: "1", askpassDisabled: true, controllingTty: false, stdinEof: true, authRetained: true }]);
	});

	for (const phase of ["entry", "availability", "startup"]) {
		test(`${route} clone cancellation during ${phase} does not launch late work`, { skip: process.platform === "win32" }, async (t) => {
			const f = await fixture(t, route, phase === "startup" ? "startup" : "normal");
			if (phase === "availability") f.env.GITHUB_PROCESS_WAIT_PROBE = "1";
			const result = await run(t, f, `
				${phase === "entry" ? "controller.abort();" : ""}
				const pending = extractGitHub(url, controller.signal, true);
				${phase === "entry" ? "" : `await waitForFile(${JSON.stringify(phase === "availability" ? "probe-ready" : "clone-ready")}); controller.abort();`}
				${phase === "availability" ? 'writeFileSync(join(root, "probe-release"), "release");' : ""}
				const result = await pending;
				console.log(JSON.stringify({ cancelled: result === null, listeners: getEventListeners(controller.signal, "abort").length, requestAt, completedAt: Date.now() }));
			`);
			assert.equal(result.cancelled, true);
			assert.equal(result.listeners, 0);
			assert.equal(result.identities.some(({ role }) => role === "helper"), false);
			assert.equal(result.identities.filter(({ role }) => role === "clone").length, phase === "startup" ? 1 : 0);
		});
	}

	for (const trigger of ["abort", "timeout"]) {
		for (const mode of ["resistant", "root-exits"]) {
			test(`${route} clone ${trigger} reclaims ${mode} process tree`, { skip: process.platform === "win32" }, async (t) => {
				const f = await fixture(t, route, mode);
				const result = await run(t, f, `
					const pending = extractGitHub(url, controller.signal, true);
					await waitForFile("clone-ready");
					const readyAt = Date.now();
					${trigger === "abort" ? "controller.abort();" : ""}
					const result = await pending;
					console.log(JSON.stringify({ cancelled: result === null, apiFallback: result?.content.includes("API-only view") === true, listeners: getEventListeners(controller.signal, "abort").length, requestAt, readyAt, completedAt: Date.now() }));
				`);
				assert.equal(result.listeners, 0);
				assert.equal(result.identities.filter(({ role }) => role === "clone").length, 1);
				assert.equal(result.identities.filter(({ role }) => role === "helper").length, 1);
				assert.equal(result.apiFallback, trigger === "timeout" && route === "gh");
				assert.equal(result.cancelled, trigger === "abort" || route === "git");
				assert.deepEqual(await readdir(join(f.root, "cache")), ["keep"]);
			});
		}
	}

	test(`${route} clone spawn failure releases cancellation resources`, { skip: process.platform === "win32" }, async (t) => {
		const f = await fixture(t, route, "normal");
		const result = await run(t, f, `
			const { checkGhAvailable } = await import(${JSON.stringify(apiModuleUrl)});
			await checkGhAvailable();
			unlinkSync(join(root, "bin", ${JSON.stringify(route)}));
			const result = await extractGitHub(url, controller.signal, true);
			console.log(JSON.stringify({ failed: result === null, listeners: getEventListeners(controller.signal, "abort").length }));
		`);
		assert.equal(result.failed, true);
		assert.equal(result.listeners, 0);
	});

	test(`${route} clone signal failure is explicit and does not poison retries`, { skip: process.platform === "win32" }, async (t) => {
		const f = await fixture(t, route, "startup");
		const result = await run(t, f, `
			const pending = extractGitHub(url, controller.signal, true);
			await waitForFile("clone-ready");
			const { rootPid } = JSON.parse(readFileSync(join(root, "clone-ready"), "utf8"));
			const kill = process.kill;
			let failureExplicit = false;
			// Inject an OS signalling failure, not process-termination proof; other cases use real signals.
			process.kill = (pid, ...args) => {
				if (pid === -rootPid) throw Object.assign(new Error("Injected clone group signal denied"), { code: "EPERM" });
				return kill(pid, ...args);
			};
			try {
				controller.abort();
				await pending;
			} catch (error) {
				failureExplicit = error.code === "EPERM";
			} finally {
				process.kill = kill;
				kill(rootPid, "SIGKILL");
			}
			process.env.GITHUB_PROCESS_MODE = "normal";
			let retried;
			let retryError;
			try { retried = await extractGitHub(url, undefined, true); }
			catch (error) { retryError = error.message; }
			console.log(JSON.stringify({ failureExplicit, retryCloned: retried?.content.includes("process fixture") === true, retryError, listeners: getEventListeners(controller.signal, "abort").length }));
		`);
		assert.equal(result.failureExplicit, true);
		assert.equal(result.listeners, 0);
		assert.equal(result.retryCloned, true, result.retryError);
		assert.equal(result.identities.filter(({ role }) => role === "clone").length, 2);
	});
}
