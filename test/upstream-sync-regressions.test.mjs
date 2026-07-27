import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import initializeExtension from "../index.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const searchSrc = readFileSync(new URL("../search.ts", import.meta.url), "utf8");

test("content extraction is loaded lazily", () => {
	assert.doesNotMatch(indexSrc, /import \{ fetchAllContent \} from "\.\/extract\.ts"/);
	assert.match(indexSrc, /extractModulePromise \?\?= import\("\.\/extract\.ts"\)/);
});

test("answers without sources remain visible", () => {
	assert.match(indexSrc, /return answer \? `\$\{answer\}[\s\S]*No sources returned\.`/);
});

test("explicit auto honors the configured provider", () => {
	assert.match(searchSrc, /options\.provider && options\.provider !== "auto"[\s\S]*getSearchConfig\(\)\.searchProvider/);
});

test("activity widget uses the supported string-array API", async () => {
	const shortcuts = [];
	initializeExtension({
		registerTool() {},
		registerShortcut(name, shortcut) { shortcuts.push({ name, shortcut }); },
	});
	const activity = shortcuts.find(({ shortcut }) => shortcut.description === "Toggle web search activity");
	assert.ok(activity);
	const widgets = [];
	await activity.shortcut.handler({
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, content) { widgets.push({ key, content }); },
		},
	});
	assert.equal(widgets[0].key, "web-activity");
	assert.ok(Array.isArray(widgets[0].content));
});
