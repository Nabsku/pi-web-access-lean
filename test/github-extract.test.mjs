import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { parseGitHubUrl } from "../github-extract.ts";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;
// Poll persistent flags directly: directory events and initial stat baselines can miss them.
const POLL_MS = 25;

test("githubClone.enabled false skips GitHub clone/API specialization", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-github-disabled-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify({ githubClone: { enabled: false } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			console.log(JSON.stringify(await extractGitHub("https://github.com/owner/repo")));
		`,
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi") },
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
});

test("GitHub URL parsing rejects malformed identifiers and encodings", () => {
	for (const url of [
		"https://github.com/..%2Fvictim/repo",
		"https://github.com/owner/repo%2Fother",
		"https://github.com/owner/repo%5Cother",
		"https://github.com/owner%ZZ/repo",
		"https://github.com/owner/repo/blob/main/file%ZZ",
		"https://github.com/owner/repo/blob/branch%00/file.ts",
		"https://github.com/owner/repo/blob/branch%0A/file.ts",
		"https://github.com/owner%0A/repo",
		"https://github.com/owner/repo%0A",
		"https://github.com/-owner/repo",
		"https://github.com/owner-/repo",
		"https://github.com/own--er/repo",
		"https://github.com/owner/.git",
	]) assert.equal(parseGitHubUrl(url), null, url);
});

test("GitHub URL parsing preserves normal repositories, encoded paths and slash refs", () => {
	assert.deepEqual(parseGitHubUrl("https://www.github.com/valid-owner/repo_name.git"), {
		owner: "valid-owner", repo: "repo_name", refIsFullSha: false, type: "root",
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/space%20name.ts"), {
		owner: "owner", repo: "repo", ref: "main", refIsFullSha: false,
		path: "src/space name.ts", type: "blob",
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/tree/feature%2Fbranch/src"), {
		owner: "owner", repo: "repo", ref: "feature/branch", refIsFullSha: false,
		path: "src", type: "tree",
	});
	assert.equal(parseGitHubUrl("https://github.com/owner/repo/blob/" + "a".repeat(40) + "/file.ts").refIsFullSha, true);
	assert.equal(parseGitHubUrl("https://github.com/owner/repo/issues/1"), null);
	assert.equal(parseGitHubUrl("https://github.com.evil.example/owner/repo"), null);
});

async function createCloneFixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-access-github-containment-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const cache = join(root, "cache");
	const bin = join(root, "bin");
	await Promise.all([home + "/.pi", cache, bin, join(root, "outside"), join(root, "victim", "repo")].map((path) => mkdir(path, { recursive: true })));
	await Promise.all([
		writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ githubClone: { clonePath: cache } })),
		writeFile(join(cache, "keep.txt"), "preserve sibling"),
		writeFile(join(root, "outside", "marker.txt"), "preserve outside"),
		writeFile(join(root, "victim", "repo", "marker.txt"), "preserve victim"),
	]);
	const executable = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.GITHUB_FIXTURE_ROOT;
const tool = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\\n");
if (tool === "gh" && args[0] === "--version") {
	if (process.env.GITHUB_FIXTURE_WAIT_VERSION === "1") {
		const release = path.join(root, "availability-release");
		const finish = () => { if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); } };
		const timer = setInterval(finish, ${POLL_MS});
		fs.writeFileSync(path.join(root, "availability-started"), "started");
		finish();
		return;
	}
	process.exit(process.env.GITHUB_FIXTURE_GIT_ONLY === "1" ? 1 : 0);
}
if (tool === "gh" && args[0] === "api") {
	const values = { ".size": "1", ".default_branch": "main", ".tree[].path": "README.md\\nsrc/file.ts", ".content": Buffer.from("api fixture").toString("base64") };
	if (!(args.at(-1) in values)) throw new Error("Unexpected fixture API request");
	process.stdout.write(values[args.at(-1)]);
	process.exit(0);
}
const destination = tool === "gh" && args[0] === "repo" && args[1] === "clone" ? args[3] : tool === "git" && args[0] === "clone" ? args.at(-1) : null;
if (!destination || !path.resolve(destination).startsWith(root + path.sep)) throw new Error("Clone fixture must stay in its disposable root");
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (process.env.GITHUB_FIXTURE_FAIL_CLONE === "swap-root") {
	const cache = path.join(root, "cache");
	fs.renameSync(cache, path.join(root, "retired-cache"));
	const replacement = path.join(root, "outside", path.relative(cache, destination));
	fs.mkdirSync(replacement, { recursive: true });
	fs.writeFileSync(path.join(replacement, "marker.txt"), "preserve replacement");
	fs.symlinkSync(path.join(root, "outside"), cache, "dir");
	process.exit(1);
}
if (process.env.GITHUB_FIXTURE_FAIL_CLONE === "1") {
	fs.symlinkSync(path.join(root, "outside"), destination, "dir");
	process.exit(1);
}
fs.mkdirSync(path.join(destination, "src"), { recursive: true });
fs.writeFileSync(path.join(destination, "README.md"), "clone fixture");
fs.writeFileSync(path.join(destination, "src", "file.ts"), "export const fixture = true;");
`;
	await Promise.all(["gh", "git"].map((name) => writeFile(join(bin, name), executable, { mode: 0o755 })));
	return {
		root, cache,
		env: {
			...process.env, HOME: home, USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi"), XDG_CONFIG_HOME: join(home, ".config"),
			PATH: bin + delimiter + dirname(process.execPath), NODE_OPTIONS: "",
			GITHUB_FIXTURE_ROOT: root,
		},
	};
}

function runCloneFixture(t, fixture, source) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import assert from "node:assert/strict";
			import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
			import { isAbsolute, join, relative, resolve, sep } from "node:path";
			const { parseGitHubUrl, extractGitHub, clearCloneCache } = await import(${JSON.stringify(extractModuleUrl)});
			globalThis.fetch = async () => { throw new Error("Network disabled in clone fixture"); };
			const root = process.env.GITHUB_FIXTURE_ROOT;
			const cache = join(root, "cache");
			const outside = join(root, "outside");
			const victim = join(root, "victim", "repo");
			const clonePath = (result) => result?.content.match(/^Repository cloned to: (.+)$/m)?.[1];
			function contained(path) {
				const rel = relative(realpathSync(cache), realpathSync(path));
				return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
			}
			${source}
		`,
		encoding: "utf8",
		env: fixture.env,
	});
	assert.equal(child.status, 0, child.error?.message || child.stderr);
	const result = JSON.parse(child.stdout);
	const log = join(fixture.root, "commands.jsonl");
	const commands = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	t.diagnostic(JSON.stringify({ scenario: t.name, ...result, commands }));
	return { ...result, commands };
}

test("malformed GitHub identifiers cannot delete outside the clone cache", { skip: process.platform === "win32" }, async (t) => {
	for (const url of ["https://github.com/..%2Fvictim/repo", "https://github.com/owner/..%2F..%2Fvictim%2Frepo"]) {
		await t.test(url, async (t) => {
			const fixture = await createCloneFixture(t);
			const observed = runCloneFixture(t, fixture, `
				const url = ${JSON.stringify(url)};
				const info = parseGitHubUrl(url);
				if (info) assert.ok(resolve(cache, info.owner, info.repo).startsWith(root + sep), "unsafe red-fixture target");
				const result = await extractGitHub(url, undefined, true);
				console.log(JSON.stringify({ rejected: result === null, victimPreserved: existsSync(join(victim, "marker.txt")) }));
			`);
			assert.equal(observed.victimPreserved, true);
			assert.equal(observed.rejected, true);
			assert.deepEqual(observed.commands, []);
		});
	}
});

test("encoded ref traversal cannot escape the clone cache", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	const observed = runCloneFixture(t, fixture, `
		const url = "https://github.com/owner/repo/tree/..%2F..%2F..%2F..%2Fvictim%2Frepo";
		const info = parseGitHubUrl(url);
		if (info) assert.ok(resolve(cache, info.owner, info.repo + "@" + info.ref).startsWith(root + sep), "unsafe red-fixture target");
		const result = await extractGitHub(url, undefined, true);
		const path = clonePath(result);
		console.log(JSON.stringify({ safeResult: result === null || !!path && contained(path), victimPreserved: existsSync(join(victim, "marker.txt")) }));
	`);
	assert.equal(observed.victimPreserved, true);
	assert.equal(observed.safeResult, true);
});

test("pre-existing owner-directory symlinks cannot redirect clone cleanup", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	await symlink(join(fixture.root, "victim"), join(fixture.cache, "owner"), "dir");
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		console.log(JSON.stringify({ error: result?.error, contained: contained(clonePath(result)), victimPreserved: existsSync(join(victim, "marker.txt")) }));
	`);
	assert.equal(observed.error, null);
	assert.equal(observed.victimPreserved, true);
	assert.equal(observed.contained, true);
});

test("normal clone/ref/API paths and cache cleanup preserve unrelated files", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	const observed = runCloneFixture(t, fixture, `
		const first = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const again = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const blob = await extractGitHub("https://github.com/owner/repo/blob/main/src/file.ts", undefined, true);
		const tree = await extractGitHub("https://github.com/owner/repo/tree/feature%2Fbranch/src", undefined, true);
		const sha = await extractGitHub("https://github.com/owner/repo/blob/" + "a".repeat(40) + "/src/file.ts", undefined, true);
		const paths = [first, blob, tree].map(clonePath);
		const allContained = paths.every(contained);
		const distinctRefs = new Set(paths).size === paths.length;
		rmSync(paths[0], { recursive: true });
		symlinkSync(outside, paths[0], "dir");
		await clearCloneCache();
		console.log(JSON.stringify({
			cached: clonePath(first) === clonePath(again), allContained, distinctRefs,
			rootContent: first.content.includes("clone fixture"), blobContent: blob.content.includes("export const fixture = true;"),
			treeContent: tree.content.includes("file.ts"), shaContent: sha.content.includes("api fixture"),
			allRemoved: paths.every((path) => !existsSync(path)),
			outsidePreserved: readFileSync(join(outside, "marker.txt"), "utf8") === "preserve outside",
			siblingPreserved: readFileSync(join(cache, "keep.txt"), "utf8") === "preserve sibling",
		}));
	`);
	for (const field of ["cached", "allContained", "distinctRefs", "rootContent", "blobContent", "treeContent", "shaContent", "allRemoved", "outsidePreserved", "siblingPreserved"]) assert.equal(observed[field], true, field);
	assert.equal(observed.commands.filter(({ args }) => args[0] === "repo" && args[1] === "clone").length, 3);
	assert.ok(observed.commands.some(({ args }) => args.includes("feature/branch")));
});

test("git fallback cloning also stays inside the configured cache", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	fixture.env.GITHUB_FIXTURE_GIT_ONLY = "1";
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo/tree/feature%2Fbranch/src", undefined, true);
		const path = clonePath(result);
		const inside = contained(path);
		await clearCloneCache();
		console.log(JSON.stringify({ error: result?.error, contained: inside, removed: !existsSync(path), siblingPreserved: existsSync(join(cache, "keep.txt")) }));
	`);
	assert.equal(observed.error, null);
	for (const field of ["contained", "removed", "siblingPreserved"]) assert.equal(observed[field], true, field);
	assert.ok(observed.commands.some(({ tool, args }) => tool === "git" && args.includes("feature/branch")));
});

test("failed-clone cleanup unlinks its symlink and preserves API fallback", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	fixture.env.GITHUB_FIXTURE_FAIL_CLONE = "1";
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const calls = readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\\n").map(JSON.parse);
		const destination = calls.find(({ args }) => args[0] === "repo" && args[1] === "clone").args[3];
		console.log(JSON.stringify({ apiFallback: result?.content.includes("API-only view"), removed: !existsSync(destination), outsidePreserved: readFileSync(join(outside, "marker.txt"), "utf8") === "preserve outside" }));
	`);
	for (const field of ["apiFallback", "removed", "outsidePreserved"]) assert.equal(observed[field], true, field);
});

test("failed-clone cleanup refuses a replaced cache root", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	fixture.env.GITHUB_FIXTURE_FAIL_CLONE = "swap-root";
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const calls = readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\\n").map(JSON.parse);
		const destination = calls.find(({ args }) => args[0] === "repo" && args[1] === "clone").args[3];
		const marker = join(outside, relative(cache, destination), "marker.txt");
		console.log(JSON.stringify({ apiFallback: result?.content.includes("API-only view"), replacementPreserved: existsSync(marker) }));
	`);
	assert.equal(observed.apiFallback, true);
	assert.equal(observed.replacementPreserved, true);
});

test("an unusable cache root falls back to the API without attempting a clone", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	await rm(fixture.cache, { recursive: true });
	await writeFile(fixture.cache, "preserve cache-file");
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		console.log(JSON.stringify({ apiFallback: result?.content.includes("API-only view"), rootPreserved: readFileSync(cache, "utf8") === "preserve cache-file" }));
	`);
	assert.equal(observed.apiFallback, true);
	assert.equal(observed.rootPreserved, true);
	assert.ok(!observed.commands.some(({ args }) => args[0] === "repo" && args[1] === "clone"));
});

test("cache-root API fallback does not report success after caller cancellation", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	await rm(fixture.cache, { recursive: true });
	await writeFile(fixture.cache, "preserve cache-file");
	fixture.env.GITHUB_FIXTURE_WAIT_VERSION = "1";
	const observed = runCloneFixture(t, fixture, `
		const { activityMonitor } = await import(${JSON.stringify(new URL("../activity.ts", import.meta.url).href)});
		const controller = new AbortController();
		const ready = join(root, "availability-started");
		const onReady = () => {
			if (existsSync(ready)) {
				controller.abort();
				writeFileSync(join(root, "availability-release"), "released");
				clearInterval(readinessTimer);
			}
		};
		const readinessTimer = setInterval(onReady, ${POLL_MS});
		onReady();
		let result;
		try {
			result = await extractGitHub("https://github.com/owner/repo", controller.signal, true);
		} finally {
			clearInterval(readinessTimer);
		}
		console.log(JSON.stringify({ aborted: controller.signal.aborted, cancelledResult: result === null, status: activityMonitor.getEntries().at(-1).status }));
	`);
	assert.equal(observed.aborted, true);
	assert.equal(observed.cancelledResult, true);
	assert.equal(observed.status, 0);
});

test("cache cleanup refuses a root replaced by an outside-directory symlink", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createCloneFixture(t);
	const observed = runCloneFixture(t, fixture, `
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const path = clonePath(result);
		assert.ok(contained(path));
		const rel = relative(cache, path);
		renameSync(cache, join(root, "retired-cache"));
		const replacement = join(outside, rel);
		mkdirSync(replacement, { recursive: true });
		writeFileSync(join(replacement, "marker.txt"), "preserve replacement");
		symlinkSync(outside, cache, "dir");
		await clearCloneCache();
		console.log(JSON.stringify({ replacementPreserved: existsSync(join(replacement, "marker.txt")), outsidePreserved: existsSync(join(outside, "marker.txt")) }));
	`);
	assert.equal(observed.replacementPreserved, true);
	assert.equal(observed.outsidePreserved, true);
});
