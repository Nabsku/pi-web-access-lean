import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { search, type SearchProvider } from "./search.ts";
import { executeCodeSearch } from "./code-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { isAbortError } from "./utils.ts";
import { createCredentialSafeCancellation } from "./credential-source.ts";

const MAX_INLINE_CONTENT = 30000;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;

type QueryResultData = {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
};

type RecencyFilter = "day" | "week" | "month" | "year";

function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: "text", text }], details };
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const normalized = (value ?? "auto").trim().toLowerCase();
	if (normalized === "auto" || normalized === "exa" || normalized === "perplexity") {
		return normalized;
	}
	return "auto";
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

function parseStringArray(value: string): string[] | undefined {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === "string") ? parsed : undefined;
}

function prepareSearchArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("web_search arguments must be an object");
	const input = args as Record<string, unknown>;
	// Pi's schema converter otherwise truncates fractional result counts.
	const numResults = input.numResults;
	if (typeof numResults === "number" || typeof numResults === "string") {
		const count = Number(numResults);
		if (!Number.isInteger(count)) throw new Error(`Invalid numResults: configured integer range 1..20, observed ${count}. Use a whole-number count from 1 to 20.`);
	}
	let output: Record<string, unknown> | undefined;
	for (const key of ["queries", "domainFilter"]) {
		const value = input[key];
		if (value === undefined) continue;
		if (Array.isArray(value) && value.every(entry => typeof entry === "string")) continue;
		if (typeof value !== "string" || !value.trim().startsWith("[")) throw new Error(`${key} must be an array of strings`);
		let parsed: string[] | undefined;
		try {
			parsed = parseStringArray(value);
		} catch {
			throw new Error(`${key} must be an array of strings; the given value is not valid JSON`);
		}
		if (!parsed) throw new Error(`${key} must be an array of strings`);
		output ??= { ...input };
		output[key] = parsed;
	}
	return output ?? input;
}

function normalizeSearchQueries(input: { query?: unknown; queries?: unknown }): string[] {
	let queries = input.queries;
	// Call renderers also receive raw, partially streamed arguments.
	if (typeof queries === "string" && queries.trim().startsWith("[")) {
		try { queries = parseStringArray(queries); } catch { /* Incomplete arguments are not executable yet. */ }
	}
	if (Array.isArray(queries)) return normalizeQueryList(queries);
	if (typeof input.query !== "string") return [];
	const query = input.query.trim();
	if (query.startsWith("[") && query.endsWith("]")) {
		try {
			const expanded = parseStringArray(query);
			if (expanded) return normalizeQueryList(expanded);
		} catch { /* Malformed singular arrays remain literal search text. */ }
	}
	return normalizeQueryList([query]);
}

function normalizeFetchUrls(input: { url?: unknown; urls?: unknown }): string[] {
	const urls = normalizeQueryList(Array.isArray(input.urls) ? input.urls : []);
	return urls.length > 0 ? [...new Set(urls)] : normalizeQueryList([input.url]);
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\nSources:\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\nSources:\n` : "Sources:\n";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatActivityEntry(entry: ActivityEntry): string {
	const target = entry.type === "api" ? entry.query : entry.url?.replace(/^https?:\/\//, "");
	const status = entry.error ? "error" : entry.status === null ? "…" : entry.status === 0 ? "abort" : String(entry.status);
	return `${entry.type === "api" ? "API" : "GET"} ${(target || "").slice(0, 42)} ${status}`;
}

function updateActivityWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines = [theme.fg("accent", "── Web Search Activity ──")];
	lines.push(...(entries.length ? entries.map((entry) => `  ${formatActivityEntry(entry)}`) : [theme.fg("muted", "  No activity yet")]));
	ctx.ui.setWidget("web-activity", lines);
}

function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([query]) => query));
}

function formatQueryHeader(query: string, provider: string | undefined, duplicateQueries: Set<string>): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

function buildSearchReturn(args: {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: Array<{ url: string; title: string; content: string; error: string | null }>;
}): AgentToolResult<{ queries: string[]; queryCount: number; successfulQueries: number; totalResults: number; urls: string[] }> {
	const { queryList, results, urls, includeContent, inlineContent } = args;
	const successful = results.filter((r) => r.error === null).length;
	let output = "";
	const duplicateQueries = duplicateQuerySet(results);

	for (const r of results) {
		output += formatQueryHeader(r.query, r.provider, duplicateQueries);
		if (r.error !== null) output += `Error: ${r.error}\n\n`;
		else output += formatSearchSummary(r.results, r.answer) + "\n\n";
	}

	if (includeContent && inlineContent?.length) {
		output += "---\n\n## Fetched Content\n\n";
		for (const item of inlineContent) {
			if (item.error !== null) {
				output += `### ${item.url}\n\nError: ${item.error}\n\n`;
				continue;
			}
			const content = item.content.length > MAX_INLINE_CONTENT
				? item.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]"
				: item.content;
			output += `### ${item.title || item.url}\n${item.url}\n\n${content}\n\n`;
		}
	}

	return {
		...textResult(output.trim(), {
			queries: queryList,
			queryCount: queryList.length,
			successfulQueries: successful,
			totalResults: results.reduce((sum, r) => sum + r.results.length, 0),
			urls,
		}),
		...(successful === 0 ? { isError: true } : {}),
	};
}

export default function webAccessLean(pi: ExtensionAPI) {
	const newSession = () => ({ controller: new AbortController(), clones: undefined as ReturnType<typeof import("./extract.ts").createGitHubCloneSession> | undefined });
	let session = newSession();

	async function endSession(): Promise<void> {
		const previous = session;
		previous.controller.abort();
		if (previous.clones) {
			const extractModule = await extractModulePromise!;
			await extractModule.disposeGitHubCloneSession(previous.clones);
		}
	}

	pi.on("session_start", async () => {
		await endSession();
		session = newSession();
	});
	pi.on("session_shutdown", endSession);

	async function fetchAllContent(urls: string[], signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent[]> {
		const current = session;
		const operationSignal = signal ? AbortSignal.any([signal, current.controller.signal]) : current.controller.signal;
		if (!operationSignal.aborted) {
			const extractModule = await (extractModulePromise ??= import("./extract.ts"));
			if (!operationSignal.aborted) {
				current.clones ??= extractModule.createGitHubCloneSession();
				return extractModule.fetchAllContent(urls, operationSignal, options, current.clones);
			}
		}
		return urls.map((url) => ({ url, title: "", content: "", error: "Aborted" }));
	}

	pi.registerShortcut("ctrl+shift+w", {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateActivityWidget(ctx));
				updateActivityWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		prepareArguments: prepareSearchArguments,
		description: "Search the web. Supports single query or batch queries, recency/domain filters, optional page-content fetch.",
		promptSnippet: "Use for current/external web research. Use queries for multi-angle research.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query" })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries" })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query, default 5, max 20; Sonar keeps additional cited sources" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch page content for results" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Recency filter" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Domains to include/exclude" })),
			provider: Type.Optional(StringEnum(["auto", "perplexity", "exa"], { description: "Search provider" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const queryList = normalizeSearchQueries(params);
			if (queryList.length === 0) {
				return { ...textResult("Error: No query provided.", { error: "No query provided" }), isError: true };
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			let allInlineContent: ExtractedContent[] = [];
			const provider = normalizeProviderInput(params.provider);
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
			const cancellation = createCredentialSafeCancellation(signal);

			for (let i = 0; i < queryList.length; i++) {
				cancellation.throwIfAborted();
				const query = queryList[i];
				onUpdate?.({ content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: ${query}` }], details: { phase: "search", progress: i / queryList.length } });
				try {
					const { answer, results, inlineContent, provider: usedProvider } = await search(query, {
						provider,
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
						cancellation,
					});
					cancellation.throwIfAborted();
					searchResults.push({ query, answer, results, error: null, provider: usedProvider });
					for (const r of results) if (!allUrls.includes(r.url)) allUrls.push(r.url);
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					cancellation.throwIfAborted();
					if (isAbortError(err)) throw err;
					searchResults.push({ query, answer: "", results: [], error: err instanceof Error ? err.message : String(err), provider });
				}
			}

			if (params.includeContent) {
				const providedByUrl = new Map<string, ExtractedContent[]>();
				for (const item of allInlineContent) {
					const provided = providedByUrl.get(item.url);
					if (provided) provided.push(item);
					else providedByUrl.set(item.url, [item]);
				}
				const missing = allUrls.filter(url => !providedByUrl.has(url));
				if (missing.length > 0) {
					onUpdate?.({ content: [{ type: "text", text: `Fetching ${missing.length} URL(s)...` }], details: { phase: "fetch", progress: 0 } });
					const fetched = await fetchAllContent(missing, signal);
					cancellation.throwIfAborted();
					let next = 0;
					allInlineContent = allUrls.flatMap(url => providedByUrl.get(url) ?? [fetched[next++]]);
				}
			}

			return buildSearchReturn({ queryList, results: searchResults, urls: allUrls, includeContent: params.includeContent ?? false, inlineContent: allInlineContent });
		},
		renderCall(args, theme) {
			const queryList = normalizeSearchQueries(args);
			const label = queryList.length === 1 ? queryList[0] : `${queryList.length} queries`;
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", queryList.length ? label : "(no query)"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { error?: string; successfulQueries?: number; queryCount?: number; totalResults?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", `${details?.successfulQueries ?? 0}/${details?.queryCount ?? 0} queries, ${details?.totalResults ?? 0} sources`), 0, 0);
		},
	});

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description: "Search for code examples, docs, API references, library usage, and debugging topics.",
		promptSnippet: "Use for programming/API/library questions before coding or debugging.",
		parameters: Type.Object({
			query: Type.String({ description: "Programming question, API, library, or debugging topic" }),
			maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Max returned context tokens" })),
		}),
		async execute(toolCallId, params, signal) {
			return executeCodeSearch(toolCallId, params, signal);
		},
		renderCall(args, theme) {
			const { query } = args as { query?: string };
			return new Text(theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", query || "(no query)"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { error?: string; maxTokens?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", "code context returned") + theme.fg("muted", ` (${details?.maxTokens ?? 5000} tokens max)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable markdown. Handles normal pages, PDFs, and GitHub repositories.",
		promptSnippet: "Use for direct URLs when page content is needed.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs" })),
			forceClone: Type.Optional(Type.Boolean({ description: "Force cloning large GitHub repositories" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const urlList = normalizeFetchUrls(params);
			if (urlList.length === 0) {
				return { content: [{ type: "text", text: "Error: No URL provided. Use 'url' or 'urls'." }], details: { error: "No URL provided" }, isError: true };
			}
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }], details: { phase: "fetch", progress: 0 } });
			const results = await fetchAllContent(urlList, signal, { forceClone: typeof params.forceClone === "boolean" ? params.forceClone : undefined });
			const successful = results.filter((r) => r.error === null).length;

			if (urlList.length === 1) {
				const r = results[0];
				if (r.error !== null) return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { urls: urlList, successful: 0, error: r.error }, isError: true };
				const truncated = r.content.length > MAX_INLINE_CONTENT;
				const text = truncated ? r.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]" : r.content;
				return { content: [{ type: "text", text }], details: { urls: urlList, successful: 1, title: r.title, totalChars: r.content.length, truncated } };
			}

			let output = "## Fetched URLs\n\n";
			for (const r of results) {
				if (r.error !== null) output += `- ${r.url}: Error - ${r.error}\n`;
				else output += `## ${r.title || r.url}\n${r.url}\n\n${r.content.length > MAX_INLINE_CONTENT ? r.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]" : r.content}\n\n`;
			}
			return { content: [{ type: "text", text: output.trim() }], details: { urls: urlList, successful, urlCount: urlList.length }, ...(successful === 0 ? { isError: true } : {}) };
		},
		renderCall(args, theme) {
			const urlList = normalizeFetchUrls(args);
			const label = urlList.length === 1 ? urlList[0] : `${urlList.length} URLs`;
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", urlList.length ? label : "(no URL)"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { error?: string; successful?: number; urlCount?: number; title?: string; totalChars?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (details?.urlCount && details.urlCount > 1) return new Text(theme.fg("success", `${details.successful}/${details.urlCount} URLs`), 0, 0);
			return new Text(theme.fg("success", details?.title || "content fetched") + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`), 0, 0);
		},
	});
}
