import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResponse, type SearchOptions } from "./perplexity.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { createCredentialSafeCancellation, CredentialResolutionError } from "./credential-source.ts";
import { isAbortError, parseConfigRoot } from "./utils.ts";

export type SearchProvider = "auto" | "perplexity" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
let cachedSearchConfig: { searchProvider: SearchProvider } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto" };
		return cachedSearchConfig;
	}

	try {
		const raw = parseConfigRoot(readFileSync(CONFIG_PATH, "utf-8"));
		cachedSearchConfig = { searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider) };
		return cachedSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "exa" ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const cancellation = options.cancellation ?? createCredentialSafeCancellation(options.signal);
	cancellation.throwIfAborted();
	const provider = options.provider && options.provider !== "auto"
		? options.provider
		: getSearchConfig().searchProvider;

	if (provider === "perplexity") {
		try {
			const result = await searchWithPerplexity(query, { ...options, cancellation });
			cancellation.throwIfAborted();
			return { ...result, provider: "perplexity" };
		} catch (err) {
			cancellation.throwIfAborted();
			throw err;
		}
	}

	if (provider === "exa") {
		const result = await searchWithExa(query, options);
		cancellation.throwIfAborted();
		if (result) return { ...result, provider: "exa" };
		throw new Error("Exa search returned no results.");
	}

	const fallbackErrors: string[] = [];
	let firstEmpty: AttributedSearchResponse | undefined;

	if (isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			cancellation.throwIfAborted();
			if (result) {
				const response: AttributedSearchResponse = { ...result, provider: "exa" };
				if (result.answer.trim() || result.results.length) return response;
				firstEmpty = response;
			}
		} catch (err) {
			cancellation.throwIfAborted();
			if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (isPerplexityAvailable()) {
		try {
			const result = await searchWithPerplexity(query, { ...options, cancellation });
			cancellation.throwIfAborted();
			const response: AttributedSearchResponse = { ...result, provider: "perplexity" };
			if (result.answer.trim() || result.results.length) return response;
			firstEmpty ??= response;
		} catch (err) {
			cancellation.throwIfAborted();
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Perplexity: ${errorMessage(err)}`);
		}
	}

	if (firstEmpty) return firstEmpty;

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error("No search provider available. Set EXA_API_KEY/exaApiKey or perplexityApiKey in ~/.pi/web-search.json");
}
