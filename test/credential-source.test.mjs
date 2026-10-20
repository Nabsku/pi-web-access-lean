import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialResolutionError, hasCredentialSource, redactCredential, resolveCredential } from "../credential-source.ts";

test("resolves environment, escaped literal, and command credential sources lazily", async () => {
	assert.equal(await resolveCredential({ provider: "Exa", configuredValue: "$SCOPED_KEY", environment: { SCOPED_KEY: " env-key " } }), "env-key");
	assert.equal(await resolveCredential({ provider: "Exa", configuredValue: "$$literal" }), "$literal");
	assert.equal(await resolveCredential({
		provider: "Exa",
		configuredValue: "!secret-tool read exa",
		environment: { HOME: "/tmp/home", OP_SESSION_demo: "session", EXA_API_KEY: "must-not-leak" },
		runCommand: async (command, options) => {
			assert.equal(command, "secret-tool read exa");
			assert.equal(options.environment.OP_SESSION_demo, "session");
			assert.equal(options.environment.EXA_API_KEY, undefined);
			return { stdout: "command-key\n" };
		},
	}), "command-key");
});

test("explicit credential sources are discoverable without executing them", () => {
	assert.equal(hasCredentialSource({ provider: "Perplexity", configuredValue: "!secret-tool read perplexity" }), true);
	assert.equal(hasCredentialSource({ provider: "Perplexity" }), false);
});

test("credential failures and provider errors do not disclose secrets", async () => {
	await assert.rejects(
		resolveCredential({ provider: "Exa", configuredValue: "$MISSING", environment: {} }),
		(error) => error instanceof CredentialResolutionError && error.category === "environment-empty",
	);
	assert.equal(redactCredential("request rejected for secret-key", "secret-key"), "request rejected for [redacted]");
});

test("command sources forward Windows base variables without unrelated credentials", async () => {
	const windows = {
		SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD",
		USERPROFILE: "C:\\Users\\fixture", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\fixture",
		APPDATA: "C:\\Users\\fixture\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
		TEMP: "C:\\Temp", TMP: "C:\\Temp", ProgramData: "C:\\ProgramData",
		ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
	};
	let received;
	assert.equal(await resolveCredential({
		provider: "Exa", configuredValue: "!fixture",
		environment: { ...windows, UNRELATED_SECRET: "drop", EXA_API_KEY: "drop", PERPLEXITY_API_KEY: "drop", OP_SERVICE_ACCOUNT_TOKEN: "drop" },
		runCommand: async (_command, options) => { received = options.environment; return { stdout: "value\n" }; },
	}), "value");
	assert.deepEqual(received, windows);
});
