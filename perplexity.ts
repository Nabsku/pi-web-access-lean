import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { createCredentialSafeCancellation, hasCredentialSource, redactCredential, resolveCredential, type CredentialSafeCancellation } from "./credential-source.ts";
import { isAbortError, parseConfigRoot } from "./utils.ts";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const REQUEST_TIMEOUT_MS = 30_000;

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
	/** @internal Shared only within one search or registered-tool invocation. */
	cancellation?: CredentialSafeCancellation;
}

interface WebSearchConfig {
	perplexityApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = parseConfigRoot(content) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export function isPerplexityAvailable(): boolean {
	return hasCredentialSource({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
	});
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const cancellation = options.cancellation ?? createCredentialSafeCancellation(options.signal);
	cancellation.throwIfAborted();
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	let apiKey: string;
	try {
		apiKey = await getApiKey(options.signal);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			cancellation.throwIfAborted();
		}
		throw err;
	}
	cancellation.addCredential(apiKey);
	const numResults = typeof options.numResults === "number" && Number.isFinite(options.numResults)
		? Math.max(1, Math.min(Math.floor(options.numResults), 20))
		: 5;

	const requestBody: Record<string, unknown> = {
		model: "sonar",
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	const startedAt = performance.now();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response | undefined;
	let data: Record<string, unknown>;
	try {
		signal.throwIfAborted();
		response = await fetch(PERPLEXITY_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal,
		});
		signal.throwIfAborted();

		if (!response.ok) {
			const errorText = await response.text();
			signal.throwIfAborted();
			throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
		}

		try {
			data = await response.json();
		} catch (err) {
			if (signal.aborted || isAbortError(err)) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Perplexity API returned invalid JSON: ${message}`);
		}
		signal.throwIfAborted();
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			cancellation.throwIfAborted();
		}
		const timedOut = timeout.aborted;
		if (timedOut) {
			err = new Error(`Perplexity API error 408: request deadline exceeded (budget ${REQUEST_TIMEOUT_MS} ms, elapsed ${Math.round(performance.now() - startedAt)} ms). Retry or narrow the query.`);
		}
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (isAbortError(err)) {
			activityMonitor.logComplete(activityId, 0);
		} else if (response && !timedOut) {
			activityMonitor.logComplete(activityId, response.status);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	const answer = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
	const citations = Array.isArray(data.citations) ? data.citations : [];
	// Sonar footnotes index the original array, so retain the entire referenced prefix.
	let citationCount = numResults;
	for (const match of answer.matchAll(/\[(\d+)\]/g)) {
		citationCount = Math.max(citationCount, Number(match[1]));
	}

	const results: SearchResult[] = [];
	for (let i = 0; i < Math.min(citations.length, citationCount); i++) {
		const citation = citations[i];
		if (typeof citation === "string") {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (citation && typeof citation === "object" && typeof citation.url === "string") {
			results.push({
				title: citation.title || `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}
