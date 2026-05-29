import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { fetchAllContent } from "./extract.js";
import { search, type SearchProvider } from "./search.js";
import { executeCodeSearch } from "./code-search.js";
import type { SearchResult } from "./perplexity.js";

const MAX_INLINE_CONTENT = 30000;

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

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\nSources:\n` : "Sources:\n";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
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
	const successful = results.filter((r) => !r.error).length;
	let output = "";
	const duplicateQueries = duplicateQuerySet(results);

	for (const r of results) {
		output += formatQueryHeader(r.query, r.provider, duplicateQueries);
		if (r.error) output += `Error: ${r.error}\n\n`;
		else output += formatSearchSummary(r.results, r.answer) + "\n\n";
	}

	if (includeContent && inlineContent?.length) {
		output += "---\n\n## Fetched Content\n\n";
		for (const item of inlineContent) {
			if (item.error) {
				output += `### ${item.url}\n\nError: ${item.error}\n\n`;
				continue;
			}
			const content = item.content.length > MAX_INLINE_CONTENT
				? item.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]"
				: item.content;
			output += `### ${item.title || item.url}\n${item.url}\n\n${content}\n\n`;
		}
	}

	return textResult(output.trim(), {
		queries: queryList,
		queryCount: queryList.length,
		successfulQueries: successful,
		totalResults: results.reduce((sum, r) => sum + r.results.length, 0),
		urls,
	});
}

export default function webAccessLean(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web. Supports single query or batch queries, recency/domain filters, optional page-content fetch.",
		promptSnippet: "Use for current/external web research. Use queries for multi-angle research.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query" })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries" })),
			numResults: Type.Optional(Type.Number({ description: "Results per query, default 5, max 20" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch page content for results" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Recency filter" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Domains to include/exclude" })),
			provider: Type.Optional(StringEnum(["auto", "perplexity", "exa"], { description: "Search provider" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return textResult("Error: No query provided.", { error: "No query provided" });
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: Array<{ url: string; title: string; content: string; error: string | null }> = [];
			const provider = normalizeProviderInput(params.provider);
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

			for (let i = 0; i < queryList.length; i++) {
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
					});
					searchResults.push({ query, answer, results, error: null, provider: usedProvider });
					for (const r of results) if (!allUrls.includes(r.url)) allUrls.push(r.url);
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					searchResults.push({ query, answer: "", results: [], error: err instanceof Error ? err.message : String(err), provider });
				}
			}

			return buildSearchReturn({ queryList, results: searchResults, urls: allUrls, includeContent: params.includeContent ?? false, inlineContent: allInlineContent });
		},
		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const queryList = normalizeQueryList(Array.isArray(input.queries) ? input.queries : (input.query !== undefined ? [input.query] : []));
			const label = queryList.length === 1 ? queryList[0] : `${queryList.length} queries`;
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", label || "(no query)"), 0, 0);
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
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return { content: [{ type: "text", text: "Error: No URL provided." }], details: { error: "No URL provided" } };
			}
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }], details: { phase: "fetch", progress: 0 } });
			const results = await fetchAllContent(urlList, signal, { forceClone: params.forceClone });
			const successful = results.filter((r) => !r.error).length;

			if (urlList.length === 1) {
				const r = results[0];
				if (r.error) return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { urls: urlList, successful: 0, error: r.error } };
				const truncated = r.content.length > MAX_INLINE_CONTENT;
				const text = truncated ? r.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]" : r.content;
				return { content: [{ type: "text", text }], details: { urls: urlList, successful: 1, title: r.title, totalChars: r.content.length, truncated } };
			}

			let output = "## Fetched URLs\n\n";
			for (const r of results) {
				if (r.error) output += `- ${r.url}: Error - ${r.error}\n`;
				else output += `## ${r.title || r.url}\n${r.url}\n\n${r.content.length > MAX_INLINE_CONTENT ? r.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated]" : r.content}\n\n`;
			}
			return { content: [{ type: "text", text: output.trim() }], details: { urls: urlList, successful, urlCount: urlList.length } };
		},
		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const urlList = urls ?? (url ? [url] : []);
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", urlList.length === 1 ? urlList[0] : `${urlList.length} URLs`), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { error?: string; successful?: number; urlCount?: number; title?: string; totalChars?: number };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (details?.urlCount && details.urlCount > 1) return new Text(theme.fg("success", `${details.successful}/${details.urlCount} URLs`), 0, 0);
			return new Text(theme.fg("success", details?.title || "content fetched") + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`), 0, 0);
		},
	});
}
