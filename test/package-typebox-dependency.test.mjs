import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("packed installs use the host TypeBox peer without a private runtime copy", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-pack-install-"));
	try {
		const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
			cwd: repoRoot,
			encoding: "utf8",
		}));
		assert.equal(packed.name, "pi-web-access-lean");
		assert.ok(packed.files.some(file => file.path === "index.ts"));

		// Pi supplies host peers; the consumer must work without installing its own TypeBox.
		execFileSync("npm", ["install", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const manifestPath = join(root, "node_modules", "pi-web-access-lean", "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		assert.equal(manifest.peerDependencies?.typebox, "*");
		assert.equal(manifest.dependencies?.typebox, undefined);
		assert.equal(typeof manifest.devDependencies?.typebox, "string");
		assert.throws(() => createRequire(manifestPath).resolve("typebox"), { code: "MODULE_NOT_FOUND" });
		t.diagnostic(JSON.stringify({ package: packed.id, integrity: packed.integrity, typeboxPeer: manifest.peerDependencies.typebox, privateTypebox: false }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
