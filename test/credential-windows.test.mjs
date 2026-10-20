import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { test } from "node:test";
import { resolveCredential } from "../credential-source.ts";

const source = new URL("../credential-source.ts", import.meta.url).href;
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const x86Bash = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
const pathBash = "D:\\msys64\\usr\\bin\\bash.exe";
const command = "printf '%s' \"$HOME\"";

function observe(t, scenario = {}) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8", env: { HOME: tmpdir(), PATH: dirname(process.execPath) },
		input: String.raw`
			import childProcess from "node:child_process";
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			import { inspect, promisify } from "node:util";
			const scenario = ${JSON.stringify(scenario)}, calls = [];
			const environment = {
				HOME: "C:/Users/fixture", PATH: "C:/tools", USERPROFILE: "C:/Users/fixture", SystemRoot: "C:/Windows",
				ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
				OP_SESSION_fixture: "synthetic-session", UNRELATED_SECRET: "S3CR3T", EXA_API_KEY: "S3CR3T", OP_SERVICE_ACCOUNT_TOKEN: "S3CR3T",
			};
			Object.assign(process.env, environment);
			Object.defineProperty(process, "platform", { value: scenario.platform ?? "win32" });
			const caller = new AbortController();
			if (scenario.preAborted) caller.abort();
			let elapsed = 0;
			Date.now = () => elapsed;
			fs.existsSync = path => { elapsed += scenario.statElapsedMs ?? 0; return (scenario.installed ?? []).includes(path) || path === scenario.pathBash; };
			function record(kind, executable, args, options) {
				const env = options.env ?? process.env;
				calls.push({ kind, executable, args, timeoutMs: options.timeout, maxBuffer: options.maxBuffer,
					sameSignal: options.signal === caller.signal, environmentKeys: Object.keys(env).sort(),
					unrelatedSecretForwarded: ["UNRELATED_SECRET", "EXA_API_KEY", "OP_SERVICE_ACCOUNT_TOKEN"].some(key => env[key] !== undefined),
					windowsBaseForwarded: env.USERPROFILE === environment.USERPROFILE && env.SystemRoot === environment.SystemRoot });
			}
			function stub(run) {
				const callback = (...args) => { const done = args.pop(); run(...args).then(result => done(null, result.stdout, result.stderr ?? ""), done); return { kill() {} }; };
				callback[promisify.custom] = run;
				return callback;
			}
			childProcess.exec = stub(async (command, options) => {
				record("default-shell", command, [], options);
				return { stdout: "credential-value\n" };
			});
			childProcess.execFile = stub(async (executable, args, options) => {
				const lookup = executable === "where" || executable === "where.exe";
				record(lookup ? "lookup" : "bash", executable, args, options);
				if (lookup) {
					elapsed += scenario.lookupElapsedMs ?? 0;
					if (scenario.lookupError) {
						if (scenario.lookupError === "abort") caller.abort();
						throw Object.assign(new Error("S3CR3T diagnostic"), { code: scenario.lookupError });
					}
					return { stdout: scenario.lookupStdout ?? (scenario.pathBash ? scenario.pathBash + "\r\n" : "") };
				}
				if (scenario.commandError) throw Object.assign(new Error("S3CR3T diagnostic"), { code: scenario.commandError });
				return { stdout: "credential-value\n" };
			});
			syncBuiltinESMExports();
			const { resolveCredential, hasCredentialSource } = await import(${JSON.stringify(source)});
			const configuredValue = scenario.source ?? ${JSON.stringify("!" + command)};
			const available = hasCredentialSource({ provider: "Exa", configuredValue });
			const workDuringAvailability = calls.length;
			let value, error;
			try { value = await resolveCredential({ provider: "Exa", configuredValue, environmentValue: "legacy-must-not-win", environment, signal: caller.signal }); }
			catch (failure) { error = { name: failure.name, category: failure.category, message: failure.message, inspected: inspect(failure) }; }
			console.log(JSON.stringify({ available, workDuringAvailability, value, error, calls, elapsedMs: elapsed }));
		`,
	});
	assert.equal(child.status, 0, child.error?.message || child.stdout + child.stderr);
	const result = JSON.parse(child.stdout);
	assert.equal((child.stdout + child.stderr).includes("S3CR3T"), false, "secret escaped through environment metadata or errors");
	assert.equal(result.available, true);
	assert.equal(result.workDuringAvailability, 0);
	assert.ok(result.calls.every(call => !call.unrelatedSecretForwarded && call.sameSignal));
	t.diagnostic(JSON.stringify({ boundary: "public credential resolver; simulated Windows/process/filesystem/clock boundaries", ...result }));
	return result;
}

for (const [name, scenario, expected] of [
	["preferred Git Bash", { installed: [gitBash, x86Bash], pathBash }, gitBash],
	["x86 Git Bash", { installed: [x86Bash], pathBash }, x86Bash],
	["PATH Bash", { pathBash }, pathBash],
]) test("Windows command chooses " + name, t => {
	const result = observe(t, scenario);
	assert.equal(result.value, "credential-value");
	const command = result.calls.at(-1);
	assert.equal(command.kind, "bash");
	assert.equal(command.executable, expected);
	assert.deepEqual(command.args, ["-c", "printf '%s' \"$HOME\""]);
	assert.ok(result.calls.every(call => call.windowsBaseForwarded && call.maxBuffer === 16_385));
});

for (const [name, scenario] of [
	["no Bash", {}],
	["lookup has no matches", { lookupError: 1 }],
	["where is unavailable", { lookupError: "ENOENT" }],
	["System32 WSL launcher", { pathBash: "C:\\Windows\\System32\\bash.exe" }],
	["Sysnative WSL launcher", { pathBash: "C:/WINDOWS/Sysnative/bash.exe" }],
	["nonexistent PATH result", { lookupStdout: "D:\\missing\\bash.exe\r\n" }],
]) test("Windows command retains cmd fallback: " + name, t => {
	const result = observe(t, scenario);
	assert.equal(result.value, "credential-value");
	assert.equal(result.calls.at(-1).kind, "default-shell");
	assert.equal(result.calls[0].kind, "lookup");
	assert.ok(result.calls.every(call => call.windowsBaseForwarded));
});

test("Windows lookup and command share the existing timeout and minimized environment", t => {
	const result = observe(t, { pathBash, lookupElapsedMs: 1_250 });
	assert.equal(result.calls[0].kind, "lookup");
	assert.equal(result.calls[0].timeoutMs, 5_000);
	assert.equal(result.calls[1].timeoutMs, 3_750);
	assert.deepEqual(result.calls[0].environmentKeys, result.calls[1].environmentKeys);
});

test("Windows install checks also consume the shared lookup/command timeout", t => {
	const result = observe(t, { pathBash, statElapsedMs: 500, lookupElapsedMs: 1_250 });
	assert.equal(result.calls[0].timeoutMs, 4_000);
	assert.equal(result.calls[1].timeoutMs, 2_250);
});

for (const [name, scenario, category, expectedWork] of [
	["pre-aborted caller", { preAborted: true }, "command-aborted", 0],
	["abort during lookup", { lookupError: "abort" }, "command-aborted", 1],
	["lookup exhausts deadline", { pathBash, lookupElapsedMs: 5_001 }, "command-timeout", 1],
	["lookup timeout", { lookupError: "ETIMEDOUT" }, "command-timeout", 1],
	["lookup output overflow", { lookupError: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "command-output-too-large", 1],
	["unexpected lookup failure", { lookupError: "EACCES" }, "command-failed", 1],
	["Bash command failure", { installed: [gitBash], commandError: "EACCES" }, "command-failed", 1],
]) test("Windows failure stops command work and stays redacted: " + name, t => {
	const result = observe(t, scenario);
	assert.equal(result.error?.name, "CredentialResolutionError");
	assert.equal(result.error.category, category);
	assert.equal(result.calls.length, expectedWork);
});

test("non-Windows command keeps the default shell without Bash discovery", t => {
	const result = observe(t, { platform: "darwin", installed: [gitBash], pathBash });
	assert.equal(result.value, "credential-value");
	assert.deepEqual(result.calls.map(call => call.kind), ["default-shell"]);
});

test("native POSIX credential command retains expansion and minimized environment", { skip: process.platform === "win32" }, async t => {
	const value = await resolveCredential({ provider: "Exa", configuredValue: '!test -z "$UNRELATED_SECRET" && printf \'%s\' "$HOME"', environment: { HOME: "/tmp/credential-shell-fixture", UNRELATED_SECRET: "drop" } });
	assert.equal(value, "/tmp/credential-shell-fixture");
	t.diagnostic(JSON.stringify({ boundary: "real native POSIX shell -> public resolveCredential", homeExpanded: true, unrelatedSecretAbsent: true }));
});
