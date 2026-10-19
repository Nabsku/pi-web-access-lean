import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = new URL("../", import.meta.url).href;
const scenarios = [
	["text", "control"], ["html", "control"], ["pdf", "control"],
	["text", "elapsed"], ["html", "elapsed"], ["pdf", "elapsed"],
	["html", "exact"], ["html", "override"],
	["pdf", "import-elapsed"], ["pdf", "import-timer"],
	["html", "caller"], ["pdf", "caller"], ["pdf", "import-caller"],
	["html", "caller-early"], ["pdf", "caller-early"],
	["text", "early-error"], ["text", "late-error"],
	["html", "elapsed", "batch"], ["html", "elapsed", "tool"],
];

for (const [type, scenario, seam = "direct"] of scenarios) {
	test(`${seam} ${type} extraction honors its deadline: ${scenario} (controlled DNS/fetch/clock)`, t => {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `(${runScenario.toString()})(${JSON.stringify({ source, type, scenario, seam })})`,
			encoding: "utf8",
		});
		assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
		t.diagnostic(child.stdout.trim());
	});
}

async function runScenario({ source, type, scenario, seam }) {
	const assert = (await import("node:assert/strict")).default;
	const { mock } = await import("node:test");
	const dns = (await import("node:dns/promises")).default;
	const fs = (await import("node:fs/promises")).default;
	const { createRequire, register, syncBuiltinESMExports } = await import("node:module");
	const { getEventListeners } = await import("node:events");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { performance } = await import("node:perf_hooks");
	const realNow = performance.now.bind(performance);
	const home = await fs.mkdtemp(join(tmpdir(), "pi-extract-deadline-"));
	Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi") });
	const caller = new AbortController();
	const defaultDeadline = 30000; // Existing HTTP default, not a test watchdog.
	const deadline = scenario === "override" ? defaultDeadline / 2 : defaultDeadline;
	const early = ["control", "early-error"].includes(scenario);
	let elapsedClock = 0;
	const advance = () => {
		elapsedClock = early || scenario === "caller-early" ? deadline - 1 : scenario === "exact" ? deadline : deadline + 1;
		// Wall time moves independently; only the monotonic clock measures elapsed work.
		mock.timers.setTime(early ? deadline + 1 : 0);
		if (scenario.includes("caller")) caller.abort();
	};
	let shutdown;
	try {
		const realWrite = fs.writeFile;
		mock.method(fs, "writeFile", async (...args) => {
			await realWrite(...args);
			if (type === "pdf" && !scenario.startsWith("import-")) advance();
		});
		mock.method(dns, "lookup", async host => {
			assert.equal(host, "deadline.example.test");
			return [{ address: "93.184.216.34", family: 4 }];
		});
		syncBuiltinESMExports();
		globalThis.pdfImport = async () => {
			if (!scenario.startsWith("import-")) return;
			if (scenario === "import-timer") {
				mock.timers.tick(deadline);
				// A fired timeout must still count if the wall clock subsequently changes.
				mock.timers.setTime(0);
			} else advance();
		};
		const loader = `export async function resolve(s, c, next) {
			const real = await next(s, c);
			if (s !== "unpdf") return real;
			const code = "export * from " + JSON.stringify(real.url) + "; await globalThis.pdfImport();";
			return { url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true };
		}`;
		register("data:text/javascript," + encodeURIComponent(loader), source);
		const Turndown = createRequire(new URL("package.json", source))("turndown");
		const realTurndown = Turndown.prototype.turndown;
		mock.method(Turndown.prototype, "turndown", function (...args) {
			const result = realTurndown.apply(this, args);
			if (type === "html") advance();
			return result;
		});
		const { extractContent, fetchAllContent } = await import(new URL("extract.ts", source));
		const { activityMonitor } = await import(new URL("activity.ts", source));
		let tool;
		if (seam === "tool") {
			const handlers = new Map();
			(await import(new URL("index.ts", source))).default({
				registerShortcut() {}, on(event, handler) { handlers.set(event, handler); },
				registerTool(definition) { if (definition.name === "fetch_content") tool = definition; },
			});
			shutdown = handlers.get("session_shutdown");
		}
		const text = "Deadline fixture text survives in-budget extraction. ".repeat(30).trim();
		const body = type === "pdf" ? makePdf("Deadline PDF control") : type === "html"
			? `<html><head><title>Deadline control</title></head><body><article><p>${text}</p></article></body></html>` : text;
		let requestSignal;
		const response = new Response(body, { headers: { "content-type": type === "pdf" ? "application/pdf" : type === "html" ? "text/html" : "text/plain" } });
		mock.method(globalThis, "fetch", async (_url, init) => {
			requestSignal = init.signal;
			if (type === "text") advance();
			if (scenario.endsWith("error")) throw new Error("fixture transport failed");
			return response;
		});
		mock.method(performance, "now", () => elapsedClock);
		mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const url = "https://deadline.example.test/control" + (type === "pdf" ? ".pdf" : "");
		const started = realNow();
		const options = scenario === "override" ? { timeoutMs: deadline } : undefined;
		let result, rendered;
		if (seam === "tool") rendered = await tool.execute("deadline", { url }, caller.signal);
		else result = seam === "batch" ? (await fetchAllContent([url], caller.signal, options))[0] : await extractContent(url, caller.signal, options);
		const elapsedMs = realNow() - started;
		let artifact;
		if (type === "pdf") {
			artifact = await fs.readFile(join(home, "Downloads", "control.md"), "utf8");
			assert.match(artifact, /Deadline PDF control/);
		}
		console.log(JSON.stringify({ type, scenario, seam, deadline, observedClock: Date.now(), observedElapsed: elapsedClock, elapsedMs,
			result: result && { ...result, content: { chars: result.content.length } }, rendered, artifact }));
		if (early) {
			if (scenario === "early-error") assert.match(result.error, /^fixture transport failed/);
			else {
				assert.equal(result.error, null);
				if (type === "pdf") assert.match(result.content, /PDF extracted and saved to: .*control.md\n\nPages: 1/);
				else assert.equal(result.content, text);
			}
		} else if (seam === "tool") {
			assert.equal(rendered.isError, true);
			assert.equal(rendered.details.successful, 0);
			assert.match(rendered.content[0].text, /^Error: The operation was aborted\./);
			assert.doesNotMatch(rendered.content[0].text, /Deadline fixture text/);
		} else {
			assert.equal(result.title, "");
			assert.equal(result.content, "");
			if (scenario.includes("caller")) assert.equal(result.error, "Aborted");
			else assert.match(result.error, /^The operation was aborted\./);
		}
		assert.equal(response.body.locked, false);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		const entry = activityMonitor.getEntries().at(-1);
		assert.notEqual(entry.endTime, undefined);
		if (!early) assert.equal(entry.status, 0, "late extraction must not remain a successful activity");
		const wasAborted = requestSignal.aborted;
		mock.timers.tick(defaultDeadline + 1);
		assert.equal(requestSignal.aborted, wasAborted, "the extraction timer must be cleared");
	} finally {
		mock.timers.reset();
		await shutdown?.();
		mock.restoreAll();
		syncBuiltinESMExports();
		delete globalThis.pdfImport;
		await fs.rm(home, { recursive: true, force: true });
	}

	function makePdf(text) {
		const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
		];
		let body = "%PDF-1.4\n";
		const offsets = [];
		for (const [i, object] of objects.entries()) {
			offsets.push(Buffer.byteLength(body));
			body += `${i + 1} 0 obj\n${object}\nendobj\n`;
		}
		const xref = Buffer.byteLength(body);
		body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
		body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return Buffer.from(body);
	}
}
