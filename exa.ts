import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { parseConfigRoot } from "./utils.ts";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	exaApiKey?: unknown;
}

interface ExaSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		publishedDate?: string;
		author?: string;
		text?: string;
		highlights?: unknown;
		highlightScores?: number[];
	}>;
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

export type ExaSearchResult = SearchResponse | null;

export interface ExaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

type McpParsedResult = { title: string; url: string; content: string };

class ExaMcpToolNotFoundError extends Error {}

function mcpToolError(toolName: string, message: string, prefix = ""): Error {
	return message.toLowerCase() === `tool ${toolName.toLowerCase()} not found`
		? new ExaMcpToolNotFoundError(prefix + message)
		: new Error(prefix + message);
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = parseConfigRoot(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Exa",
		configuredValue: loadConfig().exaApiKey,
		environmentValue: process.env.EXA_API_KEY,
		signal,
	});
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function exaSearchArgs(query: string, options: ExaSearchOptions): Record<string, unknown> {
	return {
		query,
		type: "auto",
		numResults: options.numResults ?? 5,
		...mapDomainFilter(options.domainFilter),
		...(options.recencyFilter ? { startPublishedDate: recencyToStartDate(options.recencyFilter) } : {}),
	};
}

function fallbackSourceLabel(url: string | undefined, index: number): string {
	try {
		const hostname = url ? new URL(url).hostname : "";
		if (hostname) return hostname;
	} catch {
		// Invalid URLs retain the generic label.
	}
	return `Source ${index + 1}`;
}

function buildAnswerFromSearchResults(results: ExaSearchResponse["results"]): string {
	if (!results?.length) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content = highlights.length > 0
			? highlights.join(" ")
			: typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
		if (!content) continue;
		const sourceTitle = item.title || fallbackSourceLabel(item.url, i);
		parts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResponse["results"]): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		mapped.push({
			title: item.title || fallbackSourceLabel(item.url, i),
			url: item.url,
			snippet: "",
		});
	}
	return mapped;
}

function mapInlineContent(results: ExaSearchResponse["results"]): ExtractedContent[] {
	if (!results?.length) return [];
	return results.flatMap((r, i) => r?.url && typeof r.text === "string" && r.text.length > 0
		? [{ url: r.url, title: r.title || fallbackSourceLabel(r.url, i), content: r.text, error: null }]
		: []);
}

function mapSearchResponse(results: ExaSearchResponse["results"], includeContent?: boolean): SearchResponse {
	const response: SearchResponse = {
		answer: buildAnswerFromSearchResults(results),
		results: mapResults(results),
	};
	if (includeContent) {
		const inlineContent = mapInlineContent(results);
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}
	return response;
}

export async function callExaMcp(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const response = await fetch(`${EXA_MCP_URL}?tools=${encodeURIComponent(toolName)}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal: requestSignal(signal),
	});

	const body = await response.text();
	signal?.throwIfAborted();
	if (!response.ok) {
		if (response.status === 429) {
			throw new Error(`Exa MCP rate limit reached (429). Configure exaApiKey in ${CONFIG_PATH} or EXA_API_KEY to use your account's limits: ${body.slice(0, 300)}`);
		}
		throw new Error(`Exa MCP error ${response.status}: ${body.slice(0, 300)}`);
	}

	const dataLines = body.split("\n").filter(line => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
		}
	}

	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
			}
		} catch {
		}
	}

	if (!parsed) {
		throw new Error("Exa MCP returned an empty response");
	}

	if (parsed.error) {
		const code = typeof parsed.error.code === "number" ? ` ${parsed.error.code}` : "";
		const message = parsed.error.message || "Unknown error";
		throw mcpToolError(toolName, String(message), `Exa MCP error${code}: `);
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find(item => item.type === "text" && typeof item.text === "string")
			?.text?.trim();
		throw mcpToolError(toolName, message || "Exa MCP returned an error");
	}

	const text = parsed.result?.content
		?.find(item => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;

	if (!text) {
		throw new Error("Exa MCP returned empty content");
	}

	return text;
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter(block => block.trim().length > 0);
	const parsed = blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) {
				content = block.slice(hlMatch.index + hlMatch[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter(result => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		const sourceTitle = result.title || fallbackSourceLabel(result.url, i);
		parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
	}
	return parts.join("\n\n");
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
	return results.flatMap((result, i) => result.content.length > 0
		? [{ url: result.url, title: result.title || fallbackSourceLabel(result.url, i), content: result.content, error: null }]
		: []);
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	return parts.join(" ");
}

function parseJsonMcpResults(text: string): ExaSearchResponse["results"] | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (err) {
		if (err instanceof SyntaxError) return null;
		throw err;
	}
	const results = data && typeof data === "object" && "results" in data ? data.results : null;
	if (!Array.isArray(results) || results.some(item => !item || typeof item !== "object"
		|| typeof item.url !== "string" || !item.url
		|| (item.title !== undefined && typeof item.title !== "string")
		|| (item.text !== undefined && typeof item.text !== "string"))) {
		throw new Error("Exa MCP returned invalid search results");
	}
	return results;
}

async function searchWithExaMcpTool(tool: string, args: Record<string, unknown>, options: ExaSearchOptions): Promise<SearchResponse | null> {
	const text = await callExaMcp(tool, args, options.signal);
	const jsonResults = parseJsonMcpResults(text);
	if (jsonResults) return mapSearchResponse(jsonResults, options.includeContent);

	const parsedResults = parseMcpResults(text);
	if (!parsedResults) {
		if (tool === EXA_MCP_ADVANCED_TOOL) throw new Error("Exa MCP returned invalid search results");
		return null;
	}
	const response: SearchResponse = {
		answer: buildAnswerFromMcpResults(parsedResults),
		results: mapResults(parsedResults),
	};

	if (options.includeContent) {
		const inlineContent = mapMcpInlineContent(parsedResults);
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}
	return response;
}

async function searchWithExaMcp(query: string, options: ExaSearchOptions = {}): Promise<SearchResponse | null> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	const basicArgs = { query: buildMcpQuery(query, options), numResults: options.numResults ?? 5 };
	try {
		let response: SearchResponse | null;
		if (options.includeContent || options.recencyFilter || options.domainFilter?.length) {
			try {
				response = await searchWithExaMcpTool(EXA_MCP_ADVANCED_TOOL, {
					...exaSearchArgs(query, options),
					enableHighlights: true,
					textMaxCharacters: options.includeContent ? 50000 : 3000,
				}, options);
			} catch (err) {
				options.signal?.throwIfAborted();
				if (!(err instanceof ExaMcpToolNotFoundError)) throw err;
				// Basic search can only preserve filters as best-effort query hints.
				response = await searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
			}
		} else {
			response = await searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
		}
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (options.signal?.aborted || message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

export function isExaAvailable(): boolean {
	return true;
}

export function hasExaApiKey(): boolean {
	return hasCredentialSource({
		provider: "Exa",
		configuredValue: loadConfig().exaApiKey,
		environmentValue: process.env.EXA_API_KEY,
	});
}

export async function searchWithExa(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResult> {
	const apiKey = await getApiKey(options.signal);
	if (!apiKey) {
		return searchWithExaMcp(query, options);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				...exaSearchArgs(query, options),
				contents: options.includeContent ? { text: true, highlights: true } : { highlights: true },
			}),
			signal: requestSignal(options.signal),
		});

		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as ExaSearchResponse;
		activityMonitor.logComplete(activityId, response.status);

		return mapSearchResponse(data.results, options.includeContent);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		throw new Error(redactedMessage);
	}
}
