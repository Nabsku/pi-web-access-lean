import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;

test("githubClone.enabled false skips GitHub clone/API specialization", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-github-disabled-"));
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
		env: { ...process.env, HOME: home, USERPROFILE: home },
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
});